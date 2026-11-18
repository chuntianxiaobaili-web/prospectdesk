import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRows,parseCompose,verifySentBody,searchRowsReady,fullSearchReady,BrowserMailAdapter,serializeVisiblePlainBody,createVisiblePlainBodyReader} from './browser-adapter.mjs';

const account='test@example.com';
const ref={accountId:account,draftId:'9000000000000000100',recipient:'customer@example.com',subject:'Existing customer update'};
const compose=`0 AXWebArea Zoho Mail (${account})
  2 button From ${account}
  3 button 发送
  4 text 收件人：
    5 customer@example.com
    6 combo box (collapsed, settable) Description: 收件人
  7 text 抄送
    8 combo box (collapsed, settable) Description: 抄送人
  9 text field (settable) Value: Existing customer update, ID: subject
  10 text entry area (settable) Description: 纯文本编辑区域, Value: Hello team,

Here is the update.

Regards
\t11 tab (selected) Description: compose`;
test('compose binds full plaintext and one recipient',()=>{
  const item=parseCompose(compose,account,ref);assert.equal(item.body,'Hello team,\n\nHere is the update.\n\nRegards');assert.equal(item.sendIndex,3);assert.equal(item.approvedHash.length,64);
});
test('rich text uses complete accessible value, not duplicated child text',()=>{
  const rich=compose.replace('text entry area (settable) Description: 纯文本编辑区域','container Description: 富文本编辑区域').replace('\t11 tab','\t15 container\n\t\t16 text Hello team,\n\t11 tab');
  assert.equal(parseCompose(rich,account,ref).body,parseCompose(compose,account,ref).body);
});
test('extra recipient stops dispatch',()=>assert.throws(()=>parseCompose(compose.replace('  7 text','    15 extra@example.com\n  7 text'),account,ref),/RECIPIENT/));
test('different account stops dispatch',()=>assert.throws(()=>parseCompose(compose.replace('From '+account,'From other@example.com'),account,ref),/ACCOUNT/));
test('duplicate send button stops dispatch',()=>assert.throws(()=>parseCompose(compose+'\n  12 button 发送',account,ref),/AMBIGUOUS/));
test('content changes alter bound version',()=>assert.notEqual(parseCompose(compose,account,ref).draftVersion,parseCompose(compose.replace('Here is the update.','Changed update.'),account,ref).draftVersion));
test('attachment row requires review',()=>assert.throws(()=>parseCompose(compose,account,{...ref,attachments:true}),/ATTACHMENT/));
test('rows bind exact numeric ID and local trash button',()=>{
  const s='  20 Value: 来自 我, 主题 Existing customer update, 创建时间 今天, ID: 9000000000000000100\n    21 text <customer@example.com>\n    22 button 删除所选的邮件对话并移至回收站\n  30 ID: 9000000000000000101, Value: 未读邮件 , 来自 我, 主题 Different, 投递时间 今天\n    31 text "name"<second@example.com>\n    32 button 删除所选的邮件对话并移至回收站';
  const rows=parseRows(s);assert.equal(rows.length,2);assert.equal(rows[0].deleteIndex,22);assert.equal(rows[1].recipient,'second@example.com');assert.equal(rows[1].created,false);
});
test('old count during checkbox refresh is not complete',()=>{
  const old='  1 text 来自邮件的结果 (1)\n  2 checkbox (disabled, settable, integer) 0\n  3 text 包含垃圾邮件/回收站';assert.equal(fullSearchReady(old),false);
  const ready=old.replace('(disabled, settable, integer) 0','(settable, integer) 1')+'\n'+rowText(ref.draftId,{created:true});
  assert.equal(fullSearchReady(ready),true);
});
test('sent verification rejects additional or changed body text',()=>{
  const item=parseCompose(compose,account,ref);
  const sent='  1 text Hello team,\n  2 text Here is the update.\n  3 text Regards\n  4 toolbar 撰写操作';
  assert.equal(verifySentBody(sent,item),true);assert.equal(verifySentBody(sent.replace('update.','different update.'),item),false);assert.equal(verifySentBody(sent.replace('  4 toolbar','  9 text Added text\n  4 toolbar'),item),false);
});
test('preflight skips another same-subject message',async()=>{
  const a=new BrowserMailAdapter({tab:{},accountId:account});a.searchRecipient=async()=>({state:'来自邮件的结果 (2)',rows:[{...ref,created:true},{draftId:'9000000000000000101',subject:ref.subject,created:false}]});
  assert.equal((await a.preflight(ref)).reason,'existing_same_subject_correspondence');
});
test('preflight holds non-draft correspondence for review even with another subject',async()=>{
  const a=new BrowserMailAdapter({tab:{},accountId:account});a.searchRecipient=async()=>({state:'来自邮件的结果 (2)',rows:[{...ref,created:true},{draftId:'9000000000000000101',subject:'A reply',created:false}]});
  assert.equal((await a.preflight(ref)).reason,'existing_correspondence_requires_review');
});
test('cleanup refuses a receipt not confirmed in this adapter',async()=>{
  const a=new BrowserMailAdapter({tab:{},accountId:account});await assert.rejects(()=>a.cleanup(ref,{status:'sent'},{beforeClick:async()=>{}}),/NO_CONFIRMED/);
});

