import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MailSessionRunner, AtomicJsonJournal} from './session-runner.mjs';

const clone = value => structuredClone(value);
const binding = item => Object.fromEntries(['accountId', 'draftId', 'draftVersion', 'approvedHash'].map(key => [key, item[key]]));
const itemFor = draftId => ({accountId:'test@example.test', draftId, draftVersion:`v-${draftId}`,
  approvedHash:`hash-${draftId}`, recipient:`${draftId}@example.test`, subject:`Subject ${draftId}`, body:`Body ${draftId}`});
const sentFor = item => ({status:'sent', authoritative:true, messageId:`sent-${item.draftId}`, recipient:item.recipient, ...binding(item)});
const cleanupFor = (item, receipt) => ({status:'trashed', authoritative:true, sentMessageId:receipt.messageId, ...binding(item)});

function fixture({refs=['a','b','c'], durationMs=1000, intervalMs=100, target=3, prepareAheadMs=0, retainSentDrafts=false, overrides={}, storeOverride,useDefaultSleep=false,onRuntimeReminder=null}={}) {
  let now = 0;
  let timerId = 0;
  const callbacks = new Map();
  const clock = {monotonic:()=>now, wall:()=>Date.UTC(2026,10,17)+now};
  const timers = {
    setTimeout(fn,ms){const id=++timerId; callbacks.set(id,{fn,due:now+ms}); return id;},
    clearTimeout(id){callbacks.delete(id);},
  };
  function advance(ms) {
    now += ms;
    for(const [id,cb] of [...callbacks]) if(cb.due<=now){callbacks.delete(id);cb.fn();}
  }
  const writes = [];
  const clicks = [];
  const cleanupClicks = [];
  const sleeps = [];
  const store = storeOverride ?? {save(state){writes.push(clone(state));}};
  const adapter = {
    async scanDrafts(){return refs.map(id=>({draftId:id, accountId:'test@example.test'}));},
    async countDrafts(){return {count:10-cleanupClicks.length,exact:false,source:'visible_badge'};},
    async inspectDraft(ref){return itemFor(ref.draftId);},
    async preflight(){return {ok:true};},
    async send(item,{beforeClick}){await beforeClick();clicks.push({id:item.draftId,at:now});return sentFor(item);},
    async reconcile(){return {status:'unknown'};},
    async cleanup(item,receipt,{beforeClick}){await beforeClick();cleanupClicks.push(item.draftId);return cleanupFor(item,receipt);},
    ...overrides,
  };
  const sleep = async(ms)=>{sleeps.push(ms);advance(ms);};
  const runner = new MailSessionRunner({adapter,clock,timers,store,durationMs,intervalMs,target,prepareAheadMs,retainSentDrafts,sleep:useDefaultSleep?undefined:sleep,onRuntimeReminder});
  return {runner,adapter,clock,advance,writes,clicks,cleanupClicks,callbacks,sleeps};
}

test('initialization is read-only and excludes exact duplicate draft IDs',async()=>{
  const f=fixture({refs:['a','a','b','c']});
  const status=await f.runner.initialize({excludeDraftIds:['c']});
  assert.equal(status.planned,2);
  assert.equal(f.runner.state.exclusions.length,2);
  assert.equal(f.clicks.length,0);
  assert.equal(f.cleanupClicks.length,0);
  assert.equal(status.initialMailboxCount.exact,false);
});

test('starting twice keeps the original deadline and one timer',async()=>{
  const f=fixture();await f.runner.initialize();
  const first=f.runner.start();f.advance(350);const second=f.runner.start();
  assert.equal(second.deadlineAt,first.deadlineAt);
  assert.equal(second.remainingMs,650);
  assert.equal(f.callbacks.size,1);
});

test('zero eligible drafts complete the queue without sending',async()=>{
  const f=fixture({refs:[]});await f.runner.initialize();
  assert.equal(f.runner.start().phase,'exhausted');
  assert.equal((await f.runner.step()).sent,0);
  assert.equal((await f.runner.finish()).planned,0);
  assert.equal(f.clicks.length,0);
});

