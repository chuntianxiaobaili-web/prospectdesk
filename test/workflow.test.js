import vm from 'node:vm';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {SalesWorkflow} from '../src/workflow.js';import {MockDraftAdapter,MockMailbox} from '../src/mock.js';import {parseCSV,clean,hash} from '../src/import.js';
export const config={brand:{name:'Synthetic Flowers',products:['artificial flowers'],verifiedFacts:['Example only']},accountId:'mock@example.test',draftModel:{provider:'mock',model:'draft-high'},sendModel:{provider:'mock',model:'execution'},pacing:{minSeconds:1,maxSeconds:2}};
const row=(n=1)=>({company:`Company ${n}`,website:`https://company${n}.test`,email:`sales@company${n}.test`,need:`artificial arrangements ${n}`,sourceUrl:`https://company${n}.test/contact`,sourceDate:'2026-10-23',evidence:`Published sales@company${n}.test`,newness:'verified',contactStatus:'not contacted'});
function setup(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sales-test-'));let now=100000;const mailAdapter=new MockMailbox();const opts={directory,config:{...config,accountLockDirectory:directory+'/account-locks'},mailAdapter,draftAdapter:new MockDraftAdapter(),now:()=>now};const w=new SalesWorkflow(opts);t.after(()=>{w.close();fs.rmSync(directory,{recursive:true,force:true});});return {w,opts,mailAdapter,advance:()=>now+=3000};}
async function ready(w,n=1){const {accepted}=w.importRows([row(n)]);const id=accepted[0],d=await w.generateDraft(id);w.approve(id,{hash:d.hash,reviewer:'Human QA',acknowledgedRecipient:d.recipient});return {id,d,q:w.enqueue(id)};}
test('CSV multiline quoting and malformed input',()=>{assert.equal(parseCSV('a,b\n"one\ntwo","x"')[0].a,'one\ntwo');assert.throws(()=>parseCSV('a,b\n"x,y'));});
test('duplicate company/domain/group rejected and history applies after import',t=>{const {w}=setup(t);const id=w.importRows([row()]).accepted[0];assert.equal(w.importRows([row()]).rejected.length,1);w.importHistory([{company:'Company 1'}]);assert.throws(()=>w.prepareDraft(id),/historical/);});
test('unverified history can draft, cannot approve',async t=>{const {w}=setup(t);const id=w.importRows([{...row(),newness:'provisional'}]).accepted[0];const d=await w.generateDraft(id);assert.throws(()=>w.approve(id,{hash:d.hash,reviewer:'QA',acknowledgedRecipient:d.recipient}),/newness/);});
test('review hash and recipient exact; edits invalidate approval',async t=>{const {w}=setup(t);const {id,d,q}=await ready(w);assert.throws(()=>w.setDraft(id,d),/Cancel/);w.cancel(q.id);const changed=w.setDraft(id,{...d,english:d.english+' Updated.'});assert.equal(changed.approval,null);assert.throws(()=>w.enqueue(id),/approved/);assert.throws(()=>w.approve(id,{hash:d.hash,reviewer:'QA',acknowledgedRecipient:d.recipient}),/exact/);});
test('mock send, no duplicate, global pacing persists for late enqueue',async t=>{const {w,mailAdapter,advance}=setup(t);const {id}=await ready(w);w.resume();assert.equal((await w.tick()).mode,'mock');assert.equal(mailAdapter.messages.size,1);assert.throws(()=>w.enqueue(id),/Already/);await ready(w,2);assert.equal((await w.tick()).status,'waiting');advance();assert.equal((await w.tick()).status,'sent');});
test('lost ack pauses; authoritative reconcile avoids resend after restart',async t=>{const {w,opts,mailAdapter}=setup(t);const {q}=await ready(w);mailAdapter.failAfterAccept=true;w.resume();assert.equal((await w.tick()).status,'unknown');assert.throws(()=>w.resume(),/Reconcile/);w.close();const restarted=new SalesWorkflow(opts);try{assert.equal(restarted.status().paused,true);assert.equal((await restarted.reconcile(q.id)).status,'sent');assert.equal(mailAdapter.messages.size,1);}finally{restarted.close();}});
test('cancel and reenqueue same draft uses one queue identity',async t=>{const {w}=setup(t);const {id,q}=await ready(w);w.cancel(q.id);assert.equal(w.enqueue(id).id,q.id);assert.equal(w.status().queue.length,1);w.cancel(q.id);assert.equal(w.status().queue[0].status,'cancelled');});
test('stop suppression cancels queued item; fresh reply preflight holds',async t=>{const {w,mailAdapter}=setup(t);const {id}=await ready(w);w.suppress({recipient:row().email,reason:'Explicit stop'});assert.throws(()=>w.prepareDraft(id),/suppressed/);assert.equal(w.status().queue[0].status,'suppressed');await ready(w,2);mailAdapter.preflight=async()=>({accountId:config.accountId,accountVerified:true,recipientVerified:true,fresh:true,latestReply:true});w.resume();await assert.rejects(()=>w.tick(),/preflight hold/);assert.equal(mailAdapter.messages.size,0);});
test('single instance lock and paused restart',async t=>{const {w,opts}=setup(t);await ready(w);assert.throws(()=>new SalesWorkflow(opts),/already open/);w.close();const x=new SalesWorkflow(opts);assert.equal(x.status().paused,true);x.close();});
test('approval expiry blocks execution',async t=>{const {w}=setup(t);await ready(w);w.state.drafts[Object.keys(w.state.drafts)[0]].approval.expiresAt=0;w.resume();await assert.rejects(()=>w.tick(),/expired/);});
test('reply retains inbound context and requires verified thread ownership',async t=>{const {w}=setup(t);const id=w.importRows([{...row(),purpose:'reply',newness:'provisional',threadOwnershipVerified:true,threadId:'t1',replyToMessageId:'m1',inboundContext:'Please share dimensions.'}]).accepted[0];assert.match(w.prepareDraft(id).prompt,/dimensions/);const d=await w.generateDraft(id);w.approve(id,{hash:d.hash,reviewer:'QA',acknowledgedRecipient:d.recipient});assert.equal(w.enqueue(id).status,'queued');});
test('screened but rejected identity cannot re-enter as new',t=>{const {w}=setup(t);assert.equal(w.importRows([{...row(),email:''}]).rejected.length,1);assert.equal(w.importRows([row()]).rejected.length,1);});
test('same account across directories serializes mailbox preflight/send',async t=>{const {w,opts}=setup(t);await ready(w);const secondDir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-second-'));const x=new SalesWorkflow({...opts,directory:secondDir});t.after(()=>{x.close();fs.rmSync(secondDir,{recursive:true,force:true});});await ready(x,2);let release;w.mailAdapter.preflight=()=>new Promise(r=>release=()=>r({accountId:config.accountId,accountVerified:true,recipientVerified:true,fresh:true}));w.resume();x.resume();const pending=w.tick();await assert.rejects(()=>x.tick(),/account already executing/);release();await pending;});
test('cancel or edit during preflight cannot send stale approved snapshot',async t=>{const {w,mailAdapter}=setup(t);const {id,d,q}=await ready(w);let release;mailAdapter.preflight=()=>new Promise(r=>release=()=>r({accountId:config.accountId,accountVerified:true,recipientVerified:true,fresh:true}));w.resume();const pending=w.tick();w.cancel(q.id);w.setDraft(id,{...d,english:d.english+' Changed during wait.'});release();await assert.rejects(()=>pending,/cancelled/);assert.equal(mailAdapter.messages.size,0);});
test('close during send waits quiescence before releasing state lock',async t=>{const {w,opts,mailAdapter}=setup(t);await ready(w);let release;const original=mailAdapter.send.bind(mailAdapter);mailAdapter.send=m=>new Promise(resolve=>release=async()=>resolve(await original({...m,signal:undefined})));w.resume();const pending=w.tick();await new Promise(r=>setImmediate(r));const closed=w.close();assert.throws(()=>new SalesWorkflow(opts),/already open/);await release();await pending;await closed;assert.equal(w.closed,true);const reopened=new SalesWorkflow(opts);assert.equal(reopened.status().queue[0].status,'sent');reopened.close();});
test('batch count/pause plan executes exact counts and stops at completion',async t=>{const {w,advance}=setup(t);await ready(w,1);await ready(w,2);await ready(w,3);w.setBatchPlan([{count:2,pauseSeconds:2},{count:1,pauseSeconds:0}]);w.resume();assert.equal((await w.tick()).status,'sent');assert.equal((await w.tick()).status,'waiting');advance();assert.equal((await w.tick()).status,'sent');assert.equal((await w.tick()).status,'waiting');advance();assert.equal((await w.tick()).status,'sent');assert.equal(w.status().batchProgress.complete,true);assert.throws(()=>w.resume(),/plan complete/);});
test('production drafting refuses incomplete learning playbook',async t=>{const {w}=setup(t);w.draftAdapter={generate:async()=>({subject:'x',english:'x',chinese:'x'})};const id=w.importRows([row()]).accepted[0];await assert.rejects(()=>w.generateDraft(id),/100 distinct/);});
test('email evidence substring and impossible dates are rejected',t=>{const {w}=setup(t);assert.equal(w.importRows([{...row(5),evidence:'notsales@company5.test'}]).rejected.length,1);assert.equal(w.importRows([{...row(6),sourceDate:'2026-02-30'}]).rejected.length,1);});


test('planned queue start survives a restart and manual resume', async t => {
  const {w, opts, advance, mailAdapter} = setup(t);
  const {q} = await ready(w);
  w.resume({notBefore: 103000, allowedIds: new Set([q.id])});
  assert.deepEqual(await w.tick(), {status: 'waiting', notBefore: 103000});
  await w.close();
  const restarted = new SalesWorkflow(opts);
  t.after(() => restarted.close());
  assert.equal(restarted.status().paused, true);
  restarted.resume();
  assert.equal((await restarted.tick()).status, 'waiting');
  assert.equal(mailAdapter.messages.size, 0);
  advance();
  assert.equal((await restarted.tick()).status, 'sent');
  await restarted.close();
});

test('mailbox compatibility only reads readiness and excludes private data', async t => {
  const {w, mailAdapter} = setup(t);
  await ready(w);
  const before = w.status();
  const safe = await w.mailboxCompatibility();
  assert.equal(safe.compatible, true);
  assert.equal(safe.mode, 'mock');
  mailAdapter.checkCompatibility = async () => ({
    compatible: false,
    checks: [{id: 'submit_control', ok: false}, {id: 'name@company.test', ok: false}],
    email: 'name@company.test',
    error: 'message preview'
  });
  const failed = await w.mailboxCompatibility();
  assert.deepEqual(failed.checks, [{id: 'submit_control', ok: false}]);
  assert.equal(failed.compatible, false);
  assert.doesNotMatch(JSON.stringify(failed), /company\.test|message preview/);
  assert.equal(mailAdapter.messages.size, 0);
  assert.deepEqual(w.status(), before);
});


test('compatibility probe never competes with a fixed send job', async t => {
  const {w, mailAdapter} = setup(t);
  await ready(w);
  let finish;
  mailAdapter.checkCompatibility = () => new Promise(resolve => { finish = resolve; });
  assert.equal((await w.mailboxCompatibility({busy: true})).status, 'busy');
  const probe = w.mailboxCompatibility();
  assert.equal((await w.mailboxCompatibility()).status, 'busy');
  w.resume();
  assert.equal((await w.tick()).status, 'paused_or_busy');
  assert.equal(mailAdapter.messages.size, 0);
  finish({compatible: true});
  assert.equal((await probe).compatible, true);
});


function addMailboxDraft(mailbox, queued) {
  const entry = {
    binding: {accountId: config.accountId, draftId: 'draft-123', draftVersion: 'revision-1', approvedHash: queued.snapshot.hash},
    recipient: queued.snapshot.recipient, subject: queued.snapshot.subject, body: queued.snapshot.english
  };
  mailbox.drafts.set(queued.id, entry);
  return entry;
}

test('record sent before moving only the exact unchanged original into Trash', async t => {
  const {w, mailAdapter} = setup(t);
  const {q} = await ready(w);
  const selected = addMailboxDraft(mailAdapter, q);
  const duplicate = {...selected, binding: {...selected.binding, draftId: 'different-provider-draft'}};
  mailAdapter.drafts.set('unrelated', duplicate);
  const trash = mailAdapter.trashSentDraft.bind(mailAdapter);
  mailAdapter.trashSentDraft = packet => {
    const saved = JSON.parse(fs.readFileSync(w.file, 'utf8')).queue[0];
    assert.equal(saved.status, 'sent');
    assert.equal(saved.draftCleanup.status, 'pending');
    assert.equal(saved.receipt.messageId, packet.sentMessageId);
    assert.deepEqual(saved.draftBinding, selected.binding);
    return trash(packet);
  };

  w.resume();
  const result = await w.tick();
  assert.equal(result.status, 'sent');
  assert.deepEqual(result.draftCleanup, {status: 'trashed'});
  assert.equal(mailAdapter.drafts.has(q.id), false);
  assert.deepEqual(mailAdapter.trash.get(q.id), selected);
  assert.deepEqual(mailAdapter.drafts.get('unrelated'), duplicate);
  assert.equal(mailAdapter.messages.size, 1);
});

test('record absence when the provider consumed the exact bound draft on send', async t => {
  const {w, mailAdapter} = setup(t);
  const {q} = await ready(w);
  addMailboxDraft(mailAdapter, q);
  const send = mailAdapter.send.bind(mailAdapter);
  mailAdapter.send = async packet => {
    const receipt = await send(packet);
    mailAdapter.drafts.delete(packet.idempotencyKey);
    return receipt;
  };

  w.resume();
  const result = await w.tick();
  assert.equal(result.status, 'sent');
  assert.deepEqual(result.draftCleanup, {status: 'already_absent'});
  assert.equal(mailAdapter.trash.size, 0);
});

test('unknown send never cleans until its receipt is confirmed on restart', async t => {
  const {w, opts, mailAdapter} = setup(t);
  const {q} = await ready(w);
  addMailboxDraft(mailAdapter, q);
  mailAdapter.failAfterAccept = true;
  w.resume();
  assert.equal((await w.tick()).status, 'unknown');
  assert.equal(mailAdapter.drafts.has(q.id), true);
  assert.equal(mailAdapter.trash.size, 0);
  await w.close();

  const restarted = new SalesWorkflow(opts);
  try {
    const result = await restarted.reconcile(q.id);
    assert.equal(result.status, 'sent');
    assert.equal(result.draftCleanup.status, 'trashed');
    assert.equal(mailAdapter.messages.size, 1);
  } finally {
    await restarted.close();
  }
});

test('uncertain cleanup preserves the sent state and reconciles without a resend', async t => {
  const {w, opts, mailAdapter} = setup(t);
  const {id, q} = await ready(w);
  addMailboxDraft(mailAdapter, q);
  const trash = mailAdapter.trashSentDraft.bind(mailAdapter);
  mailAdapter.trashSentDraft = async packet => {
    await trash(packet);
    throw Error('Mock lost trash acknowledgement');
  };

  w.resume();
  const result = await w.tick();
  assert.equal(result.status, 'sent');
  assert.equal(result.draftCleanup.status, 'needs_review');
  await w.close();
  mailAdapter.trashSentDraft = trash;
  const restarted = new SalesWorkflow(opts);
  try {
    assert.throws(() => restarted.enqueue(id), /Already queued/);
    const confirmed = await restarted.reconcile(q.id);
    assert.equal(confirmed.status, 'sent');
    assert.equal(confirmed.draftCleanup.status, 'already_absent');
    assert.equal(mailAdapter.messages.size, 1);
  } finally {
    await restarted.close();
  }
});

test('mismatched receipt and edited drafts are left for review', async t => {
  for (const change of ['receipt', 'draft']) {
    const {w, mailAdapter} = setup(t);
    const {q} = await ready(w);
    const original = addMailboxDraft(mailAdapter, q);
    const send = mailAdapter.send.bind(mailAdapter);
    const trash = mailAdapter.trashSentDraft.bind(mailAdapter);
    let trashCalls = 0;
    mailAdapter.trashSentDraft = packet => {
      trashCalls++;
      return trash(packet);
    };
    mailAdapter.send = async packet => {
      const receipt = await send(packet);
      if (change === 'receipt') {
        receipt.draftBinding.draftId = 'different-draft';
      } else {
        original.binding.draftVersion = 'revision-2';
        original.body += ' Later edit.';
      }
      return receipt;
    };

    w.resume();
    const result = await w.tick();
    assert.equal(result.status, 'sent');
    assert.equal(result.draftCleanup.status, 'needs_review');
    assert.equal(trashCalls, change === 'receipt' ? 0 : 1);
    assert.equal(mailAdapter.trash.size, 0);
    assert.equal(mailAdapter.drafts.get(q.id), original);
    w.close();
  }
});

test('an unbound send never triggers draft cleanup', async t => {
  const {w, mailAdapter} = setup(t);
  await ready(w);
  let called = false;
  mailAdapter.trashSentDraft = async () => { called = true; };
  w.resume();
  const result = await w.tick();
  assert.equal(result.status, 'sent');
  assert.equal(result.draftCleanup, undefined);
  assert.equal(called, false);
});


// Product-evidence drafting uses real production gates; only the mailbox is synthetic.
function productReviewSetup(t){
  const fixture=setup(t),{w}=fixture;
  w.config.draftingPolicy={mode:'product-evidence-review'};
  w.config.brand={
    name:'Synthetic Flowers',products:['artificial flowers'],
    verifiedFacts:['Offers artificial flowers and foliage'],
    evidenceSources:[{path:'C:/synthetic/product-catalog.pdf',checkedAt:'2026-11-18',readEvidence:'Synthetic catalogue product section inspected',locator:'page 3'}],
    unknowns:['MOQ','lead time']
  };
  w.draftAdapter={generate:async()=>({subject:'Selection review',english:'Hello team, your published event styling uses artificial flowers. Which flower forms would be useful for your next review?',chinese:'您好，贵司公开的活动布置使用仿真花。下一次选品评估需要哪些花型？'})};
  return fixture;
}
function saveProductDraft(w,n=1,newness='verified'){
  const id=w.importRows([{...row(n),newness}]).accepted[0];
  return {id,d:w.setDraft(id,{subject:'Selection '+n,english:'Hello Company '+n+', which artificial flower forms would be useful for your next selection review?',chinese:'Company '+n+' 您好，下一次选品评估需要哪些仿真花型？'})};
}
function approveProductDraft(w,id,d){
  return w.approve(id,{hash:d.hash,reviewer:'Human product QA',acknowledgedRecipient:d.recipient});
}

test('product evidence policy saves a traceable bilingual draft without claiming source learning and still needs exact approval',async t=>{
  const {w,mailAdapter}=productReviewSetup(t);
  const {id,d}=saveProductDraft(w);
  assert.equal(w.state.approvedPlaybook,undefined);
  assert.equal(d.draftingPolicy.mode,'product-evidence-review');
  assert.equal(d.draftingPolicy.basis.verifiedFacts[0],'Offers artificial flowers and foliage');
  assert.equal(d.draftingPolicy.basis.evidenceSources[0].locator,'page 3');
  assert.ok(d.draftingPolicy.basisHash);
  assert.equal(d.approval,null);
  assert.throws(()=>w.enqueue(id),/human-approved/);
  assert.throws(()=>w.approve(id,{hash:'wrong',reviewer:'QA',acknowledgedRecipient:d.recipient}),/exact/);
  approveProductDraft(w,id,d);w.enqueue(id);w.resume();
  assert.equal((await w.tick()).status,'sent');
  assert.equal(mailAdapter.messages.size,1);
});

test('product evidence mode cannot relax history or suppression gates',t=>{
  const {w}=productReviewSetup(t);
  const {id,d}=saveProductDraft(w,1,'provisional');
  assert.throws(()=>approveProductDraft(w,id,d),/newness/);
  w.suppress({recipient:d.recipient,reason:'Explicit stop'});
  assert.throws(()=>w.setDraft(id,{subject:'Updated',english:'Updated text',chinese:'更新稿'}),/suppressed/);
});

test('product evidence mode rejects missing facts, missing source records and incomplete audit fields',t=>{
  const {w}=productReviewSetup(t);
  const id=w.importRows([row()]).accepted[0];
  const good=structuredClone(w.config.brand);
  const bad=[
    {...good,verifiedFacts:[]},
    {...good,verifiedFacts:['  ']},
    {...good,verifiedFacts:{claim:'not an array'}},
    {...good,evidenceSources:[]},
    {...good,evidenceSources:[{path:'C:/synthetic/catalog.pdf',checkedAt:'2026-11-18',readEvidence:' '}]},
    {...good,evidenceSources:[{path:'relative/catalog.pdf',checkedAt:'2026-11-18',readEvidence:'Read page'}]},
    {...good,evidenceSources:[{url:'file:///C:/synthetic/catalog.pdf',checkedAt:'2026-11-18',readEvidence:'Read page'}]},
    {...good,evidenceSources:[{url:'https://catalog.example.test',checkedAt:'2026-02-30',readEvidence:'Read page'}]},
    {...good,evidenceSources:[{url:'https://catalog.example.test',checkedAt:'2026-02-30T12:00:00.000Z',readEvidence:'Read page'}]}
  ];
  for(const brand of bad){w.config.brand=brand;assert.throws(()=>w.setDraft(id,{subject:'Draft',english:'Draft text',chinese:'审核稿'}),/Product evidence/);}
  assert.equal(Object.keys(w.state.drafts).length,0);
});

test('product evidence source may be an actual read website and is retained in the draft review snapshot',t=>{
  const {w}=productReviewSetup(t);
  w.config.brand.evidenceSources=[{url:'https://catalog.example.test/products',checkedAt:'2026-11-18T10:00:00.000Z',readEvidence:'Synthetic official product page body read'}];
  const {id,d}=saveProductDraft(w);
  assert.equal(d.draftingPolicy.basis.evidenceSources[0].url,'https://catalog.example.test/products');
  assert.equal(w.prepareDraft(id).draftingPolicy.basisHash,d.draftingPolicy.basisHash);
  assert.match(w.prepareDraft(id).prompt,/no 100-source learning completion claimed/);
});

test('changing product facts before review or enqueue invalidates the old draft basis',t=>{
  const {w}=productReviewSetup(t);
  const {id,d}=saveProductDraft(w);
  w.config.brand.verifiedFacts.push('An additional synthetic product fact');
  assert.throws(()=>approveProductDraft(w,id,d),/Product evidence or drafting policy changed/);
  const revised=w.setDraft(id,{...d,english:d.english+' Please review the specific product reference.'});
  assert.notEqual(revised.draftingPolicy.basisHash,d.draftingPolicy.basisHash);
  assert.notEqual(revised.hash,d.hash);
  approveProductDraft(w,id,revised);
  w.config.brand.evidenceSources[0].checkedAt='2026-11-19';
  assert.throws(()=>w.enqueue(id),/Product evidence or drafting policy changed/);
});

test('an already queued product-evidence draft stops before mailbox access after a fact change',async t=>{
  const {w,mailAdapter}=productReviewSetup(t);
  const {id,d}=saveProductDraft(w);approveProductDraft(w,id,d);w.enqueue(id);w.resume();
  let calls=0;mailAdapter.preflight=async()=>{calls++;return {};};
  w.config.brand.verifiedFacts[0]='Updated synthetic product fact';
  await assert.rejects(()=>w.tick(),/Product evidence or drafting policy changed/);
  assert.equal(calls,0);assert.equal(mailAdapter.messages.size,0);
  assert.equal(w.state.queue[0].status,'queued');
});

test('product evidence changed during mailbox preflight stops before dispatch',async t=>{
  const {w,mailAdapter}=productReviewSetup(t);
  const {id,d}=saveProductDraft(w);approveProductDraft(w,id,d);w.enqueue(id);w.resume();
  mailAdapter.preflight=async()=>{w.config.brand.products.push('new product');return {accountId:w.config.accountId,accountVerified:true,recipientVerified:true,fresh:true};};
  await assert.rejects(()=>w.tick(),/Product evidence or drafting policy changed/);
  assert.equal(mailAdapter.messages.size,0);assert.equal(w.state.paused,true);
});

test('switching drafting policy does not reuse an approval created under product review',t=>{
  const {w}=productReviewSetup(t);
  const {id,d}=saveProductDraft(w);approveProductDraft(w,id,d);
  delete w.config.draftingPolicy;
  assert.throws(()=>w.enqueue(id),/Drafting policy changed/);
  w.config.draftingPolicy={mode:'unknown'};
  assert.throws(()=>w.setDraft(id,d),/Unknown drafting policy/);
});

test('evidence changes while a model is producing a draft require a new generation',async t=>{
  const {w}=productReviewSetup(t);
  const id=w.importRows([row()]).accepted[0];
  w.draftAdapter.generate=async()=>{w.config.brand.unknowns.push('sample packing');return {subject:'Draft',english:'English draft',chinese:'中文稿'};};
  await assert.rejects(()=>w.generateDraft(id),/Product evidence changed during draft generation/);
  assert.equal(Object.keys(w.state.drafts).length,0);
});

test('product evidence mode never uses the mock drafting bypass for incomplete evidence',t=>{
  const {w}=productReviewSetup(t);
  w.draftAdapter=new MockDraftAdapter();w.config.brand.evidenceSources=[];
  const id=w.importRows([row()]).accepted[0];
  assert.throws(()=>w.setDraft(id,{subject:'Draft',english:'English draft',chinese:'中文稿'}),/auditable evidence sources/);
});


test('workflow lock metadata uses the actual Node PID by default and accepts explicit absent diagnostics',t=>{
  const {w}=setup(t);
  assert.equal(w.runtimePid,process.pid);
  assert.equal(JSON.parse(fs.readFileSync(w.lock,'utf8')).pid,process.pid);
  w.beginMailboxAction();
  assert.equal(JSON.parse(fs.readFileSync(w.accountLock,'utf8')).pid,process.pid);
  w.finishMailboxAction();
  assert.equal(fs.existsSync(w.accountLock),false);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sales-null-pid-'));
  const x=new SalesWorkflow({directory,config:{...config,accountLockDirectory:directory+'/account-locks'},runtimePid:null});
  try{
    assert.equal(x.runtimePid,null);
    assert.equal(JSON.parse(fs.readFileSync(x.lock,'utf8')).pid,null);
    x.beginMailboxAction();
    assert.equal(JSON.parse(fs.readFileSync(x.accountLock,'utf8')).pid,null);
    x.finishMailboxAction();
    assert.equal(fs.existsSync(x.accountLock),false);
  }finally{x.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('workflow diagnostic PID validation happens before creating state or account locks',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sales-invalid-pid-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const opts={directory,config:{...config,accountLockDirectory:directory+'/account-locks'}};
  for(const runtimePid of [0,-1,1.5,NaN,Infinity,'123',false,{},[]]){
    assert.throws(()=>new SalesWorkflow({...opts,runtimePid}),/RUNTIME_PID_MUST_BE_POSITIVE_INTEGER_OR_NULL/);
    assert.equal(fs.existsSync(path.join(directory,'state.lock')),false);
    assert.equal(fs.existsSync(path.join(directory,'account-locks')),false);
  }
  const explicit=new SalesWorkflow({...opts,runtimePid:4321});
  try{
    assert.equal(JSON.parse(fs.readFileSync(explicit.lock,'utf8')).pid,4321);
    explicit.beginMailboxAction();
    assert.equal(JSON.parse(fs.readFileSync(explicit.accountLock,'utf8')).pid,4321);
    explicit.finishMailboxAction();
  }finally{explicit.close();}
});

test('workflow construction and mailbox locks work in a VM with no process global',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sales-no-process-'));
  const context=vm.createContext({fs,path,os,clean,hash,clone:structuredClone,structuredClone,AbortController});
  assert.equal(vm.runInContext('typeof process',context),'undefined');
  const IsolatedWorkflow=vm.runInContext('('+SalesWorkflow.toString()+')',context);
  const cfg={...config,accountLockDirectory:path.join(directory,'account-locks')};
  const first=new IsolatedWorkflow({directory:path.join(directory,'first'),config:cfg});
  let second;
  try{
    assert.equal(first.runtimePid,null);
    assert.equal(JSON.parse(fs.readFileSync(first.lock,'utf8')).pid,null);
    assert.throws(()=>new IsolatedWorkflow({directory:first.directory,config:cfg}),/already open/);
    first.beginMailboxAction();
    const metadata=JSON.parse(fs.readFileSync(first.accountLock,'utf8'));
    assert.equal(metadata.pid,null);assert.equal(metadata.accountId,cfg.accountId);
    second=new IsolatedWorkflow({directory:path.join(directory,'second'),config:cfg});
    assert.throws(()=>second.beginMailboxAction(),/account already executing/);
    assert.equal(fs.existsSync(first.accountLock),true);
    first.finishMailboxAction();
    assert.equal(fs.existsSync(first.accountLock),false);
    second.beginMailboxAction();second.finishMailboxAction();
    context.process={};
    const noPid=new IsolatedWorkflow({directory:path.join(directory,'third'),config:cfg});
    assert.equal(noPid.runtimePid,null);noPid.close();
  }finally{
    if(first.running)first.finishMailboxAction();
    if(second?.running)second.finishMailboxAction();
    first.close();second?.close();fs.rmSync(directory,{recursive:true,force:true});
  }
});