const rowText=(id,{subject=ref.subject,recipient=ref.recipient,index=20,created=false}={})=>
  `  ${index} Value: 来自 我, 主题 ${subject}, ${created?'创建时间':'投递时间'} 今天, ID: ${id}\n    ${index+1} text <${recipient}>`;
const receiptFor=item=>({status:'sent',authoritative:true,messageId:'9000000000000000200',
  accountId:account,draftId:item.draftId,recipient:item.recipient,
  approvedHash:item.approvedHash,draftVersion:item.draftVersion,mode:'cua-browser-ui'});
const checkedSearch=(rows,{checked=true,disabled=false,total=rows.length}={})=>
  `0 AXWebArea Zoho Mail (${account})\n  1 text field (settable) Value: ${ref.recipient}\n`+
  `  2 checkbox (${disabled?'disabled, ':''}settable, integer) ${checked?1:0}\n`+
  `  3 text 包含垃圾邮件/回收站\n  4 text 来自邮件的结果 (${total})\n`+rows.join('\n');

test('rich text without a full accessible Value is held instead of reconstructing partial children',()=>{
  const partial=compose.replace('text entry area (settable) Description: 纯文本编辑区域, Value: Hello team,',
    'container Description: 富文本编辑区域\n\t15 text Hello team,');
  assert.throws(()=>parseCompose(partial,account,ref),/COMPOSE_LAYOUT_CHANGED/);
});

test('disabled checked or unchecked full-search controls never mean a completed search',()=>{
  assert.equal(fullSearchReady(checkedSearch([],{checked:false,disabled:true})),false);
  assert.equal(fullSearchReady(checkedSearch([],{checked:true,disabled:true})),false);
  assert.equal(fullSearchReady(checkedSearch([],{checked:false})),false);
  assert.equal(fullSearchReady(checkedSearch([],{checked:true})),true);
});

test('recipient search waits through stale disabled results for enabled complete scope',async()=>{
  const draft=rowText(ref.draftId,{created:true});
  const older=rowText('9000000000000000101',{index:30});
  const initial=checkedSearch([draft],{checked:false});
  const stale=checkedSearch([draft],{checked:false,disabled:true});
  const complete=checkedSearch([draft,older]);
  const initialWithoutId=checkedSearch([draft.replace(/, ID: \d+/,'')],{checked:false});
  const checkedWithoutIds=checkedSearch([draft.replace(/, ID: \d+/,''),older.replace(/, ID: \d+/,'')]);
  const snapshots=[initialWithoutId,initial,stale,stale,checkedWithoutIds,complete],clicks=[];
  const a=new BrowserMailAdapter({accountId:account,tab:{
    async getAXState(){assert.ok(snapshots.length,'expected bounded state progression');return snapshots.shift();},
    async typeText(){},async pressKey(){},async click(index){clicks.push(index);},
  }});
  a.folder=async()=>`0 AXWebArea Zoho Mail (${account})\n  9 text field (settable) 搜索 ( / )`;
  const result=await a.searchRecipient(ref.recipient);
  assert.deepEqual(clicks,[2]);assert.equal(result.rows.length,2);assert.equal(snapshots.length,0);
  assert.equal(result.rows[1].draftId,'9000000000000000101');
});

test('checked search heading is not ready until counted rows have stable IDs',()=>{
  const draft=rowText(ref.draftId,{created:true});
  const noRows=checkedSearch([],{total:1});
  const unenriched=checkedSearch([draft.replace(/, ID: \d+/,'')]);
  assert.equal(searchRowsReady(noRows),false);assert.equal(fullSearchReady(noRows),false);
  assert.equal(searchRowsReady(unenriched),false);assert.equal(fullSearchReady(unenriched),false);
  assert.equal(searchRowsReady(checkedSearch([draft])),true);assert.equal(fullSearchReady(checkedSearch([draft])),true);
});

test('stale rows contradicting a zero-count or no-match search are not ready',()=>{
  const draft=rowText(ref.draftId,{created:true});
  assert.equal(searchRowsReady(checkedSearch([draft],{total:0})),false);
  assert.equal(searchRowsReady('无与搜索条件相匹配的消息\n'+draft),false);
  assert.equal(searchRowsReady('无与搜索条件相匹配的消息'),true);
});

test('large searches require a complete rendered first page before being marked ready',()=>{
  const rows=Array.from({length:50},(_,i)=>rowText(String(1000000000000000+i),{index:20+i*3}));
  assert.equal(searchRowsReady(checkedSearch(rows.slice(0,49),{total:70})),false);
  assert.equal(searchRowsReady(checkedSearch(rows,{total:70})),true);
});