test('deadline timer stops a session even with no further steps',async()=>{
  const f=fixture();await f.runner.initialize();f.runner.start();f.advance(1000);
  assert.equal(f.runner.state.phase,'deadline');
  assert.equal(f.runner.state.deadlineReached,true);
  assert.equal(f.clicks.length,0);
});

test('deadline during preflight prevents any send click',async()=>{
  const f=fixture();
  f.adapter.preflight=async()=>{f.advance(1000);return {ok:true};};
  await f.runner.initialize();f.runner.start();await f.runner.step();
  assert.equal(f.clicks.length,0);
  assert.equal(f.runner.status().phase,'deadline');
  assert.equal(f.runner.state.records[0].status,'not_attempted');
});

test('deadline inside adapter immediately before click is checked again',async()=>{
  const f=fixture();
  f.adapter.send=async(item,{beforeClick})=>{f.advance(1000);await beforeClick();f.clicks.push(item.draftId);return sentFor(item);};
  await f.runner.initialize();f.runner.start();await f.runner.step();
  assert.equal(f.clicks.length,0);
  assert.equal(f.runner.status().sent,0);
});

test('dispatch intent is durable before the first external click; receipt precedes cleanup',async()=>{
  const f=fixture({target:1});
  f.adapter.send=async(item,{beforeClick})=>{
    await beforeClick();
    assert.equal(f.writes.at(-1).events.at(-1).type,'send_intent');
    f.clicks.push(item.draftId);return sentFor(item);
  };
  f.adapter.cleanup=async(item,receipt,{beforeClick})=>{
    assert.equal(f.writes.at(-1).events.at(-1).type,'sent_confirmed');
    assert.equal(f.writes.at(-1).records[0].receipt.messageId,receipt.messageId);
    await beforeClick();
    assert.equal(f.writes.at(-1).events.at(-1).type,'cleanup_intent');
    f.cleanupClicks.push(item.draftId);return cleanupFor(item,receipt);
  };
  await f.runner.initialize();f.runner.start();await f.runner.step();
  assert.equal(f.runner.status().sent,1);assert.equal(f.runner.status().cleaned,1);
});

test('deadline reached while durable intent is written still prevents the click',async()=>{
  const f=fixture();const originalSave=f.runner.store.save;
  f.runner.store.save=state=>{originalSave(state);if(state.events.at(-1)?.type==='send_intent')f.advance(1000);};
  await f.runner.initialize();f.runner.start();await f.runner.step();
  assert.equal(f.clicks.length,0);assert.equal(f.runner.status().sent,0);
  assert.equal(f.runner.status().phase,'deadline');
});

test('unknown result after an authorized click halts and never retries',async()=>{
  const f=fixture();let reconcileCalls=0;
  f.adapter.send=async(item,{beforeClick})=>{await beforeClick();f.clicks.push(item.draftId);throw Error('connection lost');};
  f.adapter.reconcile=async()=>{reconcileCalls++;return {status:'unknown'};};
  await f.runner.initialize();f.runner.start();await f.runner.step();f.advance(100);await f.runner.step();f.runner.start();await f.runner.step();
  assert.equal(f.runner.status().phase,'halted');assert.equal(f.runner.status().unknown,1);
  assert.deepEqual(f.clicks,['a']);assert.equal(reconcileCalls,1);assert.equal(f.cleanupClicks.length,0);
});

test('an exact authoritative reconciliation can recover an uncertain response without resending',async()=>{
  const f=fixture({target:1});
  f.adapter.send=async(item,{beforeClick})=>{await beforeClick();f.clicks.push(item.draftId);throw Error('response lost');};
  f.adapter.reconcile=async item=>sentFor(item);
  await f.runner.initialize();f.runner.start();await f.runner.step();
  assert.deepEqual(f.clicks,['a']);assert.equal(f.runner.status().sent,1);assert.equal(f.runner.status().cleaned,1);
});

