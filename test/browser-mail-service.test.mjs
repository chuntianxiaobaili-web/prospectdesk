import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash,randomUUID} from 'node:crypto';
import {BrowserMailService,MailSessionRunner,BrowserMailAdapter,runSession,resumeUnattempted} from '../src/browser-mail/index.mjs';

const account='test@example.test';
const ref=id=>({accountId:account,draftId:id,recipient:`${id}@example.test`,subject:`Subject ${id}`});
const item=id=>({...ref(id),body:`Body ${id}`,draftVersion:`v-${id}`,approvedHash:`hash-${id}`});
const binding=i=>Object.fromEntries(['accountId','draftId','draftVersion','approvedHash'].map(k=>[k,i[k]]));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

function fixture({coreBusy=false,refs=[ref('a'),ref('b')],overrides={},tabOverrides={},blocker=()=>null,runtimePid,serviceOptions={}}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'browser-mail-service-'));
  let now=0,sequence=0;const timers=new Map(),sent=[],cleaned=[],factories=[],counts={reads:0,mutations:0,preflight:0};
  const ax=`0 AXWebArea Zoho Mail (${account})\n  1 row (selected) Description: 草稿, ID: 11111111111\n  2 row (selectable) Description: 已发送, ID: 22222222222\n  3 text field (settable) 搜索 ( / )\n  4 text private body and customer@example.test`;
  const tab={async getAXState(){counts.reads++;return ax;},...Object.fromEntries(['click','reload','typeText','pressKey'].map(name=>[name,async()=>{counts.mutations++;throw Error(`Unexpected UI mutation: ${name}`);} ])),...tabOverrides};
  const options={tab,accountId:account,journalDirectory:path.join(dir,'journals'),accountLockPath:path.join(dir,'account.lock'),
    isCoreBusy:()=>coreBusy,shouldBlockRecipient:blocker,runtimePid,
    runnerOptions:{clock:{monotonic:()=>now,wall:()=>Date.UTC(2026,10,17)+now},
      timers:{setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,at:now+ms});return id;},clearTimeout(id){timers.delete(id);}},
      sleep:async ms=>{now+=ms;}},
    adapterFactory:async options=>{
      factories.push(structuredClone({preparedRefs:options.preparedRefs,approvedPermanentDraftIds:options.approvedPermanentDraftIds}));
      return {approvedPermanentDraftIds:new Set(options.approvedPermanentDraftIds),
        async scanDrafts(){return options.preparedRefs??refs;},
        async inspectDraft(r){return item(r.draftId);},
        async preflight(){counts.preflight++;return {ok:true};},
        async send(i,{beforeClick}){await beforeClick({revalidate:async()=>{}});sent.push(i.draftId);return {...binding(i),recipient:i.recipient,status:'sent',authoritative:true,messageId:`sent-${i.draftId}`};},
        async reconcile(){return {status:'unknown'};},
        async cleanup(i,r){cleaned.push(i.draftId);return {...binding(i),status:'already_absent',authoritative:true,sentMessageId:r.messageId};},
        async countDrafts(){return {value:refs.length-cleaned.length,exact:true,source:'fixture_total'};},...overrides};
    }};
  Object.assign(options,serviceOptions);
  const service=new BrowserMailService(options);
  const advance=(ms,{fire=true}={})=>{now+=ms;if(fire)for(const [id,entry]of [...timers])if(entry.at<=now&&timers.has(id)){timers.delete(id);entry.fn();}};
  const cleanup=async()=>{await service.close();assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()),'browser-mail-service-')));fs.rmSync(dir,{recursive:true,force:true});};
  return {service,options,dir,counts,sent,cleaned,factories,timers,advance,cleanup,setCoreBusy:v=>{coreBusy=v;}};
}

test('public browser-mail entry exports the independent components',()=>{
  for(const value of [BrowserMailService,MailSessionRunner,BrowserMailAdapter,runSession,resumeUnattempted])assert.equal(typeof value,'function');
});