test('reconcile rejects a baseline sent ID before clicking the sent message',async()=>{
  const item=parseCompose(compose,account,ref),oldId='9000000000000000200',clicks=[];
  const a=new BrowserMailAdapter({accountId:account,tab:{async click(index){clicks.push(index);}}});
  a.folder=async()=>rowText(oldId);
  a.preflightIds.set(item.draftId,new Set([item.draftId,oldId]));
  assert.deepEqual(await a.reconcile(item),{status:'unknown',reason:'sent_receipt_not_new'});
  assert.equal(clicks.length,0);assert.equal(a.lastReceipts.size,0);
});

test('reconcile without a recorded preflight baseline does not accept a matching sent message',async()=>{
  const item=parseCompose(compose,account,ref),clicks=[];
  const a=new BrowserMailAdapter({accountId:account,tab:{async click(index){clicks.push(index);}}});
  a.folder=async()=>rowText('9000000000000000200');
  assert.equal((await a.reconcile(item)).reason,'sent_receipt_not_new');
  assert.equal(clicks.length,0);
});

test('a new sent ID with the complete matching body yields an exact receipt',async()=>{
  const item=parseCompose(compose,account,ref),newId='9000000000000000200',clicks=[];
  const a=new BrowserMailAdapter({accountId:account,tab:{async click(index){clicks.push(index);}}});
  a.folder=async()=>rowText(newId);
  a.preflightIds.set(item.draftId,new Set([item.draftId]));
  const full=`0 AXWebArea Zoho Mail (${account})\n  1 container ID: zm_Container_m${newId}\n`+
    '  2 text Hello team,\n  3 text Here is the update.\n  4 text Regards\n  5 toolbar 撰写操作';
  a.waitFor=async predicate=>{assert.equal(predicate(full),true);return full;};
  const receipt=await a.reconcile(item);
  assert.equal(receipt.status,'sent');assert.equal(receipt.messageId,newId);
  assert.equal(receipt.draftId,item.draftId);assert.equal(receipt.approvedHash,item.approvedHash);
  assert.deepEqual(clicks,[20]);assert.deepEqual(a.lastReceipts.get(item.draftId),receipt);
});

function missingDraftFixture(searchState) {
  const item=parseCompose(compose,account,ref),receipt=receiptFor(item),clicks=[];
  const a=new BrowserMailAdapter({accountId:account,tab:{async click(index){clicks.push(index);}}});
  a.lastReceipts.set(item.draftId,receipt);
  a.folder=async()=>`0 AXWebArea Zoho Mail (${account})\n  1 text 当前处于文件夹 草稿，\n  2 text 此文件夹为空`;
  a.searchDraftsForRecipient=async()=>searchState;
  let cleanupHooks=0;
  return {a,item,receipt,clicks,beforeClick:async()=>{cleanupHooks++;},get cleanupHooks(){return cleanupHooks;}};
}

test('cleanup accepts authoritative absence only after a complete Drafts-scoped search',async()=>{
  const f=missingDraftFixture('  1 container Description: 文件夹内, Value: 草稿/\n  2 text 来自邮件的结果 (0)');
  const result=await f.a.cleanup(f.item,f.receipt,{beforeClick:f.beforeClick});
  assert.equal(result.status,'already_absent');assert.equal(result.authoritative,true);
  assert.equal(result.draftId,f.item.draftId);assert.equal(result.sentMessageId,f.receipt.messageId);
  assert.deepEqual(f.a.lastDraftLookup,{draftId:f.item.draftId,accountId:account,complete:true,absent:true});
  assert.equal(f.clicks.length,0);assert.equal(f.cleanupHooks,0);
});

test('no-match message in a complete Drafts search proves absence without a delete click',async()=>{
  const f=missingDraftFixture('  1 container Description: 文件夹内, Value: 草稿/\n  2 text 无与搜索条件相匹配的消息');
  assert.equal((await f.a.cleanup(f.item,f.receipt,{beforeClick:f.beforeClick})).status,'already_absent');
  assert.equal(f.clicks.length,0);assert.equal(f.cleanupHooks,0);
});

test('incomplete scoped search never counts as original-draft cleanup',async()=>{
  const f=missingDraftFixture('  1 container Description: 文件夹内, Value: 草稿/\n  2 text 来自邮件的结果 (3)');
  await assert.rejects(()=>f.a.cleanup(f.item,f.receipt,{beforeClick:f.beforeClick}),/ORIGINAL_DRAFT_ABSENCE_INCOMPLETE/);
  assert.equal(f.a.lastDraftLookup,null);assert.equal(f.cleanupHooks,0);assert.equal(f.clicks.length,0);
});

test('complete results without Drafts scope never prove original-draft absence',async()=>{
  const f=missingDraftFixture('  1 text 来自邮件的结果 (0)');
  await assert.rejects(()=>f.a.cleanup(f.item,f.receipt,{beforeClick:f.beforeClick}),/ORIGINAL_DRAFT_ABSENCE_INCOMPLETE/);
  assert.equal(f.cleanupHooks,0);
});

