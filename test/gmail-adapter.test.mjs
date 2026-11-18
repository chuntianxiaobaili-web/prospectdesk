import test from 'node:test';
import assert from 'node:assert/strict';
import {GmailBrowserMailAdapter,gmailAccountFromAX,gmailComposeIdFromAX,parseGmailCompose,gmailCompatibilityChecker,parseGmailSearchCompletion,gmailComposerMetadata,gmailListRowsFromEvidence,createGmailVisibleComposerReader,createGmailVisibleListReader,gmailSentHeadersFromAX,createGmailVisibleMessageReader,createGmailVisibleAddressClicker,serializeGmailVisiblePlainBody} from '../src/browser-mail/gmail-adapter.mjs';

const accountId='seller@example.test',recipient='buyer@example.test';
const ref={accountId,draftId:'saved-compose-one',threadId:'visible-thread-one',recipient,subject:'Specific product topic'};
const body='Hello team,\n\nOne supported offer.\n\nWhich option is relevant?';
const header='0 AXWebArea 草稿 - '+accountId+' - Gmail, URL: mail.google.com/mail/u/0/#drafts\n  1 button (collapsed) Description: Google 账号： Seller ('+accountId+'), Secondary Actions: Expand\n  2 link Description: 草稿, Value: mail.google.com/mail/u/0/#drafts\n  3 link Description: 已发邮件, Value: mail.google.com/mail/u/0/#sent\n';
function composeAX(messageBody=body){return header.replace('u/0/#drafts\n','u/0/#drafts?compose='+ref.draftId+'\n')+'  20 text field (settable) Description: 搜索邮件, Value: previous-query\n  4 pop up button (collapsed) Seller <'+accountId+'>, ID: :from\n  5 container 收件人 - 选择联系人\n    6 container '+recipient+'\n  7 text field (settable) Description: 主题, ID: :subject, Value: '+ref.subject+'\n  8 text entry area (settable) Description: 邮件正文, ID: :body, Value: '+messageBody+'\n  9 container send actions\n    50 button Description: 发送 ‪(Ctrl-Enter)‬, ID: :send\n    52 button Description: 保存并关闭, ID: :close\n    51 button Description: 舍弃草稿 ‪(Ctrl-Shift-D)‬, ID: :discard\n';}
function fixture(options={}){
  const log=[];let query='',phase='list',consumed=false,sent=false,currentBody=body,readerBody=body;
  const original={draftId:ref.draftId,threadId:ref.threadId,index:10,isDraft:true,subject:ref.subject,recipient,attachments:false};
  const sentRow={threadId:'visible-sent-thread',messageId:'new-sent-message',index:11,isDraft:false,subject:ref.subject,recipient,attachments:false};
  const tab={
    async getAXState(){log.push('snapshot:'+phase);return phase==='compose'?composeAX(currentBody):header+'  20 text field (settable) Description: 搜索邮件, Value: '+query+'\n';},
    async click(index){log.push('click:'+index);if(index===10)phase='compose';if(index===11)phase='message';if(index===50){sent=true;consumed=options.residual===true?false:true;phase='list';}if(index===51){consumed=true;phase='list';}if(index===52)phase='list';},
    async pressKey(index,key){log.push('key:'+key);if(key==='Return')phase='list';},
    async typeText(index,text){query=text;log.push('type:'+text);}
  };
  const reader={
    async readVisibleList({scope,query:observed}){log.push('list:'+scope);let rows=scope==='drafts'?(consumed?[]:[original]):scope==='sent'?(sent?[sentRow]:[]):[original,...(options.history??[])];if(options.staleDraftRows&&scope==='drafts')rows=options.staleDraftRows;return {scope,query:observed,complete:options.incomplete!==true,total:options.extraTotal??rows.length,rows};},
    async readVisibleComposer(){log.push('compose-proof');return {draftId:ref.draftId,sender:accountId,to:[recipient],cc:options.cc??[],bcc:[],subject:ref.subject,body:readerBody,attachmentCount:options.attachments??0};},
    async readVisibleMessage(){log.push('message-proof');return {messageId:options.messageId??'new-sent-message',sender:accountId,recipient,subject:ref.subject,body:options.sentBody??body,sent:true};}
  };
  const adapter=new GmailBrowserMailAdapter({tab,accountId,preparedRefs:[ref],...reader,approvedPermanentDraftIds:options.approvedPermanentDraftIds??[],functionalTest:options.functionalTest??null});
  return {adapter,tab,log,setBody(value){currentBody=value;readerBody=value;},get sent(){return sent;},get consumed(){return consumed;}};
}