test('compatibility only reads AX, redacts message content, and releases its transient shared lock',async t=>{
  const f=fixture();t.after(f.cleanup);const result=await f.service.compatibility();
  assert.equal(result.ok,true);assert.equal(result.status,'compatible');assert.ok(result.checkedAt);
  assert.equal(result.requiresComposePreflight,true);assert.ok(result.checks.every(c=>c.ok));
  assert.equal(f.counts.reads,1);assert.equal(f.counts.mutations,0);
  assert.equal(JSON.stringify(result).includes('customer@example.test'),false);assert.equal(JSON.stringify(result).includes(account),false);
  assert.equal(fs.existsSync(f.options.accountLockPath),false);assert.equal(f.service.isBusy(),false);
});

test('missing browser action capabilities fail compatibility without mutating UI',async t=>{
  const f=fixture({tabOverrides:{click:undefined}});t.after(f.cleanup);
  const result=await f.service.compatibility();assert.equal(result.ok,false);assert.equal(result.status,'needs_review');
  assert.equal(result.checks.find(c=>c.id==='tab_click').ok,false);assert.equal(f.counts.mutations,0);
});

test('core busy and foreign account locks block both preparation and UI probes',async t=>{
  const f=fixture({coreBusy:true});t.after(f.cleanup);
  await assert.rejects(()=>f.service.compatibility(),/CORE_MAILBOX_BUSY/);await assert.rejects(()=>f.service.prepare(),/CORE_MAILBOX_BUSY/);
  assert.equal(f.counts.reads,0);f.setCoreBusy(false);
  const owner='foreign owner';fs.writeFileSync(f.options.accountLockPath,owner);
  await assert.rejects(()=>f.service.prepare(),/ACCOUNT_MAILBOX_LOCKED/);await assert.rejects(()=>f.service.compatibility(),/ACCOUNT_MAILBOX_LOCKED/);
  assert.equal(f.counts.reads,0);await f.service.close();assert.equal(fs.readFileSync(f.options.accountLockPath,'utf8'),owner);
});

test('prepare retains the shared account lock and prepared sessions stay busy until finish',async t=>{
  const f=fixture();t.after(f.cleanup);await f.service.prepare({target:1});
  assert.equal(f.service.isBusy(),true);assert.equal(f.service.hasSession(),true);assert.equal(fs.existsSync(f.options.accountLockPath),true);
  const another=new BrowserMailService(f.options);t.after(()=>another.close());
  await assert.rejects(()=>another.prepare({target:1}),/ACCOUNT_MAILBOX_LOCKED/);
  await f.service.finish();assert.equal(f.service.isBusy(),false);assert.equal(f.service.hasSession(),false);
  assert.equal(fs.existsSync(f.options.accountLockPath),false);await another.prepare({target:1});
});

test('prepared own-lock probes work but running probes cannot read the browser',async t=>{
  const f=fixture();t.after(f.cleanup);await f.service.prepare({target:1});
  assert.equal((await f.service.compatibility()).ok,true);const reads=f.counts.reads;
  f.service.start();await assert.rejects(()=>f.service.compatibility(),/SESSION_RUNNING/);assert.equal(f.counts.reads,reads);
});

test('repeated prepare and start never replace an unarchived run or extend its deadline',async t=>{
  const f=fixture();t.after(f.cleanup);await f.service.prepare({target:1});const id=f.service.status().runId;
  await assert.rejects(()=>f.service.prepare({target:1}),/FINISH_OR_CLOSE/);assert.equal(f.service.status().runId,id);
  const first=f.service.start();f.advance(100);const second=f.service.start();assert.equal(second.deadlineAt,first.deadlineAt);
});

test('ready stop and stop without a session are harmless and finish archives the session',async t=>{
  const f=fixture();t.after(f.cleanup);assert.equal(f.service.stop().phase,'idle');
  await f.service.prepare({target:1});assert.equal(f.service.stop('user_stop').phase,'stopped');
  assert.equal(f.service.status().startedAt,null);assert.equal(f.service.hasSession(),true);
  await f.service.finish();assert.equal(f.service.status().archived,true);assert.equal(f.sent.length,0);
});