test('a missing-draft lookup for a different original ID never counts cleanup',async()=>{
  const f=missingDraftFixture('');
  f.a.inspectDraft=async()=>{
    f.a.lastDraftLookup={draftId:'9000000000000000101',accountId:account,complete:true,absent:true};
    throw Error('DRAFT_MISSING');
  };
  await assert.rejects(()=>f.a.cleanup(f.item,f.receipt,{beforeClick:f.beforeClick}),/DRAFT_MISSING/);
  assert.equal(f.cleanupHooks,0);
});

test('an absence lookup from a different account never counts cleanup',async()=>{
  const f=missingDraftFixture('');
  f.a.inspectDraft=async()=>{
    f.a.lastDraftLookup={draftId:f.item.draftId,accountId:'other@example.com',complete:true,absent:true};
    throw Error('DRAFT_MISSING');
  };
  await assert.rejects(()=>f.a.cleanup(f.item,f.receipt,{beforeClick:f.beforeClick}),/DRAFT_MISSING/);
  assert.equal(f.cleanupHooks,0);
});

test('a complete lookup that does not affirm absence never counts cleanup',async()=>{
  const f=missingDraftFixture('');
  f.a.inspectDraft=async()=>{
    f.a.lastDraftLookup={draftId:f.item.draftId,accountId:account,complete:true,absent:false};
    throw Error('DRAFT_MISSING');
  };
  await assert.rejects(()=>f.a.cleanup(f.item,f.receipt,{beforeClick:f.beforeClick}),/DRAFT_MISSING/);
  assert.equal(f.cleanupHooks,0);
});

test('draft count reads folder-details total instead of the sidebar badge',async()=>{
  const folder=`0 AXWebArea Zoho Mail (${account})\n  10 row (selected) Description: 草稿, ID: 9000000000000000300\n    11 text 草稿\n    12 text 99`;
  const menu=`0 AXWebArea Zoho Mail (${account})\n  20 文件夹详情, ID: showInfo`;
  const details=`0 AXWebArea Zoho Mail (${account})\n  30 heading 草稿, Value: 1\n  31 button 邮件总数 556\n  32 button 关闭`;
  const snapshots=[menu,details,folder],clicks=[];
  const a=new BrowserMailAdapter({accountId:account,tab:{
    async click(index,options){clicks.push({index,options});},
    async getAXState(){assert.ok(snapshots.length);return snapshots.shift();},
  }});
  a.folder=async name=>{assert.equal(name,'草稿');return folder;};
  const result=await a.countDrafts();
  assert.equal(result.value,556);assert.equal(result.source,'folder_details_total');assert.equal(result.exact,true);
  assert.deepEqual(clicks,[{index:10,options:{mouseButton:'right'}},{index:20,options:undefined},{index:32,options:undefined}]);
  assert.equal(snapshots.length,0);
});

test('a total under a different folder heading is not accepted as draft count',async()=>{
  const folder=`0 AXWebArea Zoho Mail (${account})\n  10 row (selected) Description: 草稿, ID: 9000000000000000300`;
  const menu=`0 AXWebArea Zoho Mail (${account})\n  20 文件夹详情, ID: showInfo`;
  const wrong=`0 AXWebArea Zoho Mail (${account})\n  30 heading 收件箱, Value: 1\n  31 button 邮件总数 777\n  32 button 关闭`;
  const clicks=[];
  const a=new BrowserMailAdapter({accountId:account,tab:{async click(index){clicks.push(index);}}});
  a.folder=async()=>folder;
  a.waitFor=async(predicate,label)=>{
    if(label==='folder context'){assert.equal(predicate(menu),true);return menu;}
    assert.equal(label,'folder total');assert.equal(predicate(wrong),false);throw Error('UI_NOT_READY:folder total');
  };
  await assert.rejects(()=>a.countDrafts(),/UI_NOT_READY:folder total/);
  assert.deepEqual(clicks,[10,20]);
});

test('send uses a newly observed send-control index after the host pacing wait',async()=>{
  const item=parseCompose(compose,account,ref),clicks=[],order=[];
  let waitFinished=false;
  const newerCompose=compose.replace('  3 button 发送','  73 button 发送');
  const a=new BrowserMailAdapter({accountId:account,tab:{
    async getAXState(){assert.equal(waitFinished,true);order.push('fresh_snapshot');return newerCompose;},
    async click(index){clicks.push(index);order.push('click');},
  }});
  a.inspectDraft=async()=>{order.push('initial_inspection');return item;};
  a.waitFor=async predicate=>{assert.equal(predicate('信息已发送！'),true);order.push('sent_confirmation');return '信息已发送！';};
  a.reconcile=async()=>{order.push('sent_reconcile');return receiptFor(item);};
  const result=await a.send(item,{beforeClick:async({revalidate})=>{
    order.push('pacing_wait');waitFinished=true;
    await revalidate();order.push('host_authorized');
  }});
  assert.deepEqual(clicks,[73]);assert.equal(result.messageId,receiptFor(item).messageId);
  assert.deepEqual(order,['initial_inspection','pacing_wait','fresh_snapshot','host_authorized','click','sent_confirmation','sent_reconcile']);
});

