import test from 'node:test';
import assert from 'node:assert/strict';
import {resumeUnattempted,reconcileCleanupAndResume,retryApprovedCleanupAndResume,retryPreviouslyApprovedUnattemptedCleanupAndResume,reconcileSentAndCleanupAndResume} from './recovery.mjs';
import {MailSessionRunner} from './session-runner.mjs';

function fixture() {
  let now=100;
  const runner={
    busy:false,deadlineMono:1000,nextDueMono:200,clock:{monotonic:()=>now},abort:new AbortController(),
    state:{runId:'original-run',phase:'halted',stopReason:'step_failed',config:{intervalMs:72000},startedAt:'2026-11-17T09:13:22Z',
      deadlineAt:'2026-11-17T10:13:22Z',deadlineReached:false,
      records:[{ref:{draftId:'draft-a',accountId:'test@example.test'},status:'not_attempted',cleanup:'not_eligible',error:'Host context unavailable'}],
      events:[{type:'halted',reason:'step_failed'}]},
    checkDeadline(){if(this.deadlineMono!==null&&now>=this.deadlineMono)this.state.deadlineReached=true;},
    persist(type,detail){this.state.events.push({type,...detail});},
    status(){return {phase:this.state.phase,deadlineAt:this.state.deadlineAt,deadlineReached:this.state.deadlineReached};},
  };
  runner.abort.abort('step_failed');
  return {runner,advance:ms=>{now+=ms;},checkCompatibility:async()=>({ok:true,accountId:'test@example.test'})};
}

test('explicit compatible unattempted recovery preserves the original window and next send time',async()=>{
  const f=fixture(),s=f.runner.state;const previous={start:s.startedAt,deadline:s.deadlineAt,mono:f.runner.deadlineMono,due:f.runner.nextDueMono};
  const result=await resumeUnattempted(f.runner,{checkCompatibility:f.checkCompatibility});
  assert.equal(result.phase,'running');assert.equal(s.records[0].status,'pending');assert.equal(s.stopReason,null);
  assert.equal(f.runner.abort.signal.aborted,false);
  assert.deepEqual({start:s.startedAt,deadline:s.deadlineAt,mono:f.runner.deadlineMono,due:f.runner.nextDueMono},previous);
  assert.equal(s.events.at(-1).type,'recovered');
});

test('compatibility is checked before state changes and must match the selected account',async()=>{
  const f=fixture();let checks=0;
  await assert.rejects(()=>resumeUnattempted(f.runner,{checkCompatibility:async()=>{
    checks++;assert.equal(f.runner.state.phase,'halted');assert.equal(f.runner.state.records[0].status,'not_attempted');
    return {ok:true,accountId:'other@example.test'};
  }}),/COMPATIBILITY_NOT_CONFIRMED/);
  assert.equal(checks,1);assert.equal(f.runner.state.phase,'halted');assert.equal(f.runner.abort.signal.aborted,true);
});

test('unknown sends, send intent, existing receipt and pending cleanup each prohibit recovery',async()=>{
  for(const mutate of [
    s=>s.records[0].status='unknown',
    s=>s.events.push({type:'send_intent',draftId:'draft-a'}),
    s=>s.records[0].attemptAt='2026-11-17T09:14:00Z',
    s=>s.records[0].clickAuthorizedAt='2026-11-17T09:14:00Z',
    s=>s.records[0].receipt={status:'sent'},
    s=>s.records.push({ref:{draftId:'prior'},status:'sent',cleanup:'pending'}),
  ]){
    const f=fixture();mutate(f.runner.state);let checked=false;
    await assert.rejects(()=>resumeUnattempted(f.runner,{checkCompatibility:async()=>{checked=true;return {ok:true,accountId:'test@example.test'};}}));
    assert.equal(checked,false);assert.equal(f.runner.state.phase,'halted');
  }
});

test('deadline already reached prevents recovery and skips compatibility check',async()=>{
  const f=fixture();f.advance(900);let checked=false;
  await assert.rejects(()=>resumeUnattempted(f.runner,{checkCompatibility:async()=>{checked=true;return {ok:true,accountId:'test@example.test'};}}),/WINDOW_EXPIRED/);
  assert.equal(checked,false);assert.equal(f.runner.state.records[0].status,'not_attempted');
});

test('deadline is rechecked after asynchronous compatibility validation',async()=>{
  const f=fixture();
  await assert.rejects(()=>resumeUnattempted(f.runner,{checkCompatibility:async()=>{f.advance(900);return {ok:true,accountId:'test@example.test'};}}),/WINDOW_EXPIRED/);
  assert.equal(f.runner.state.records[0].status,'not_attempted');assert.equal(f.runner.state.phase,'halted');
});

test('running, busy or another failure reason does not qualify for recovery',async()=>{
  for(const mutate of [r=>r.state.phase='running',r=>r.busy=true,r=>r.state.stopReason='send_unknown']){
    const f=fixture();mutate(f.runner);
    await assert.rejects(()=>resumeUnattempted(f.runner,{checkCompatibility:f.checkCompatibility}));
  }
});

test('changed run state during compatibility checking prevents recovery',async()=>{
  const f=fixture();
  await assert.rejects(()=>resumeUnattempted(f.runner,{checkCompatibility:async()=>{
    f.runner.nextDueMono=300;return {ok:true,accountId:'test@example.test'};
  }}),/STATE_CHANGED_DURING_CHECK/);
  assert.equal(f.runner.state.phase,'halted');assert.equal(f.runner.state.records[0].status,'not_attempted');
});

test('recovery requires an explicit check and cannot be applied twice',async()=>{
  const f=fixture();await assert.rejects(()=>resumeUnattempted(f.runner),/COMPATIBILITY_CHECK_REQUIRED/);
  await resumeUnattempted(f.runner,{checkCompatibility:f.checkCompatibility});
  await assert.rejects(()=>resumeUnattempted(f.runner,{checkCompatibility:f.checkCompatibility}),/UNATTEMPTED_STEP_FAILURE/);
});

test('a fixed interval update is recorded without changing the existing next due time or deadline',async()=>{
  const f=fixture();
  await resumeUnattempted(f.runner,{checkCompatibility:f.checkCompatibility,intervalMs:60000});
  assert.equal(f.runner.state.config.intervalMs,60000);assert.equal(f.runner.nextDueMono,200);assert.equal(f.runner.deadlineMono,1000);
  const event=f.runner.state.events.find(e=>e.type==='fixed_interval_updated');
  assert.equal(event.previousIntervalMs,72000);assert.equal(event.intervalMs,60000);
  assert.equal(event.currentNextDuePreserved,true);assert.equal(event.deadlinePreserved,true);
});

test('invalid interval updates fail before compatibility or state changes',async()=>{
  for(const intervalMs of [0,-1,NaN,Infinity,'60000']){
    const f=fixture();let checked=false;
    await assert.rejects(()=>resumeUnattempted(f.runner,{intervalMs,checkCompatibility:async()=>{checked=true;return {ok:true,accountId:'test@example.test'};}}),/INTERVAL_MUST_BE_POSITIVE/);
    assert.equal(checked,false);assert.equal(f.runner.state.config.intervalMs,72000);assert.equal(f.runner.state.phase,'halted');
  }
});

test('real runner applies the revised fixed interval only after the next actual send',async()=>{
  let now=0,fail=true;const clicks=[];
  const item=id=>({accountId:'test@example.test',draftId:id,draftVersion:id,approvedHash:id,recipient:`${id}@example.test`,subject:id,body:id});
  const adapter={
    async scanDrafts(){return ['a','b'].map(id=>({accountId:'test@example.test',draftId:id}));},
    async countDrafts(){return {value:2,source:'fixture',exact:true};},
    async inspectDraft(ref){if(fail)throw Error('host inactive');return item(ref.draftId);},
    async preflight(){return {ok:true};},
    async send(i,{beforeClick}){await beforeClick();clicks.push(now);return {...i,status:'sent',authoritative:true,messageId:`sent-${i.draftId}`};},
    async reconcile(){return {status:'unknown'};},
    async cleanup(i,r){return {...i,status:'already_absent',authoritative:true,sentMessageId:r.messageId};},
  };
  const runner=new MailSessionRunner({adapter,target:2,intervalMs:72000,store:{save(){}},
    clock:{monotonic:()=>now,wall:()=>Date.UTC(2026,10,17)+now},timers:{setTimeout(){return 1;},clearTimeout(){}}});
  await runner.initialize();runner.start();await runner.step();const originalDeadline=runner.deadlineMono;
  now=5000;fail=false;
  await resumeUnattempted(runner,{intervalMs:60000,checkCompatibility:async()=>({ok:true,accountId:'test@example.test'})});
  assert.equal(runner.nextDueMono,0);assert.equal(runner.deadlineMono,originalDeadline);
  await runner.step();assert.equal(runner.nextDueMono,65000);
  await runner.step();assert.deepEqual(clicks,[5000]);
  now=65000;await runner.step();assert.deepEqual(clicks,[5000,65000]);assert.equal(runner.deadlineMono,originalDeadline);
});

