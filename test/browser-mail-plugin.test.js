import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {apply,getWorkflow,getBrowserMailService} from '../src/plugin.js';

const accountId='fixture@example.test';
const binding=item=>Object.fromEntries(['accountId','draftId','draftVersion','approvedHash'].map(k=>[k,item[k]]));
const itemFor=id=>({accountId,draftId:id,draftVersion:'v-'+id,approvedHash:'h-'+id,recipient:id+'@example.test',subject:'Fixture '+id,body:'Synthetic test '+id});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture(t,{connected=true,overrides={},refs=['one','two'],initialCount=10}={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'browser-mail-plugin-'));
  const registered=new Map(),factories=[],sends=[],deletes=[],timers=new Map();let mono=0,timerId=0,shutdown,ready;
  const advance=ms=>{mono+=ms;for(const [id,timer] of [...timers])if(timer.at<=mono){timers.delete(id);timer.fn();}};
  const adapter={
    async scanDrafts(){return refs.map(draftId=>({accountId,draftId}));},
    async countDrafts(){return {value:initialCount-deletes.length,exact:true,source:'synthetic_folder_details'};},
    async inspectDraft(ref){return itemFor(ref.draftId);},
    async preflight(){return {ok:true};},
    async send(item,{beforeClick}){await beforeClick();sends.push({id:item.draftId,at:mono});return {status:'sent',authoritative:true,messageId:'sent-'+item.draftId,recipient:item.recipient,...binding(item)};},
    async reconcile(){return {status:'unknown'};},
    async cleanup(item,receipt,{beforeClick}){await beforeClick();deletes.push(item.draftId);return {status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,...binding(item)};},
    ...overrides
  };
  const tab={async getAXState(){return 'Zoho Mail ('+accountId+')\nSecret subject and body must never be returned';},async click(){throw Error('Compatibility must not click');},async reload(){throw Error('Compatibility must not reload');},async typeText(){throw Error('Compatibility must not type');},async pressKey(){throw Error('Compatibility must not press keys');}};
  const ctx={tools:{register(tool){registered.set(tool.name,tool);return ()=>registered.delete(tool.name);},guard(){return ()=>{};}},effect(factory){shutdown=factory();}};
  apply(ctx,{directory,config:{brand:{name:'Synthetic'},accountId,accountLockDirectory:path.join(directory,'account-locks'),draftModel:{provider:'synthetic',model:'fixture'}},
    browserMail:connected?{tab,adapterFactory:args=>{factories.push(args);return adapter;},runnerOptions:{clock:{monotonic:()=>mono,wall:()=>Date.UTC(2026,10,17)+mono},timers:{setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,at:mono+ms});return id;},clearTimeout(id){timers.delete(id);}},sleep:async ms=>advance(ms)}}:undefined,
    onReady(w,services){ready={w,...services};}
  });
  let closed=false;const close=async()=>{if(!closed){closed=true;await shutdown();}};
  t.after(async()=>{await close();fs.rmSync(directory,{recursive:true,force:true});});
  const call=(name,args={},signal=new AbortController().signal)=>registered.get('sales_'+name).execute(args,{signal});
  return {ctx,call,ready,registered,directory,adapter,factories,sends,deletes,timers,advance,close};
}

test('plugin exposes browser-mail entrypoints while preserving original research and packet tools',async t=>{
  const f=fixture(t);
  for(const name of ['browser_mail_compatibility','browser_mail_prepare','browser_mail_start','browser_mail_step','browser_mail_status','browser_mail_stop','browser_mail_finish','research_brief','set_draft','enqueue','start_queue','tick','reconcile'])assert.ok(f.registered.has('sales_'+name),name);
  assert.equal(getWorkflow(f.ctx),f.ready.w);assert.equal(getBrowserMailService(f.ctx),f.ready.browserMail);
  assert.equal((await f.call('browser_mail_status')).phase,'idle');
});

test('missing host tab reports not connected and never silently opens a browser',async t=>{
  const f=fixture(t,{connected:false});
  assert.deepEqual(await f.call('browser_mail_status'),{configured:false,status:'not_connected'});
  await assert.rejects(f.call('browser_mail_prepare'),/options.browserMail.tab/);
  assert.equal(f.sends.length,0);
});