test('parse the explicitly selected Gmail account and saved compose identifier',()=>{
  assert.equal(gmailAccountFromAX(header),accountId);assert.equal(gmailComposeIdFromAX(composeAX()),ref.draftId);
  assert.throws(()=>gmailComposeIdFromAX(header),/SAVED_COMPOSE_ID_MISSING/);
  assert.throws(()=>gmailAccountFromAX(header+header),/ACCOUNT_CONTROL_AMBIGUOUS/);
});
test('compose parser preserves full paragraph text and binds subject/account/id',()=>{
  const item=parseGmailCompose(composeAX(),accountId,ref);assert.equal(item.body,body);assert.equal(item.sendIndex,50);assert.equal(item.draftVersion,item.approvedHash);
  assert.throws(()=>parseGmailCompose(composeAX(),accountId,{...ref,draftId:'other'}),/ORIGINAL_DRAFT_ID_CHANGED/);
  assert.throws(()=>parseGmailCompose(composeAX(),accountId,{...ref,subject:'Different'}),/SUBJECT_CHANGED/);
  assert.throws(()=>parseGmailCompose(composeAX().replace('Seller <'+accountId+'>','Seller <other@example.test>'),accountId,ref),/COMPOSE_ACCOUNT_MISMATCH/);
});
test('compatibility reads account, drafts, sent and search without mutation',async()=>{
  const f=fixture();const result=await gmailCompatibilityChecker({tab:f.tab,accountId});assert.equal(result.compatible,true);assert.ok(result.requiresComposePreflight);assert.equal(f.log.filter(x=>x.startsWith('click:')).length,0);
});
test('requires exact prepared refs and fresh visible evidence readers',async()=>{
  const f=fixture();assert.equal((await f.adapter.scanDrafts({limit:1})).length,1);
  const missing=new GmailBrowserMailAdapter({tab:f.tab,accountId});await assert.rejects(()=>missing.scanDrafts(),/EXACT_PREPARED_REFS_REQUIRED/);await assert.rejects(()=>missing.countDrafts(),/LIST_PROOF_INCOMPLETE/);
});
test('full composed draft is cross-checked against visible recipients and body',async()=>{
  const f=fixture();const item=await f.adapter.inspectDraft(ref);assert.equal(item.body,body);
  const cc=fixture({cc:['other@example.test']});await assert.rejects(()=>cc.adapter.inspectDraft(ref),/RECIPIENT_OR_CC_CHANGED/);
  const attachments=fixture({attachments:1});await assert.rejects(()=>attachments.adapter.inspectDraft(ref),/RECIPIENT_OR_CC_CHANGED/);
});
test('normal outreach holds any prior correspondence and a same-subject record',async()=>{
  const prior={threadId:'prior',index:12,isDraft:false,subject:'Old conversation',recipient};
  const f=fixture({history:[prior]});assert.equal((await f.adapter.preflight(ref)).reason,'existing_correspondence_requires_review');
  const same=fixture({history:[{...prior,subject:ref.subject}]});assert.equal((await same.adapter.preflight(ref)).reason,'existing_same_subject_correspondence');
});
test('incomplete and paginated search evidence never becomes absence proof',async()=>{
  const incomplete=fixture({incomplete:true});await assert.rejects(()=>incomplete.adapter.findDraft(ref),/LIST_PROOF_INCOMPLETE/);assert.equal(incomplete.adapter.lastDraftLookup,undefined);
  const pages=fixture({extraTotal:51});await assert.rejects(()=>pages.adapter.findDraft(ref),/PAGINATION_REQUIRES_REVIEW/);
});
test('stale unrelated search rows cannot prove an original draft disappeared',async()=>{
  const f=fixture({staleDraftRows:[{threadId:'unrelated',index:12,isDraft:false,subject:'Unrelated result',recipient:'other@example.test'}]});
  await assert.rejects(()=>f.adapter.findDraft(ref),/DRAFT_SEARCH_SCOPE_MISMATCH/);assert.equal(f.adapter.lastDraftLookup,undefined);
});
test('send calls final awaited guard immediately before the single send click',async()=>{
  const f=fixture();const item=await f.adapter.inspectDraft(ref);assert.equal((await f.adapter.preflight(item)).ok,true);
  const receipt=await f.adapter.send(item,{beforeClick:async({revalidate})=>{await revalidate();f.log.push('final-guard');}});
  assert.equal(receipt.authoritative,true);assert.equal(receipt.messageId,'new-sent-message');assert.equal(receipt.draftId,ref.draftId);
  const at=f.log.indexOf('final-guard');assert.equal(f.log[at+1],'click:50');assert.equal(f.log.filter(x=>x==='click:50').length,1);
  const cleanup=await f.adapter.cleanup(item,receipt,{});assert.equal(cleanup.removalMethod,'provider_consumed');assert.equal(cleanup.authoritative,true);assert.equal(f.log.includes('click:51'),false);
});
test('text changed during pacing wait stops before any send',async()=>{
  const f=fixture();const item=await f.adapter.inspectDraft(ref);await f.adapter.preflight(item);
  await assert.rejects(()=>f.adapter.send(item,{beforeClick:async({revalidate})=>{f.setBody(body+' extra');await revalidate();}}),/CONTENT_CHANGED_DURING_PACING_WAIT/);assert.equal(f.sent,false);
});
test('a deadline guard error causes no send and no cleanup',async()=>{
  const f=fixture();const item=await f.adapter.inspectDraft(ref);await f.adapter.preflight(item);
  await assert.rejects(()=>f.adapter.send(item,{beforeClick:async({revalidate})=>{await revalidate();throw Error('deadline');}}),/deadline/);assert.equal(f.sent,false);assert.equal(f.log.includes('click:51'),false);
});
test('a guard that skips content revalidation has no send authority',async()=>{
  const f=fixture();const item=await f.adapter.inspectDraft(ref);await f.adapter.preflight(item);await assert.rejects(()=>f.adapter.send(item,{beforeClick:async()=>{}}),/HOST_REVALIDATION_HOOK_REQUIRED/);assert.equal(f.sent,false);
});
test('sent toast or mismatched full body cannot produce an authoritative receipt',async()=>{
  const f=fixture({sentBody:body+' changed'});const item=await f.adapter.inspectDraft(ref);await f.adapter.preflight(item);const receipt=await f.adapter.send(item,{beforeClick:async({revalidate})=>revalidate()});assert.equal(receipt.status,'unknown');await assert.rejects(()=>f.adapter.cleanup(item,receipt,{}),/NO_CONFIRMED_RECEIPT_FOR_CLEANUP/);
});
test('reconciliation never treats a baseline sent message as new',async()=>{
  const f=fixture();const item=await f.adapter.inspectDraft(ref);await f.adapter.preflight(item);f.adapter.preflightIds.get(item.draftId).add('new-sent-message');const receipt=await f.adapter.send(item,{beforeClick:async({revalidate})=>revalidate()});assert.equal(receipt.status,'unknown');
});
test('residual original stays intact without explicit per-ID permanent-delete approval',async()=>{
  const f=fixture({residual:true});const item=await f.adapter.inspectDraft(ref);await f.adapter.preflight(item);const receipt=await f.adapter.send(item,{beforeClick:async({revalidate})=>revalidate()});await assert.rejects(()=>f.adapter.cleanup(item,receipt,{beforeClick:async()=>{}}),/PERMANENT_DRAFT_DELETE_REQUIRES_CURRENT_APPROVAL/);assert.equal(f.consumed,false);assert.equal(f.log.includes('click:51'),false);
});
test('approved residual cleanup uses the guarded original compose discard only',async()=>{
  const f=fixture({residual:true,approvedPermanentDraftIds:[ref.draftId]});const item=await f.adapter.inspectDraft(ref);await f.adapter.preflight(item);const receipt=await f.adapter.send(item,{beforeClick:async({revalidate})=>revalidate()});const cleanup=await f.adapter.cleanup(item,receipt,{beforeClick:async()=>f.log.push('cleanup-guard')});assert.equal(cleanup.removalMethod,'permanent_draft_delete');const at=f.log.indexOf('cleanup-guard');assert.equal(f.log[at+1],'click:51');assert.equal(f.consumed,true);
});
test('functional test exception is optional, exact and isolated from normal outreach',async()=>{
  const history=[{threadId:'old',index:12,isDraft:false,subject:'Prior ordinary mail',recipient}];
  const f=fixture({history,functionalTest:{kind:'functional-test',recipient,messages:[{subject:ref.subject,body}]}});const item=await f.adapter.inspectDraft(ref);assert.equal((await f.adapter.preflight(item)).mode,'functional-test');assert.equal((await f.adapter.preflight({...item,body:'Unapproved'})).reason,'outside_exact_function_test_packet');
  assert.throws(()=>fixture({functionalTest:{kind:'functional-test',recipient,messages:[{subject:'same',body},{subject:'same',body}]}}),/TEST_PACKET_INVALID/);
});