test('only the exact original-missing preflight hold recovers after fresh matching proof',async()=>{
  const f=fixture();f.runner.state.stopReason='preflight_hold';
  Object.assign(f.runner.state.records[0],{status:'held',reason:'original_draft_not_in_completed_search'});
  let checked=0;
  await resumeUnattempted(f.runner,{checkCompatibility:async input=>{
    checked++;assert.equal(input.requiresPreflight,true);assert.equal(input.draftId,'draft-a');
    assert.equal(f.runner.state.records[0].status,'held');
    return {ok:true,accountId:'test@example.test',draftId:'draft-a',preflightOk:true};
  }});
  assert.equal(checked,1);assert.equal(f.runner.state.phase,'running');assert.equal(f.runner.state.records[0].status,'pending');
  assert.equal(f.runner.deadlineMono,1000);assert.equal(f.runner.nextDueMono,200);
  assert.equal(f.runner.state.events.at(-1).reason,'fresh_preflight_confirmed_original_after_incomplete_search');
});

test('preflight hold requires an explicit fresh successful preflight for the same draft',async()=>{
  for(const evidence of [
    {ok:true,accountId:'test@example.test'},
    {ok:true,accountId:'test@example.test',draftId:'draft-a',preflightOk:false},
    {ok:true,accountId:'test@example.test',draftId:'different',preflightOk:true},
  ]){
    const f=fixture();f.runner.state.stopReason='preflight_hold';
    Object.assign(f.runner.state.records[0],{status:'held',reason:'original_draft_not_in_completed_search'});
    await assert.rejects(()=>resumeUnattempted(f.runner,{checkCompatibility:async()=>evidence}),/FRESH_PREFLIGHT_NOT_CONFIRMED/);
    assert.equal(f.runner.state.records[0].status,'held');assert.equal(f.runner.state.phase,'halted');
  }
});

test('bounce, duplicate and unrelated preflight holds remain ineligible',async()=>{
  for(const reason of ['delivery_or_stop_record','existing_same_subject_correspondence','history_requires_full_review','account_changed']){
    const f=fixture();f.runner.state.stopReason='preflight_hold';
    Object.assign(f.runner.state.records[0],{status:'held',reason});let checks=0;
    await assert.rejects(()=>resumeUnattempted(f.runner,{checkCompatibility:async()=>{checks++;return {ok:true,accountId:'test@example.test',draftId:'draft-a',preflightOk:true};}}),/PREFLIGHT_HOLD_NOT_ELIGIBLE/);
    assert.equal(checks,0);
  }
});

test('an eligible search hold still rejects send evidence and expiration during recheck',async()=>{
  const f=fixture();f.runner.state.stopReason='preflight_hold';
  Object.assign(f.runner.state.records[0],{status:'held',reason:'original_draft_not_in_completed_search',attemptAt:'prior'});
  await assert.rejects(()=>resumeUnattempted(f.runner,{checkCompatibility:async()=>({ok:true,accountId:'test@example.test',draftId:'draft-a',preflightOk:true})}),/SEND_EVIDENCE/);
  delete f.runner.state.records[0].attemptAt;
  await assert.rejects(()=>resumeUnattempted(f.runner,{checkCompatibility:async()=>{f.advance(900);return {ok:true,accountId:'test@example.test',draftId:'draft-a',preflightOk:true};}}),/WINDOW_EXPIRED/);
  assert.equal(f.runner.state.records[0].status,'held');
});

function cleanupFixture() {
  const f=fixture();const item={accountId:'test@example.test',draftId:'draft-a',draftVersion:'version-a',
    approvedHash:'hash-a',recipient:'customer@example.test',subject:'Existing draft',body:'Existing body'};
  const receipt={...item,status:'sent',authoritative:true,messageId:'sent-a'};
  f.runner.validReceipt=MailSessionRunner.prototype.validReceipt;
  f.runner.validCleanup=MailSessionRunner.prototype.validCleanup;
  f.runner.state.stopReason='cleanup_unknown';
  f.runner.state.config.intervalMs=60000;
  f.runner.state.records=[{ref:{accountId:item.accountId,draftId:item.draftId},item,receipt,status:'sent',cleanup:'unknown',attemptAt:'prior-click'}];
  f.evidence={accountId:item.accountId,draftId:item.draftId,draftVersion:item.draftVersion,approvedHash:item.approvedHash,
    sentMessageId:receipt.messageId,status:'already_absent',authoritative:true,removalMethod:'ui_delete_confirmed_absent'};
  return f;
}

test('read-only cleanup reconciliation resumes without changing the confirmed sent record or original timing',async()=>{
  const f=cleanupFixture(),original=structuredClone(f.runner.state.records[0].receipt);let calls=0;
  await reconcileCleanupAndResume(f.runner,{reconcileCleanup:async input=>{
    calls++;assert.equal(input.receipt.messageId,'sent-a');assert.equal(input.draftId,'draft-a');
    assert.equal(f.runner.state.phase,'halted');return f.evidence;
  }});
  assert.equal(calls,1);assert.equal(f.runner.state.records[0].status,'sent');
  assert.equal(f.runner.state.records[0].cleanup,'already_absent');assert.deepEqual(f.runner.state.records[0].receipt,original);
  assert.equal(f.runner.state.phase,'running');assert.equal(f.runner.abort.signal.aborted,false);
  assert.equal(f.runner.deadlineMono,1000);assert.equal(f.runner.nextDueMono,200);assert.equal(f.runner.state.config.intervalMs,60000);
  assert.equal(f.runner.state.events.at(-2).type,'cleanup_reconciled');
});

test('cleanup absence evidence must match every original binding and the known sent message',async()=>{
  for(const wrong of [
    {draftId:'other'},{accountId:'other@example.test'},{draftVersion:'other'},
    {approvedHash:'other'},{sentMessageId:'other'},{authoritative:false},
    {status:'trashed'},{removalMethod:'inferred_from_count'},
  ]){
    const f=cleanupFixture();
    await assert.rejects(()=>reconcileCleanupAndResume(f.runner,{reconcileCleanup:async()=>({...f.evidence,...wrong})}),/EXACT_ABSENCE_NOT_CONFIRMED/);
    assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.state.records[0].cleanup,'unknown');
    assert.equal(f.runner.state.phase,'halted');
  }
});

test('cleanup reconciliation rejects an invalid sent receipt or any unknown send before the callback',async()=>{
  for(const mutate of [
    f=>f.runner.state.records[0].receipt.authoritative=false,
    f=>f.runner.state.records[0].receipt.draftId='other',
    f=>f.runner.state.records.push({ref:{draftId:'b'},status:'unknown',cleanup:'not_eligible'}),
    f=>f.runner.state.records.push({...structuredClone(f.runner.state.records[0]),ref:{draftId:'b',accountId:'test@example.test'}}),
  ]){
    const f=cleanupFixture();mutate(f);let calls=0;
    await assert.rejects(()=>reconcileCleanupAndResume(f.runner,{reconcileCleanup:async()=>{calls++;return f.evidence;}}));
    assert.equal(calls,0);
  }
});

test('read-only cleanup may be recorded after an existing deadline but never resumes the run',async()=>{
  const f=cleanupFixture();f.advance(900);let calls=0;
  await reconcileCleanupAndResume(f.runner,{reconcileCleanup:async()=>{calls++;return f.evidence;}});
  assert.equal(calls,1);assert.equal(f.runner.state.records[0].cleanup,'already_absent');
  assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.state.phase,'deadline');
  assert.equal(f.runner.abort.signal.aborted,true);assert.equal(f.runner.state.events.at(-1).type,'recovery_not_resumed');
});

test('deadline during the read-only cleanup callback records evidence without resuming',async()=>{
  const f=cleanupFixture();
  await reconcileCleanupAndResume(f.runner,{reconcileCleanup:async()=>{f.advance(900);return f.evidence;}});
  assert.equal(f.runner.state.records[0].cleanup,'already_absent');assert.equal(f.runner.state.phase,'deadline');
  assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.deadlineMono,1000);
});

test('cleanup reconciliation refuses changed state during the read-only callback',async()=>{
  const f=cleanupFixture();
  await assert.rejects(()=>reconcileCleanupAndResume(f.runner,{reconcileCleanup:async()=>{f.runner.nextDueMono=250;return f.evidence;}}),/STATE_CHANGED_DURING_CHECK/);
  assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.state.records[0].cleanup,'unknown');
});

