import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SalesWorkflow} from '../src/workflow.js';
import {hash} from '../src/import.js';
import {saveApprovedDraft,bindApprovedDrafts,readApprovedDraft,preparedRefsForBindings,reconcileApprovedDraftSave} from '../src/browser-mail/approved-draft-handoff.mjs';

const clone=value=>structuredClone(value);
function setup(t,{newness='verified'}={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'approved-handoff-'));
  let now=Date.parse('2026-11-18T00:00:00Z');
  const config={
    brand:{name:'Synthetic Flowers',products:['artificial roses'],verifiedFacts:['Synthetic product evidence only'],
      evidenceSources:[{path:'C:/Synthetic/products.csv',checkedAt:'2026-11-18',readEvidence:'Synthetic test fixture, never a real read claim'}]},
    draftingPolicy:{mode:'product-evidence-review'},accountId:'sender@example.test',
    draftModel:{provider:'synthetic-host',model:'manual-test-draft'},minimumIntervalSeconds:1,
    accountLockDirectory:path.join(directory,'account-locks')
  };
  const workflow=new SalesWorkflow({directory,config,now:()=>now});
  t.after(async()=>{await workflow.close();fs.rmSync(directory,{recursive:true,force:true});});
  const leadId=workflow.importRows([{company:'Synthetic Event Hire',website:'https://events.example.test',
    email:'buyer@events.example.test',need:'Published artificial floral hire fixtures',
    sourceUrl:'https://events.example.test/contact',sourceDate:'2026-11-18',
    evidence:'Published buyer@events.example.test',newness,contactStatus:'not_contacted'}]).accepted[0];
  const draft=workflow.setDraft(leadId,{subject:'Synthetic rose material comparison',
    english:'Hello synthetic team,\nA test-only artificial rose comparison.\nSynthetic Flowers',
    chinese:'测试团队您好：这是合成测试文案。'});
  if(newness==='verified')workflow.approve(leadId,{hash:draft.hash,reviewer:'Synthetic human-review fixture',acknowledgedRecipient:draft.recipient});
  return {workflow,leadId,hash:draft.hash,draft,advance:ms=>now+=ms};
}
function saver() {
  const state={drafts:[],saveCalls:0,inspectCalls:0,readCalls:0};
  const adapter={
    identity:{browserId:'edge',targetId:'synthetic-target'},
    async readExisting({accountId}){
      state.readCalls++;
      return {accountId,complete:true,drafts:state.drafts.map(d=>({accountId:d.accountId,draftId:d.draftId,recipient:d.recipient,subject:d.subject}))};
    },
    async save(packet,{beforeSave}){
      await beforeSave();state.saveCalls++;
      const approvedHash=hash({accountId:packet.accountId,recipient:packet.recipient,subject:packet.subject,body:packet.body});
      state.drafts.push({...clone(packet),draftId:'1795000000000000001',draftVersion:approvedHash,approvedHash});
      return {status:'saved'};
    },
    async inspect(ref){state.inspectCalls++;return clone(state.drafts.find(d=>d.draftId===ref.draftId));}
  };
  return {adapter,state};
}
async function handoff(t) {
  const core=setup(t),save=saver();
  const binding=await saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter});
  return {...core,...save,binding};
}
function browser(binding) {
  const item={accountId:binding.accountId,draftId:binding.mailboxDraftId,draftVersion:binding.mailboxDraftVersion,
    approvedHash:binding.mailboxContentHash,recipient:binding.recipient,subject:binding.subject,body:binding.body};
  const state={sendCalls:0,clicks:0,reconciles:0,cleanups:0,reads:0,receipt:null};
  const adapter={
    mode:'synthetic-browser',
    async inspectDraft(){state.reads++;return clone(item);},
    async preflight(){return {ok:true};},
    async send(input,{beforeClick}){
      state.sendCalls++;
      await beforeClick({revalidate:async()=>{assert.equal(input.body,item.body);}});
      state.clicks++;
      return state.receipt??{status:'unknown',reason:'synthetic acknowledgement absent'};
    },
    async reconcile(){state.reconciles++;return {status:'unknown',reason:'synthetic acknowledgement absent'};},
    async cleanup(input,receipt,{beforeClick}){await beforeClick();state.cleanups++;return {status:'already_absent'};},
    async countDrafts(){return {value:1,exact:true,source:'synthetic'};}
  };
  return {adapter,state,item};
}