test('changed body during the pacing wait prevents the adapter send click',async()=>{
  const item=parseCompose(compose,account,ref),clicks=[];let confirmations=0,reconciliations=0;
  const changed=compose.replace('Here is the update.','A different body after waiting.');
  const a=new BrowserMailAdapter({accountId:account,tab:{
    async getAXState(){return changed;},async click(index){clicks.push(index);},
  }});
  a.inspectDraft=async()=>item;
  a.waitFor=async()=>{confirmations++;return '信息已发送！';};
  a.reconcile=async()=>{reconciliations++;return receiptFor(item);};
  await assert.rejects(()=>a.send(item,{beforeClick:async({revalidate})=>{await revalidate();}}),/CONTENT_CHANGED_DURING_PACING_WAIT/);
  assert.equal(clicks.length,0);assert.equal(confirmations,0);assert.equal(reconciliations,0);
});

test('legacy host that ignores revalidation is rejected before a send click',async()=>{
  const item=parseCompose(compose,account,ref),clicks=[];let hookCalls=0,snapshots=0;
  const a=new BrowserMailAdapter({accountId:account,tab:{
    async getAXState(){snapshots++;return compose;},async click(index){clicks.push(index);},
  }});
  a.inspectDraft=async()=>item;
  await assert.rejects(()=>a.send(item,{beforeClick:async()=>{hookCalls++;}}),/HOST_REVALIDATION_HOOK_REQUIRED/);
  assert.equal(hookCalls,1);assert.equal(snapshots,0);assert.equal(clicks.length,0);
});

function residualCleanupFixture(approvedPermanentDraftIds=[]) {
  const item=parseCompose(compose,account,ref),receipt=receiptFor(item),order=[],clicks=[];
  const a=new BrowserMailAdapter({accountId:account,approvedPermanentDraftIds,tab:{
    async click(index){order.push('delete_click');clicks.push(index);},
  }});
  a.lastReceipts.set(item.draftId,receipt);
  a.inspectDraft=async()=>{order.push('fresh_body');return item;};
  a.findDraft=async()=>{order.push('exact_original');return {...ref,deleteIndex:88};};
  a.snapshot=async()=>{order.push('after_click_snapshot');return '';};
  a.searchDraftsForRecipient=async recipient=>{
    assert.equal(recipient,item.recipient);order.push('scoped_absence_check');
    return '  1 container Description: 文件夹内, Value: 草稿/\n  2 text 来自邮件的结果 (0)';
  };
  return {a,item,receipt,order,clicks,beforeClick:async()=>{order.push('deadline_guard');}};
}

test('residual original deletion needs a current exact-ID confirmation before any delete control lookup',async()=>{
  const f=residualCleanupFixture();
  await assert.rejects(()=>f.a.cleanup(f.item,f.receipt,{beforeClick:f.beforeClick}),/PERMANENT_DRAFT_DELETE_REQUIRES_CURRENT_APPROVAL/);
  assert.deepEqual(f.order,['fresh_body']);assert.equal(f.clicks.length,0);
});

test('approval for another draft never authorizes deletion of this sent original',async()=>{
  const f=residualCleanupFixture(['9000000000000000101']);
  await assert.rejects(()=>f.a.cleanup(f.item,f.receipt,{beforeClick:f.beforeClick}),/PERMANENT_DRAFT_DELETE_REQUIRES_CURRENT_APPROVAL/);
  assert.deepEqual(f.order,['fresh_body']);assert.equal(f.clicks.length,0);
});

test('exact confirmed approval deletes once after the deadline hook and verifies scoped absence',async()=>{
  const f=residualCleanupFixture([ref.draftId]);
  const result=await f.a.cleanup(f.item,f.receipt,{beforeClick:f.beforeClick});
  assert.deepEqual(f.clicks,[88]);
  assert.deepEqual(f.order,['fresh_body','exact_original','deadline_guard','delete_click','after_click_snapshot','scoped_absence_check']);
  assert.equal(result.status,'already_absent');assert.equal(result.removalMethod,'permanent_draft_delete');
  assert.equal(result.draftId,f.item.draftId);assert.equal(result.sentMessageId,f.receipt.messageId);assert.equal(result.authoritative,true);
});