test('new sessions do not inherit earlier permanent-delete IDs',async t=>{
  const f=fixture();t.after(f.cleanup);
  await f.service.prepare({target:1,preparedRefs:[ref('a')],approvedPermanentDraftIds:['a']});await f.service.finish();
  await f.service.prepare({target:1,preparedRefs:[ref('a')]});
  assert.deepEqual(f.factories.map(v=>v.approvedPermanentDraftIds),[['a'],[]]);
  assert.equal(f.service.adapter.approvedPermanentDraftIds.size,0);
});

test('foreign-account refs and permanent IDs outside this selection cannot be prepared',async t=>{
  const f=fixture();t.after(f.cleanup);
  await assert.rejects(()=>f.service.prepare({preparedRefs:[{...ref('a'),accountId:'other@example.test'}]}),/ACCOUNT_MISMATCH/);
  await assert.rejects(()=>f.service.prepare({target:1,preparedRefs:[ref('a')],approvedPermanentDraftIds:['b']}),/OUTSIDE_SELECTED/);
  assert.equal(f.service.hasSession(),false);assert.equal(fs.existsSync(f.options.accountLockPath),false);
  assert.throws(()=>f.service.start(),/PREPARE_BROWSER/);
});

test('cancellation during prepare leaves no startable session or owned lock',async t=>{
  const gate=deferred(),entered=deferred();const f=fixture({overrides:{async scanDrafts(){entered.resolve();await gate.promise;return [ref('a')];}}});t.after(f.cleanup);
  const controller=new AbortController();const preparing=f.service.prepare({target:1},{signal:controller.signal});await entered.promise;
  controller.abort();gate.resolve();await assert.rejects(preparing);
  assert.equal(f.service.hasSession(),false);assert.equal(fs.existsSync(f.options.accountLockPath),false);
});

test('concurrent operations reject and close holds its lock until in-flight work settles',async t=>{
  const gate=deferred(),entered=deferred();const f=fixture({overrides:{async preflight(){entered.resolve();await gate.promise;return {ok:true};}}});t.after(f.cleanup);
  await f.service.prepare({target:1});f.service.start();const stepping=f.service.step();await entered.promise;
  await assert.rejects(()=>f.service.finish(),/OPERATION_IN_PROGRESS/);await assert.rejects(()=>f.service.compatibility(),/OPERATION_IN_PROGRESS/);
  const closing=f.service.close();assert.equal(fs.existsSync(f.options.accountLockPath),true);assert.equal(f.service.isBusy(),true);
  gate.resolve();await Promise.all([stepping,closing]);assert.equal(f.sent.length,0);
  assert.equal(fs.existsSync(f.options.accountLockPath),false);assert.equal(f.service.status().closed,true);assert.equal(f.timers.size,0);
});

test('finish itself is serialized and close waits for its read to settle',async t=>{
  const gate=deferred(),entered=deferred();let reads=0;
  const f=fixture({overrides:{async countDrafts(){if(++reads===2){entered.resolve();await gate.promise;}return {value:2,exact:true};}}});t.after(f.cleanup);
  await f.service.prepare({target:1});f.service.stop();const finishing=f.service.finish();await entered.promise;
  await assert.rejects(()=>f.service.compatibility(),/OPERATION_IN_PROGRESS/);
  const closing=f.service.close();assert.equal(fs.existsSync(f.options.accountLockPath),true);gate.resolve();
  await assert.rejects(finishing);await closing;assert.equal(fs.existsSync(f.options.accountLockPath),false);
});

test('external step cancellation stops future clicks without misclassifying a send as unknown',async t=>{
  const gate=deferred(),entered=deferred();const f=fixture({overrides:{async preflight(){entered.resolve();await gate.promise;return {ok:true};}}});t.after(f.cleanup);
  await f.service.prepare({target:1});f.service.start();const c=new AbortController();const stepping=f.service.step({signal:c.signal});
  await entered.promise;c.abort();gate.resolve();await stepping;
  assert.equal(f.service.status().phase,'stopped');assert.equal(f.service.status().unknown,0);assert.equal(f.sent.length,0);
});