test('wrong original binding in a sent receipt never permits cleanup',async()=>{
  const f=fixture();
  f.adapter.send=async(item,{beforeClick})=>{await beforeClick();f.clicks.push(item.draftId);return {...sentFor(item),draftId:'different-original'};};
  await f.runner.initialize();f.runner.start();await f.runner.step();
  assert.equal(f.runner.status().unknown,1);assert.equal(f.cleanupClicks.length,0);
});

test('a send finishing after cutoff is recorded but its original draft stays intact',async()=>{
  const f=fixture();
  f.adapter.send=async(item,{beforeClick})=>{await beforeClick();f.clicks.push(item.draftId);f.advance(1000);return sentFor(item);};
  await f.runner.initialize();f.runner.start();await f.runner.step();
  assert.equal(f.runner.status().sent,1);assert.equal(f.runner.status().cleanupPending,1);
  assert.equal(f.runner.status().phase,'deadline');assert.equal(f.cleanupClicks.length,0);
});

test('cutoff at cleanup hook preserves sent count and skips deletion',async()=>{
  const f=fixture();
  f.adapter.cleanup=async(item,receipt,{beforeClick})=>{f.advance(1000);await beforeClick();f.cleanupClicks.push(item.draftId);return cleanupFor(item,receipt);};
  await f.runner.initialize();f.runner.start();await f.runner.step();
  assert.equal(f.runner.status().sent,1);assert.equal(f.runner.status().cleanupPending,1);
  assert.equal(f.cleanupClicks.length,0);
});

test('cleanup evidence for a different version halts without losing confirmed sent status',async()=>{
  const f=fixture();
  f.adapter.cleanup=async(item,receipt,{beforeClick})=>{await beforeClick();return {...cleanupFor(item,receipt),draftVersion:'wrong-version'};};
  await f.runner.initialize();f.runner.start();await f.runner.step();
  assert.equal(f.runner.status().sent,1);assert.equal(f.runner.status().cleaned,0);
  assert.equal(f.runner.status().stopReason,'cleanup_unknown');
});

test('provider-consumed originals count separately with authoritative absence',async()=>{
  const f=fixture({target:1});
  f.adapter.cleanup=async(item,receipt)=>({...cleanupFor(item,receipt),status:'already_absent'});
  await f.runner.initialize();f.runner.start();await f.runner.step();
  assert.equal(f.runner.status().cleaned,1);assert.equal(f.runner.status().alreadyAbsent,1);assert.equal(f.runner.status().trashed,0);
});

test('explicit retention continues confirmed sends at the fixed interval without inventing cleanup',async()=>{
  const f=fixture({refs:['a','b'],durationMs:null,target:2,intervalMs:72000,prepareAheadMs:60000,retainSentDrafts:true,
    overrides:{async cleanup(){throw Error('PERMANENT_DRAFT_DELETE_REQUIRES_CURRENT_APPROVAL');}}});
  await f.runner.initialize();f.runner.start();
  const first=await f.runner.step();
  assert.equal(first.phase,'running');assert.equal(first.sent,1);assert.equal(first.cleanupPending,1);
  f.advance(first.waitMs);const second=await f.runner.step();
  assert.equal(second.phase,'target_reached');assert.equal(second.sent,2);
  assert.equal(second.cleanupPending,2);assert.equal(second.cleaned,0);assert.equal(second.retainSentDrafts,true);
  assert.deepEqual(f.clicks.map(c=>c.at),[0,72000]);assert.deepEqual(f.cleanupClicks,[]);
  assert.equal(f.runner.state.events.filter(e=>e.type==='cleanup_intent').length,0);
  assert.equal(f.runner.state.events.filter(e=>e.type==='cleanup_retained').length,2);
  for(const record of f.runner.state.records){
    assert.equal(record.status,'sent');assert.equal(record.cleanup,'pending');
    assert.equal(record.cleanupReason,'retained_by_send_only_policy');
    assert.equal(record.cleanupError,'PERMANENT_DRAFT_DELETE_REQUIRES_CURRENT_APPROVAL');
    assert.equal(record.cleanupReceipt,undefined);
  }
  await f.runner.step();assert.equal(f.clicks.length,2);
  assert.equal((await f.runner.finish()).cleanupPending,2);
});

