import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {apply,getWorkflow,getBrowserMailService} from '../src/plugin.js';
import {hash} from '../src/import.js';
import {BrowserMailAdapter,parseCompose} from '../src/browser-mail/browser-adapter.mjs';

const clone=value=>structuredClone(value);
const accountId='handoff-fixture@example.test';
const boundFields=item=>Object.fromEntries(['accountId','draftId','draftVersion','approvedHash'].map(k=>[k,item[k]]));

function fixture(t,{count=1,approved=true,saveUnknown=false,receiptUnknown=false,useDefaultAdapter=false}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'handoff-plugin-'));
  const mailbox=[],events=[],calls={save:0,read:0,inspect:0,send:0,cleanup:0},factories=[],adapterInputs=[];
  const config={accountId,accountLockDirectory:path.join(directory,'locks'),
    brand:{name:'Synthetic Supplier',products:['artificial flowers'],verifiedFacts:['Synthetic product evidence'],
      evidenceSources:[{path:'C:/Synthetic/products.csv',checkedAt:'2026-11-18',readEvidence:'Synthetic fixture only'}]},
    draftingPolicy:{mode:'product-evidence-review'},draftModel:{provider:'fixture',model:'manual'}};
  let mono=0,wall=Date.parse('2026-11-18T00:00:00Z'),shutdown,registered,ctx,workflow,service,advanceHook,revalidateHook,readHook;
  const timers=new Map();let timerId=0;
  const tab={async getAXState(){return '';},async click(){},async typeText(){},async pressKey(){},async reload(){}};
  const identity={browserId:'edge',transport:'cua',targetId:'synthetic-handoff-tab',browserVersion:'fixture/1',identityVerified:true};
  const connection={tab,identity,async verifyIdentity(){return {ok:true,...identity};},async close(){}};
  const writerFactory=options=>{
    factories.push(options);
    return {identity:options.identity,
      async readExisting({accountId:account,recipient}){
        options.assertExclusive();await readHook?.();calls.read++;
        return {accountId:account,complete:true,drafts:mailbox.filter(d=>d.recipient===recipient).map(({accountId,draftId,recipient,subject})=>({accountId,draftId,recipient,subject}))};
      },
      async save(packet,{beforeSave}){
        await options.beforeMutation();await beforeSave();options.assertExclusive();calls.save++;
        events.push('save');
        if(saveUnknown)return {status:'unknown'};
        const approvedHash=hash({accountId:packet.accountId,recipient:packet.recipient,subject:packet.subject,body:packet.body});
        mailbox.push({...clone(packet),draftId:'fixture-draft-'+calls.save,draftVersion:approvedHash,approvedHash});
        return {status:'saved'};
      },
      async inspect(ref){options.assertExclusive();calls.inspect++;return clone(mailbox.find(d=>d.draftId===ref.draftId));}
    };
  };
  const adapterFactory=input=>{adapterInputs.push(input);const {preparedRefs}=input;return {
    async scanDrafts(){return clone(preparedRefs??mailbox.map(({accountId,draftId})=>({accountId,draftId})));},
    async inspectDraft(ref){return clone(mailbox.find(d=>d.draftId===ref.draftId));},
    async preflight(){return {ok:true};},
    async send(item,{beforeClick}){
      await beforeClick({revalidate:async()=>{await revalidateHook?.(item);}});
      const disk=JSON.parse(fs.readFileSync(workflow.file,'utf8'));
      const proof=Object.values(disk.mailboxDraftBindings).find(b=>b.mailboxDraftId===item.draftId);
      assert.equal(proof.usage.status,'sending');calls.send++;events.push('send');
      return receiptUnknown?{status:'unknown'}:{status:'sent',authoritative:true,recipient:item.recipient,messageId:'sent-'+item.draftId,...boundFields(item)};
    },
    async reconcile(){return {status:'unknown'};},
    async cleanup(item,receipt,{beforeClick}){
      await beforeClick();calls.cleanup++;events.push('cleanup');
      return {status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,...boundFields(item)};
    },
    async countDrafts(){return {value:mailbox.length-calls.cleanup,exact:true,source:'synthetic'};}
  };};
  const boot=()=>{
    registered=new Map();
    ctx={tools:{register(tool){registered.set(tool.name,tool);return()=>{};},guard(){return()=>{};}},effect(fn){shutdown=fn();}};
    apply(ctx,{directory:path.join(directory,'workflow'),config,now:()=>wall,
      browserMail:{connection,...(useDefaultAdapter?{}:{adapterFactory}),draftWriterFactory:writerFactory,runnerOptions:{
        clock:{monotonic:()=>mono,wall:()=>wall},
        timers:{setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,at:mono+ms});return id;},clearTimeout(id){timers.delete(id);}},
        sleep:async ms=>{mono+=ms;wall+=ms;await advanceHook?.();}}}});
    workflow=getWorkflow(ctx);service=getBrowserMailService(ctx);
  };
  boot();
  const leads=[];
  for(let i=0;i<count;i++){
    const leadId=workflow.importRows([{company:'Synthetic Buyer '+i,website:'https://buyer'+i+'.example.test',email:'contact@buyer'+i+'.example.test',
      need:'Synthetic floral materials',sourceUrl:'https://buyer'+i+'.example.test/contact',sourceDate:'2026-11-18',
      evidence:'Published contact@buyer'+i+'.example.test',newness:'verified',contactStatus:'not_contacted'}]).accepted[0];
    const draft=workflow.setDraft(leadId,{subject:'Synthetic proposal '+i,english:'Hello test buyer '+i+',\nSynthetic floral material details.',chinese:'合成买家 '+i+' 的测试正文。'});
    if(approved)workflow.approve(leadId,{hash:draft.hash,reviewer:'Synthetic review fixture',acknowledgedRecipient:draft.recipient});
    leads.push({leadId,draft});
  }
  t.after(async()=>{await shutdown();assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(os.tmpdir()),'handoff-plugin-')));fs.rmSync(directory,{recursive:true,force:true});});
  const call=(name,args={},signal=new AbortController().signal)=>registered.get('sales_'+name).execute(args,{signal});
  const save=(index=0)=>call('browser_mail_save_approved_draft',{leadId:leads[index].leadId,expectedCoreHash:leads[index].draft.hash});
  const prepare=(extra={})=>call('browser_mail_prepare_approved_drafts',{leadIdsJson:JSON.stringify(leads.map(l=>l.leadId)),target:count,intervalMs:1000,...extra});
  return {directory,mailbox,events,calls,factories,adapterInputs,tab,leads,call,save,prepare,
    get workflow(){return workflow;},get service(){return service;},get registered(){return registered;},
    reload:async()=>{await shutdown();boot();},setAdvanceHook:fn=>{advanceHook=fn;},setRevalidateHook:fn=>{revalidateHook=fn;},setReadHook:fn=>{readHook=fn;}};
}