test('persisted core suppression skips a recipient before mailbox preflight',async t=>{
  const f=fixture({blocker:()=> 'recipient_suppressed'});t.after(f.cleanup);
  await f.service.prepare({target:1});f.service.start();await f.service.step();
  assert.equal(f.service.status().skipped,1);assert.equal(f.counts.preflight,0);assert.equal(f.sent.length,0);
});

test('suppression introduced during the pacing wait prevents the next actual click',async t=>{
  let blocked=false;const f=fixture({blocker:()=>blocked?'recipient_suppressed':null});t.after(f.cleanup);
  f.service.runnerOptions.sleep=async ms=>{blocked=true;f.advance(ms);};
  await f.service.prepare({target:2,durationMs:1000,intervalMs:100,prepareAheadMs:60});f.service.start();await f.service.step();
  f.advance(40);await f.service.step();assert.deepEqual(f.sent,['a']);assert.equal(f.service.status().unknown,0);
});

test('a replaced account lock is never blindly deleted by close',async t=>{
  const f=fixture();t.after(f.cleanup);await f.service.prepare({target:1});
  const foreign=JSON.stringify({ownerToken:'someone-else'});fs.writeFileSync(f.options.accountLockPath,foreign);
  await f.service.close();assert.equal(fs.readFileSync(f.options.accountLockPath,'utf8'),foreign);
  assert.equal(f.service.status().lockWarning,'ACCOUNT_LOCK_OWNERSHIP_LOST');
});

test('terminal reports remain terminal after their former deadline and status does not write logs',async t=>{
  const f=fixture();t.after(f.cleanup);await f.service.prepare({target:1,durationMs:100});f.service.start();await f.service.step();
  assert.equal(f.service.status().phase,'target_reached');f.advance(500);
  assert.equal((await f.service.finish()).phase,'target_reached');const journal=f.service.runner.store.filename;
  const saved=fs.readFileSync(journal,'utf8');f.advance(1000);
  assert.equal(f.service.status().phase,'target_reached');assert.equal(f.service.status().deadlineReached,false);
  assert.equal(fs.readFileSync(journal,'utf8'),saved);assert.equal(f.timers.size,0);
});

test('close cancels the deadline timer and no later timer event writes the journal',async t=>{
  const f=fixture();t.after(f.cleanup);await f.service.prepare({target:1,durationMs:100});f.service.start();assert.equal(f.timers.size,1);
  await f.service.close();const journal=f.service.runner.store.filename,saved=fs.readFileSync(journal,'utf8');f.advance(1000);
  assert.equal(f.timers.size,0);assert.equal(fs.readFileSync(journal,'utf8'),saved);
});


test('hosts without a process PID keep token-owned locking and read-only compatibility',async t=>{
  const f=fixture({runtimePid:null});t.after(f.cleanup);
  const result=await f.service.compatibility();assert.equal(result.ok,true);
  assert.equal(f.counts.mutations,0);assert.equal(fs.existsSync(f.options.accountLockPath),false);
  await f.service.prepare({target:1});
  const record=JSON.parse(fs.readFileSync(f.options.accountLockPath,'utf8'));
  assert.equal(record.pid,null);assert.equal(record.kind,'browser-mail-session');
  assert.equal(typeof record.ownerToken,'string');assert.ok(record.ownerToken.length>0);
  const other=new BrowserMailService({...f.options,runtimePid:null});t.after(()=>other.close());
  await assert.rejects(()=>other.prepare({target:1}),/ACCOUNT_MAILBOX_LOCKED/);
  await f.service.finish();assert.equal(fs.existsSync(f.options.accountLockPath),false);
});

test('normal Node hosts preserve the actual default PID in lock metadata',async t=>{
  const f=fixture();t.after(f.cleanup);await f.service.prepare({target:1});
  assert.equal(JSON.parse(fs.readFileSync(f.options.accountLockPath,'utf8')).pid,process.pid);
});