test('retention is opt-in and default permission-held cleanup still halts',async()=>{
  const f=fixture({durationMs:null,overrides:{async cleanup(){throw Error('PERMANENT_DRAFT_DELETE_REQUIRES_CURRENT_APPROVAL');}}});
  await f.runner.initialize();f.runner.start();await f.runner.step();
  assert.equal(f.runner.status().retainSentDrafts,false);
  assert.equal(f.runner.status().stopReason,'cleanup_unknown');assert.equal(f.runner.status().sent,1);
  assert.equal(f.runner.state.records[0].cleanupReason,undefined);
  f.advance(100);await f.runner.step();assert.equal(f.clicks.length,1);
});

test('retention does not continue unrelated or already-attempted cleanup failures',async()=>{
  for(const attempted of [false,true]){
    const f=fixture({durationMs:null,retainSentDrafts:true,overrides:{
      async cleanup(_item,_receipt,{beforeClick}){
        if(attempted)await beforeClick();
        throw Error(attempted?'PERMANENT_DRAFT_DELETE_REQUIRES_CURRENT_APPROVAL':'ORIGINAL_DRAFT_CHANGED');
      }
    }});
    await f.runner.initialize();f.runner.start();await f.runner.step();
    assert.equal(f.runner.status().stopReason,'cleanup_unknown');assert.equal(f.runner.status().sent,1);
    assert.equal(f.runner.state.records[0].cleanup,attempted?'unknown':'pending');
    assert.equal(f.runner.state.records[0].cleanupReason,undefined);
    assert.equal(f.runner.state.events.filter(e=>e.type==='cleanup_retained').length,0);
  }
});

test('retention never resolves or retries an unknown send',async()=>{
  let cleanupCalls=0;
  const f=fixture({durationMs:null,retainSentDrafts:true,overrides:{
    async send(item,{beforeClick}){await beforeClick();f.clicks.push(item.draftId);return {status:'unknown'};},
    async cleanup(){cleanupCalls++;throw Error('PERMANENT_DRAFT_DELETE_REQUIRES_CURRENT_APPROVAL');}
  }});
  await f.runner.initialize();f.runner.start();await f.runner.step();
  assert.equal(f.runner.status().stopReason,'send_unknown');assert.equal(f.runner.status().sent,0);
  assert.equal(f.runner.status().unknown,1);assert.equal(cleanupCalls,0);
  f.advance(100);await f.runner.step();assert.deepEqual(f.clicks,['a']);
});

test('retention configuration requires an actual boolean',()=>{
  assert.throws(()=>fixture({retainSentDrafts:'true'}),/retainSentDrafts must be a boolean/);
});

test('late polling does not create a catch-up burst',async()=>{
  const f=fixture();await f.runner.initialize();f.runner.start();await f.runner.step();
  f.advance(500);await f.runner.step();await f.runner.step();
  assert.deepEqual(f.clicks.map(c=>c.at),[0,500]);
  assert.equal(f.runner.status().waitMs,100);
  f.advance(100);await f.runner.step();assert.deepEqual(f.clicks.map(c=>c.at),[0,500,600]);
});

test('prepare-ahead begins read-only work early then waits for the original send time',async()=>{
  const f=fixture({prepareAheadMs:60});const checked=[];
  f.adapter.preflight=async item=>{checked.push({id:item.draftId,at:f.clock.monotonic()});return {ok:true};};
  await f.runner.initialize();f.runner.start();await f.runner.step();
  assert.equal(f.runner.status().waitMs,40);assert.equal(f.runner.status().sendWaitMs,100);
  f.advance(40);await f.runner.step();
  assert.deepEqual(checked,[{id:'a',at:0},{id:'b',at:40}]);
  assert.deepEqual(f.sleeps,[60]);assert.deepEqual(f.clicks.map(c=>c.at),[0,100]);
});