test('registered save tool proves approved UI save and persists full readback without sending',async t=>{
  const f=fixture(t),proof=await f.save();
  assert.equal(proof.status,'saved_and_readback_verified');assert.equal(proof.coreApprovalHash,f.leads[0].draft.hash);
  assert.notEqual(proof.mailboxContentHash,proof.coreApprovalHash);
  assert.equal(proof.body,f.leads[0].draft.english);assert.equal(proof.browserId,'edge');
  assert.equal(f.calls.save,1);assert.equal(f.calls.send,0);assert.equal(f.calls.cleanup,0);
  const state=JSON.parse(fs.readFileSync(f.workflow.file,'utf8'));
  assert.deepEqual(state.mailboxDraftBindings[proof.leadId],proof);
  assert.equal(state.mailboxDraftSaveAttempts[proof.leadId].event,'draft_handoff_verified');
  assert.equal(fs.existsSync(f.workflow.accountLock),false);
  assert.equal(f.registered.has('sales_approve'),false);
});

test('unapproved draft causes zero UI save or read',async t=>{
  const f=fixture(t,{approved:false});await assert.rejects(()=>f.save(),/APPROVAL/);
  assert.equal(f.factories.length,0);assert.equal(f.calls.save,0);assert.equal(f.calls.read,0);
  assert.equal(f.workflow.state.mailboxDraftBindings,undefined);
});