test('deletion is not confirmed while the exact original draft remains in scoped results',async()=>{
  const f=residualCleanupFixture([ref.draftId]);
  f.a.searchDraftsForRecipient=async()=>
    '  1 container Description: 文件夹内, Value: 草稿/\n  2 text 来自邮件的结果 (1)\n'+rowText(ref.draftId,{created:true});
  await assert.rejects(()=>f.a.cleanup(f.item,f.receipt,{beforeClick:f.beforeClick}),/ORIGINAL_DRAFT_REMOVAL_NOT_CONFIRMED/);
  assert.deepEqual(f.clicks,[88]);
});

test('incomplete post-delete search is uncertain even with exact current approval',async()=>{
  const f=residualCleanupFixture([ref.draftId]);
  f.a.searchDraftsForRecipient=async()=>
    '  1 container Description: 文件夹内, Value: 草稿/\n  2 text 来自邮件的结果 (1)';
  await assert.rejects(()=>f.a.cleanup(f.item,f.receipt,{beforeClick:f.beforeClick}),/ORIGINAL_DRAFT_REMOVAL_NOT_CONFIRMED/);
  assert.deepEqual(f.clicks,[88]);
});

test('changed body always stops residual deletion even with exact approval',async()=>{
  const f=residualCleanupFixture([ref.draftId]);
  f.a.inspectDraft=async()=>({...f.item,body:'New content after the sent message',approvedHash:'different',draftVersion:'different'});
  await assert.rejects(()=>f.a.cleanup(f.item,f.receipt,{beforeClick:f.beforeClick}),/DRAFT_CHANGED_BEFORE_CLEANUP/);
  assert.equal(f.clicks.length,0);assert.deepEqual(f.order,[]);
});

test('provider-consumed original needs no permanent-delete approval and records that method separately',async()=>{
  const f=missingDraftFixture('  1 container Description: 文件夹内, Value: 草稿/\n  2 text 来自邮件的结果 (0)');
  const result=await f.a.cleanup(f.item,f.receipt,{beforeClick:f.beforeClick});
  assert.equal(result.removalMethod,'provider_consumed');assert.equal(f.clicks.length,0);assert.equal(f.cleanupHooks,0);
});

test('rich editor label without Description still binds complete accessible Value',()=>{
  const rich=compose.replace('text entry area (settable) Description: 纯文本编辑区域','container 富文本编辑区域');
  assert.equal(parseCompose(rich,account,ref).body,parseCompose(compose,account,ref).body);
});
test('rich editor alias without full Value is never reconstructed from children',()=>{
  const partial=compose.replace('text entry area (settable) Description: 纯文本编辑区域, Value: Hello team,','container 富文本编辑区域\n\t15 text Hello team,');
  assert.throws(()=>parseCompose(partial,account,ref),/COMPOSE_LAYOUT_CHANGED/);
});
test('multiple rich editor headers are ambiguous even when one has a full Value',()=>{
  const rich=compose.replace('text entry area (settable) Description: 纯文本编辑区域','container 富文本编辑区域');
  assert.throws(()=>parseCompose(rich+'\n\t99 container Description: 富文本编辑区域, Value: Other body',account,ref),/COMPOSE_EDITOR_AMBIGUOUS/);
});
test('inspectDraft readiness accepts only the complete rich editor alias',async()=>{
  const alias=compose.replace('text entry area (settable) Description: 纯文本编辑区域','container 富文本编辑区域');
  const clicks=[];const a=new BrowserMailAdapter({accountId:account,tab:{async click(i){clicks.push(i);}}});
  a.findDraft=async()=>({...ref,index:20});
  a.waitFor=async predicate=>{assert.equal(predicate(alias),true);assert.equal(predicate(alias.replace(', Value: Hello team,','\n\t99 text Hello team,')),false);return alias;};
  const item=await a.inspectDraft(ref);assert.equal(item.body,parseCompose(compose,account,ref).body);assert.deepEqual(clicks,[20]);
});