test('an explicit host PID is retained and invalid diagnostic PID values are rejected',async t=>{
  const f=fixture({runtimePid:4321});t.after(f.cleanup);await f.service.prepare({target:1});
  assert.equal(JSON.parse(fs.readFileSync(f.options.accountLockPath,'utf8')).pid,4321);
  for(const runtimePid of [0,-1,1.5,NaN,Infinity,'123',false,{},[]]){
    assert.throws(()=>new BrowserMailService({...f.options,runtimePid}),/RUNTIME_PID_MUST_BE_POSITIVE_INTEGER_OR_NULL/);
  }
});


test('the default constructor and compatibility work when the host has no process global',async t=>{
  const f=fixture();t.after(f.cleanup);
  const context=vm.createContext({fs,path,AbortController,createHash,randomUUID,
    clone:structuredClone,bridgeOwners:new WeakMap(),browserIds:new Set(['edge','chrome','yandex']),
    terminal:new Set(['halted','stopped','deadline','exhausted','target_reached'])});
  assert.equal(vm.runInContext('typeof process',context),'undefined');
  const IsolatedService=vm.runInContext('('+BrowserMailService.toString()+')',context);
  const service=new IsolatedService(f.options);t.after(()=>service.close());
  assert.equal(service.runtimePid,null);
  assert.equal((await service.compatibility()).ok,true);
  assert.equal(fs.existsSync(f.options.accountLockPath),false);
  assert.equal(f.counts.mutations,0);
  context.process={};
  const unavailablePid=new IsolatedService(f.options);
  assert.equal(unavailablePid.runtimePid,null);await unavailablePid.close();
});

 test('service defaults to unlimited time and accepts a five-hour user window',async t=>{
  const f=fixture();t.after(f.cleanup);await f.service.prepare({target:10});
  let status=f.service.start();assert.equal(status.durationMs,null);assert.equal(status.timeLimited,false);
  assert.equal(status.deadlineAt,null);f.advance(2*60*60*1000);assert.equal(f.service.status().phase,'running');
  await f.service.finish();await f.service.prepare({target:10,durationMs:5*60*60*1000});
  status=f.service.start();assert.equal(status.remainingMs,5*60*60*1000);
  f.advance(5*60*60*1000-1);assert.equal(f.service.status().phase,'running');f.advance(1);
  assert.equal(f.service.status().phase,'deadline');assert.equal(f.sent.length,0);
});

test('service removes the former fifty-item cap without expanding the authorized draft list',async t=>{
  const f=fixture();t.after(f.cleanup);await f.service.prepare({target:10000,preparedRefs:[ref('a')]});
  assert.equal(f.service.status().target,10000);assert.equal(f.service.status().planned,1);
  f.service.start();await f.service.step();assert.equal(f.service.status().phase,'exhausted');assert.deepEqual(f.sent,['a']);
  await f.service.finish();await assert.rejects(()=>f.service.prepare({target:10001}),/1_TO_10000/);
});

test('service delivers one durable eight-hour reminder and releases both timers on close',async t=>{
  const notifications=[];const f=fixture({serviceOptions:{onRuntimeReminder:event=>notifications.push(event)}});t.after(f.cleanup);
  await f.service.prepare({target:2});f.service.start();assert.equal(f.timers.size,1);
  f.advance(8*60*60*1000);assert.equal(notifications.length,1);assert.equal(f.service.status().phase,'running');
  assert.equal(f.service.status().runtimeReminder.notificationStatus,'delivered');
  const journal=JSON.parse(fs.readFileSync(f.service.runner.store.filename,'utf8'));
  assert.equal(journal.runtimeReminder.notificationId,notifications[0].notificationId);
  f.service.status();f.advance(8*60*60*1000);assert.equal(notifications.length,1);
  await f.service.close();assert.equal(f.timers.size,0);
});