test('cleanup reconciliation requires the matching idle halt and an explicit checker',async()=>{
  const f=cleanupFixture();await assert.rejects(()=>reconcileCleanupAndResume(f.runner),/READ_ONLY_CLEANUP_CHECK_REQUIRED/);
  for(const change of [r=>r.busy=true,r=>r.state.phase='running',r=>r.state.stopReason='send_unknown']){
    const g=cleanupFixture();change(g.runner);
    await assert.rejects(()=>reconcileCleanupAndResume(g.runner,{reconcileCleanup:async()=>g.evidence}),/IDLE_CLEANUP_HALT/);
  }
});

 test('unlimited unattempted recovery preserves no deadline and its persisted reminder identity',async()=>{
  const f=fixture();f.runner.deadlineMono=null;f.runner.state.deadlineAt=null;f.runner.state.config.durationMs=null;
  f.runner.state.runtimeReminder={notificationId:'already-notified',notificationStatus:'delivered'};
  let rearmed=0;f.runner.armDeadline=()=>{assert.equal(f.runner.deadlineMono,null);};f.runner.resetContinuousRuntime=()=>rearmed++;
  f.advance(10*60*60*1000);await resumeUnattempted(f.runner,{checkCompatibility:f.checkCompatibility});
  assert.equal(f.runner.state.phase,'running');assert.equal(f.runner.deadlineMono,null);assert.equal(rearmed,1);
  assert.equal(f.runner.state.runtimeReminder.notificationId,'already-notified');
});

test('unlimited cleanup recovery preserves confirmed send and does not invent an expired cutoff',async()=>{
  const f=cleanupFixture();f.runner.deadlineMono=null;f.runner.state.deadlineAt=null;f.runner.state.config.durationMs=null;
  f.advance(10*60*60*1000);await reconcileCleanupAndResume(f.runner,{reconcileCleanup:async()=>f.evidence});
  assert.equal(f.runner.state.phase,'running');assert.equal(f.runner.deadlineMono,null);
  assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.state.records[0].cleanup,'already_absent');
});

test('a missing original timing policy is not reinterpreted as an unlimited recovery',async()=>{
  const f=fixture();f.runner.deadlineMono=null;
  await assert.rejects(()=>resumeUnattempted(f.runner,{checkCompatibility:f.checkCompatibility}),/WINDOW_EXPIRED/);
  const cleanup=cleanupFixture();cleanup.runner.deadlineMono=null;
  await assert.rejects(()=>reconcileCleanupAndResume(cleanup.runner,{reconcileCleanup:async()=>cleanup.evidence}),/ORIGINAL_WINDOW_MISSING/);
});

async function approvedCleanupFixture({durationMs=null,target=3}={}) {
  let now=0;const sent=[],deleted=[],writes=[];const timers=new Map();let timerId=0;
  const accountId='owner@example.test',ids=['a','b','c'];
  const bind=item=>Object.fromEntries(['accountId','draftId','draftVersion','approvedHash'].map(key=>[key,item[key]]));
  const item=id=>({accountId,draftId:id,draftVersion:'version-'+id,approvedHash:'hash-'+id,
    recipient:id+'@example.test',subject:'Subject '+id,body:'Body '+id});
  const adapter={approvedPermanentDraftIds:new Set(),
    async scanDrafts(){return ids.map(id=>({accountId,draftId:id}));},
    async countDrafts(){return {value:ids.length-deleted.length,source:'fixture_total',exact:true};},
    async inspectDraft(ref){return item(ref.draftId);},async preflight(){return {ok:true};},
    async send(value,{beforeClick}){await beforeClick();sent.push(value.draftId);return {...bind(value),status:'sent',authoritative:true,messageId:'sent-'+value.draftId,recipient:value.recipient};},
    async reconcile(){return {status:'unknown'};},
    async cleanup(value,receipt,{beforeClick}){
      if(!this.approvedPermanentDraftIds.has(value.draftId))throw Error('PERMANENT_DRAFT_DELETE_REQUIRES_CURRENT_APPROVAL');
      await beforeClick();deleted.push(value.draftId);
      return {...bind(value),status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,removalMethod:'permanent_draft_delete'};
    },
  };
  const runner=new MailSessionRunner({adapter,durationMs,target,intervalMs:100,store:{save(state){writes.push(structuredClone(state));}},
    clock:{monotonic:()=>now,wall:()=>Date.UTC(2026,10,18)+now},
    timers:{setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}}});
  await runner.initialize();runner.start();await runner.step();
  assert.equal(runner.state.phase,'halted');assert.equal(runner.state.stopReason,'cleanup_unknown');
  assert.equal(runner.state.records[0].cleanupError,'PERMANENT_DRAFT_DELETE_REQUIRES_CURRENT_APPROVAL');
  const approval={runId:runner.state.runId,accountId,selectedDraftIds:ids.slice(0,target),approvedPermanentDraftIds:ids.slice(0,target),
    reviewer:'user-chat-explicit-confirmation',approvedAt:new Date(runner.clock.wall()).toISOString(),
    expiresAt:new Date(runner.clock.wall()+60000).toISOString(),statement:'Delete only these selected originals after confirmed sending and unchanged full readback.'};
  return {runner,adapter,approval,sent,deleted,writes,timers,bind,advance(ms){now+=ms;},
    compatibility:async()=>({ok:true,accountId})};
}

test('new exact approval retries only the confirmed sent original cleanup and never resends',async()=>{
  const f=await approvedCleanupFixture();const pending=structuredClone(f.runner.state.records.slice(1));
  const original={runId:f.runner.state.runId,start:f.runner.state.startedAt,deadline:f.runner.deadlineMono,due:f.runner.nextDueMono,config:structuredClone(f.runner.state.config)};
  const result=await retryApprovedCleanupAndResume(f.runner,{approval:f.approval,checkCompatibility:f.compatibility});
  assert.equal(result.phase,'running');assert.equal(result.sent,1);assert.equal(result.cleaned,1);assert.deepEqual(f.sent,['a']);assert.deepEqual(f.deleted,['a']);
  assert.deepEqual(f.runner.state.records.slice(1),pending);assert.equal(f.runner.state.records[0].status,'sent');
  assert.deepEqual({runId:f.runner.state.runId,start:f.runner.state.startedAt,deadline:f.runner.deadlineMono,due:f.runner.nextDueMono,config:f.runner.state.config},original);
  assert.deepEqual([...f.adapter.approvedPermanentDraftIds],f.approval.approvedPermanentDraftIds);
  assert.deepEqual(f.writes.find(state=>state.events.at(-1)?.type==='permanent_draft_delete_approved').permanentDraftDeleteApproval,f.approval);
  assert.equal(f.writes.find(state=>state.events.at(-1)?.type==='cleanup_intent').records[0].status,'sent');
  assert.equal(f.runner.busy,false);f.runner.stop();
});

test('retry completion can reach the original target without sending another item',async()=>{
  const f=await approvedCleanupFixture({target:1});
  const result=await retryApprovedCleanupAndResume(f.runner,{approval:f.approval});
  assert.equal(result.phase,'target_reached');assert.equal(result.sent,1);assert.equal(result.cleaned,1);assert.deepEqual(f.sent,['a']);assert.equal(f.timers.size,0);
});

test('a fixed original cutoff and next due are preserved during an authorized cleanup retry',async()=>{
  const f=await approvedCleanupFixture({durationMs:1000});f.advance(100);
  const deadline=f.runner.deadlineMono,due=f.runner.nextDueMono,deadlineAt=f.runner.state.deadlineAt;
  await retryApprovedCleanupAndResume(f.runner,{approval:f.approval,checkCompatibility:f.compatibility});
  assert.equal(f.runner.deadlineMono,deadline);assert.equal(f.runner.nextDueMono,due);assert.equal(f.runner.state.deadlineAt,deadlineAt);f.runner.stop();
});

test('missing, wrong-run, wrong-account, outside-selection and incomplete approvals stop before cleanup',async()=>{
  for(const alter of [a=>null,a=>({...a,runId:'another-run'}),a=>({...a,accountId:'other@example.test'}),
    a=>({...a,selectedDraftIds:['a','b']}),a=>({...a,selectedDraftIds:['a','b','outside']}),
    a=>({...a,approvedPermanentDraftIds:['outside']}),a=>({...a,approvedPermanentDraftIds:['b']}),
    a=>({...a,reviewer:''}),a=>({...a,statement:''}),a=>({...a,approvedAt:''}),a=>({...a,expiresAt:''}),
    a=>({...a,selectedDraftIds:['a','a','c']}),a=>({...a,approvedPermanentDraftIds:['a','a']})]){
    const f=await approvedCleanupFixture();const cleanups=f.runner.state.events.filter(e=>e.type==='cleanup_intent').length;
    await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:alter(f.approval)}));
    assert.deepEqual(f.sent,['a']);assert.deepEqual(f.deleted,[]);assert.equal(f.adapter.approvedPermanentDraftIds.size,0);
    assert.equal(f.runner.state.events.filter(e=>e.type==='cleanup_intent').length,cleanups);assert.equal(f.runner.busy,false);
  }
});