const visibleFixture=()=>{
  const first='Hello team,',second='Approved message.',email='sender@example.test',url='https://example.test';
  return {
    html:'<div><div style="font-family: Verdana, Arial, Helvetica, sans-serif; font-size: 10pt"><div>'+first+'<br></div><div><br></div><div>'+second+'<br></div><div><a href="mailto:'+email+'" target="_blank">'+email+'</a><br></div><div><a href="'+url+'" target="_blank">'+url+'</a><br></div></div></div>',
    innerText:first+'\n\n\n\n'+second+'\n\n'+email+'\n\n'+url+'\n',
    textContent:first+second+email+url,
    canonical:first+'\n\n'+second+'\n'+email+'\n'+url
  };
};
test('visible DIV BR body serializer preserves exact lines without duplicate block endings',()=>{
  const f=visibleFixture();const result=serializeVisiblePlainBody(f,f.innerText);
  assert.equal(result.body,f.canonical);assert.equal(result.bodySerialization,'visible-plain-lines-v1');
  assert.equal(result.bodySource,'visible-iframe-body');assert.equal(result.bodyEvidence.axTextComparison,'non-whitespace-equal');
});
test('visible serializer retains multiple genuine empty line blocks instead of folding whitespace',()=>{
  const f={html:'<div><div>A<br></div><div><br></div><div><br></div><div>B<br></div></div>',innerText:'A\n\n\n\n\n\nB',textContent:'AB'};
  assert.equal(serializeVisiblePlainBody(f,f.innerText).body,'A\n\n\nB');
});
test('visible serializer decodes supported HTML entities without changing approved text',()=>{
  const f={html:'<div>R&amp;D &lt;sample&gt; &#39;A&#39; &#x1F33C;<br></div>',innerText:"R&D <sample> 'A' 🌼",textContent:"R&D <sample> 'A' 🌼"};
  assert.equal(serializeVisiblePlainBody(f,f.innerText).body,f.innerText);
});
test('visible serializer refuses unknown entities and malformed unbalanced markup',()=>{
  for(const html of ['<div>&hiddenEntity;<br></div>','<div>A<br>','<div>A</p>','<!-- hidden --><div>A<br></div>']){
    assert.throws(()=>serializeVisiblePlainBody({html,innerText:'A',textContent:'A'},'A'),/VISIBLE_BODY_/);
  }
});
test('visible serializer rejects hidden attributes, opaque classes and non-approved style properties',()=>{
  for(const html of ['<div hidden="hidden">A<br></div>','<div class="hidden">A<br></div>','<div style="display:none">A<br></div>','<div style="font-size:0pt">A<br></div>','<div style="visibility:hidden">A<br></div>']){
    assert.throws(()=>serializeVisiblePlainBody({html,innerText:'A',textContent:'A'},'A'),/VISIBLE_BODY_/);
  }
});
test('images tables scripts styles spans and unsupported structures never become plain-text proof',()=>{
  for(const tag of ['img','table','script','style','span','iframe','ul']){
    const html=tag==='img'?'<div>A<img src="x"></div>':'<div><'+tag+'>A</'+tag+'></div>';
    assert.throws(()=>serializeVisiblePlainBody({html,innerText:'A',textContent:'A'},'A'),/VISIBLE_BODY_DOM_UNSUPPORTED/);
  }
});
test('visible links must reveal the exact URL or email target',()=>{
  for(const link of [
    '<a href="https://other.test">https://example.test</a>',
    '<a href="mailto:other@example.test">sender@example.test</a>',
    '<a href="javascript:alert(1)">https://example.test</a>',
    '<a href="https://example.test">click here</a>',
    '<a href="https://example.test" onclick="doSomething()">https://example.test</a>'
  ]){
    assert.throws(()=>serializeVisiblePlainBody({html:'<div>'+link+'<br></div>',innerText:'https://example.test',textContent:'https://example.test'},'https://example.test'),/VISIBLE_BODY_/);
  }
});
test('an extra visible DOM or AX text difference stops canonical readback',()=>{
  const f=visibleFixture();
  assert.throws(()=>serializeVisiblePlainBody({...f,html:f.html.replace('Approved message.','Approved message. Extra')},f.innerText),/VISIBLE_BODY_TEXT_MISMATCH/);
  assert.throws(()=>serializeVisiblePlainBody(f,f.innerText+' Extra'),/VISIBLE_BODY_TEXT_MISMATCH/);
  assert.throws(()=>serializeVisiblePlainBody({...f,innerText:f.innerText+' Extra'},f.innerText),/VISIBLE_BODY_TEXT_MISMATCH/);
});
test('visible body callback uses only the observed iframe body public DOM values',async()=>{
  const f=visibleFixture(),calls=[];
  const tab={playwright:{frameLocator(selector){calls.push(selector);return {locator(selector){calls.push(selector);return {async evaluate(fn){calls.push('evaluate');assert.ok(String(fn).includes('innerHTML'));return f;}};}};}}};
  const reader=createVisiblePlainBodyReader(tab);
  const result=await reader({state:'  1 container Description: 富文本编辑区域, Value: '+f.innerText,item:{body:f.innerText}});
  assert.equal(result.body,f.canonical);assert.deepEqual(calls,['iframe','body','evaluate']);
});
test('plain editor callback keeps its complete AX value without attempting DOM fallback',async()=>{
  const reader=createVisiblePlainBodyReader({});
  const result=await reader({state:'  1 text entry area (settable) Description: 纯文本编辑区域, Value: A\n\nB',item:{body:'A\n\nB'}});
  assert.equal(result.body,'A\n\nB');assert.equal(result.bodySerialization,'ax-plain-value-v1');
});
test('rich editor with no supported DOM reader fails instead of accepting inflated AX text',async()=>{
  const reader=createVisiblePlainBodyReader({});
  await assert.rejects(()=>reader({state:'  1 container 富文本编辑区域, Value: A',item:{body:'A'}}),/DOM_READER_UNAVAILABLE/);
});
test('optional canonical body callback produces distinct raw AX and canonical mailbox hashes',async()=>{
  const f=visibleFixture(),rich=compose.replace('text entry area (settable) Description: 纯文本编辑区域','container Description: 富文本编辑区域')
    .replace('Hello team,\n\nHere is the update.\n\nRegards',f.innerText.trim());
  const a=new BrowserMailAdapter({tab:{},accountId:account,readComposeBody:async({item})=>serializeVisiblePlainBody(f,item.body)});
  const raw=parseCompose(rich,account,ref),item=await a.parseComposeSnapshot(rich,ref);
  assert.equal(item.body,f.canonical);assert.notEqual(item.approvedHash,raw.approvedHash);
  assert.equal(item.axBodyHash,raw.approvedHash);assert.equal(item.draftVersion,item.approvedHash);
  assert.equal(item.bodySerialization,'visible-plain-lines-v1');
});
test('ordinary existing-draft adapters keep the unmodified AX-based body behavior',async()=>{
  const rich=compose.replace('text entry area (settable) Description: 纯文本编辑区域','container Description: 富文本编辑区域');
  const a=new BrowserMailAdapter({tab:{},accountId:account});
  assert.deepEqual(await a.parseComposeSnapshot(rich,ref),parseCompose(rich,account,ref));
});
test('canonical callback is awaited within final revalidate before the deadline hook permits input',async()=>{
  const raw=parseCompose(compose,account,ref);let now=0,reads=0;const clicks=[];
  const a=new BrowserMailAdapter({tab:{async click(index){clicks.push(index);}},accountId:account,
    readComposeBody:async({item})=>{await Promise.resolve();if(++reads===2)now=100;return {body:item.body,bodySerialization:'ax-plain-value-v1'};}});
  const item=await a.parseComposeSnapshot(compose,ref);
  a.inspectDraft=async()=>item;a.snapshot=async()=>compose;
  await assert.rejects(()=>a.send(item,{beforeClick:async({revalidate})=>{await revalidate();if(now>=100)throw Error('DEADLINE');}}),/DEADLINE/);
  assert.equal(reads,2);assert.equal(clicks.length,0);
});
test('canonical callback cannot substitute different text even with a serializer marker',async()=>{
  const a=new BrowserMailAdapter({tab:{},accountId:account,readComposeBody:async()=>({body:'Altered text',bodySerialization:'visible-plain-lines-v1'})});
  await assert.rejects(()=>a.parseComposeSnapshot(compose,ref),/VISIBLE_BODY_TEXT_MISMATCH/);
});