test('save uses current approved content and proves a unique new ID with complete readback',async t=>{
  const core=setup(t),save=saver(),events=[];
  const proof=await saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter,store:{save:e=>events.push(e)}});
  assert.equal(proof.status,'saved_and_readback_verified');
  assert.equal(proof.coreApprovalHash,core.hash);
  assert.equal(proof.mailboxDraftId,'1795000000000000001');
  assert.notEqual(proof.coreApprovalHash,proof.mailboxContentHash);
  assert.equal(proof.body,core.draft.english);
  assert.equal(save.state.saveCalls,1);assert.equal(save.state.inspectCalls,1);
  assert.deepEqual(events.map(e=>e.event),['draft_save_started','draft_save_intent','draft_handoff_verified']);
  await assert.rejects(()=>saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter}),/ALREADY_ATTEMPTED/);
});
test('unapproved or provisional core drafts never enter the browser save path',async t=>{
  for(const mode of ['unapproved','provisional']){
    const core=setup(t,{newness:mode==='provisional'?'provisional':'verified'}),save=saver();
    if(mode==='unapproved')core.workflow.draft(core.leadId).approval=null;
    await assert.rejects(()=>saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter}),/APPROVAL|NEWNESS/);
    assert.equal(save.state.saveCalls,0);assert.equal(save.state.readCalls,0);
  }
});
test('expired approval, changed products, edited draft or changed account block saving',async t=>{
  for(const change of ['expiry','products','draft','account']){
    const core=setup(t),save=saver();
    if(change==='expiry')core.advance(86400001);
    if(change==='products')core.workflow.config.brand.verifiedFacts.push('New fact');
    if(change==='draft')core.workflow.setDraft(core.leadId,{...core.draft,english:core.draft.english+' Changed.'});
    if(change==='account')core.workflow.config.accountId='other@example.test';
    await assert.rejects(()=>saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter}),/EXPIRED|evidence|APPROVAL|ACCOUNT/);
    assert.equal(save.state.saveCalls,0);
  }
});
test('save hook rechecks approval and a failed durable intent prevents the save action',async t=>{
  const core=setup(t),save=saver();const original=save.adapter.save;
  save.adapter.save=async(packet,options)=>{core.workflow.config.brand.verifiedFacts.push('Changed while filling');return original(packet,options);};
  await assert.rejects(()=>saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter}),/evidence/);
  assert.equal(save.state.saveCalls,0);
  const second=setup(t),s2=saver();
  await assert.rejects(()=>saveApprovedDraft({...second,expectedCoreHash:second.hash,adapter:s2.adapter,store:{save:e=>{if(e.event==='draft_save_intent')throw Error('Disk full');}}}),/Disk full/);
  assert.equal(s2.state.saveCalls,0);
});
test('incomplete draft search and matching pre-existing draft do not create a new draft',async t=>{
  for(const kind of ['incomplete','existing']){
    const core=setup(t),save=saver();
    if(kind==='incomplete')save.adapter.readExisting=async()=>({accountId:core.workflow.config.accountId,complete:false,drafts:[]});
    else save.state.drafts.push({accountId:core.workflow.config.accountId,draftId:'old-draft',recipient:core.draft.recipient,subject:core.draft.subject});
    await assert.rejects(()=>saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter}),/COMPLETE_DRAFT_SEARCH|MATCHING_EXISTING/);
    assert.equal(save.state.saveCalls,0);
  }
});
test('old ID reuse, duplicate new candidates and wrong returned save ID cannot establish proof',async t=>{
  for(const kind of ['old','duplicate','wrong-id']){
    const core=setup(t),save=saver(),original=save.adapter.save;
    if(kind==='old')save.state.drafts.push({accountId:core.workflow.config.accountId,draftId:'1795000000000000001',recipient:'old@events.example.test',subject:'Old unrelated draft'});
    save.adapter.save=async(packet,options)=>{
      if(kind==='old')save.state.drafts=[];
      const result=await original(packet,options);
      if(kind==='duplicate')save.state.drafts.push({...clone(save.state.drafts[0]),draftId:'1795000000000000002'});
      return kind==='wrong-id'?{...result,draftId:'incorrect-id'}:result;
    };
    await assert.rejects(()=>saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter}),/ID_MISSING_OR_AMBIGUOUS|ID_MISMATCH/);
    assert.equal(save.state.saveCalls,1);
  }
});
test('readback must match account, exact body, recipient, no cc and mailbox content hash',async t=>{
  for(const change of ['account','body','recipient','cc','hash']){
    const core=setup(t),save=saver(),original=save.adapter.inspect;
    save.adapter.inspect=async ref=>{
      const item=await original(ref);
      if(change==='account')item.accountId='other@example.test';
      if(change==='body')item.body+=' Unapproved automatic signature';
      if(change==='recipient')item.recipient='other@events.example.test';
      if(change==='cc')item.cc=['other@events.example.test'];
      if(change==='hash')item.approvedHash=core.hash;
      return item;
    };
    await assert.rejects(()=>saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter}),/CONTENT_MISMATCH|HASH_OR_VERSION/);
    assert.equal(save.state.saveCalls,1);
  }
});
test('unknown or throwing save is never retried or claimed as a verified draft',async t=>{
  for(const kind of ['unknown','throw']){
    const core=setup(t),save=saver();
    save.adapter.save=async(packet,{beforeSave})=>{
      await beforeSave();save.state.saveCalls++;
      if(kind==='throw')throw Error('Lost save acknowledgement');
      return {status:'unknown'};
    };
    await assert.rejects(()=>saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter}),/UNCONFIRMED|Lost save/);
    await assert.rejects(()=>saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter}),/ALREADY_ATTEMPTED/);
    assert.equal(save.state.saveCalls,1);
  }
});
test('adapter must obtain the save hook once; no save result alone counts',async t=>{
  const core=setup(t),save=saver();
  save.adapter.save=async()=>({status:'saved'});
  await assert.rejects(()=>saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter}),/AUTHORIZATION_HOOK_REQUIRED/);
  const c2=setup(t),s2=saver();
  s2.adapter.save=async(packet,{beforeSave})=>{await beforeSave();await beforeSave();return {status:'saved'};};
  await assert.rejects(()=>saveApprovedDraft({...c2,expectedCoreHash:c2.hash,adapter:s2.adapter}),/HOOK_ALREADY_USED/);
});
test('concurrent save operations for the same core lead are rejected before duplicate writes',async t=>{
  const core=setup(t),save=saver();let release;
  const original=save.adapter.readExisting;save.adapter.readExisting=async args=>{await new Promise(r=>release=r);save.adapter.readExisting=original;return original(args);};
  const pending=saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter});
  await assert.rejects(()=>saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter}),/ALREADY_ATTEMPTED/);
  release();await pending;assert.equal(save.state.saveCalls,1);
});
test('binding scans only verified original IDs and never overwrites the mailbox hash',async t=>{
  const core=await handoff(t),raw=browser(core.binding);
  const bound=bindApprovedDrafts({workflow:core.workflow,bindings:[core.binding],adapter:raw.adapter});
  const refs=await bound.scanDrafts({limit:50});assert.equal(refs.length,1);
  const inspected=await bound.inspectDraft(refs[0]);
  assert.equal(inspected.approvedHash,core.binding.mailboxContentHash);
  assert.notEqual(inspected.approvedHash,core.binding.coreApprovalHash);
  await assert.rejects(()=>bound.inspectDraft({...refs[0],draftId:'unbound'}),/UNBOUND/);
});
test('changed approval or product facts during inspection or preflight stop the handoff',async t=>{
  for(const method of ['inspectDraft','preflight']){
    const core=await handoff(t),raw=browser(core.binding),original=raw.adapter[method];
    raw.adapter[method]=async(...args)=>{const result=await original(...args);core.workflow.config.brand.verifiedFacts.push('Changed');return result;};
    const bound=bindApprovedDrafts({workflow:core.workflow,bindings:[core.binding],adapter:raw.adapter});
    if(method==='inspectDraft')await assert.rejects(()=>bound.inspectDraft(raw.item),/evidence/);
    else await assert.rejects(()=>bound.preflight(raw.item),/evidence/);
  }
});
test('send pacing revalidation checks current approval after the wait before the click',async t=>{
  const core=await handoff(t),raw=browser(core.binding);
  const bound=bindApprovedDrafts({workflow:core.workflow,bindings:[core.binding],adapter:raw.adapter});
  await assert.rejects(()=>bound.send(raw.item,{beforeClick:async({revalidate})=>{core.advance(86400001);await revalidate();}}),/EXPIRED/);
  assert.equal(raw.state.clicks,0);
});
test('a change inside fresh page revalidation is blocked before dispatch',async t=>{
  const core=await handoff(t),raw=browser(core.binding);
  raw.adapter.send=async(item,{beforeClick})=>{
    await beforeClick({revalidate:async()=>{core.workflow.config.brand.verifiedFacts.push('Changed during page read');}});
    raw.state.clicks++;return {status:'unknown'};
  };
  const bound=bindApprovedDrafts({workflow:core.workflow,bindings:[core.binding],adapter:raw.adapter});
  await assert.rejects(()=>bound.send(raw.item,{beforeClick:async({revalidate})=>await revalidate()}),/evidence/);
  assert.equal(raw.state.clicks,0);
});
test('unknown send and read-only reconciliation stay unknown without hidden retries',async t=>{
  const core=await handoff(t),raw=browser(core.binding);
  const bound=bindApprovedDrafts({workflow:core.workflow,bindings:[core.binding],adapter:raw.adapter});
  const result=await bound.send(raw.item,{beforeClick:async({revalidate})=>await revalidate()});
  assert.equal(result.status,'unknown');assert.equal(raw.state.sendCalls,1);assert.equal(raw.state.clicks,1);
  core.advance(86400001);
  assert.equal((await bound.reconcile(raw.item)).status,'unknown');
  assert.equal(raw.state.reconciles,1);assert.equal(raw.state.sendCalls,1);
});
test('cleanup rechecks the approval but reconciliation does not rewrite a sent result',async t=>{
  const core=await handoff(t),raw=browser(core.binding);
  const bound=bindApprovedDrafts({workflow:core.workflow,bindings:[core.binding],adapter:raw.adapter});
  await assert.rejects(()=>bound.cleanup(raw.item,{status:'sent'},{beforeClick:async()=>{core.workflow.config.brand.verifiedFacts.push('Changed');}}),/evidence/);
  assert.equal(raw.state.cleanups,0);
  const receipt={status:'sent',authoritative:true,messageId:'sent-1',approvedHash:raw.item.approvedHash};
  raw.adapter.reconcile=async()=>receipt;
  assert.deepEqual(await bound.reconcile(raw.item),receipt);
});
test('invalid binding integrity and duplicate lead bindings are rejected',async t=>{
  const core=await handoff(t),raw=browser(core.binding);
  assert.throws(()=>bindApprovedDrafts({workflow:core.workflow,bindings:[{...core.binding,body:'Unapproved body'}],adapter:raw.adapter}),/HASH_MISMATCH/);
  assert.throws(()=>bindApprovedDrafts({workflow:core.workflow,bindings:[core.binding,core.binding],adapter:raw.adapter}),/DUPLICATE/);
});
test('cancelled handoff never saves and aborted before-save retains a review reservation',async t=>{
  const core=setup(t),save=saver(),abort=new AbortController();abort.abort();
  await assert.rejects(()=>saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter,signal:abort.signal}),/CANCELLED/);
  assert.equal(save.state.saveCalls,0);
  const c2=setup(t),s2=saver(),a2=new AbortController();
  s2.adapter.save=async(packet,{beforeSave})=>{a2.abort();await beforeSave();s2.state.saveCalls++;return {status:'saved'};};
  await assert.rejects(()=>saveApprovedDraft({...c2,expectedCoreHash:c2.hash,adapter:s2.adapter,signal:a2.signal}),/CANCELLED/);
  assert.equal(s2.state.saveCalls,0);
  await assert.rejects(()=>saveApprovedDraft({...c2,expectedCoreHash:c2.hash,adapter:s2.adapter}),/ALREADY_ATTEMPTED/);
});
test('readApprovedDraft checks suppression and never calls approval on behalf of the user',t=>{
  const core=setup(t);core.workflow.approve=()=>{throw Error('Must never be called');};
  assert.equal(readApprovedDraft({workflow:core.workflow,leadId:core.leadId,expectedCoreHash:core.hash}).coreApprovalHash,core.hash);
  core.workflow.suppress({recipient:core.draft.recipient,reason:'Synthetic opt-out'});
  assert.throws(()=>readApprovedDraft({workflow:core.workflow,leadId:core.leadId,expectedCoreHash:core.hash}),/suppressed/);
});