test('actual observed Gmail empty-result wording requires exact query URL and no loading or old rows',()=>{
  const query='in:anywhere {from:buyer@example.test to:buyer@example.test}';
  const empty=header.replace('u/0/#drafts\n','u/0/#search/'+encodeURIComponent(query)+'\n')+'  20 text field (settable) Description: 搜索邮件, Value: '+query+' \n  40 table\n    41 row\n      42 cell\n        43 text 找不到与您的搜索匹配的邮件。请尝试使用发件人、日期和大小等\n';
  assert.equal(parseGmailSearchCompletion(empty,query).total,0);
  assert.equal(parseGmailSearchCompletion(empty+'  44 container 加载速度指示器\n',query).complete,false);
  assert.equal(parseGmailSearchCompletion(empty+'  44 row ID: :old, Unrelated stale row\n',query).complete,false);
  assert.equal(parseGmailSearchCompletion(empty,query+' different').complete,false);
  assert.equal(parseGmailSearchCompletion(empty.replace(encodeURIComponent(query),'oldquery'),query).complete,false);
});

test('stable standalone original ID is independent from the opaque compose URL token',()=>{
  const item=parseGmailCompose(composeAX(),accountId,{...ref,draftId:'standalone-original-id',composeToken:ref.draftId});assert.equal(item.draftId,'standalone-original-id');assert.equal(item.composeToken,ref.draftId);
});
test('visible Gmail row evidence preserves unknown recipient and uses standalone ID as primary',()=>{
  const state='0 AXWebArea Gmail\n  19 row ID: :visible, 草稿 , One subject\n';
  const subject={subject:'One subject',threadId:'#thread-a:opaque',legacyThreadId:'legacy-thread',legacyLastMessageId:'legacy-draft',standaloneDraftId:'#msg-a:opaque',legacyStandaloneDraftId:'legacy-draft'};
  const rows=gmailListRowsFromEvidence(state,[{domId:':visible',subjects:[subject,{...subject}]}]);assert.equal(rows[0].draftId,'legacy-draft');assert.equal(rows[0].recipient,null);assert.equal(rows[0].index,19);
  assert.throws(()=>gmailListRowsFromEvidence(state,[{domId:':visible',subjects:[subject,{...subject,legacyStandaloneDraftId:'different'}]}]),/VISIBLE_ID_AMBIGUOUS/);
  assert.throws(()=>gmailListRowsFromEvidence(state,[{domId:':unrelated',subjects:[subject]}]),/AX_DOM_MISMATCH/);
});
test('visible sender/to metadata handles the actual value-before-ID subject order',()=>{
  const state=composeAX().replace('  5 container 收件人 - 选择联系人\n    6 container '+recipient,'  5 container 收件人 - 选择联系人\n    6 Value: '+recipient+', ID: :chip').replace('Description: 主题, ID: :subject, Value: '+ref.subject,'Description: 主题, Value: '+ref.subject+', ID: :subject');
  const meta=gmailComposerMetadata(state);assert.equal(meta.sender,accountId);assert.deepEqual(meta.to,[recipient]);assert.equal(meta.subject,ref.subject);assert.equal(meta.body,body);
  assert.throws(()=>gmailComposerMetadata(state.replace(/  4 pop up button[^\n]*\n/,'')),/SENDER_NOT_VISIBLE/);
});
test('visible body reader matches exact DIV/BR text and never collapses paragraph differences',async()=>{
  const state=composeAX().replace('    6 container '+recipient,'    6 Value: '+recipient+', ID: :chip');
  const dom={html:body.replace(/\n/g,'<br>'),innerText:body,textContent:body.replace(/\n/g,'')};
  const reader=createGmailVisibleComposerReader({playwright:{getByRole(){return{async evaluate(){return dom;}}}}});const proof=await reader({state});assert.equal(proof.body,body);
  dom.html=dom.html.replace('<br><br>','<br>');await assert.rejects(()=>reader({state}),/VISIBLE_COMPOSE_TEXT_MISMATCH/);
});
test('complete standalone draft count is exact and a duplicate original ID is rejected',async()=>{
  const f=fixture();const count=await f.adapter.countDrafts();assert.equal(count.exact,true);assert.equal(count.value,1);assert.equal(count.source,'gmail_visible_standalone_draft_count');
  f.adapter.readVisibleList=async({scope,query})=>({scope,query,complete:true,total:2,rows:[{threadId:'thread-one',draftId:'same-original',isDraft:true,index:1,subject:'A'},{threadId:'thread-two',draftId:'same-original',isDraft:true,index:2,subject:'B'}]});await assert.rejects(()=>f.adapter.countDrafts(),/DRAFT_ID_AMBIGUOUS/);
});

