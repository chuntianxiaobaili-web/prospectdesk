import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BrowserMailService} from '../src/browser-mail/service.mjs';
import {apply,getBrowserMailService} from '../src/plugin.js';

const accountId='browser-fixture@example.test';
const fields=['accountId','draftId','draftVersion','approvedHash'];
const binding=item=>Object.fromEntries(fields.map(k=>[k,item[k]]));
const itemFor=id=>({accountId,draftId:id,draftVersion:'v-'+id,approvedHash:'h-'+id,recipient:id+'@example.test',subject:'Subject '+id,body:'Synthetic body '+id});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

function fixture(t,{browserId='edge',directory,refs=['one','two'],bridge=true,overrides={},sleepHook,afterSendHook,afterCleanupHook}={}){
  const ownsDirectory=!directory;
  directory??=fs.mkdtempSync(path.join(os.tmpdir(),'mail-multibrowser-'));
  let mono=0,timerId=0,guard,verified=0,closed=0;
  const timers=new Map(),clicks=[],sent=[],cleaned=[];
  const targetId='synthetic-target-'+browserId;
  let proof={ok:true,browserId,transport:'playwright',targetId,browserVersion:'fixture/1',identityVerified:true};
  const events={1:{kind:'click',index:1,role:'button',name:'发送'},2:{kind:'click',index:2,role:'button',name:'永久删除'},3:{kind:'click',index:3,role:'row',name:'草稿'}};
  const tab={
    async getAXState(){return `0 AXWebArea Zoho Mail (${accountId})\n  1 row (selected) Description: 草稿, ID: 11111111111\n  2 row (selectable) Description: 已发送, ID: 22222222222\n  3 text field (settable) 搜索 ( / )`;},
    async click(index){guard?.(events[index]??{kind:'click',index,name:'Unknown'});clicks.push(index);},
    async reload(){},
    async typeText(index){guard?.({kind:'typeText',index,role:'textbox',name:'搜索'});},
    async pressKey(index){guard?.({kind:'pressKey',index,role:'textbox',name:'搜索'});}
  };
  if(bridge)tab.setMutationGuard=fn=>{guard=fn;};
  const connection={tab,identity:Object.freeze({...proof}),async verifyIdentity(){verified++;return {...proof};},async close(){closed++;}};
  const advance=ms=>{mono+=ms;for(const [id,timer]of [...timers])if(timer.at<=mono){timers.delete(id);timer.fn();}};
  const adapter={
    async scanDrafts(){return refs.map(draftId=>({accountId,draftId}));},
    async inspectDraft(ref){return itemFor(ref.draftId);},
    async preflight(){return {ok:true};},
    async send(item,{beforeClick}){
      await beforeClick({revalidate:async()=>{}});
      await afterSendHook?.({advance,tab,connection});
      await tab.click(1);sent.push(item.draftId);
      return {status:'sent',authoritative:true,recipient:item.recipient,messageId:'sent-'+item.draftId,...binding(item)};
    },
    async reconcile(){return {status:'unknown'};},
    async cleanup(item,receipt,{beforeClick}){
      await beforeClick();await afterCleanupHook?.({advance,tab,connection});
      await tab.click(2);cleaned.push(item.draftId);
      return {status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,...binding(item)};
    },
    async countDrafts(){return {value:20-cleaned.length,exact:true,source:'synthetic_total'};},
    ...overrides
  };
  const options={connection,accountId,journalDirectory:path.join(directory,'journals'),accountLockPath:path.join(directory,'shared-account.lock'),
    adapterFactory:()=>adapter,runnerOptions:{clock:{monotonic:()=>mono,wall:()=>Date.UTC(2026,10,17)+mono},
      timers:{setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,at:mono+ms});return id;},clearTimeout(id){timers.delete(id);}},
      sleep:async ms=>{advance(ms);await sleepHook?.();}}};
  const service=new BrowserMailService(options);
  t.after(async()=>{await service.close();if(ownsDirectory){assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(os.tmpdir()),'mail-multibrowser-')));fs.rmSync(directory,{recursive:true,force:true});}});
  return {service,options,connection,tab,adapter,directory,clicks,sent,cleaned,advance,
    setProof:p=>{proof={...proof,...p};},get verified(){return verified;},get closed(){return closed;},get guard(){return guard;}};
}