test('prepared refs preserve separate mailbox and core identities',async t=>{
  const core=await handoff(t),refs=preparedRefsForBindings([core.binding]);
  assert.deepEqual(refs,[{accountId:core.binding.accountId,draftId:core.binding.mailboxDraftId,draftVersion:core.binding.mailboxDraftVersion,recipient:core.binding.recipient,subject:core.binding.subject,approvedHash:core.binding.mailboxContentHash,bodySerialization:'native-ax-text-v1'}]);
  assert.throws(()=>preparedRefsForBindings([{...core.binding,body:'Changed'}]),/HASH_MISMATCH/);
  assert.throws(()=>preparedRefsForBindings([core.binding,core.binding]),/DUPLICATE/);
});

test('new-compose handoff refuses threaded replies even with verified ownership',async t=>{
  const core=setup(t),save=saver(),lead=core.workflow.lead(core.leadId);
  Object.assign(lead,{purpose:'reply',threadOwnershipVerified:true,threadId:'synthetic-thread',replyToMessageId:'synthetic-inbound',inboundContext:'Synthetic enquiry'});
  assert.throws(()=>readApprovedDraft({workflow:core.workflow,leadId:core.leadId,expectedCoreHash:core.hash}),/REPLY_DRAFT_HANDOFF_NOT_SUPPORTED/);
  await assert.rejects(()=>saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter}),/REPLY_DRAFT_HANDOFF_NOT_SUPPORTED/);
  assert.equal(save.state.saveCalls,0);assert.equal(save.state.readCalls,0);
});