test('expired, future, impossible and pre-run approval timestamps are never inferred as current consent',async()=>{
  for(const update of [f=>{f.advance(60000);},f=>{f.approval.approvedAt=new Date(f.runner.clock.wall()+1).toISOString();},
    f=>{f.approval.approvedAt='2026-02-31T00:00:00Z';},f=>{f.approval.approvedAt='2026-11-17T00:00:00Z';}]){
    const f=await approvedCleanupFixture();update(f);
    await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval}));
    assert.deepEqual(f.deleted,[]);assert.equal(f.adapter.approvedPermanentDraftIds.size,0);
  }
});

test('unknown sends, changed receipt, prior cleanup intent and other cleanup holds prohibit retry',async()=>{
  for(const alter of [r=>{r.state.records[1].status='unknown';},r=>{r.state.records[0].receipt.draftVersion='changed';},
    r=>{r.state.events.push({type:'cleanup_intent',draftId:'a'});},r=>{r.state.records[1].cleanup='unknown';},
    r=>{r.state.records[0].cleanup='unknown';},r=>{r.state.records[0].cleanupError='some other failure';},r=>{r.state.records[1].status='held';}]){
    const f=await approvedCleanupFixture();alter(f.runner);
    await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval}));assert.deepEqual(f.deleted,[]);assert.deepEqual(f.sent,['a']);
  }
});

test('busy runner and mismatched compatibility stop before recording or applying approval',async()=>{
  const busy=await approvedCleanupFixture();busy.runner.busy=true;
  await assert.rejects(()=>retryApprovedCleanupAndResume(busy.runner,{approval:busy.approval}),/IDLE_RUNNER/);assert.deepEqual(busy.deleted,[]);
  const f=await approvedCleanupFixture();let locked=false;
  await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval,checkCompatibility:async()=>{
    locked=f.runner.busy;return {ok:true,accountId:'other@example.test'};
  }}),/COMPATIBILITY_NOT_CONFIRMED/);
  assert.equal(locked,true);assert.equal(f.runner.busy,false);assert.equal(f.adapter.approvedPermanentDraftIds.size,0);
});

test('async compatibility cannot change the window, selected record or remaining queue',async()=>{
  for(const alter of [r=>{r.nextDueMono++;},r=>{r.state.records[1].ref.draftId='changed';},r=>{r.state.records[0].item.body='changed';}]){
    const f=await approvedCleanupFixture();
    await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval,checkCompatibility:async()=>{alter(f.runner);return {ok:true,accountId:f.approval.accountId};}}),/ORIGINAL_STATE_CHANGED/);
    assert.deepEqual(f.deleted,[]);assert.equal(f.adapter.approvedPermanentDraftIds.size,0);assert.equal(f.runner.busy,false);
  }
});

test('an expired original window is never extended to perform cleanup',async()=>{
  const f=await approvedCleanupFixture({durationMs:1000});f.advance(1000);
  await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval}),/WINDOW_EXPIRED/);
  assert.equal(f.runner.deadlineMono,1000);assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.state.records[0].cleanup,'pending');assert.deepEqual(f.deleted,[]);
});

test('cutoff and approval expiry are both rechecked immediately before cleanup authorization',async()=>{
  for(const change of ['deadline','approval']){
    const f=await approvedCleanupFixture({durationMs:change==='deadline'?1000:null});
    f.adapter.cleanup=async(value,receipt,{beforeClick})=>{f.advance(change==='deadline'?1000:60000);await beforeClick();f.deleted.push(value.draftId);return {...f.bind(value),status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,removalMethod:'permanent_draft_delete'};};
    await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval}));
    assert.deepEqual(f.deleted,[]);assert.deepEqual(f.sent,['a']);assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.state.records[0].cleanup,'pending');assert.equal(f.runner.busy,false);
  }
});

test('durable cleanup intent is followed by a final guard before any click',async()=>{
  const f=await approvedCleanupFixture({durationMs:1000});const save=f.runner.store.save;
  f.runner.store.save=state=>{save(state);if(state.events.at(-1)?.type==='cleanup_intent')f.advance(1000);};
  await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval}));
  assert.deepEqual(f.deleted,[]);assert.deepEqual(f.sent,['a']);assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.state.records[0].cleanup,'unknown');
  assert.equal(f.runner.state.deadlineReached,true);assert.equal(f.runner.busy,false);
});

test('a missing cleanup response after guarded intent stays sent with unknown cleanup and is never retried',async()=>{
  const f=await approvedCleanupFixture();f.adapter.cleanup=async(value,receipt,{beforeClick})=>{await beforeClick();f.deleted.push(value.draftId);throw Error('response lost');};
  await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval}),/response lost/);
  assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.state.records[0].cleanup,'unknown');assert.equal(f.runner.state.phase,'halted');
  await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval}),/NOT_PERMISSION_HELD/);
  assert.deepEqual(f.sent,['a']);assert.deepEqual(f.deleted,['a']);assert.equal(f.runner.busy,false);
});

test('provider-consumed absence needs no delete intent but destructive results cannot omit the hook',async()=>{
  const f=await approvedCleanupFixture();f.adapter.cleanup=async(value,receipt)=>({...f.bind(value),status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,removalMethod:'provider_consumed'});
  assert.equal((await retryApprovedCleanupAndResume(f.runner,{approval:f.approval})).cleaned,1);assert.deepEqual(f.deleted,[]);assert.deepEqual(f.sent,['a']);f.runner.stop();
  const missing=await approvedCleanupFixture();missing.adapter.cleanup=async(value,receipt)=>({...missing.bind(value),status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,removalMethod:'permanent_draft_delete'});
  await assert.rejects(()=>retryApprovedCleanupAndResume(missing.runner,{approval:missing.approval}),/AUTHORITATIVE_EVIDENCE_MISSING/);assert.deepEqual(missing.sent,['a']);
});

test('mismatched authoritative cleanup evidence never loses the original confirmed send',async()=>{
  const f=await approvedCleanupFixture();f.adapter.cleanup=async(value,receipt,{beforeClick})=>{await beforeClick();return {...f.bind(value),draftVersion:'wrong',status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,removalMethod:'permanent_draft_delete'};};
  await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval}),/AUTHORITATIVE_EVIDENCE_MISSING/);
  assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.state.records[0].cleanup,'unknown');assert.deepEqual(f.sent,['a']);
});

test('cleanup confirmation arriving after cutoff is counted without resuming or sending',async()=>{
  const f=await approvedCleanupFixture({durationMs:1000});f.adapter.cleanup=async(value,receipt,{beforeClick})=>{await beforeClick();f.deleted.push(value.draftId);f.advance(1000);return {...f.bind(value),status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,removalMethod:'permanent_draft_delete'};};
  const result=await retryApprovedCleanupAndResume(f.runner,{approval:f.approval});
  assert.equal(result.phase,'deadline');assert.equal(result.sent,1);assert.equal(result.cleaned,1);assert.deepEqual(f.sent,['a']);assert.equal(f.runner.deadlineMono,1000);
});

test('compatibility cannot replace the original runner state or its adapter even with identical data',async()=>{
  for(const replace of [r=>{r.state=structuredClone(r.state);},r=>{r.adapter={...r.adapter};}]){
    const f=await approvedCleanupFixture();
    await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval,checkCompatibility:async()=>{replace(f.runner);return {ok:true,accountId:f.approval.accountId};}}),/ORIGINAL_STATE_CHANGED/);
    assert.deepEqual(f.sent,['a']);assert.deepEqual(f.deleted,[]);assert.equal(f.runner.busy,false);
  }
});


test('approval wrapper leaves send untouched and preserves original adapter cleanup delegation',async()=>{
  const f=await approvedCleanupFixture();const original=f.runner.adapter,trace=[];
  f.runner.adapter=new Proxy(original,{get(target,property){
    const value=Reflect.get(target,property,target);
    if(property!=='cleanup')return value;
    return async (item,receipt,options)=>{
      trace.push('service-enter-'+item.draftId);
      return await value.call(target,item,receipt,{...options,beforeClick:async hook=>{
        trace.push('service-before-'+item.draftId);await options.beforeClick(hook);trace.push('service-final-'+item.draftId);
      }});
    };
  }});
  const send=f.runner.adapter.send;
  await retryApprovedCleanupAndResume(f.runner,{approval:f.approval});
  assert.equal(f.runner.adapter.send,send);f.advance(100);await f.runner.step();
  assert.deepEqual(f.sent,['a','b']);assert.deepEqual(f.deleted,['a','b']);
  assert.deepEqual(trace,['service-enter-a','service-before-a','service-final-a','service-enter-b','service-before-b','service-final-b']);
  f.runner.stop();
});