test('an explicitly injected mailbox profile supplies its own read-only compatibility checks',async t=>{
  let input;const f=fixture({serviceOptions:{mailProfile:'gmail-ui',compatibilityChecker:async value=>{
    input=value;return {compatible:true,checks:[{id:'gmail_account',ok:true,privateBody:'must not leak'},{id:'gmail_drafts',ok:true,count:1}]};
  }}});t.after(f.cleanup);const result=await f.service.compatibility();
  assert.equal(result.compatible,true);assert.equal(result.mailProfile,'gmail-ui');assert.equal(f.counts.reads,0);
  assert.equal(input.accountId,account);assert.equal(input.tab,f.options.tab);assert.equal(typeof input.signal.aborted,'boolean');
  assert.equal(result.checks.some(c=>c.id==='account_matches'),false);assert.equal(JSON.stringify(result).includes('must not leak'),false);
  await f.service.prepare({target:1});assert.equal(f.service.runner.state.mailProfile,'gmail-ui');
  assert.equal(f.service.status().mailProfile,'gmail-ui');assert.equal(f.service.describe().profile,'gmail-ui');
  const journal=JSON.parse(fs.readFileSync(f.service.runner.store.filename,'utf8'));assert.equal(journal.mailProfile,'gmail-ui');
});

test('custom compatibility cannot hide failed tab controls or a negative profile result',async t=>{
  const f=fixture({tabOverrides:{click:undefined},serviceOptions:{mailProfile:'gmail-ui',compatibilityChecker:async()=>({compatible:true,checks:[{id:'gmail_account',ok:true}]})}});t.after(f.cleanup);
  assert.equal((await f.service.compatibility()).compatible,false);
  const other=fixture({serviceOptions:{mailProfile:'gmail-ui',compatibilityChecker:async()=>({compatible:false,checks:[{id:'gmail_account',ok:true}]})}});t.after(other.cleanup);
  assert.equal((await other.service.compatibility()).compatible,false);
});

test('custom compatibility results are validated and a failed probe releases its transient lock',async t=>{
  for(const value of [null,{compatible:true,checks:[]},{compatible:true,checks:[{id:'gmail_account',ok:'true'}]}, {compatible:true,checks:[{id:account,ok:true}]}]){
    const f=fixture({serviceOptions:{mailProfile:'gmail-ui',compatibilityChecker:async()=>value}});t.after(f.cleanup);
    await assert.rejects(()=>f.service.compatibility(),/INVALID_COMPATIBILITY_CHECK_RESULT/);assert.equal(fs.existsSync(f.options.accountLockPath),false);
  }
});

test('custom profile and callbacks are explicit constructor inputs',async t=>{
  const f=fixture();t.after(f.cleanup);
  assert.throws(()=>new BrowserMailService({...f.options,mailProfile:'gmail-ui'}),/REQUIRES_COMPATIBILITY_CHECKER/);
  assert.throws(()=>new BrowserMailService({...f.options,compatibilityChecker:4}),/MUST_BE_A_FUNCTION/);
  assert.throws(()=>new BrowserMailService({...f.options,onRuntimeReminder:4}),/MUST_BE_A_FUNCTION/);
  assert.throws(()=>new BrowserMailService({...f.options,mailProfile:''}),/EXPLICIT_MAIL_PROFILE_REQUIRED/);
});

test('a host acknowledgement is persisted once without stopping the active unlimited service',async t=>{
  const f=fixture();t.after(f.cleanup);await f.service.prepare({target:2});f.service.start();f.advance(8*60*60*1000);
  const id=f.service.status().runtimeReminder.notificationId;
  assert.equal(f.service.status().runtimeReminder.notificationStatus,'unconfigured');
  assert.throws(()=>f.service.acknowledgeRuntimeReminder('other'),/ID_MISMATCH/);
  assert.equal(f.service.acknowledgeRuntimeReminder(id).runtimeReminder.notificationStatus,'delivered-by-host');
  assert.equal(f.service.status().phase,'running');
  const journal=fs.readFileSync(f.service.runner.store.filename,'utf8');f.service.acknowledgeRuntimeReminder(id);
  assert.equal(fs.readFileSync(f.service.runner.store.filename,'utf8'),journal);
});