for(const browserId of ['edge','chrome','yandex'])test(browserId+' has a separate verified journal and runs through the same service',async t=>{
  const f=fixture(t,{browserId,refs:['one']});
  const compatible=await f.service.compatibility();
  assert.equal(compatible.compatible,true);assert.equal(compatible.mode,'playwright-cdp-browser-ui');
  assert.equal(compatible.connection.browserId,browserId);
  assert.equal(compatible.connectionChecks[0].ok,true);
  assert.ok(compatible.mailboxChecks.some(c=>c.id==='account_matches'));
  await f.service.prepare({target:1});f.service.start();const result=await f.service.step();
  assert.equal(result.sent,1);assert.equal(result.cleaned,1);assert.equal(result.connection.browserId,browserId);
  assert.equal(f.service.journalDirectory,path.join(f.directory,'journals',browserId));
  const journal=JSON.parse(fs.readFileSync(path.join(f.service.journalDirectory,fs.readdirSync(f.service.journalDirectory)[0]),'utf8'));
  assert.equal(journal.connection.browserId,browserId);
  assert.equal(journal.connection.identityVerified,true);
  assert.equal(journal.connection.targetId,undefined);
  assert.equal(journal.mailProfile,'chinese-zoho-ui');
  await f.service.finish();
});

test('three browser services use one shared mailbox lock instead of browser-specific locks',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mail-multibrowser-shared-'));
  const one=fixture(t,{directory,browserId:'edge'}),two=fixture(t,{directory,browserId:'chrome'}),three=fixture(t,{directory,browserId:'yandex'});
  t.after(async()=>{await Promise.all([one.service.close(),two.service.close(),three.service.close()]);fs.rmSync(directory,{recursive:true,force:true});});
  await one.service.prepare({target:1});
  await assert.rejects(()=>two.service.prepare(),/ACCOUNT_MAILBOX_LOCKED/);
  await assert.rejects(()=>three.service.compatibility(),/ACCOUNT_MAILBOX_LOCKED/);
  assert.equal(two.verified,0);assert.equal(three.verified,0);
  await one.service.finish();await two.service.prepare({target:1});await two.service.finish();await three.service.prepare({target:1});
});

test('browser changes during the fixed waiting period prevent the next send',async t=>{
  let f;
  f=fixture(t,{sleepHook:()=>f.setProof({browserId:'chrome'})});
  await f.service.prepare();f.service.start();await f.service.step();f.advance(12000);
  const result=await f.service.step();
  assert.equal(result.sent,1);assert.equal(f.sent.length,1);assert.equal(result.phase,'stopped');
  assert.equal(result.connection.identityVerified,false);assert.equal(result.stopReason,'browser_identity_changed');
});

test('identity change during preparation leaves no startable session or held lock',async t=>{
  const f=fixture(t);f.setProof({targetId:'different-target'});
  await assert.rejects(()=>f.service.prepare(),/IDENTITY_CHANGED/);
  assert.equal(f.service.hasSession(),false);assert.equal(fs.existsSync(f.options.accountLockPath),false);
  assert.throws(()=>f.service.start(),/PREPARE_BROWSER/);
});

test('identity failure is reported separately from untested mailbox controls',async t=>{
  const f=fixture(t);f.setProof({identityVerified:false});
  const result=await f.service.compatibility();
  assert.equal(result.compatible,false);assert.equal(result.connectionChecks[0].ok,false);
  assert.deepEqual(result.mailboxChecks,[]);assert.equal(f.clicks.length,0);
});

test('bridge send dispatch rechecks deadline after asynchronous geometry preparation',async t=>{
  const f=fixture(t,{refs:['one'],afterSendHook:({advance})=>advance(1000)});
  await f.service.prepare({target:1,durationMs:1000});f.service.start();
  const result=await f.service.step();
  assert.equal(f.sent.length,0);assert.equal(f.clicks.length,0);
  assert.equal(result.deadlineReached,true);assert.equal(result.unknown,1);
  assert.equal(result.cleaned,0);
});

test('bridge cleanup dispatch rechecks deadline while preserving the confirmed send',async t=>{
  const f=fixture(t,{refs:['one'],afterCleanupHook:({advance})=>advance(1000)});
  await f.service.prepare({target:1,durationMs:1000});f.service.start();const result=await f.service.step();
  assert.equal(result.sent,1);assert.equal(result.cleaned,0);assert.equal(result.cleanupPending,1);
  assert.deepEqual(f.clicks,[1]);assert.equal(result.deadlineReached,true);
});