test('caller cannot substitute an approval hash or use new-compose handoff for a threaded reply',async t=>{
  const f=fixture(t),leadId=f.leads[0].leadId;
  await assert.rejects(()=>f.call('browser_mail_save_approved_draft',{leadId,expectedCoreHash:'fake-hash'}),/APPROVAL/);
  f.workflow.lead(leadId).purpose='reply';
  await assert.rejects(()=>f.save(),/REPLY_DRAFT_HANDOFF_NOT_SUPPORTED/);
  assert.equal(f.factories.length,0);assert.equal(f.calls.save,0);assert.equal(f.calls.read,0);
});

test('save owns account and operation latch while reading',async t=>{
  const f=fixture(t);let release,entered;const enter=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.setReadHook(async()=>{entered();await gate;});const saving=f.save();await enter;
  assert.equal(fs.existsSync(f.workflow.accountLock),true);
  await assert.rejects(()=>f.call('browser_mail_compatibility'),/OPERATION_IN_PROGRESS/);
  await assert.rejects(()=>f.prepare(),/FINISH_OR_CLOSE/);
  release();await saving;assert.equal(f.service.isBusy(),false);
});

test('verified save cannot be recreated after workflow restart',async t=>{
  const f=fixture(t);await f.save();await f.reload();
  await assert.rejects(()=>f.save(),/ALREADY_ATTEMPTED/);assert.equal(f.calls.save,1);
});

test('uncertain save reserves durable intent across restart and never cleans up',async t=>{
  const f=fixture(t,{saveUnknown:true});await assert.rejects(()=>f.save(),/OUTCOME_UNCONFIRMED/);
  const state=JSON.parse(fs.readFileSync(f.workflow.file,'utf8'));
  assert.equal(state.mailboxDraftBindings,undefined);
  assert.equal(state.mailboxDraftSaveAttempts[f.leads[0].leadId].event,'draft_handoff_needs_review');
  await f.reload();await assert.rejects(()=>f.save(),/ALREADY_ATTEMPTED/);
  assert.equal(f.calls.save,1);assert.equal(f.calls.cleanup,0);
});

test('approved prepare freezes provider IDs and content hashes from persisted proofs',async t=>{
  const f=fixture(t),proof=await f.save();await f.prepare();
  const ref=f.service.runner.state.records[0].ref;
  assert.equal(ref.draftId,proof.mailboxDraftId);assert.equal(ref.approvedHash,proof.mailboxContentHash);
  f.workflow.state.mailboxDraftBindings[proof.leadId].body='Late unrelated mutation';
  const item=await f.service.withOperation('synthetic_readback',undefined,()=>f.service.adapter.inspectDraft(ref));
  assert.equal(item.body,proof.body);assert.equal(item.draftId,proof.mailboxDraftId);
});

test('old prepare rejects a bound ID, automatic scan and mixed bound/unbound selection',async t=>{
  const f=fixture(t),proof=await f.save();
  const bound={accountId,draftId:proof.mailboxDraftId};
  for(const args of [{preparedRefsJson:JSON.stringify([bound])},{},{preparedRefsJson:JSON.stringify([bound,{accountId,draftId:'other'}])}]){
    await assert.rejects(()=>f.call('browser_mail_prepare',args),/CORE_BOUND_DRAFT/);
  }
  assert.equal(f.calls.send,0);
});