test('a received message merged into the current draft thread still holds outreach',async()=>{
  const f=fixture();f.adapter.readVisibleList=async({scope,query})=>({scope,query,complete:true,total:1,rows:[{draftId:ref.draftId,threadId:ref.threadId,index:10,isDraft:true,draftThreadOnly:false,subject:ref.subject,recipient}]});const result=await f.adapter.preflight(ref);assert.equal(result.reason,'existing_correspondence_in_draft_thread');
});
test('nonempty visible-list reader requires a complete pagination counter and exact stable IDs',async()=>{
  const query='in:drafts to:'+recipient;const list=header.replace('u/0/#drafts\n','u/0/#search/'+encodeURIComponent(query)+'\n')+'  20 text field (settable) Description: 搜索邮件, Value: '+query+'\n  30 pop up button (collapsed) Description: 显示更多邮件, ID: :count\n    31 text 第 1\n    32 text  - \n    33 text 1 行\n    34 text ，共 \n    35 text 1 行\n  36 row ID: :visible, 草稿 , '+ref.subject+' , 10:00 , Body\n';
  const subject={subject:ref.subject,threadId:'#thread-a:opaque',legacyThreadId:'thread-one',legacyLastMessageId:'draft-one',standaloneDraftId:'#msg-a:opaque',legacyStandaloneDraftId:'draft-one'};
  const reader=createGmailVisibleListReader({playwright:{getByRole(){return{async evaluateAll(){return[{domId:':visible',subjects:[subject]}];}}}}});const result=await reader({state:list,scope:'drafts',query});assert.equal(result.complete,true);assert.equal(result.rows[0].draftId,'draft-one');assert.equal(result.rows[0].recipient,null);
  const partial=await reader({state:list.replace('35 text 1 行','35 text 2 行'),scope:'drafts',query});assert.equal(partial.complete,false);assert.equal(partial.reason,'pagination_incomplete');
  const actualRole=list.replace('30 pop up button (collapsed)','30 button (collapsed)');const actualResult=await reader({state:actualRole,scope:'drafts',query});assert.equal(actualResult.complete,true);assert.equal(actualResult.total,1);
  const ambiguous=await reader({state:actualRole+'  60 button (collapsed) Description: 显示更多邮件, ID: :second-counter\n    61 text 第 1 - 1 行，共 1 行\n',scope:'drafts',query});assert.equal(ambiguous.complete,false);assert.equal(ambiguous.reason,'pagination_count_ambiguous');
  const wrongQuery=await reader({state:actualRole,scope:'drafts',query:query+' changed'});assert.equal(wrongQuery.complete,false);
  const missingRow=await reader({state:actualRole.replace(/  36 row[^\n]*\n/,''),scope:'drafts',query}).catch(error=>({error:error.message}));assert.equal(missingRow.error,'GMAIL_ROW_AX_DOM_MISMATCH');
});

test('an unfinished sent-message reader prevents dispatch before the first send click',async()=>{
  const f=fixture();const item=await f.adapter.inspectDraft(ref);await f.adapter.preflight(item);f.adapter.readVisibleMessage=undefined;await assert.rejects(()=>f.adapter.send(item,{beforeClick:async({revalidate})=>revalidate()}),/VISIBLE_MESSAGE_READER_REQUIRED/);assert.equal(f.sent,false);
});