test('real registered tools prepare read-only, start deadline, send one item and archive exact counts',async t=>{
  const f=fixture(t,{refs:['one']});
  const prepared=await f.call('browser_mail_prepare',{target:1});assert.equal(prepared.planned,1);assert.equal(prepared.sent,0);assert.equal(f.sends.length,0);
  const started=await f.call('browser_mail_start');assert.equal(started.deadlineAt,null);assert.equal(f.sends.length,0);
  const result=await f.call('browser_mail_step');assert.equal(result.sent,1);assert.equal(result.cleaned,1);assert.equal(result.phase,'target_reached');
  assert.equal(f.ready.w.state.queue.length,0);assert.deepEqual(f.ready.w.state.drafts,{});
  const finished=await f.call('browser_mail_finish');assert.equal(finished.archived,true);assert.equal(finished.finalMailboxCount.exact,true);assert.equal(finished.finalMailboxCount.value,9);
  const logs=fs.readdirSync(path.join(f.directory,'browser-mail-runs')).filter(n=>n.endsWith('.json'));assert.equal(logs.length,1);
  const journal=JSON.parse(fs.readFileSync(path.join(f.directory,'browser-mail-runs',logs[0]),'utf8'));assert.equal(journal.records[0].receipt.messageId,'sent-one');
});

test('prepare owns shared account lock and old packet entrypoints are blocked until finish',async t=>{
  const f=fixture(t);await f.call('browser_mail_prepare');assert.equal(fs.existsSync(f.ready.w.accountLock),true);
  for(const [name,args] of [['start_queue',{}],['resume',{}],['tick',{}],['reconcile',{sendId:'anything'}]])await assert.rejects(f.call(name,args),/Browser mail session owns/);
  assert.equal((await f.call('mailbox_compatibility')).status,'busy');
  await f.call('browser_mail_stop');assert.equal(f.ready.browserMail.isBusy(),true);
  await f.call('browser_mail_finish');assert.equal(f.ready.browserMail.isBusy(),false);assert.equal(fs.existsSync(f.ready.w.accountLock),false);
  assert.deepEqual(await f.call('resume'),{paused:false});
});

test('defaults keep 72-second fixed spacing and repeated start does not move deadline',async t=>{
  const f=fixture(t);await f.call('browser_mail_prepare');const first=await f.call('browser_mail_start');
  await f.call('browser_mail_step');f.advance(12000);const again=await f.call('browser_mail_start');assert.equal(again.deadlineAt,first.deadlineAt);
  await f.call('browser_mail_step');assert.deepEqual(f.sends.map(s=>s.at),[0,72000]);
  await f.call('browser_mail_finish');
});

test('global pause stops browser writes and keeps receipt totals',async t=>{
  const f=fixture(t);await f.call('browser_mail_prepare');await f.call('browser_mail_start');await f.call('browser_mail_step');
  await f.call('pause');f.advance(72000);const result=await f.call('browser_mail_step');assert.equal(result.phase,'stopped');assert.equal(result.sent,1);assert.equal(f.sends.length,1);
  await f.call('browser_mail_finish');
});

test('an explicitly requested one-hour deadline stops later calls',async t=>{
  const f=fixture(t);await f.call('browser_mail_prepare',{durationMs:3600000});await f.call('browser_mail_start');f.advance(3600000);
  const result=await f.call('browser_mail_step');assert.equal(result.deadlineReached,true);assert.equal(result.sent,0);assert.equal(f.deletes.length,0);
  await f.call('browser_mail_finish');
});

test('permanent cleanup approval is passed only for current prepare call',async t=>{
  const f=fixture(t);await f.call('browser_mail_prepare',{approvedPermanentDraftIdsJson:'["one"]',excludeDraftIdsJson:'["two"]'});assert.deepEqual(f.factories[0].approvedPermanentDraftIds,['one']);
  await f.call('browser_mail_stop');await f.call('browser_mail_finish');await f.call('browser_mail_prepare');assert.deepEqual(f.factories[1].approvedPermanentDraftIds,[]);
});

test('invalid preparation JSON fails before acquiring or scanning mailbox',async t=>{
  const f=fixture(t);await assert.rejects(f.call('browser_mail_prepare',{preparedRefsJson:'{}'}),/bounded JSON array/);
  await assert.rejects(f.call('browser_mail_prepare',{approvedPermanentDraftIdsJson:'['}),SyntaxError);
  assert.equal(f.factories.length,0);assert.equal(fs.existsSync(f.ready.w.accountLock),false);
});