function existingApprovedDraft(core,save,id='1795000000000000001') {
  const packet=readApprovedDraft({workflow:core.workflow,leadId:core.leadId,expectedCoreHash:core.hash});
  const approvedHash=hash({accountId:packet.accountId,recipient:packet.recipient,subject:packet.subject,body:packet.body});
  const item={...clone(packet),draftId:id,draftVersion:approvedHash,approvedHash};
  save.state.drafts.push(item);return item;
}
test('explicit existing-draft reconciliation only reads and marks the recovery method',async t=>{
  const core=setup(t),save=saver(),events=[],item=existingApprovedDraft(core,save);
  const prior={attemptId:'original-uncertain-attempt',event:'draft_handoff_needs_review',error:'Body mismatch during original save'};
  core.workflow.state.mailboxDraftSaveAttempts={[core.leadId]:clone(prior)};
  save.adapter.save=()=>{throw Error('Reconciliation must never call save');};
  const proof=await reconcileApprovedDraftSave({...core,expectedCoreHash:core.hash,expectedMailboxDraftId:item.draftId,adapter:save.adapter,store:{save:event=>events.push(event)}});
  assert.equal(proof.status,'saved_and_readback_verified');
  assert.equal(proof.recoveryMethod,'explicit_existing_draft_reconciliation');
  assert.equal(proof.originalSaveAttemptId,prior.attemptId);
  assert.equal(proof.mailboxDraftId,item.draftId);assert.equal(proof.coreApprovalHash,core.hash);
  assert.notEqual(proof.coreApprovalHash,proof.mailboxContentHash);
  assert.equal(save.state.saveCalls,0);assert.equal(save.state.readCalls,1);assert.equal(save.state.inspectCalls,1);
  assert.deepEqual(core.workflow.state.mailboxDraftSaveAttempts[core.leadId],prior);
  assert.deepEqual(events.map(e=>e.event),['draft_handoff_verified']);
  assert.equal(events[0].attemptId,prior.attemptId);
});
test('reconciliation requires the explicit original ID, not a matching subject or another ID',async t=>{
  for(const id of [undefined,'','different-id']){
    const core=setup(t),save=saver();existingApprovedDraft(core,save);
    await assert.rejects(()=>reconcileApprovedDraftSave({...core,expectedCoreHash:core.hash,expectedMailboxDraftId:id,adapter:save.adapter}),/EXPLICIT_MAILBOX_DRAFT_ID_REQUIRED|EXPLICIT_ORIGINAL_DRAFT_NOT_FOUND/);
    assert.equal(save.state.saveCalls,0);assert.equal(save.state.inspectCalls,0);
  }
});
test('reconciliation rejects incomplete scope, wrong account and duplicate IDs',async t=>{
  for(const change of ['incomplete','account','duplicate']){
    const core=setup(t),save=saver(),item=existingApprovedDraft(core,save),read=save.adapter.readExisting;
    save.adapter.readExisting=async args=>{
      const result=await read(args);
      if(change==='incomplete')result.complete=false;
      if(change==='account')result.accountId='other@example.test';
      if(change==='duplicate')result.drafts.push(clone(result.drafts[0]));
      return result;
    };
    await assert.rejects(()=>reconcileApprovedDraftSave({...core,expectedCoreHash:core.hash,expectedMailboxDraftId:item.draftId,adapter:save.adapter}),/COMPLETE_DRAFT_SEARCH_REQUIRED|DRAFT_SEARCH_BINDING_AMBIGUOUS/);
    assert.equal(save.state.saveCalls,0);assert.equal(save.state.inspectCalls,0);
  }
});
test('reconciliation checks recipient and subject for that exact ID before opening it',async t=>{
  for(const change of ['recipient','subject']){
    const core=setup(t),save=saver(),item=existingApprovedDraft(core,save);
    item[change]=change==='recipient'?'other@events.example.test':'Another subject';
    await assert.rejects(()=>reconcileApprovedDraftSave({...core,expectedCoreHash:core.hash,expectedMailboxDraftId:item.draftId,adapter:save.adapter}),/EXPLICIT_ORIGINAL_DRAFT_CONTENT_MISMATCH/);
    assert.equal(save.state.saveCalls,0);assert.equal(save.state.inspectCalls,0);
  }
});
test('existing-draft readback must match the original ID and exact approved full body',async t=>{
  for(const change of ['id','body','hash','cc']){
    const core=setup(t),save=saver(),item=existingApprovedDraft(core,save),inspect=save.adapter.inspect;
    save.adapter.inspect=async ref=>{
      const result=await inspect(ref);
      if(change==='id')result.draftId='another-id';
      if(change==='body')result.body=result.body.replace('\n','\n\n');
      if(change==='hash')result.approvedHash=core.hash;
      if(change==='cc')result.cc=['other@events.example.test'];
      return result;
    };
    await assert.rejects(()=>reconcileApprovedDraftSave({...core,expectedCoreHash:core.hash,expectedMailboxDraftId:item.draftId,adapter:save.adapter}),/EXPLICIT_ORIGINAL_DRAFT_ID_MISMATCH|MAILBOX_DRAFT_CONTENT_MISMATCH|MAILBOX_CONTENT_HASH_OR_VERSION_MISMATCH/);
    assert.equal(save.state.saveCalls,0);
  }
});
test('changed or expired approval is rechecked throughout the read-only recovery',async t=>{
  for(const stage of ['before','search','inspect','expiry']){
    const core=setup(t),save=saver(),item=existingApprovedDraft(core,save);
    if(stage==='before')core.workflow.setDraft(core.leadId,{...core.draft,english:core.draft.english+' Changed.'});
    if(stage==='expiry')core.advance(86400001);
    if(stage==='search'){const read=save.adapter.readExisting;save.adapter.readExisting=async args=>{const result=await read(args);core.workflow.config.brand.verifiedFacts.push('Changed during search');return result;};}
    if(stage==='inspect'){const inspect=save.adapter.inspect;save.adapter.inspect=async ref=>{const result=await inspect(ref);core.workflow.config.brand.verifiedFacts.push('Changed during readback');return result;};}
    await assert.rejects(()=>reconcileApprovedDraftSave({...core,expectedCoreHash:core.hash,expectedMailboxDraftId:item.draftId,adapter:save.adapter}),/APPROVAL|EXPIRED|evidence/);
    assert.equal(save.state.saveCalls,0);
  }
});
test('successful reconciliation retains the unknown-save reservation and never retries creation',async t=>{
  const core=setup(t),save=saver(),originalSave=save.adapter.save;
  save.adapter.save=async(packet,options)=>{await originalSave(packet,options);return {status:'unknown'};};
  await assert.rejects(()=>saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter}),/UNCONFIRMED/);
  const proof=await reconcileApprovedDraftSave({...core,expectedCoreHash:core.hash,expectedMailboxDraftId:save.state.drafts[0].draftId,adapter:save.adapter});
  assert.equal(proof.recoveryMethod,'explicit_existing_draft_reconciliation');
  await assert.rejects(()=>saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter}),/ALREADY_ATTEMPTED/);
  assert.equal(save.state.saveCalls,1);
});
test('a read-only recovery adapter needs no save, send or delete capability',async t=>{
  const core=setup(t),save=saver(),item=existingApprovedDraft(core,save);
  const readOnly={readExisting:save.adapter.readExisting,inspect:save.adapter.inspect,identity:save.adapter.identity};
  const proof=await reconcileApprovedDraftSave({...core,expectedCoreHash:core.hash,expectedMailboxDraftId:item.draftId,adapter:readOnly});
  assert.equal(proof.mailboxDraftId,item.draftId);
  assert.equal(save.state.saveCalls,0);
});
test('cancelled recovery and failed proof persistence do not mutate the mailbox',async t=>{
  for(const change of ['abort','store']){
    const core=setup(t),save=saver(),item=existingApprovedDraft(core,save),abort=new AbortController();
    if(change==='abort'){const inspect=save.adapter.inspect;save.adapter.inspect=async ref=>{const result=await inspect(ref);abort.abort();return result;};}
    const store=change==='store'?{save:()=>{throw Error('Proof disk unavailable');}}:undefined;
    await assert.rejects(()=>reconcileApprovedDraftSave({...core,expectedCoreHash:core.hash,expectedMailboxDraftId:item.draftId,adapter:save.adapter,signal:abort.signal,store}),/CANCELLED|Proof disk unavailable/);
    assert.equal(save.state.saveCalls,0);assert.equal(save.state.drafts.length,1);
  }
});