test('visible readiness tolerates complete rows appearing after the old twelve-second window',async t=>{
  let now=0,reads=0;
  t.mock.method(Date,'now',()=>now);
  const a=new BrowserMailAdapter({accountId:account,tab:{async getAXState(){reads++;now+=5000;return now>=20000?'complete folder rows':'loading';}}});
  assert.equal(a.visibleReadyTimeoutMs,30000);
  assert.equal(await a.waitFor(state=>state==='complete folder rows','草稿'),'complete folder rows');
  assert.equal(reads,4);
});

test('visible readiness stops at thirty seconds without treating incomplete state as ready',async t=>{
  let now=0,reads=0,predicates=0;
  t.mock.method(Date,'now',()=>now);
  const a=new BrowserMailAdapter({accountId:account,tab:{async getAXState(){reads++;now+=5000;return 'folder heading but rows still loading';}}});
  await assert.rejects(()=>a.waitFor(state=>{predicates++;return state==='complete folder rows';},'草稿'),/^Error: UI_NOT_READY:草稿$/);
  assert.equal(reads,6);assert.equal(predicates,6);
});

test('a configured visible readiness window remains bounded and an explicit override stays independent',async t=>{
  let now=0,reads=0;
  t.mock.method(Date,'now',()=>now);
  const a=new BrowserMailAdapter({accountId:account,visibleReadyTimeoutMs:10000,tab:{async getAXState(){reads++;now+=5000;return 'loading';}}});
  await assert.rejects(()=>a.waitFor(()=>false,'configured'),/UI_NOT_READY:configured/);
  assert.equal(reads,2);
  await assert.rejects(()=>a.waitFor(()=>false,'override',15000),/UI_NOT_READY:override/);
  assert.equal(reads,5);assert.equal(a.visibleReadyTimeoutMs,10000);
});

test('visible readiness rejects unbounded or invalid windows before observing the page',async()=>{
  const invalid=[0,-1,NaN,Infinity,1.5,30001,null,'30000'];
  for(const visibleReadyTimeoutMs of invalid)assert.throws(()=>new BrowserMailAdapter({accountId:account,tab:{},visibleReadyTimeoutMs}),/VISIBLE_READY_TIMEOUT/);
  let reads=0;const a=new BrowserMailAdapter({accountId:account,tab:{async getAXState(){reads++;return 'ready';}}});
  for(const timeout of invalid)await assert.rejects(()=>a.waitFor(()=>true,'invalid',timeout),/VISIBLE_READY_TIMEOUT/);
  assert.equal(reads,0);
});