test('compatibility tool exposes sanitized checks and performs no click',async t=>{
  const f=fixture(t);const result=await f.call('browser_mail_compatibility');assert.equal(result.compatible,false);assert.ok(Array.isArray(result.checks));assert.equal(JSON.stringify(result).includes('Secret subject'),false);assert.equal(f.sends.length,0);
});

test('unload awaits in-flight inspection before closing workflow or releasing account lock',async t=>{
  const entered=deferred(),release=deferred();const f=fixture(t,{overrides:{async inspectDraft(ref){entered.resolve();await release.promise;return itemFor(ref.draftId);}}});
  await f.call('browser_mail_prepare');await f.call('browser_mail_start');const stepping=f.call('browser_mail_step');await entered.promise;
  let closed=false;const closing=f.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);assert.equal(fs.existsSync(f.ready.w.accountLock),true);
  release.resolve();await stepping;await closing;assert.equal(f.sends.length,0);assert.equal(f.ready.w.closed,true);assert.equal(fs.existsSync(f.ready.w.accountLock),false);assert.equal(getBrowserMailService(f.ctx),undefined);
});

test('aborting the active tool stops subsequent browser writes',async t=>{
  const entered=deferred(),release=deferred();const f=fixture(t,{overrides:{async inspectDraft(ref){entered.resolve();await release.promise;return itemFor(ref.draftId);}}});
  await f.call('browser_mail_prepare');await f.call('browser_mail_start');const controller=new AbortController();const stepping=f.call('browser_mail_step',{},controller.signal);await entered.promise;controller.abort('cancelled');release.resolve();
  await stepping;assert.equal(f.sends.length,0);assert.equal(f.deletes.length,0);assert.equal(f.ready.browserMail.status().phase,'stopped');
});

test('recording a recipient stop also stops the existing-draft session',async t=>{
  const f=fixture(t);await f.call('browser_mail_prepare');await f.call('browser_mail_start');
  await f.call('suppress',{recipient:'one@example.test',reason:'Synthetic recipient stop'});
  const result=await f.call('browser_mail_step');assert.equal(result.phase,'stopped');assert.equal(f.sends.length,0);assert.equal(f.ready.w.state.suppressed[0].email,'one@example.test');
});

test('a new browser session still checks the core persistent recipient suppression list',async t=>{
  const f=fixture(t,{refs:['one']});await f.call('suppress',{recipient:'one@example.test',reason:'Synthetic recipient stop'});
  await f.call('browser_mail_prepare',{target:1});await f.call('browser_mail_start');const result=await f.call('browser_mail_step');
  assert.equal(result.sent,0);assert.equal(f.sends.length,0);assert.equal(f.deletes.length,0);
});

test('full package virtual acceptance: fifty confirmed sends and cleanups within one fixed hour',async t=>{
  const refs=Array.from({length:50},(_,i)=>'draft-'+(i+1));const f=fixture(t,{refs,initialCount:80});
  const prepared=await f.call('browser_mail_prepare',{target:50});assert.equal(prepared.initialMailboxCount.value,80);assert.equal(prepared.planned,50);
  const started=await f.call('browser_mail_start');let result=started;
  for(let i=0;i<50;i++){f.advance(result.waitMs);if(i===25)assert.equal((await f.call('browser_mail_start')).deadlineAt,started.deadlineAt);result=await f.call('browser_mail_step');}
  assert.equal(result.phase,'target_reached');assert.equal(result.sent,50);assert.equal(result.cleaned,50);assert.equal(result.unknown,0);assert.equal(result.cleanupPending,0);assert.equal(result.deadlineReached,false);
  assert.equal(f.sends.length,50);assert.equal(new Set(f.sends.map(s=>s.id)).size,50);assert.deepEqual(f.sends.map(s=>s.at),Array.from({length:50},(_,i)=>i*72000));
  const final=await f.call('browser_mail_finish');assert.equal(final.finalMailboxCount.value,30);assert.equal(final.finalMailboxCount.exact,true);assert.equal(final.remainingPlanned,0);assert.equal(final.archived,true);
  const files=fs.readdirSync(path.join(f.directory,'browser-mail-runs')).filter(n=>n.endsWith('.json'));const journal=JSON.parse(fs.readFileSync(path.join(f.directory,'browser-mail-runs',files[0]),'utf8'));
  assert.equal(journal.records.filter(r=>r.status==='sent').length,50);assert.equal(new Set(journal.records.map(r=>r.receipt.messageId)).size,50);assert.equal(journal.records.filter(r=>r.cleanup==='already_absent').length,50);
});