test('save reconciliation never erases persisted send usage or replaces another approved attempt',async t=>{
  for(const change of ['sent','unknown','attempt-hash','attempt-account']){
    const core=setup(t),save=saver(),item=existingApprovedDraft(core,save);
    if(change==='sent'||change==='unknown')core.workflow.state.mailboxDraftBindings={[core.leadId]:{usage:{status:change,runId:'prior-send-run'}}};
    if(change==='attempt-hash')core.workflow.state.mailboxDraftSaveAttempts={[core.leadId]:{coreApprovalHash:'another-approved-hash'}};
    if(change==='attempt-account')core.workflow.state.mailboxDraftSaveAttempts={[core.leadId]:{accountId:'other@example.test'}};
    const previous=clone(core.workflow.state.mailboxDraftBindings??{});
    await assert.rejects(()=>reconcileApprovedDraftSave({...core,expectedCoreHash:core.hash,expectedMailboxDraftId:item.draftId,adapter:save.adapter}),/HANDOFF_SEND_ALREADY_ATTEMPTED|ORIGINAL_SAVE_ATTEMPT_BINDING_CHANGED/);
    assert.deepEqual(core.workflow.state.mailboxDraftBindings??{},previous);assert.equal(save.state.readCalls,0);assert.equal(save.state.saveCalls,0);
  }
});