test('filtered absence is insufficient when the unchanged stable ID remains under edited fields',async()=>{
  const f=fixture();f.adapter.search=async query=>({scope:'drafts',query,complete:true,total:query==='in:drafts'?1:0,rows:query==='in:drafts'?[{draftId:ref.draftId,threadId:ref.threadId,index:10,isDraft:true,subject:'Edited subject',recipient:'edited@example.test'}]:[]});await assert.rejects(()=>f.adapter.findDraft(ref),/ORIGINAL_DRAFT_CHANGED/);assert.notEqual(f.adapter.lastDraftLookup?.absent,true);
});
test('attachment sibling text remains outside the editor and holds the draft',()=>{
  const state=composeAX().replace('    6 container '+recipient,'    6 Value: '+recipient+', ID: :chip').replace('  9 container send actions','  9 container attachments\n    91 text catalog.pdf (2 MB)\n  92 container send actions');assert.throws(()=>gmailComposerMetadata(state),/ATTACHMENT_REQUIRES_REVIEW/);
});
test('an empty notice with a selected data row is never a completed empty search',()=>{
  const query='in:drafts';const state=header.replace('u/0/#drafts\n','u/0/#search/'+encodeURIComponent(query)+'\n')+'  20 text field (settable) Description: 搜索邮件, Value: '+query+'\n  40 text 找不到与您的搜索匹配的邮件。请尝试使用发件人、日期和大小等\n  41 row (selected) ID: :visible, 草稿 , Subject\n';assert.equal(parseGmailSearchCompletion(state,query).complete,false);
});
test('default empty-list reader also requires zero visible DOM rows',async()=>{
  const query='in:drafts';const state=header.replace('u/0/#drafts\n','u/0/#search/'+encodeURIComponent(query)+'\n')+'  20 text field (settable) Description: 搜索邮件, Value: '+query+'\n  40 text 找不到与您的搜索匹配的邮件。请尝试使用发件人、日期和大小等\n';const reader=createGmailVisibleListReader({playwright:{getByRole(){return{async evaluateAll(){return 1;}}}}});assert.equal((await reader({state,scope:'drafts',query})).complete,false);
});
const detailsAX=()=>header+'  60 table\n    61 row\n      62 cell\n        63 text 发件人:\n      64 cell\n        65 text Seller '+accountId+'\n    66 row\n      67 cell\n        68 text 收件人:\n      69 cell\n        70 pop up button '+recipient+'\n    71 row\n      72 cell\n        73 text 日期:\n      74 cell\n        75 text 2026年11月18日 16:00\n    76 row\n      77 cell\n        78 text 主题:\n      79 cell\n        80 text '+ref.subject+'\n';
test('observed visible details table identifies sender, recipient, date and subject',()=>{
  assert.deepEqual(gmailSentHeadersFromAX(detailsAX()),{sender:accountId,recipient,subject:ref.subject,date:'2026年11月18日 16:00'});assert.throws(()=>gmailSentHeadersFromAX(detailsAX().replace('70 pop up button '+recipient,'70 pop up button '+recipient+' other@example.test')),/ADDRESS_AMBIGUOUS/);
});
test('default receipt reader opens visible details and binds its exact legacy message container/body',async()=>{
  const log=[],tab={async click(index){log.push(index);},async getAXState(){return detailsAX();},playwright:{locator(){return{async evaluateAll(){return[{messageId:'#msg-f:new-visible',legacyMessageId:'new-legacy',bodies:[{html:body.replace(/\n/g,'<br>'),innerText:body,textContent:body.replace(/\n/g,'')}]}];}}}}};const reader=createGmailVisibleMessageReader(tab);const proof=await reader({state:header+'  15 pop up button Description: 显示详细信息, ID: :details\n',row:{isDraft:false,messageId:'new-legacy'},item:{accountId}});assert.deepEqual(log,[15]);assert.equal(proof.messageId,'new-legacy');assert.equal(proof.recipient,recipient);assert.equal(proof.body,body);assert.equal(proof.sent,true);
});
test('receipt reader rejects wrong visible ID, hidden body text and multiple message containers',async()=>{
  let messages=[{messageId:'#msg-f:new-visible',legacyMessageId:'wrong-id',bodies:[{html:body.replace(/\n/g,'<br>'),innerText:body,textContent:body}]}];const reader=createGmailVisibleMessageReader({playwright:{locator(){return{async evaluateAll(){return messages;}}}}});const args={state:detailsAX(),row:{isDraft:false,messageId:'new-legacy'},item:{accountId}};await assert.rejects(()=>reader(args),/VISIBLE_MESSAGE_ID_MISMATCH/);messages[0].legacyMessageId='new-legacy';messages[0].bodies[0].textContent+='hidden quote';await assert.rejects(()=>reader(args),/HIDDEN_OR_INCOMPLETE_BODY/);messages=[messages[0],{...messages[0]}];await assert.rejects(()=>reader(args),/CONTAINER_AMBIGUOUS/);
});