test('future ordinary cleanup refuses an expired approval even while the old Set still contains its ID',async()=>{
  const f=await approvedCleanupFixture();await retryApprovedCleanupAndResume(f.runner,{approval:f.approval});
  assert.equal(f.adapter.approvedPermanentDraftIds.has('b'),true);f.advance(60000);await f.runner.step();
  assert.deepEqual(f.deleted,['a']);assert.deepEqual(f.sent,['a','b']);assert.equal(f.runner.state.records[1].status,'sent');
  assert.equal(f.runner.state.records[1].cleanup,'pending');assert.match(f.runner.state.records[1].cleanupError,/APPROVAL_EXPIRED/);
  assert.equal(f.runner.state.phase,'halted');
});

test('future cleanup checks approval after the awaited upstream hook and before its delete call',async()=>{
  const f=await approvedCleanupFixture();await retryApprovedCleanupAndResume(f.runner,{approval:f.approval});
  const remaining=structuredClone(f.runner.state.records[2]);const save=f.runner.store.save;
  f.runner.store.save=state=>{save(state);if(state.events.at(-1)?.type==='cleanup_intent'&&state.events.at(-1)?.draftId==='b')queueMicrotask(()=>f.advance(60000));};
  f.advance(100);await f.runner.step();
  assert.deepEqual(f.deleted,['a']);assert.deepEqual(f.sent,['a','b']);assert.equal(f.runner.state.records[1].status,'sent');
  assert.equal(f.runner.state.records[1].cleanup,'unknown');assert.match(f.runner.state.records[1].cleanupError,/APPROVAL_EXPIRED/);
  assert.deepEqual(f.runner.state.records[2],remaining);assert.equal(f.runner.state.phase,'halted');assert.equal(f.runner.deadlineMono,null);
});

test('future cleanup cannot expand the approval snapshot, account or selected ID scope after its hook',async()=>{
  for(const alter of [r=>{r.state.permanentDraftDeleteApproval.expiresAt='2027-11-18T00:00:00Z';},
    r=>{r.state.permanentDraftDeleteApproval.accountId='other@example.test';},
    r=>{r.state.permanentDraftDeleteApproval.approvedPermanentDraftIds.push('outside');}]){
    const f=await approvedCleanupFixture();await retryApprovedCleanupAndResume(f.runner,{approval:f.approval});
    const save=f.runner.store.save;f.runner.store.save=state=>{save(state);if(state.events.at(-1)?.type==='cleanup_intent'&&state.events.at(-1)?.draftId==='b')queueMicrotask(()=>alter(f.runner));};
    f.advance(100);await f.runner.step();assert.deepEqual(f.deleted,['a']);assert.equal(f.runner.state.records[1].status,'sent');
    assert.equal(f.runner.state.records[1].cleanup,'unknown');assert.match(f.runner.state.records[1].cleanupError,/APPROVAL_RUN_CHANGED/);
  }
});

test('setup persistence and timer failures close the run before any remaining send can occur',async()=>{
  for(const failing of ['approval-write','started-write','clear-timers','arm-deadline','arm-reminder','all-writes']){
    const f=await approvedCleanupFixture({durationMs:1000});const pending=structuredClone(f.runner.state.records.slice(1));
    const before={runId:f.runner.state.runId,deadline:f.runner.deadlineMono,deadlineAt:f.runner.state.deadlineAt,due:f.runner.nextDueMono};
    const persist=f.runner.persist.bind(f.runner);
    if(['approval-write','started-write','all-writes'].includes(failing))f.runner.persist=(type,detail)=>{
      if(failing==='all-writes'||type===(failing==='approval-write'?'permanent_draft_delete_approved':'approved_cleanup_retry_started'))throw Error('injected '+failing);
      return persist(type,detail);
    };
    if(failing==='clear-timers')f.runner.clearTimers=()=>{throw Error('injected clear timers');};
    if(failing==='arm-deadline')f.runner.armDeadline=()=>{throw Error('injected arm deadline');};
    if(failing==='arm-reminder')f.runner.resetContinuousRuntime=()=>{throw Error('injected arm reminder');};
    await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval}),/injected/);
    assert.equal(f.runner.state.phase,'halted');assert.equal(f.runner.abort.signal.aborted,true);assert.equal(f.runner.busy,false);
    assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.state.records[0].cleanup,'pending');
    assert.deepEqual(f.runner.state.records.slice(1),pending);assert.deepEqual(f.deleted,[]);await f.runner.step();assert.deepEqual(f.sent,['a']);
    assert.deepEqual({runId:f.runner.state.runId,deadline:f.runner.deadlineMono,deadlineAt:f.runner.state.deadlineAt,due:f.runner.nextDueMono},before);
  }
});

test('partial approval Set application rolls back when a protective wrapper was not installed',async()=>{
  const f=await approvedCleanupFixture();const set=f.adapter.approvedPermanentDraftIds;let added=0;
  const add=set.add;set.add=function(id){if(++added===2)throw Error('injected Set failure');return add.call(this,id);};
  await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval}),/injected Set failure/);
  assert.equal(set.size,0);assert.equal(f.runner.state.phase,'halted');assert.equal(f.runner.abort.signal.aborted,true);
  assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.state.records[0].cleanup,'pending');
  await f.runner.step();assert.deepEqual(f.sent,['a']);assert.deepEqual(f.deleted,[]);
});

test('a real journal save failure during setup also leaves the original sent record and queue closed',async()=>{
  const f=await approvedCleanupFixture();const pending=structuredClone(f.runner.state.records.slice(1)),save=f.runner.store.save;
  f.runner.store.save=state=>{if(state.events.at(-1)?.type==='approved_cleanup_retry_started')throw Error('disk full at retry setup');save(state);};
  await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval}),/disk full/);
  assert.equal(f.runner.state.phase,'halted');assert.equal(f.runner.state.stopReason,'journal_failure');assert.equal(f.runner.abort.signal.aborted,true);
  assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.state.records[0].cleanup,'pending');
  assert.deepEqual(f.runner.state.records.slice(1),pending);await f.runner.step();assert.deepEqual(f.sent,['a']);assert.deepEqual(f.deleted,[]);
});


test('current retry guard rejects approval expiry after awaited geometry immediately before dispatch',async()=>{
  const f=await approvedCleanupFixture();const originalGuard=f.runner.guard;
  f.adapter.cleanup=async(item,receipt,{beforeClick})=>{
    await beforeClick();await Promise.resolve();f.advance(60000);
    f.runner.guard();f.deleted.push(item.draftId);
    return {...f.bind(item),status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,removalMethod:'permanent_draft_delete'};
  };
  await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval}),/APPROVAL_EXPIRED/);
  assert.deepEqual(f.sent,['a']);assert.deepEqual(f.deleted,[]);assert.equal(f.runner.state.records[0].status,'sent');
  assert.equal(f.runner.state.records[0].cleanup,'unknown');assert.equal(f.runner.state.phase,'halted');
  assert.equal(f.runner.guard,originalGuard);assert.equal(Object.getOwnPropertyDescriptor(f.runner,'guard').configurable,false);
});

test('future cleanup retains approval TTL in the final dispatch guard after awaited geometry',async()=>{
  const f=await approvedCleanupFixture();await retryApprovedCleanupAndResume(f.runner,{approval:f.approval});const originalGuard=f.runner.guard;
  f.adapter.cleanup=async(item,receipt,{beforeClick})=>{
    await beforeClick();await Promise.resolve();f.advance(60000);
    f.runner.guard();f.deleted.push(item.draftId);
    return {...f.bind(item),status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,removalMethod:'permanent_draft_delete'};
  };
  f.advance(100);await f.runner.step();assert.deepEqual(f.deleted,['a']);assert.deepEqual(f.sent,['a','b']);
  assert.equal(f.runner.state.records[1].status,'sent');assert.equal(f.runner.state.records[1].cleanup,'unknown');
  assert.equal(f.runner.state.phase,'halted');assert.equal(f.runner.guard,originalGuard);
});

test('cleanup-only dispatcher restores the exact original guard function before later sends',async()=>{
  const f=await approvedCleanupFixture();const inherited=f.runner.guard;let originalCalls=0;
  function originalGuard(){originalCalls++;return inherited.call(this);}
  Object.defineProperty(f.runner,'guard',{value:originalGuard,writable:true,configurable:true,enumerable:true});
  const descriptor=Object.getOwnPropertyDescriptor(f.runner,'guard');
  await retryApprovedCleanupAndResume(f.runner,{approval:f.approval});
  assert.ok(originalCalls>0);assert.equal(f.runner.guard,originalGuard);assert.equal(Object.getOwnPropertyDescriptor(f.runner,'guard').configurable,false);
  const originalSend=f.adapter.send;f.adapter.send=async function(item,options){assert.equal(f.runner.guard,originalGuard);return await originalSend.call(this,item,options);};
  f.advance(100);await f.runner.step();assert.deepEqual(f.sent,['a','b']);assert.deepEqual(f.deleted,['a','b']);
  assert.equal(f.runner.guard,originalGuard);f.runner.stop();
});