test('read-only preparation time does not add drift to the minimum send interval',async()=>{
  const f=fixture({durationMs:3600000,intervalMs:72000,prepareAheadMs:60000});
  f.adapter.inspectDraft=async ref=>{f.advance(25000);return itemFor(ref.draftId);};
  await f.runner.initialize();f.runner.start();await f.runner.step();
  f.advance(12000);await f.runner.step();f.advance(12000);await f.runner.step();
  assert.deepEqual(f.clicks.map(c=>c.at),[25000,97000,169000]);
  assert.deepEqual(f.sleeps,[35000,35000]);
  assert.equal(f.clicks[1].at-f.clicks[0].at,72000);
});

test('deadline during an early-prepared send wait prevents the next click',async()=>{
  const f=fixture({durationMs:80,prepareAheadMs:60});
  await f.runner.initialize();f.runner.start();await f.runner.step();
  f.advance(40);await f.runner.step();
  assert.deepEqual(f.clicks.map(c=>c.id),['a']);
  assert.equal(f.runner.status().sent,1);assert.equal(f.runner.status().phase,'deadline');
  assert.equal(f.runner.state.records[1].status,'not_attempted');
});

test('default waiting implementation aborts immediately when deadline timer fires',async()=>{
  const f=fixture({durationMs:80,prepareAheadMs:60,useDefaultSleep:true});
  await f.runner.initialize();f.runner.start();await f.runner.step();
  f.advance(40);const second=f.runner.step();
  for(let i=0;i<10&&f.callbacks.size<2;i++)await Promise.resolve();
  assert.equal(f.callbacks.size,2);
  f.advance(40);await second;
  assert.deepEqual(f.clicks.map(c=>c.id),['a']);
  assert.equal(f.runner.status().phase,'deadline');assert.equal(f.callbacks.size,0);
});

test('prepare-ahead never sends catch-up work early after a delayed poll',async()=>{
  const f=fixture({prepareAheadMs:80});await f.runner.initialize();f.runner.start();await f.runner.step();
  f.advance(500);await f.runner.step();await f.runner.step();
  assert.deepEqual(f.clicks.map(c=>c.at),[0,500]);
  assert.equal(f.runner.status().waitMs,20);assert.equal(f.runner.status().sendWaitMs,100);
});

test('send hook revalidates fresh UI after pacing wait and before durable intent',async()=>{
  const f=fixture({prepareAheadMs:60}),validated=[];
  f.adapter.send=async(item,{beforeClick})=>{
    await beforeClick({revalidate:async()=>{
      validated.push({id:item.draftId,at:f.clock.monotonic()});
      assert.equal(f.writes.at(-1).events.some(e=>e.type==='send_intent'&&e.draftId===item.draftId),false);
    }});
    f.clicks.push({id:item.draftId,at:f.clock.monotonic()});return sentFor(item);
  };
  await f.runner.initialize();f.runner.start();await f.runner.step();
  f.advance(40);await f.runner.step();
  assert.deepEqual(validated,[{id:'a',at:0},{id:'b',at:100}]);
  assert.deepEqual(f.clicks,validated);assert.deepEqual(f.sleeps,[60]);
});

test('deadline during post-wait UI revalidation creates neither click nor send intent',async()=>{
  const f=fixture({durationMs:150,prepareAheadMs:60});
  f.adapter.send=async(item,{beforeClick})=>{
    await beforeClick({revalidate:async()=>{if(item.draftId==='b')f.advance(50);}});
    f.clicks.push({id:item.draftId,at:f.clock.monotonic()});return sentFor(item);
  };
  await f.runner.initialize();f.runner.start();await f.runner.step();
  f.advance(40);await f.runner.step();
  assert.deepEqual(f.clicks.map(c=>c.id),['a']);assert.equal(f.runner.status().phase,'deadline');
  assert.equal(f.runner.state.events.some(e=>e.type==='send_intent'&&e.draftId==='b'),false);
  assert.equal(Object.hasOwn(f.runner.state.records[1],'attemptAt'),false);
  assert.equal(Object.hasOwn(f.runner.state.records[1],'clickAuthorizedAt'),false);
});