test('partial target stops at the exact deadline without a catch-up send',async t=>{
  const f=fixture(t,{refs:Array.from({length:50},(_,i)=>'draft-'+i),initialCount:80});
  await f.call('browser_mail_prepare',{target:50,durationMs:144000});let result=await f.call('browser_mail_start');
  for(let i=0;i<3;i++){f.advance(result.waitMs);result=await f.call('browser_mail_step');}
  assert.equal(result.phase,'deadline');assert.equal(result.sent,2);assert.equal(result.cleaned,2);assert.equal(result.remainingPlanned,48);assert.deepEqual(f.sends.map(s=>s.at),[0,72000]);
  const final=await f.call('browser_mail_finish');assert.equal(final.finalMailboxCount.value,78);assert.equal(final.deadlineReached,true);assert.equal(final.archived,true);
});

test('invalid browser binding releases the already-created core workflow lock',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'browser-mail-invalid-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const ctx={};
  assert.throws(()=>apply(ctx,{directory,config:{brand:{name:'Synthetic'},accountId,accountLockDirectory:path.join(directory,'account-locks'),draftModel:{provider:'synthetic',model:'fixture'}},browserMail:{tab:{}}}),/EXPLICIT_BROWSER_TAB_REQUIRED/);
  assert.equal(fs.existsSync(path.join(directory,'state.lock')),false);assert.equal(getWorkflow(ctx),undefined);
});

test('explicit work duration text reaches the real registered session route',async t=>{const f=fixture(t,{refs:['one']});await f.call('browser_mail_prepare',{target:1,workDuration:'5小时'});const started=await f.call('browser_mail_start');assert.equal(started.durationMs,18000000);assert.equal(Date.parse(started.deadlineAt)-Date.parse(started.startedAt),18000000);await f.call('browser_mail_finish');await f.call('browser_mail_prepare',{target:1,workDuration:'不限时'});assert.equal((await f.call('browser_mail_start')).deadlineAt,null);});
test('conflicting or reminder-only duration text fails before acquiring mailbox',async t=>{const f=fixture(t);await assert.rejects(f.call('browser_mail_prepare',{workDuration:'5小时',durationMs:3600000}),/WORK_DURATION_CONFLICT/);await assert.rejects(f.call('browser_mail_prepare',{workDuration:'8小时后提醒'}));assert.equal(f.factories.length,0);assert.equal(fs.existsSync(f.ready.w.accountLock),false);});

test('explicit Gmail profile selects its real adapter and read-only compatibility checker without host factories',async t=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gmail-profile-plugin-'));const registered=new Map();let shutdown;const state='0 AXWebArea 草稿 - fixture@example.test - Gmail, URL: mail.google.com/mail/u/0/#drafts\n1 button (collapsed) Description: Google 账号： Fixture (fixture@example.test), Secondary Actions: Expand\n2 button 写邮件\n3 link Description: 草稿, Value: mail.google.com/mail/u/0/#drafts\n4 link Description: 已发邮件, Value: mail.google.com/mail/u/0/#sent\n5 text field (settable) 搜索邮件';const tab={async getAXState(){return state;},async click(){throw Error('Unexpected compatibility click');},async reload(){throw Error('Unexpected compatibility reload');},async typeText(){throw Error('Unexpected compatibility typing');},async pressKey(){throw Error('Unexpected compatibility key');}};const ctx={tools:{register(tool){registered.set(tool.name,tool);return()=>{};},guard(){return()=>{};}},effect(fn){shutdown=fn();}};apply(ctx,{directory,config:{brand:{name:'Synthetic'},accountId,accountLockDirectory:path.join(directory,'locks'),draftModel:{provider:'fixture',model:'test'}},browserMail:{tab,mailProfile:'chinese-gmail-ui'}});t.after(async()=>{await shutdown();fs.rmSync(directory,{recursive:true,force:true});});const service=getBrowserMailService(ctx);const result=await registered.get('sales_browser_mail_compatibility').execute({},{signal:new AbortController().signal});assert.equal(result.compatible,true);assert.equal(result.mailProfile,'chinese-gmail-ui');const adapter=await service.adapterFactory({tab,accountId});assert.equal(adapter.mailProfile,'chinese-gmail-ui');assert.equal(adapter.mode,'cua-gmail-browser-ui');});