test('collapsed address uses one guarded visible semantic click instead of a virtual AX text node',async()=>{
  const expanded=composeAX(),collapsed=expanded.replace('  4 pop up button (collapsed) Seller <'+accountId+'>, ID: :from','  4 container 撰写： '+ref.subject+'\n    41 text '+recipient);
  let clicks=0;const adapter=new GmailBrowserMailAdapter({accountId,tab:{async getAXState(){return expanded;},async click(){throw Error('AX_VIRTUAL_TEXT_MUST_NOT_CLICK');}},async clickVisibleAddress(context){assert.deepEqual(context,{accountId,recipient,composeToken:ref.draftId});clicks++;}});
  assert.equal(await adapter.ensureAddressExpanded(collapsed),expanded);assert.equal(clicks,1);
  adapter.clickVisibleAddress=null;await assert.rejects(()=>adapter.ensureAddressExpanded(collapsed),/VISIBLE_ADDRESS_EXPAND_UNAVAILABLE/);assert.equal(clicks,1);
});
test('visible address clicker rechecks account/token, exact composer target and final exclusive guard',async()=>{
  const log=[];let ax=composeAX(),count=1,visible=true,lock=true;const target={async count(){return count;},async evaluate(){return {visible,email:recipient,hovercard:recipient};},async click(){log.push('semantic-click');}};
  const tab={async getAXState(){log.push('snapshot');return ax;},playwright:{locator(selector){assert.equal(selector,'div.oL.aDm.az9 > span[email="'+recipient+'"][data-hovercard-id="'+recipient+'"]');return target;}}};
  const click=createGmailVisibleAddressClicker(tab,{assertExclusive(){log.push('guard');return lock;}}),context={accountId,recipient,composeToken:ref.draftId};await click(context);assert.deepEqual(log.slice(-2),['guard','semantic-click']);assert.equal(log.filter(value=>value==='semantic-click').length,1);
  count=2;await assert.rejects(()=>click(context),/TARGET_AMBIGUOUS/);count=1;visible=false;await assert.rejects(()=>click(context),/TARGET_AMBIGUOUS/);visible=true;ax=ax.replace('?compose='+ref.draftId,'?compose=foreign');await assert.rejects(()=>click(context),/COMPOSER_CHANGED/);ax=composeAX();target.evaluate=async()=>{lock=false;return {visible:true,email:recipient,hovercard:recipient};};await assert.rejects(()=>click(context),/NOT_EXCLUSIVE/);assert.equal(log.filter(value=>value==='semantic-click').length,1);
  assert.throws(()=>createGmailVisibleAddressClicker(tab),/EXCLUSIVE_GUARD_REQUIRED/);
});


test('Gmail body metadata preserves exact visible paragraphs and verified mail/site links',()=>{
  const site='https://supplier.example.test',mail='seller@example.test',visible='Hello team,\n\n'+mail+'\n'+site;
  const via='https://www.google.com/url?q='+encodeURIComponent(site)+'&amp;source=gmail&amp;ust=1234567890123456&amp;usg=synthetic_verification';
  const html='<div dir="ltr">Hello team,<br><br><a href="mailto:'+mail+'" target="_blank">'+mail+'</a><br><a href="'+site+'" target="_blank" data-saferedirecturl="'+via+'">'+site+'</a></div>';
  const snapshot={html,innerText:visible,textContent:visible.replace(/\n/g,'')};const canonical=serializeGmailVisiblePlainBody(snapshot,visible);assert.equal(canonical.body,visible);assert.equal(canonical.bodyEvidence.gmailMetadataPolicy,'verified-ltr-google-redirect-v1');
  assert.throws(()=>serializeGmailVisiblePlainBody({...snapshot,html:html.replace(site+'</a>','https://other.example.test</a>')},visible),/LINK_TARGET_MISMATCH/);
  assert.throws(()=>serializeGmailVisiblePlainBody({...snapshot,html:html.replace('href="mailto:'+mail+'"','href="mailto:other@example.test"')},visible),/LINK_TARGET_MISMATCH/);
});
test('Gmail-only metadata never hides unsupported attributes, styles, tags or malformed markup',()=>{
  const text='https://supplier.example.test',simple='<div dir="ltr"><a href="'+text+'" target="_blank">'+text+'</a></div>',snapshot={html:simple,innerText:text,textContent:text};
  for(const html of [simple.replace('dir="ltr"','dir="rtl"'),simple.replace('dir="ltr"','dir="ltr" dir="ltr"'),simple.replace('dir="ltr"','dir="ltr" hidden="hidden"'),simple.replace('dir="ltr"','dir="ltr" style="display:none"'),simple.replace('<a href','<a onclick="doSomething()" href'),simple.replace('<a href','<span><a href').replace('</a>','</a></span>'),simple.replace('dir="ltr"','dir=ltr')])assert.throws(()=>serializeGmailVisiblePlainBody({...snapshot,html},text),/GMAIL_BODY_|VISIBLE_BODY_/);
});
test('Gmail redirect metadata requires the observed Google host/path and exact unique target',()=>{
  const site='https://supplier.example.test',valid='https://www.google.com/url?q='+encodeURIComponent(site)+'&amp;source=gmail&amp;ust=123456&amp;usg=synthetic';
  const snapshot=via=>({html:'<div dir="ltr"><a href="'+site+'" target="_blank" data-saferedirecturl="'+via+'">'+site+'</a></div>',innerText:site,textContent:site});
  for(const via of [valid.replace('www.google.com','lookalike.example.test'),valid.replace('/url?','/other?'),valid.replace(encodeURIComponent(site),encodeURIComponent('https://other.example.test')),valid+'&amp;q='+encodeURIComponent(site),valid+'&amp;unknown=1',valid.replace('source=gmail','source=other'),valid.replace('ust=123456','ust=invalid'),valid.replace('usg=synthetic','usg=')])assert.throws(()=>serializeGmailVisiblePlainBody(snapshot(via),site),/REDIRECT_TARGET_MISMATCH/);
  assert.throws(()=>serializeGmailVisiblePlainBody({...snapshot(valid),html:snapshot(valid).html.replace('target="_blank"','target="_self"')},site),/REDIRECT_TARGET_MISMATCH/);
});