test('approved route requires persisted binding and ignores no untrusted core-hash shortcut',async t=>{
  const f=fixture(t);await assert.rejects(()=>f.prepare(),/VERIFIED_HANDOFF_BINDING_REQUIRED/);
  const schema=f.registered.get('sales_browser_mail_prepare_approved_drafts').parameters;
  assert.equal(schema.additionalProperties,false);assert.equal(schema.properties.preparedRefsJson,undefined);
  assert.equal(schema.properties.body,undefined);assert.equal(schema.properties.coreHash,undefined);
});

test('approval invalidated during final live read blocks send and preserves draft',async t=>{
  const f=fixture(t);await f.save();await f.prepare();
  f.setRevalidateHook(()=>{f.workflow.draft(f.leads[0].leadId).approval=null;});
  await f.call('browser_mail_start');const result=await f.call('browser_mail_step');
  assert.equal(result.sent,0);assert.equal(f.calls.send,0);assert.equal(f.calls.cleanup,0);
  assert.equal(f.workflow.state.mailboxDraftBindings[f.leads[0].leadId].usage?.status,'unknown');
});

test('approval invalidated during pacing prevents second send',async t=>{
  const f=fixture(t,{count:2});await f.save(0);await f.save(1);await f.prepare();
  await f.call('browser_mail_start');await f.call('browser_mail_step');
  f.setAdvanceHook(()=>{f.workflow.draft(f.leads[1].leadId).approval=null;});
  const result=await f.call('browser_mail_step');assert.equal(result.sent,1);assert.equal(f.calls.send,1);
});

test('confirmed sends persist binding usage and reject repeated preparation after restart',async t=>{
  const f=fixture(t);const proof=await f.save();await f.prepare();await f.call('browser_mail_start');
  const result=await f.call('browser_mail_step');assert.equal(result.sent,1);assert.equal(result.cleaned,1);
  const usage=f.workflow.state.mailboxDraftBindings[proof.leadId].usage;
  assert.equal(usage.status,'sent');assert.equal(usage.runId,f.service.runner.state.runId);
  assert.deepEqual(f.workflow.state.queue,[]);
  await f.call('browser_mail_finish');await f.reload();
  await assert.rejects(()=>f.prepare(),/SEND_ALREADY_ATTEMPTED/);assert.equal(f.calls.send,1);
});

test('unknown send outcome remains reserved and cannot be prepared after restart',async t=>{
  const f=fixture(t,{receiptUnknown:true});const proof=await f.save();await f.prepare();await f.call('browser_mail_start');
  const result=await f.call('browser_mail_step');assert.equal(result.sent,0);
  assert.equal(f.workflow.state.mailboxDraftBindings[proof.leadId].usage.status,'unknown');
  await f.call('browser_mail_finish');await f.reload();await assert.rejects(()=>f.prepare(),/SEND_ALREADY_ATTEMPTED/);
  assert.equal(f.calls.send,1);assert.equal(f.calls.cleanup,0);
});

test('visible body reader is injected only for the default approved-draft adapter',async t=>{
  t.mock.method(BrowserMailAdapter.prototype,'countDrafts',async()=>({value:1,exact:true,source:'synthetic'}));
  const f=fixture(t,{useDefaultAdapter:true});
  await f.call('browser_mail_prepare',{preparedRefsJson:'[]',target:1});
  assert.notEqual(typeof f.service.adapter.readComposeBody,'function');
  await f.call('browser_mail_finish');await f.save();await f.prepare();
  assert.equal(typeof f.service.adapter.readComposeBody,'function');
  const external=fixture(t);await external.save();await external.prepare();
  assert.equal(external.adapterInputs.length,1);
  assert.equal(Object.hasOwn(external.adapterInputs[0],'readComposeBody'),false);
});