test('an attempted guard replacement during geometry cannot replace the owned final cleanup check',async()=>{
  const f=await approvedCleanupFixture();const originalGuard=f.runner.guard,external=()=>{};let rejected=false;
  f.adapter.cleanup=async(item,receipt,{beforeClick})=>{
    await beforeClick();await Promise.resolve();
    try{f.runner.guard=external;}catch(error){rejected=/OWNERSHIP_LOST/.test(error.message);}
    f.runner.guard();f.deleted.push(item.draftId);
    return {...f.bind(item),status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,removalMethod:'permanent_draft_delete'};
  };
  await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval}),/OWNERSHIP_LOST/);
  assert.equal(rejected,true);assert.deepEqual(f.deleted,[]);assert.equal(f.runner.state.phase,'halted');assert.equal(f.runner.abort.signal.aborted,true);
  assert.equal(f.runner.guard,originalGuard);await f.runner.step();assert.deepEqual(f.sent,['a']);
});

test('geometry-time descriptor redefinition is blocked before the delete dispatch',async()=>{
  const f=await approvedCleanupFixture();const originalGuard=f.runner.guard,external=()=>{};
  f.adapter.cleanup=async(item,receipt,{beforeClick})=>{
    await beforeClick();await Promise.resolve();
    Object.defineProperty(f.runner,'guard',{value:external,configurable:true,writable:true,enumerable:true});
    f.runner.guard();f.deleted.push(item.draftId);
    return {...f.bind(item),status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,removalMethod:'permanent_draft_delete'};
  };
  await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval}),/redefine property/);
  assert.deepEqual(f.deleted,[]);assert.equal(f.runner.guard,originalGuard);assert.equal(f.runner.state.phase,'halted');
  assert.equal(f.runner.abort.signal.aborted,true);assert.equal(Object.getOwnPropertyDescriptor(f.runner,'guard').configurable,false);
  await f.runner.step();assert.deepEqual(f.sent,['a']);
});

test('a guard that cannot be temporarily owned fails closed before cleanup starts',async()=>{
  const f=await approvedCleanupFixture();const guard=f.runner.guard;
  Object.defineProperty(f.runner,'guard',{value:guard,configurable:false,writable:false});
  await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval}),/GUARD_NOT_WRAPPABLE/);
  assert.equal(f.runner.guard,guard);assert.equal(f.runner.state.phase,'halted');assert.equal(f.runner.abort.signal.aborted,true);
  assert.deepEqual(f.deleted,[]);assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.state.records[0].cleanup,'pending');
});


test('a caught descriptor redefinition attempt still cannot bypass expired approval at geometry dispatch',async()=>{
  const f=await approvedCleanupFixture();const original=f.runner.guard;let rejected=false;
  f.adapter.cleanup=async(item,receipt,{beforeClick})=>{
    await beforeClick();await Promise.resolve();f.advance(60000);
    try{Object.defineProperty(f.runner,'guard',{value:()=>{},configurable:true,writable:true});}catch{rejected=true;}
    f.runner.guard();f.deleted.push(item.draftId);
    return {...f.bind(item),status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,removalMethod:'permanent_draft_delete'};
  };
  await assert.rejects(()=>retryApprovedCleanupAndResume(f.runner,{approval:f.approval}),/APPROVAL_EXPIRED/);
  assert.equal(rejected,true);assert.deepEqual(f.deleted,[]);assert.equal(f.runner.guard,original);
  assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.state.records[0].cleanup,'unknown');
});

test('the fixed dispatcher is isolated to this run and leaves the class prototype and other runs unchanged',async()=>{
  const f=await approvedCleanupFixture();const prototype=Object.getPrototypeOf(f.runner),original=Object.getOwnPropertyDescriptor(prototype,'guard');
  const other=await approvedCleanupFixture();assert.equal(Object.hasOwn(other.runner,'guard'),false);
  await retryApprovedCleanupAndResume(f.runner,{approval:f.approval});
  assert.equal(Object.getOwnPropertyDescriptor(f.runner,'guard').configurable,false);
  assert.equal(Object.hasOwn(other.runner,'guard'),false);assert.deepEqual(Object.getOwnPropertyDescriptor(prototype,'guard'),original);
  assert.equal(f.runner.guard,original.value);assert.equal(other.runner.guard,original.value);
  const event=f.runner.state.events.find(entry=>entry.type==='cleanup_guard_dispatcher_installed');
  assert.equal(event.scope,'this_run_only');assert.equal(event.idleGuard,'original_function');f.runner.stop();
});


async function previouslyApprovedUiHoldFixture(options={}) {
  const f=await approvedCleanupFixture(options);
  await retryApprovedCleanupAndResume(f.runner,{approval:f.approval});
  const cleanup=f.adapter.cleanup;let fail=true;
  f.adapter.cleanup=async function(item,receipt,settings){
    if(item.draftId==='b'&&fail)throw Error('UI_NOT_READY:draft folder filter');
    return await cleanup.call(this,item,receipt,settings);
  };
  f.advance(100);await f.runner.step();
  assert.equal(f.runner.state.records[1].status,'sent');assert.equal(f.runner.state.records[1].cleanup,'pending');
  assert.equal(f.runner.state.records[1].cleanupError,'UI_NOT_READY:draft folder filter');
  assert.equal(f.runner.state.events.some(event=>event.type==='cleanup_intent'&&event.draftId==='b'),false);
  f.context={runId:f.runner.state.runId,accountId:f.approval.accountId,selectedDraftIds:[...f.approval.selectedDraftIds]};
  f.restoreCleanup=()=>{fail=false;};
  return f;
}

test('previously approved pre-dispatch cleanup retries only the sent original using the existing proxy and dispatcher',async()=>{
  const f=await previouslyApprovedUiHoldFixture();f.restoreCleanup();
  const adapter=f.runner.adapter,descriptor=Object.getOwnPropertyDescriptor(f.runner,'guard'),guard=f.runner.guard;
  const otherRecords=structuredClone([f.runner.state.records[0],f.runner.state.records[2]]);
  const timing={runId:f.runner.state.runId,startedAt:f.runner.state.startedAt,deadline:f.runner.deadlineMono,due:f.runner.nextDueMono};
  const result=await retryPreviouslyApprovedUnattemptedCleanupAndResume(f.runner,{...f.context,checkCompatibility:f.compatibility});
  assert.equal(result.phase,'running');assert.equal(result.sent,2);assert.equal(result.cleaned,2);assert.deepEqual(f.sent,['a','b']);assert.deepEqual(f.deleted,['a','b']);
  assert.equal(f.runner.adapter,adapter);assert.equal(f.runner.guard,guard);assert.deepEqual(Object.getOwnPropertyDescriptor(f.runner,'guard'),descriptor);
  assert.deepEqual([f.runner.state.records[0],f.runner.state.records[2]],otherRecords);
  assert.deepEqual({runId:f.runner.state.runId,startedAt:f.runner.state.startedAt,deadline:f.runner.deadlineMono,due:f.runner.nextDueMono},timing);
  assert.equal(f.runner.state.events.filter(event=>event.type==='permanent_draft_delete_approved').length,1);
  assert.equal(f.runner.state.events.filter(event=>event.type==='cleanup_guard_dispatcher_installed').length,1);
  assert.equal(f.runner.busy,false);f.runner.stop();
});

test('previous approval retry refuses absent protection, wrong run scope, expiry and non-UI errors before cleanup',async()=>{
  for(const change of [f=>{f.context.runId='wrong';},f=>{f.context.accountId='other@example.test';},f=>{f.context.selectedDraftIds=['a','b'];},
    f=>{delete f.runner.state.permanentDraftDeleteApproval;},f=>{f.runner.state.events=f.runner.state.events.filter(event=>event.type!=='cleanup_guard_dispatcher_installed');},
    f=>{f.adapter.approvedPermanentDraftIds.delete('b');},f=>{f.advance(60000);},f=>{f.runner.state.records[1].cleanupError='OTHER_UI_ERROR';},
    f=>{f.runner.state.records[1].cleanup='unknown';},f=>{f.runner.state.records[2].status='unknown';},f=>{f.runner.state.events.push({type:'cleanup_intent',draftId:'b'});}]){
    const f=await previouslyApprovedUiHoldFixture();f.restoreCleanup();change(f);
    await assert.rejects(()=>retryPreviouslyApprovedUnattemptedCleanupAndResume(f.runner,f.context));
    assert.deepEqual(f.sent,['a','b']);assert.deepEqual(f.deleted,['a']);assert.equal(f.runner.busy,false);
  }
});