test('the exact observed Gmail spelling annotation unwraps only its plain visible text',()=>{
  const word='SYNTHETIC',html='<div dir="ltr">Hello <span zeum4c60="PR_1_0" data-ddnwab="PR_1_0" aria-invalid="spelling" class="LI ng">'+word+'</span><br><br>One question?</div>',visible='Hello '+word+'\n\nOne question?',snapshot={html,innerText:visible,textContent:visible.replace(/\n/g,'')};const result=serializeGmailVisiblePlainBody(snapshot,visible);assert.equal(result.body,visible);assert.equal(result.bodyEvidence.gmailAnnotationPolicy,'exact-visible-spelling-v1');
  for(const changed of [html.replace('zeum4c60="PR_1_0"','zeum4c60="PR_2_0"'),html.replace('data-ddnwab="PR_1_0"','data-ddnwab="PR_2_0"'),html.replace('aria-invalid="spelling"','aria-invalid="grammar"'),html.replace('class="LI ng"','class="other"'),html.replace('class="LI ng"','class="LI ng" style="display:none"'),html.replace('class="LI ng"','class="LI ng" hidden="hidden"'),html.replace('class="LI ng"','class="LI ng" data-other="unknown"'),html.replace(word+'</span>','<a href="https://supplier.example.test">'+word+'</a></span>'),html.replace(word+'</span>','<b>'+word+'</b></span>'),html.replace(word+'</span>','</span>')])assert.throws(()=>serializeGmailVisiblePlainBody({...snapshot,html:changed},visible),/SPELLING_ANNOTATION_UNSUPPORTED/);
});


test('observed dynamic spelling marker names require exactly one numeric zeum4c attribute',()=>{
  const plain='SYNTHETIC',base='<span zeum4c60="PR_1_0" data-ddnwab="PR_1_0" aria-invalid="spelling" class="LI ng">'+plain+'</span>',snapshot=html=>({html,innerText:plain,textContent:plain});
  for(const name of ['zeum4c60','zeum4c63','zeum4c123456'])assert.equal(serializeGmailVisiblePlainBody(snapshot(base.replace('zeum4c60',name)),plain).body,plain);
  for(const html of [base.replace('zeum4c60','zeum4cx'),base.replace('zeum4c60','zeum4c'),base.replace('zeum4c60="PR_1_0"','zeum4c60="PR_1_0" zeum4c63="PR_1_0"'),base.replace('zeum4c60="PR_1_0"','zeum4c63="PR_2_0"')])assert.throws(()=>serializeGmailVisiblePlainBody(snapshot(html),plain),/SPELLING_ANNOTATION_UNSUPPORTED/);
});


test('spelling annotation indices may vary only when both marker fields match the structural ID',()=>{
  const plain='SYNTHETIC',html=(marker,duplicate)=>'<span zeum4c63="'+marker+'" data-ddnwab="'+duplicate+'" aria-invalid="spelling" class="LI ng">'+plain+'</span>',snapshot=(marker,duplicate)=>({html:html(marker,duplicate),innerText:plain,textContent:plain});
  for(const marker of ['PR_1_0','PR_12_345'])assert.equal(serializeGmailVisiblePlainBody(snapshot(marker,marker),plain).body,plain);
  for(const [marker,duplicate] of [['PR_1_0','PR_2_0'],['PR_2_0','PR_1_0'],['PR_x_1','PR_x_1'],['PR_1','PR_1'],['OTHER_1_0','OTHER_1_0'],['PR_1_0_extra','PR_1_0_extra'],['','']])assert.throws(()=>serializeGmailVisiblePlainBody(snapshot(marker,duplicate),plain),/SPELLING_ANNOTATION_UNSUPPORTED/);
});


test('only the observed all-drafts canonical folder alias retains full visible row coverage',async()=>{
  const query='in:drafts',rows=Array.from({length:10},(_,n)=>({domId:':synthetic-'+n,subjects:[{subject:'Synthetic subject '+n,threadId:'#thread-a:synthetic-'+n,legacyThreadId:'thread-'+n,legacyLastMessageId:'draft-'+n,standaloneDraftId:'#msg-a:synthetic-'+n,legacyStandaloneDraftId:'draft-'+n}]}));
  const folder=header+'  20 text field (settable) Description: 搜索邮件, Value: in:draft \n  30 button (collapsed) Description: 显示更多邮件, ID: :count\n    31 text 第 1\n    32 text  - \n    33 text 10 行\n    34 text ，共 \n    35 text 10 行\n'+rows.map((row,n)=>'  '+(40+n)+' row ID: '+row.domId+', 草稿 , Synthetic subject '+n+'\n').join('');
  const reader=createGmailVisibleListReader({playwright:{getByRole(){return{async evaluateAll(){return rows;}}}}});const result=await reader({state:folder,scope:'drafts',query});assert.equal(result.complete,true);assert.equal(result.total,10);assert.equal(result.rows.length,10);
  for(const [state,asked] of [[folder,query+' to:'+recipient],[folder.replace('#drafts','#inbox'),query],[folder.replace('Value: in:draft ','Value: in:drafts '),query],[folder.replace('u/0/#drafts\n','u/0/#drafts?compose=foreign\n'),query],[folder.replace('35 text 10 行','35 text 11 行'),query]])assert.equal((await reader({state,scope:'drafts',query:asked})).complete,false);
  const empty=header+'  20 text field (settable) Description: 搜索邮件, Value: in:draft \n  40 text 没有任何邮件符合您的搜索条件。\n';assert.equal(parseGmailSearchCompletion(empty,query).reason,'draft_folder_empty_profile_pending');
});