test('failed post-wait UI revalidation remains explicitly unattempted',async()=>{
  const f=fixture({prepareAheadMs:60});
  f.adapter.send=async(item,{beforeClick})=>{
    await beforeClick({revalidate:async()=>{throw Error('compose changed while waiting');}});
    f.clicks.push(item.draftId);return sentFor(item);
  };
  await f.runner.initialize();f.runner.start();await f.runner.step();
  assert.equal(f.clicks.length,0);assert.equal(f.runner.status().stopReason,'step_failed');
  assert.equal(f.runner.state.records[0].status,'not_attempted');
  assert.equal(f.runner.state.events.some(e=>e.type==='send_intent'),false);
  assert.equal(Object.hasOwn(f.runner.state.records[0],'attemptAt'),false);
});

test('preflight skips are unsent and preserve the original draft',async()=>{
  const f=fixture();f.adapter.preflight=async()=>({ok:false,skip:true,reason:'already_sent'});
  await f.runner.initialize();f.runner.start();await f.runner.step();
  assert.equal(f.runner.status().skipped,1);assert.equal(f.clicks.length,0);assert.equal(f.cleanupClicks.length,0);
});

test('send receipt without calling the guarded click is rejected',async()=>{
  const f=fixture();f.adapter.send=async item=>sentFor(item);
  await f.runner.initialize();f.runner.start();await f.runner.step();
  assert.equal(f.runner.status().sent,0);assert.equal(f.runner.status().phase,'halted');assert.equal(f.cleanupClicks.length,0);
});

test('failed durable intent prevents the external send',async()=>{
  const f=fixture({storeOverride:{save(state){if(state.events.at(-1)?.type==='send_intent')throw Error('disk full');}}});
  await f.runner.initialize();f.runner.start();await f.runner.step();
  assert.equal(f.clicks.length,0);assert.equal(f.runner.status().phase,'halted');
});

test('concurrent steps are rejected and cannot send the same draft twice',async()=>{
  const f=fixture();let release;
  f.adapter.preflight=()=>new Promise(resolve=>{release=()=>resolve({ok:true});});
  await f.runner.initialize();f.runner.start();const active=f.runner.step();
  await Promise.resolve();await Promise.resolve();
  await assert.rejects(f.runner.step(),/Only one/);release();await active;
  assert.equal(f.clicks.length,1);
});

test('final mailbox count preserves unknown and badge uncertainty',async()=>{
  const f=fixture();await f.runner.initialize();f.runner.start();f.advance(1000);
  f.adapter.countDrafts=async()=>({count:9,exact:false,source:'unread_badge'});
  const result=await f.runner.finish();assert.deepEqual(result.finalMailboxCount,{count:9,exact:false,source:'unread_badge'});
  f.adapter.countDrafts=async()=>{throw Error('page unavailable');};
  assert.equal((await f.runner.finish()).finalMailboxCount.count,null);
});

test('journal refuses reuse and persists valid JSON',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mail-controller-test-'));const file=path.join(dir,'run.json');
  try {const journal=new AtomicJsonJournal(file);
    assert.throws(()=>new AtomicJsonJournal(file),/already exists/);
    journal.save({status:'unknown'});
    assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{status:'unknown'});
    assert.throws(()=>new AtomicJsonJournal(file),/already exists/);
  } finally {fs.rmSync(file,{force:true});fs.rmdirSync(dir);}
});

const hour=60*60*1000;