test('previous approval retry preserves a fixed deadline and rejects a cutoff reached during compatibility',async()=>{
  const f=await previouslyApprovedUiHoldFixture({durationMs:1000});f.restoreCleanup();const deadline=f.runner.deadlineMono,due=f.runner.nextDueMono;
  await retryPreviouslyApprovedUnattemptedCleanupAndResume(f.runner,f.context);assert.equal(f.runner.deadlineMono,deadline);assert.equal(f.runner.nextDueMono,due);f.runner.stop();
  const expired=await previouslyApprovedUiHoldFixture({durationMs:1000});expired.restoreCleanup();
  await assert.rejects(()=>retryPreviouslyApprovedUnattemptedCleanupAndResume(expired.runner,{...expired.context,checkCompatibility:async()=>{expired.advance(1000);return {ok:true,accountId:expired.context.accountId};}}),/WINDOW_EXPIRED/);
  assert.deepEqual(expired.deleted,['a']);assert.equal(expired.runner.state.records[1].status,'sent');assert.equal(expired.runner.state.records[1].cleanup,'pending');
});

test('previous approval retry checks the same original receipt and state after asynchronous compatibility',async()=>{
  for(const change of [f=>{f.runner.state.records[1].receipt.messageId='other';},f=>{f.runner.nextDueMono++;},f=>{f.runner.state.records[2].ref.draftId='other';}]){
    const f=await previouslyApprovedUiHoldFixture();f.restoreCleanup();
    await assert.rejects(()=>retryPreviouslyApprovedUnattemptedCleanupAndResume(f.runner,{...f.context,checkCompatibility:async()=>{change(f);return {ok:true,accountId:f.context.accountId};}}),/ORIGINAL_STATE_CHANGED/);
    assert.deepEqual(f.deleted,['a']);assert.deepEqual(f.sent,['a','b']);assert.equal(f.runner.busy,false);
  }
});

test('previous approval retry uses the existing final geometry TTL guard and never sends again',async()=>{
  const f=await previouslyApprovedUiHoldFixture();const adapter=f.runner.adapter,descriptor=Object.getOwnPropertyDescriptor(f.runner,'guard');
  f.adapter.cleanup=async(item,receipt,{beforeClick})=>{await beforeClick();await Promise.resolve();f.advance(60000);f.runner.guard();f.deleted.push(item.draftId);
    return {...f.bind(item),status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,removalMethod:'permanent_draft_delete'};};
  await assert.rejects(()=>retryPreviouslyApprovedUnattemptedCleanupAndResume(f.runner,f.context),/APPROVAL_EXPIRED/);
  assert.deepEqual(f.sent,['a','b']);assert.deepEqual(f.deleted,['a']);assert.equal(f.runner.state.records[1].status,'sent');assert.equal(f.runner.state.records[1].cleanup,'unknown');
  assert.equal(f.runner.state.phase,'halted');assert.equal(f.runner.adapter,adapter);assert.deepEqual(Object.getOwnPropertyDescriptor(f.runner,'guard'),descriptor);
});

test('previous approval retry fails closed on setup writes and timer errors without advancing the remaining queue',async()=>{
  for(const failure of ['started-write','timer']){
    const f=await previouslyApprovedUiHoldFixture();f.restoreCleanup();const others=structuredClone([f.runner.state.records[0],f.runner.state.records[2]]);
    if(failure==='timer')f.runner.armDeadline=()=>{throw Error('injected retry timer');};
    else{const persist=f.runner.persist.bind(f.runner);f.runner.persist=(type,detail)=>{if(type==='previously_approved_cleanup_retry_started')throw Error('injected retry write');return persist(type,detail);};}
    await assert.rejects(()=>retryPreviouslyApprovedUnattemptedCleanupAndResume(f.runner,f.context),/injected/);
    assert.equal(f.runner.state.phase,'halted');assert.equal(f.runner.abort.signal.aborted,true);assert.equal(f.runner.busy,false);
    assert.equal(f.runner.state.records[1].status,'sent');assert.equal(f.runner.state.records[1].cleanup,'pending');
    assert.deepEqual([f.runner.state.records[0],f.runner.state.records[2]],others);await f.runner.step();assert.deepEqual(f.sent,['a','b']);assert.deepEqual(f.deleted,['a']);
  }
});

test('previous approval retry preserves sent and unknown cleanup after dispatched cleanup loses its response',async()=>{
  const f=await previouslyApprovedUiHoldFixture();f.adapter.cleanup=async(item,receipt,{beforeClick})=>{await beforeClick();f.deleted.push(item.draftId);throw Error('cleanup response lost');};
  await assert.rejects(()=>retryPreviouslyApprovedUnattemptedCleanupAndResume(f.runner,f.context),/response lost/);
  assert.equal(f.runner.state.records[1].status,'sent');assert.equal(f.runner.state.records[1].cleanup,'unknown');assert.equal(f.runner.state.phase,'halted');
  await assert.rejects(()=>retryPreviouslyApprovedUnattemptedCleanupAndResume(f.runner,f.context));assert.deepEqual(f.sent,['a','b']);assert.deepEqual(f.deleted,['a','b']);
});

test('previous approval retry can finish the original target with exact provider-consumed absence evidence',async()=>{
  const f=await previouslyApprovedUiHoldFixture({target:2});f.adapter.cleanup=async(item,receipt)=>({...f.bind(item),status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,removalMethod:'provider_consumed'});
  const result=await retryPreviouslyApprovedUnattemptedCleanupAndResume(f.runner,f.context);
  assert.equal(result.phase,'target_reached');assert.equal(result.sent,2);assert.equal(result.cleaned,2);assert.deepEqual(f.sent,['a','b']);assert.deepEqual(f.deleted,['a']);
});


async function unknownSentFixture({durationMs=null,target=2}={}){
  let now=0;const calls={send:0,cleanup:0},writes=[];
  const accountId='sender@example.test',item=id=>({accountId,draftId:id,draftVersion:'v-'+id,approvedHash:'hash-'+id,
    recipient:id+'@example.test',subject:'Subject '+id,body:'Body '+id});
  const bind=value=>Object.fromEntries(['accountId','draftId','draftVersion','approvedHash'].map(key=>[key,value[key]]));
  const adapter={async scanDrafts(){return ['a','b'].slice(0,target).map(id=>({accountId,draftId:id}));},async countDrafts(){return {value:target,exact:true,source:'fixture'};},
    async inspectDraft(ref){return item(ref.draftId);},async preflight(){return {ok:true};},
    async send(value,{beforeClick}){await beforeClick();calls.send++;throw Error('accepted but metadata response unavailable');},
    async reconcile(){return {status:'unknown'};},async cleanup(){calls.cleanup++;throw Error('read-only recovery must not call cleanup');}};
  const runner=new MailSessionRunner({adapter,durationMs,target,intervalMs:100,store:{save(state){writes.push(structuredClone(state));}},
    clock:{monotonic:()=>now,wall:()=>Date.UTC(2026,10,18)+now},timers:{setTimeout(){return 1;},clearTimeout(){}}});
  await runner.initialize();runner.start();await runner.step();
  assert.equal(runner.state.phase,'halted');assert.equal(runner.state.stopReason,'send_unknown');assert.equal(runner.state.records[0].status,'unknown');
  const receipt={...bind(item('a')),recipient:item('a').recipient,status:'sent',authoritative:true,messageId:'new-sent-a'};
  const absence={...bind(item('a')),status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,removalMethod:'provider_consumed',scope:'all_drafts_stable_id',complete:true,absent:true};
  return {runner,adapter,calls,writes,receipt,absence,advance:ms=>{now+=ms;},
    checks:{reconcileSend:async()=>structuredClone(receipt),reconcileCleanup:async()=>structuredClone(absence)}};
}

test('read-only unknown send recovery commits exact send first, confirms complete absence, then resumes without dispatch',async()=>{
  const f=await unknownSentFixture();const other=structuredClone(f.runner.state.records[1]);
  const original={id:f.runner.state.runId,startedAt:f.runner.state.startedAt,deadline:f.runner.deadlineMono,due:f.runner.nextDueMono,adapter:f.runner.adapter};
  const result=await reconcileSentAndCleanupAndResume(f.runner,{reconcileSend:async input=>{assert.equal(input.draftId,'a');assert.equal(f.runner.busy,true);return f.receipt;},
    reconcileCleanup:async input=>{assert.equal(f.writes.at(-1).events.at(-1).type,'sent_confirmed');assert.equal(f.writes.at(-1).records[0].status,'sent');
      assert.equal(f.writes.at(-1).records[0].cleanup,'pending');assert.equal(input.receipt.messageId,f.receipt.messageId);return f.absence;}});
  assert.equal(result.phase,'running');assert.equal(result.sent,1);assert.equal(result.cleaned,1);assert.equal(result.unknown,0);
  assert.equal(f.calls.send,1);assert.equal(f.calls.cleanup,0);assert.equal(f.runner.state.events.some(event=>event.type==='cleanup_intent'),false);
  assert.deepEqual(f.runner.state.records[1],other);assert.deepEqual({id:f.runner.state.runId,startedAt:f.runner.state.startedAt,deadline:f.runner.deadlineMono,due:f.runner.nextDueMono,adapter:f.runner.adapter},original);
  assert.equal(f.runner.busy,false);f.runner.stop();
});