test('save and read-only recovery retain visible-body audit evidence without changing content hash',async t=>{
  for(const recovery of [false,true]){
    const core=setup(t),save=saver(),inspect=save.adapter.inspect;
    const bodyEvidence={source:'visible-editor-dom',serializer:'visible-plain-lines-v1',axTextComparison:'non-whitespace-equal'};
    save.adapter.inspect=async(...args)=>({...await inspect(...args),bodySerialization:'visible-plain-lines-v1',bodyEvidence});
    let proof;
    if(recovery){const item=existingApprovedDraft(core,save);proof=await reconcileApprovedDraftSave({...core,expectedCoreHash:core.hash,expectedMailboxDraftId:item.draftId,adapter:save.adapter});}
    else proof=await saveApprovedDraft({...core,expectedCoreHash:core.hash,adapter:save.adapter});
    assert.equal(proof.bodySerialization,'visible-plain-lines-v1');assert.deepEqual(proof.bodyEvidence,bodyEvidence);
    assert.equal(proof.mailboxContentHash,hash({accountId:proof.accountId,recipient:proof.recipient,subject:proof.subject,body:proof.body}));
    const refs=preparedRefsForBindings([proof]);assert.deepEqual(refs[0].bodyEvidence,bodyEvidence);
    const raw=browser(proof),bound=bindApprovedDrafts({workflow:core.workflow,bindings:[proof],adapter:raw.adapter});
    assert.deepEqual(await bound.scanDrafts(),refs);
    assert.equal(save.state.saveCalls,recovery?0:1);
  }
});