test('an unauthorized destructive bridge action in inspection cannot send',async t=>{
  let f;
  f=fixture(t,{overrides:{async inspectDraft(ref){await f.tab.click(1);return itemFor(ref.draftId);}}});
  await f.service.prepare({target:1});f.service.start();const result=await f.service.step();
  assert.equal(result.sent,0);assert.equal(f.clicks.length,0);
  assert.equal(result.phase,'halted');assert.match(f.service.runner.state.records[0].error,/NOT_AUTHORIZED/);
});

test('read-only folder navigation remains available during final count after stopping',async t=>{
  let f;
  f=fixture(t,{overrides:{async countDrafts(){await f.tab.click(3);return {value:20,exact:true,source:'fixture_total'};}}});
  await f.service.prepare({target:1});f.service.start();f.service.stop();const result=await f.service.finish();
  assert.equal(result.finalMailboxCount.value,20);assert.deepEqual(f.clicks,[3,3]);assert.equal(result.sent,0);
  await assert.rejects(()=>f.tab.click(3),/OPERATION_REQUIRED/);
});

test('close waits for the in-flight operation before closing its connection and releasing lock',async t=>{
  const entered=deferred(),release=deferred();
  const f=fixture(t,{overrides:{async inspectDraft(ref){entered.resolve();await release.promise;return itemFor(ref.draftId);}}});
  await f.service.prepare({target:1});f.service.start();const step=f.service.step();await entered.promise;
  const closing=f.service.close();assert.equal(f.closed,0);assert.equal(fs.existsSync(f.options.accountLockPath),true);
  release.resolve();await Promise.all([step,closing]);assert.equal(f.closed,1);assert.equal(fs.existsSync(f.options.accountLockPath),false);
  assert.equal(f.guard,null);assert.equal(f.sent.length,0);
});

test('legacy tab remains operational but never claims a verified browser brand',async t=>{
  const f=fixture(t,{bridge:false});await f.service.close();
  const {connection,...oldOptions}=f.options;
  const old=new BrowserMailService({...oldOptions,tab:f.tab});t.after(()=>old.close());
  const status=old.status();assert.equal(status.connection.browserId,'legacy');assert.equal(status.connection.identityVerified,false);
  assert.equal(old.journalDirectory,path.join(f.directory,'journals'));
  const result=await old.compatibility();assert.equal(result.compatible,true);assert.equal(result.connectionChecks[0].status,'legacy_unverified');
  await old.prepare({target:1});old.start();assert.equal((await old.step()).sent,1);
});

test('a second service cannot overwrite the first bridge input guard',async t=>{
  const f=fixture(t);
  assert.throws(()=>new BrowserMailService(f.options),/TAB_ALREADY_OWNED/);
  await f.service.prepare({target:1});f.service.start();assert.equal((await f.service.step()).sent,1);
});

test('plugin accepts a verified connection and passes account lock and isolated journal settings',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mail-multibrowser-plugin-'));
  const f=fixture(t,{browserId:'chrome',directory});await f.service.close();
  // A fresh bridge connection is required after service ownership ends.
  f.connection.verifyIdentity=async()=>({ok:true,...f.connection.identity});
  const registered=new Map();let shutdown;
  const ctx={tools:{register(tool){registered.set(tool.name,tool);return()=>{};},guard(){return()=>{};}},effect(fn){shutdown=fn();}};
  apply(ctx,{directory:path.join(f.directory,'plugin'),config:{brand:{name:'Synthetic'},accountId,accountLockDirectory:path.join(f.directory,'locks'),draftModel:{provider:'fixture',model:'test'}},
    browserMail:{connection:f.connection,adapterFactory:()=>f.adapter,runnerOptions:f.options.runnerOptions}});
  t.after(async()=>{await shutdown();fs.rmSync(directory,{recursive:true,force:true});});
  const service=getBrowserMailService(ctx);
  assert.equal(service.status().connection.browserId,'chrome');
  assert.equal(service.journalDirectory,path.join(f.directory,'plugin','browser-mail-runs','chrome'));
  const call=(name,args={})=>registered.get(name).execute(args,{signal:new AbortController().signal});
  await call('sales_browser_mail_prepare',{target:1});await call('sales_browser_mail_start');
  assert.equal((await call('sales_browser_mail_step')).sent,1);await call('sales_browser_mail_finish');
});