test('absence read failure never erases a newly confirmed and durably recorded send',async()=>{
  const f=await unknownSentFixture();await assert.rejects(()=>reconcileSentAndCleanupAndResume(f.runner,{...f.checks,reconcileCleanup:async()=>{throw Error('UI_NOT_READY:empty draft view');}}),/empty draft view/);
  assert.equal(f.runner.state.records[0].status,'sent');assert.deepEqual(f.runner.state.records[0].receipt,f.receipt);assert.equal(f.runner.state.records[0].cleanup,'pending');
  assert.equal(f.runner.state.phase,'halted');assert.equal(f.runner.state.stopReason,'cleanup_unknown');assert.equal(f.calls.send,1);assert.equal(f.calls.cleanup,0);
  assert.ok(f.writes.some(state=>state.events.at(-1)?.type==='sent_confirmed'&&state.records[0].status==='sent'&&state.records[0].cleanup==='pending'));
});

test('old counts, mismatched receipts and reused message IDs cannot confirm the unknown send',async()=>{
  for(const receipt of [f=>({sent:1,cleaned:1}),f=>({...f.receipt,draftId:'other'}),f=>({...f.receipt,approvedHash:'other'}),
    f=>({...f.receipt,recipient:'other@example.test'}),f=>({...f.receipt,authoritative:false}),f=>{f.runner.state.records[1].receipt={messageId:'old-sent'};return {...f.receipt,messageId:'old-sent'};}]){
    const f=await unknownSentFixture();const proof=receipt(f);let cleanups=0;
    await assert.rejects(()=>reconcileSentAndCleanupAndResume(f.runner,{reconcileSend:async()=>proof,reconcileCleanup:async()=>{cleanups++;return f.absence;}}),/EXACT_NEW_RECEIPT_NOT_CONFIRMED/);
    assert.equal(f.runner.state.records[0].status,'unknown');assert.equal(f.runner.state.records[0].cleanup,'not_eligible');assert.equal(cleanups,0);assert.equal(f.calls.send,1);
  }
});

test('absence proof requires the same stable original ID and complete provider-consumed evidence',async()=>{
  for(const change of [proof=>({...proof,scope:'recipient_search'}),proof=>({...proof,complete:false}),proof=>({...proof,absent:false}),
    proof=>({...proof,draftId:'another'}),proof=>({...proof,sentMessageId:'old-sent'}),proof=>({...proof,removalMethod:'permanent_draft_delete'}),proof=>({value:0,exact:true})]){
    const f=await unknownSentFixture();await assert.rejects(()=>reconcileSentAndCleanupAndResume(f.runner,{...f.checks,reconcileCleanup:async()=>change(f.absence)}),/COMPLETE_ORIGINAL_ABSENCE_NOT_CONFIRMED/);
    assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.state.records[0].cleanup,'pending');assert.equal(f.runner.state.phase,'halted');assert.equal(f.calls.cleanup,0);
  }
});

test('already-sent pending absence can be reverified without another sent count or a changed message ID',async()=>{
  const f=await unknownSentFixture({target:1});await assert.rejects(()=>reconcileSentAndCleanupAndResume(f.runner,{...f.checks,reconcileCleanup:async()=>{throw Error('empty view metadata not ready');}}));
  const result=await reconcileSentAndCleanupAndResume(f.runner,f.checks);
  assert.equal(result.phase,'target_reached');assert.equal(result.sent,1);assert.equal(result.cleaned,1);assert.equal(f.calls.send,1);
  assert.equal(f.runner.state.events.filter(event=>event.type==='sent_confirmed').length,1);assert.equal(f.runner.state.events.filter(event=>event.type==='sent_receipt_reverified').length,1);
  const other=await unknownSentFixture();await assert.rejects(()=>reconcileSentAndCleanupAndResume(other.runner,{...other.checks,reconcileCleanup:async()=>{throw Error('not ready');}}));
  await assert.rejects(()=>reconcileSentAndCleanupAndResume(other.runner,{...other.checks,reconcileSend:async()=>({...other.receipt,messageId:'different-new-sent'})}),/EXACT_NEW_RECEIPT_NOT_CONFIRMED/);
  assert.equal(other.runner.state.records[0].status,'sent');assert.equal(other.runner.state.records[0].receipt.messageId,other.receipt.messageId);assert.equal(other.calls.send,1);
});

test('readonly reconciliation after cutoff records actual facts without extending or resuming the run',async()=>{
  const f=await unknownSentFixture({durationMs:1000});const deadline=f.runner.deadlineMono,due=f.runner.nextDueMono,deadlineAt=f.runner.state.deadlineAt;f.advance(1001);
  const result=await reconcileSentAndCleanupAndResume(f.runner,f.checks);
  assert.equal(result.phase,'deadline');assert.equal(result.sent,1);assert.equal(result.cleaned,1);assert.equal(result.pending,1);
  assert.equal(f.runner.deadlineMono,deadline);assert.equal(f.runner.nextDueMono,due);assert.equal(f.runner.state.deadlineAt,deadlineAt);assert.equal(f.calls.send,1);assert.equal(f.calls.cleanup,0);
  const during=await unknownSentFixture({durationMs:1000});const crossed=await reconcileSentAndCleanupAndResume(during.runner,{...during.checks,reconcileCleanup:async()=>{during.advance(1000);return during.absence;}});
  assert.equal(crossed.phase,'deadline');assert.equal(crossed.sent,1);assert.equal(crossed.cleaned,1);assert.equal(during.runner.deadlineMono,1000);
});

test('missing send intent, prior cleanup dispatch and multiple uncertainties reject before read callbacks',async()=>{
  for(const change of [r=>{r.state.events=r.state.events.filter(event=>event.type!=='send_intent');},r=>{delete r.state.records[0].clickAuthorizedAt;},
    r=>{r.state.events.push({type:'cleanup_intent',draftId:'a'});},r=>{r.state.records[1].status='unknown';},r=>{r.state.records[1].cleanup='pending';}]){
    const f=await unknownSentFixture();change(f.runner);let reads=0;
    await assert.rejects(()=>reconcileSentAndCleanupAndResume(f.runner,{reconcileSend:async()=>{reads++;return f.receipt;},reconcileCleanup:f.checks.reconcileCleanup}));
    assert.equal(reads,0);assert.equal(f.calls.send,1);assert.equal(f.calls.cleanup,0);
  }
});

test('readonly callbacks cannot replace the original window, bound record or other pending data',async()=>{
  for(const change of [r=>{r.nextDueMono++;},r=>{r.state.records[0].item.body='changed';},r=>{r.state.records[1].ref.draftId='changed';}]){
    const f=await unknownSentFixture();await assert.rejects(()=>reconcileSentAndCleanupAndResume(f.runner,{...f.checks,reconcileSend:async()=>{change(f.runner);return f.receipt;}}),/ORIGINAL_STATE_CHANGED/);
    assert.equal(f.runner.state.records[0].status,'unknown');assert.equal(f.calls.send,1);assert.equal(f.calls.cleanup,0);
  }
});

test('resume setup failure preserves both confirmed facts and keeps all pending sends closed',async()=>{
  const f=await unknownSentFixture();f.runner.armDeadline=()=>{throw Error('resume timer failed');};
  await assert.rejects(()=>reconcileSentAndCleanupAndResume(f.runner,f.checks),/resume timer failed/);
  assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.state.records[0].cleanup,'already_absent');assert.equal(f.runner.state.phase,'halted');
  await f.runner.step();assert.equal(f.calls.send,1);assert.equal(f.calls.cleanup,0);assert.equal(f.runner.busy,false);
});

test('cancellation after a confirmed readonly receipt preserves it and never starts the absence lookup',async()=>{
  const f=await unknownSentFixture();const controller=new AbortController();let reads=0;
  await assert.rejects(()=>reconcileSentAndCleanupAndResume(f.runner,{signal:controller.signal,reconcileSend:async()=>{controller.abort();return f.receipt;},reconcileCleanup:async()=>{reads++;return f.absence;}}),/ABORTED/);
  assert.equal(f.runner.state.records[0].status,'sent');assert.equal(f.runner.state.records[0].cleanup,'pending');assert.equal(reads,0);assert.equal(f.calls.send,1);
});