test('no duration means no cutoff while the authorized queue and target still bound sends',async()=>{
  const f=fixture({durationMs:null,target:1});await f.runner.initialize();f.runner.start();
  assert.equal(f.runner.deadlineMono,null);assert.equal(f.runner.status().deadlineAt,null);
  assert.equal(f.runner.status().remainingMs,null);assert.equal(f.runner.status().timeLimited,false);
  f.advance(5*hour);await f.runner.step();assert.equal(f.runner.status().phase,'target_reached');
  assert.equal(f.runner.status().sent,1);assert.equal(f.runner.status().cleaned,1);
  assert.equal(f.runner.status().deadlineReached,false);assert.equal(f.callbacks.size,0);
});

test('explicit one-hour and five-hour windows stop at their own unchanged deadlines',async()=>{
  for(const durationMs of [hour,5*hour]){
    const f=fixture({durationMs});await f.runner.initialize();const started=f.runner.start();
    assert.equal(started.timeLimited,true);assert.equal(started.remainingMs,durationMs);
    f.advance(durationMs-1);assert.equal(f.runner.status().phase,'running');
    const original=f.runner.deadlineMono;assert.equal(f.runner.start().deadlineAt,started.deadlineAt);
    f.advance(1);assert.equal(f.runner.status().phase,'deadline');
    assert.equal(f.runner.deadlineMono,original);await f.runner.step();assert.equal(f.clicks.length,0);
  }
});

test('omitted duration defaults to unlimited rather than inheriting the former hour',async()=>{
  const base=fixture();
  const runner=new MailSessionRunner({adapter:base.adapter,clock:base.clock,timers:{setTimeout(){return 1;},clearTimeout(){}},store:{save(){}}});
  await runner.initialize();runner.start();base.advance(2*hour);
  assert.equal(runner.status().phase,'running');assert.equal(runner.state.config.durationMs,null);
  runner.stop();
});

test('eight continuous hours persist one reminder before its host callback and keep running',async()=>{
  let callbacks=0;var f;f=fixture({durationMs:null,onRuntimeReminder:event=>{
    callbacks++;assert.equal(f.writes.at(-1).events.at(-1).type,'runtime_reminder_notification_attempted');
    assert.equal(event.continuesRunning,true);assert.equal(event.thresholdMs,8*hour);assert.equal(f.runner.state.phase,'running');
  }});
  await f.runner.initialize();f.runner.start();f.advance(8*hour-1);assert.equal(callbacks,0);
  f.advance(1);assert.equal(callbacks,1);assert.equal(f.runner.status().phase,'running');
  const reminder=structuredClone(f.runner.state.runtimeReminder);assert.equal(reminder.notificationStatus,'delivered');
  assert.ok(reminder.notificationId);f.runner.status();f.runner.guard();f.advance(8*hour);
  assert.equal(callbacks,1);assert.equal(f.runner.state.events.filter(e=>e.type==='runtime_reminder_due').length,1);
  assert.equal(f.writes.at(-1).runtimeReminder.notificationId,reminder.notificationId);
  assert.equal(f.runner.deadlineMono,null);f.runner.stop();
});

test('eight-hour reminder does not extend a longer explicitly bounded run',async()=>{
  const f=fixture({durationMs:10*hour,onRuntimeReminder:()=>{}});await f.runner.initialize();f.runner.start();
  const deadline=f.runner.deadlineMono;f.advance(8*hour);assert.equal(f.runner.status().phase,'running');
  assert.equal(f.runner.deadlineMono,deadline);assert.equal(f.runner.status().remainingMs,2*hour);
  f.advance(2*hour);assert.equal(f.runner.status().phase,'deadline');
});

test('a cutoff at exactly eight hours wins over the reminder and terminal sessions never notify',async()=>{
  let notifications=0;const f=fixture({durationMs:8*hour,onRuntimeReminder:()=>notifications++});
  await f.runner.initialize();f.runner.start();f.advance(8*hour);assert.equal(f.runner.status().phase,'deadline');
  assert.equal(notifications,0);
  const stopped=fixture({durationMs:null,onRuntimeReminder:()=>notifications++});await stopped.runner.initialize();stopped.runner.start();stopped.runner.stop();stopped.advance(9*hour);assert.equal(notifications,0);
});