test('observed sent-body rendering IDs and empty presentation siblings preserve exact text',()=>{
  const plain='Hello team,\n\nOne question?',html='<div id="avWBGd-123"><div dir="ltr">Hello team,<br><br>One question?</div><div class="yj6qo"></div><div class="adL">\n</div></div>',snapshot={html,innerText:plain,textContent:plain.replace(/\n/g,'')};const proof=serializeGmailVisiblePlainBody(snapshot,plain);assert.equal(proof.body,plain);assert.equal(proof.bodyEvidence.gmailRenderingPolicy,'verified-message-container-empty-ui-v1');
  assert.equal(serializeGmailVisiblePlainBody({...snapshot,html:html.replace('avWBGd-123','avWBGd-987654321')},plain).body,plain);
  for(const changed of [html.replace('avWBGd-123','avWBGd-unknown'),html.replace('id="avWBGd-123"','id="avWBGd-123" hidden="hidden"'),html.replace('id="avWBGd-123"','id="avWBGd-123" style="display:none"'),html.replace('class="yj6qo"','class="yj6qo" id="avWBGd-123"'),html.replace('class="yj6qo"','class="yj6qo" hidden="hidden"'),html.replace('class="yj6qo"','class="yj6qo" style="display:none"'),html.replace('class="yj6qo"','class="unknown"'),html.replace('<div class="yj6qo"></div>','<div class="yj6qo">Extra text</div>'),html.replace('<div class="yj6qo"></div>','<div class="yj6qo"><br></div>'),html.replace('<div class="yj6qo"></div>','<div class="yj6qo">\u200b</div>')])assert.throws(()=>serializeGmailVisiblePlainBody({...snapshot,html:changed},plain),/GMAIL_BODY_|VISIBLE_BODY_/);
});


test('visible single-mailbox headers separate email display names from their actual angle address',()=>{
  const quoted=detailsAX().replace('70 pop up button '+recipient,'70 pop up button "'+recipient+'" <'+recipient+'>').replace('65 text Seller '+accountId,'65 text "'+accountId+'" <'+accountId+'>');assert.equal(gmailSentHeadersFromAX(quoted).recipient,recipient);assert.equal(gmailSentHeadersFromAX(quoted).sender,accountId);
  const repeatedFrom=detailsAX().replace('65 text Seller '+accountId,'65 text '+accountId+' '+accountId);assert.equal(gmailSentHeadersFromAX(repeatedFrom).sender,accountId);
  for(const state of [quoted.replace('70 pop up button','70 pop up button '+recipient+', '),quoted.replace('70 pop up button "'+recipient+'" <'+recipient+'>','70 pop up button <'+recipient+'> <other@example.test>'),quoted.replace('70 pop up button "'+recipient+'" <'+recipient+'>','70 pop up button <'+recipient+'> <'+recipient+'>'),quoted.replace('70 pop up button "'+recipient+'" <'+recipient+'>','70 pop up button "'+recipient+'" <'+recipient+'>\n        701 pop up button other@example.test'),quoted.replace('70 pop up button "'+recipient+'" <'+recipient+'>','70 pop up button "'+recipient+'" <'+recipient+'>\n        701 pop up button '+recipient),quoted.replace('70 pop up button "'+recipient+'" <'+recipient+'>','70 pop up button "'+recipient+'" <'+recipient+'>\n        701 text other@example.test'),detailsAX().replace('65 text Seller '+accountId,'65 text other@example.test '+accountId),detailsAX().replace('65 text Seller '+accountId,'65 text Seller '+accountId+'\n        651 text other@example.test')])assert.throws(()=>gmailSentHeadersFromAX(state),/GMAIL_SENT_ADDRESS_AMBIGUOUS/);
});


test('the observed canonical empty draft folder requires both exact notices and zero visible legacy IDs',async()=>{
  const query='in:drafts',empty=header+'  20 text field (settable) Description: 搜索邮件, Value: in:draft \n  30 heading 会话, Value: 2\n    31 text 会话\n  32 table\n    33 row\n      34 cell\n        35 text 您没有保存任何草稿。\n        36 text 利用草稿保存功能，可先保存您暂时不想发送出去的邮件。\n  40 container Footer\n';let visibleIds=0;const reader=createGmailVisibleListReader({playwright:{locator(selector){assert.ok(selector.includes('[data-legacy-standalone-draft-id]'));return{async evaluateAll(){return visibleIds;}}}}});const result=await reader({state:empty,scope:'drafts',query});assert.equal(result.complete,true);assert.equal(result.total,0);assert.deepEqual(result.rows,[]);
  visibleIds=1;assert.equal((await reader({state:empty,scope:'drafts',query})).reason,'visible_ids_with_empty_draft_folder');visibleIds=0;
  for(const state of [empty.replace('        35 text 您没有保存任何草稿。\n',''),empty.replace('        36 text 利用草稿保存功能，可先保存您暂时不想发送出去的邮件。\n',''),empty.replace('30 heading 会话, Value: 2','30 heading Other, Value: 2'),empty+'  41 row ID: :stale, 草稿 , Old subject\n',empty+'  41 container 正在加载\n',empty+'  41 text entry area (settable) Description: 邮件正文, ID: :editor, Value: body\n',empty.replace('Value: in:draft ','Value: other '),empty.replace('#drafts','#sent')])assert.equal((await reader({state,scope:'drafts',query})).complete,false);
  assert.equal((await reader({state:empty,scope:'drafts',query:'in:drafts to:'+recipient})).complete,false);
});