test('default bound send hashes visible line structure and guards immediately before UI dispatch',async t=>{
  const f=fixture(t,{useDefaultAdapter:true}),proof=await f.save(),trace=[];
  const expanded=proof.body.replaceAll('\n','\n\n');
  const compose=`0 AXWebArea Zoho Mail (${accountId})\n  2 button From ${accountId}\n  3 button 发送\n  4 text 收件人：\n    5 ${proof.recipient}\n    6 combo box (collapsed, settable) Description: 收件人\n  9 text field (settable) Value: ${proof.subject}, ID: subject\n  10 container Description: 富文本编辑区域, Value: ${expanded}\n\t11 tab (selected) Description: compose`;
  const rawItem=parseCompose(compose,accountId,{accountId,draftId:proof.mailboxDraftId,recipient:proof.recipient,subject:proof.subject});
  assert.notEqual(rawItem.approvedHash,proof.mailboxContentHash);
  const html='<div><div style="font-family: Verdana, Arial; font-size: 10pt">'+proof.body.split('\n').map(line=>'<div>'+line+'<br></div>').join('')+'</div></div>';
  let sent=false;
  f.tab.getAXState=async()=>{trace.push('read-ax');return sent?'信息已发送':compose;};
  f.tab.playwright={frameLocator(selector){assert.equal(selector,'iframe');return {locator(selector){assert.equal(selector,'body');return {evaluate:async()=>{
    trace.push('read-dom');await Promise.resolve();return {html,innerText:expanded,textContent:proof.body.replaceAll('\n','')};
  }};}};}};
  f.tab.click=async index=>{trace.push(index===3?'send-click':'open-draft');if(index===3){sent=true;f.calls.send++;}};
  t.mock.method(BrowserMailAdapter.prototype,'countDrafts',async()=>({value:1,exact:true,source:'synthetic'}));
  t.mock.method(BrowserMailAdapter.prototype,'findDraft',async()=>({index:81,attachments:false}));
  t.mock.method(BrowserMailAdapter.prototype,'preflight',async()=>({ok:true}));
  t.mock.method(BrowserMailAdapter.prototype,'reconcile',async item=>({status:'sent',authoritative:true,recipient:item.recipient,messageId:'synthetic-canonical-sent',...boundFields(item)}));
  t.mock.method(BrowserMailAdapter.prototype,'cleanup',async(item,receipt)=>({status:'already_absent',authoritative:true,sentMessageId:receipt.messageId,...boundFields(item)}));
  await f.prepare();
  const guard=f.service.runner.guard.bind(f.service.runner);
  f.service.runner.guard=()=>{trace.push('deadline-guard');return guard();};
  await f.call('browser_mail_start');const result=await f.call('browser_mail_step');
  assert.equal(result.sent,1);assert.equal(f.calls.send,1);
  const item=f.service.runner.state.records[0].item;
  assert.equal(item.body,proof.body);assert.equal(item.bodySerialization,'visible-plain-lines-v1');
  assert.equal(item.approvedHash,proof.mailboxContentHash);assert.notEqual(item.approvedHash,rawItem.approvedHash);
  assert.ok(trace.filter(e=>e==='read-dom').length>=3);
  const clicked=trace.indexOf('send-click');assert.equal(trace[clicked-1],'deadline-guard');
});

test('default approved rich-text draft stops explicitly when the visible DOM reader is unavailable',async t=>{
  const f=fixture(t,{useDefaultAdapter:true}),proof=await f.save();
  t.mock.method(BrowserMailAdapter.prototype,'countDrafts',async()=>({value:1,exact:true,source:'synthetic'}));
  await f.prepare();
  await assert.rejects(()=>f.service.adapter.readComposeBody({state:'10 container Description: 富文本编辑区域, Value: body',item:{body:proof.body}}),/VISIBLE_BODY_DOM_READER_UNAVAILABLE/);
  assert.equal(f.calls.send,0);assert.equal(f.calls.cleanup,0);
});