test('failed and unconfigured reminder delivery is explicit and never retried automatically',async()=>{
  let calls=0;const f=fixture({durationMs:null,onRuntimeReminder:async()=>{calls++;throw Error('host notification failed');}});
  await f.runner.initialize();f.runner.start();f.advance(8*hour);await f.runner.reminderDelivery;
  assert.equal(calls,1);assert.equal(f.runner.state.runtimeReminder.notificationStatus,'failed');
  assert.match(f.runner.state.runtimeReminder.error,/host notification failed/);f.runner.status();f.advance(hour);assert.equal(calls,1);
  assert.equal(f.runner.state.phase,'running');f.runner.stop();
  const absent=fixture({durationMs:null});await absent.runner.initialize();absent.runner.start();absent.advance(8*hour);
  assert.equal(absent.runner.state.runtimeReminder.notificationStatus,'unconfigured');assert.equal(absent.runner.state.phase,'running');absent.runner.stop();
});

test('a very long deadline is armed in supported timer chunks rather than overflowing',async()=>{
  const f=fixture({durationMs:1000*hour});await f.runner.initialize();f.runner.start();
  const deadlineTimer=f.callbacks.get(f.runner.timer);assert.equal(deadlineTimer.due,2147483647);
  f.advance(2147483647);assert.equal(f.runner.state.phase,'running');
  assert.equal(f.runner.deadlineMono,1000*hour);assert.ok(f.callbacks.has(f.runner.timer));f.runner.stop();
});

test('invalid time limits and reminder callbacks fail before the session is created',()=>{
  const base=fixture();for(const durationMs of [0,-1,NaN,Infinity,1.5,'3600000',Number.MAX_SAFE_INTEGER+1])
    assert.throws(()=>new MailSessionRunner({adapter:base.adapter,store:{save(){}},durationMs}),/positive safe integer or null/);
  assert.throws(()=>new MailSessionRunner({adapter:base.adapter,store:{save(){}},onRuntimeReminder:42}),/must be a function/);
});

test('an active host acknowledges an actually shown reminder once using its exact durable ID',async()=>{
  const f=fixture({durationMs:null});await f.runner.initialize();f.runner.start();f.advance(8*hour);
  const id=f.runner.state.runtimeReminder.notificationId;assert.equal(f.runner.state.runtimeReminder.notificationStatus,'unconfigured');
  assert.throws(()=>f.runner.acknowledgeRuntimeReminder('wrong'),/ID_MISMATCH/);
  const result=f.runner.acknowledgeRuntimeReminder(id);assert.equal(result.runtimeReminder.notificationStatus,'delivered-by-host');
  assert.equal(f.writes.at(-1).events.at(-1).type,'runtime_reminder_host_delivered');
  const writes=f.writes.length;f.runner.acknowledgeRuntimeReminder(id);assert.equal(f.writes.length,writes);
  assert.equal(f.runner.state.phase,'running');f.runner.stop();
});

test('status alone and a callback still in flight do not acknowledge reminder delivery',async()=>{
  let release;const f=fixture({durationMs:null,onRuntimeReminder:()=>new Promise(resolve=>{release=resolve;})});
  await f.runner.initialize();f.runner.start();f.advance(8*hour);
  const id=f.runner.state.runtimeReminder.notificationId;f.runner.status();
  assert.equal(f.runner.state.runtimeReminder.notificationStatus,'attempting');
  assert.throws(()=>f.runner.acknowledgeRuntimeReminder(id),/DELIVERY_IN_PROGRESS/);
  release();await f.runner.reminderDelivery;assert.equal(f.runner.state.runtimeReminder.notificationStatus,'delivered');f.runner.stop();
});
