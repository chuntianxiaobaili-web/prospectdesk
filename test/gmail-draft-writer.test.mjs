import test from 'node:test';
import assert from 'node:assert/strict';
import {GmailDraftWriter,gmailComposerControls} from '../src/browser-mail/gmail-draft-writer.mjs';
import {gmailComposerMetadata} from '../src/browser-mail/gmail-adapter.mjs';

const accountId='seller@example.test',recipient='buyer@example.test';
const packet={accountId,recipient,subject:'One exact topic',body:'Hello team,\n\nOne supported offer.\n\nWhich option is relevant?'};
const header='0 AXWebArea 草稿 - '+accountId+' - Gmail, URL: mail.google.com/mail/u/0/#drafts\n  1 button (collapsed) Description: Google 账号： Seller ('+accountId+'), Secondary Actions: Expand\n  39 button 写邮件\n  20 text field (settable) Description: 搜索邮件, Value: in:drafts\n';
function fixture(options={}){
  let open=options.existing===true,subject='',body=options.signature??'Default signature',to=[],pending='',selected=null,expanded=true,lock=true,guardError=null,closeCount=0,createCount=0;
  const log=[];
  const compose=()=>header.replace('u/0/#drafts\n','u/0/#drafts?compose=saved-token-one\n')+'  40 container 撰写： '+(subject||'新邮件')+'\n'+(expanded?'  41 pop up button (collapsed) Seller <'+(options.sender??accountId)+'>, ID: :from\n  42 container 收件人 - 选择联系人\n  43 combo box (collapsed, settable) Description: 发送至收件人, ID: :to\n':'  44 text '+recipient+'\n')+'  45 text field (settable) Description: 主题, Value: '+subject+', ID: :subject\n  46 text entry area (settable) Description: 邮件正文, ID: :body, Value: '+body+'\n  47 container actions\n  48 button Description: 保存并关闭, ID: :close\n  49 button Description: 发送 ‪(Ctrl-Enter)‬, ID: :send\n';
  const tab={
    async getAXState(){log.push('snapshot');return open?compose():header;},
    async clickVisibleComposeAddress(context){log.push('semantic-address:'+context.recipient);expanded=true;},
    async click(index){log.push('click:'+index);if(index===39){createCount++;open=true;}if(index===44)expanded=true;if(index===48){closeCount++;if(!options.closeStuck)open=false;}if(index===49)throw Error('WRITER_MUST_NEVER_SEND');},
    async pressKey(index,key){log.push('key:'+index+':'+key);if(key==='Control_L+a')selected=index;if(key==='Return'&&index===43){to=[pending];pending='';}},
    async paste(index,value,pasteOptions){log.push('paste:'+index+':'+pasteOptions.format);if(index===46){body=selected===index?value:body+value;if(pasteOptions.format!=='text')throw Error('PLAIN_TEXT_REQUIRED');if(options.collapseAfterBody)expanded=false;}selected=null;},
    async typeText(index,value){log.push('type:'+index);if(index===43)pending+=value;if(index===45)subject=selected===index?value:subject+value;if(index===46){body=selected===index?value:body+value;if(options.collapseAfterBody)expanded=false;}selected=null;}
  };
  const writer=new GmailDraftWriter({tab,accountId,identity:{browserId:'chrome',targetId:'fixture'},assertExclusive(){log.push('lock');return lock;},async beforeMutation(event){log.push('approval:'+event.kind);if(guardError)throw Error(guardError);options.beforeMutation?.(event);},
    async readVisibleComposer(){return {sender:options.sender??accountId,to:[...to,...(options.extraRecipients??[])],cc:[],bcc:[],subject,body,attachmentCount:0};}});
  return {writer,tab,log,compose,setLock(v){lock=v;},setGuardError(v){guardError=v;},get body(){return body;},get to(){return to;},get subject(){return subject;},get closeCount(){return closeCount;},get createCount(){return createCount;}};
}

function readFixture(options={}){
  const ref={accountId,draftId:'synthetic-original-one',threadId:'synthetic-thread-one',recipient,subject:packet.subject};
  let open=options.foreignInitially===true,token=options.foreignInitially?'foreign-token':'saved-token-one',body=packet.body,to=recipient,lock=true,closeCount=0,query='in:drafts';const log=[];
  const compose=()=>header.replace('u/0/#drafts\n','u/0/#drafts?compose='+token+'\n')+'  40 container 撰写： '+packet.subject+'\n  41 pop up button (collapsed) Seller <'+accountId+'>, ID: :from\n  42 container 收件人 - 选择联系人\n    43 Value: '+to+', ID: :chip\n  45 text field (settable) Description: 主题, Value: '+packet.subject+', ID: :subject\n  46 text entry area (settable) Description: 邮件正文, ID: :body, Value: '+body+'\n  47 container actions\n  48 button Description: 保存并关闭, ID: :close\n  49 button Description: 发送 ‪(Ctrl-Enter)‬, ID: :send\n';
  const tab={async getAXState(){log.push('snapshot');return open?compose():header.replace('Value: in:drafts','Value: '+query);},async click(index){log.push('click:'+index);if(index===10){open=true;token='saved-token-one';}if(index===48){closeCount++;if(!options.closeStuck)open=false;}if(index===49)throw Error('WRITER_MUST_NEVER_SEND');},async pressKey(_index,key){log.push('key:'+key);},async typeText(_index,value){query=value;log.push('search:'+value);}};
  const makeWriter=()=>new GmailDraftWriter({tab,accountId,assertExclusive(){return lock;},async beforeMutation(event){log.push('guard:'+event.kind+':'+event.args[0]);if(event.kind==='click'&&event.args[0]===48){if(options.foreignBeforeClose)token='foreign-token';if(options.changedBeforeClose)body+=' changed';if(options.lockLostBeforeClose)lock=false;if(options.beforeClose)options.beforeClose();}},async readVisibleList({scope,query}){return {scope,query,complete:true,total:1,rows:[{...ref,index:10,isDraft:true,recipient:null,attachments:false}]};},async readVisibleComposer({state}){return gmailComposerMetadata(state);}});
  const writer=makeWriter();return {ref,writer,tab,log,makeWriter,setRecipient(value){to=value;},get open(){return open;},get closeCount(){return closeCount;}};
}

test('fresh Gmail writer controls support observed subject attribute order',()=>{
  const f=fixture({existing:true});const controls=gmailComposerControls(f.compose(),accountId);assert.equal(controls.subjectValue,'');assert.equal(controls.editorIndex,46);assert.equal(controls.closeIndex,48);assert.equal(Object.hasOwn(controls,'sendIndex'),false);
});
test('save replaces the complete default signature and closes once after exact core hook',async()=>{
  const f=fixture();const result=await f.writer.save(packet,{beforeSave:async()=>f.log.push('core-save-hook')});assert.equal(result.status,'saved');assert.equal(result.requiresReadback,true);assert.equal(f.body,packet.body);assert.deepEqual(f.to,[recipient]);assert.equal(f.subject,packet.subject);assert.equal(f.closeCount,1);assert.equal(f.createCount,1);assert.equal(f.log.includes('click:49'),false);assert.equal(f.log.includes('paste:46:text'),true);assert.equal(f.log.includes('type:46'),false);assert.equal(f.log.includes('approval:paste'),true);
  const at=f.log.indexOf('core-save-hook');assert.equal(f.log[at+1],'lock');assert.equal(f.log[at+2],'click:48');
});
test('writer expands the observed collapsed recipient bar before verifying actual sender',async()=>{
  const f=fixture({collapseAfterBody:true});await f.writer.save(packet,{beforeSave:async()=>{}});assert.equal(f.log.includes('semantic-address:'+recipient),true);assert.equal(f.log.includes('approval:expandComposeAddress'),true);assert.equal(f.closeCount,1);
});
test('explicit account lock is required before any UI mutation',async()=>{
  const f=fixture();f.setLock(false);await assert.rejects(()=>f.writer.save(packet,{beforeSave:async()=>{}}),/ACCOUNT_NOT_EXCLUSIVE/);assert.equal(f.createCount,0);
  const noGuard=new GmailDraftWriter({tab:f.tab,accountId});await assert.rejects(()=>noGuard.save(packet,{beforeSave:async()=>{}}),/MUTATION_NOT_AUTHORIZED/);
});
test('every input rechecks exact approval through beforeMutation',async()=>{
  const f=fixture();f.setGuardError('CORE_APPROVAL_CHANGED');await assert.rejects(()=>f.writer.save(packet,{beforeSave:async()=>{}}),/CORE_APPROVAL_CHANGED/);assert.equal(f.createCount,0);
});
test('expired core hook stops before Save-and-close and leaves the draft for reconciliation',async()=>{
  const f=fixture();await assert.rejects(()=>f.writer.save(packet,{beforeSave:async()=>{throw Error('CORE_APPROVAL_EXPIRED');}}),/CORE_APPROVAL_EXPIRED/);assert.equal(f.createCount,1);assert.equal(f.closeCount,0);assert.equal(f.body,packet.body);
});
test('unknown close acknowledgement never repeats creation or close',async()=>{
  const f=fixture({closeStuck:true});await assert.rejects(()=>f.writer.save(packet,{beforeSave:async()=>{}}),/UI_NOT_READY:saved-composer-closed/);assert.equal(f.createCount,1);assert.equal(f.closeCount,1);
});
test('existing user composer is preserved before new-draft creation',async()=>{
  const f=fixture({existing:true});await assert.rejects(()=>f.writer.save(packet,{beforeSave:async()=>{}}),/EXISTING_COMPOSER_OPEN/);assert.equal(f.createCount,0);assert.equal(f.closeCount,0);
});
test('wrong sender and additional recipients stop before save',async()=>{
  const wrong=fixture({sender:'alias@example.test'});await assert.rejects(()=>wrong.writer.save(packet,{beforeSave:async()=>{}}),/SENDER_CHANGED/);assert.equal(wrong.closeCount,0);
  const extra=fixture({extraRecipients:['other@example.test']});await assert.rejects(()=>extra.writer.save(packet,{beforeSave:async()=>{}}),/NEW_COMPOSER_NOT_EMPTY/);assert.equal(extra.closeCount,0);
});
test('cancellation and invalid packet create no draft',async()=>{
  const f=fixture(),abort=new AbortController();abort.abort();await assert.rejects(()=>f.writer.save(packet,{signal:abort.signal,beforeSave:async()=>{}}),/DRAFT_WRITE_ABORTED/);assert.equal(f.createCount,0);
  await assert.rejects(()=>f.writer.save({...packet,subject:'Injected\nSubject'},{beforeSave:async()=>{}}),/PACKET_INVALID/);assert.equal(f.createCount,0);
});
test('readExisting verifies the exact original recipient then closes its owned composer',async()=>{
  const f=readFixture();const result=await f.writer.readExisting({accountId,recipient});assert.equal(result.drafts[0].draftId,f.ref.draftId);assert.equal(result.drafts[0].recipient,recipient);assert.equal(f.log.filter(value=>value==='click:10').length,1);assert.equal(f.closeCount,1);assert.equal(f.open,false);assert.equal(f.log.includes('click:49'),false);
  const wrong=readFixture();wrong.setRecipient('unrelated@example.test');await assert.rejects(()=>wrong.writer.readExisting({accountId,recipient}),/RECIPIENT_OR_CC_CHANGED/);assert.equal(wrong.closeCount,0);
});
test('independent sequential writers can read and close the same saved original without foreign ownership',async()=>{
  const f=readFixture();const first=await f.writer.inspect(f.ref);assert.equal(first.draftId,f.ref.draftId);assert.equal(first.body,packet.body);assert.equal(f.open,false);assert.equal(f.writer.reader.currentCompose,null);
  const second=await f.makeWriter().inspect(f.ref);assert.equal(second.approvedHash,first.approvedHash);assert.equal(f.open,false);assert.equal(f.closeCount,2);assert.equal(f.log.includes('click:49'),false);
});
test('a foreign composer present before read is preserved with no close',async()=>{
  const f=readFixture({foreignInitially:true});await assert.rejects(()=>f.writer.inspect(f.ref),/UNOWNED_COMPOSER_OPEN/);assert.equal(f.closeCount,0);assert.equal(f.open,true);
});
test('a foreign token or changed content during the final close guard is preserved',async()=>{
  const foreign=readFixture({foreignBeforeClose:true});await assert.rejects(()=>foreign.writer.inspect(foreign.ref),/READ_COMPOSER_NOT_OWNED/);assert.equal(foreign.closeCount,0);assert.equal(foreign.open,true);
  const changed=readFixture({changedBeforeClose:true});await assert.rejects(()=>changed.writer.inspect(changed.ref),/READ_COMPOSER_CHANGED/);assert.equal(changed.closeCount,0);assert.equal(changed.open,true);
});
test('lost ownership or cancellation before read-close causes no save-close',async()=>{
  const lost=readFixture({lockLostBeforeClose:true});await assert.rejects(()=>lost.writer.inspect(lost.ref),/ACCOUNT_NOT_EXCLUSIVE/);assert.equal(lost.closeCount,0);
  const controller=new AbortController();const cancelled=readFixture({beforeClose(){controller.abort();}});await assert.rejects(()=>cancelled.writer.inspect(cancelled.ref,{signal:controller.signal}),/DRAFT_WRITE_ABORTED/);assert.equal(cancelled.closeCount,0);
});
test('unknown read-close acknowledgement does not repeat the click',async()=>{
  const f=readFixture({closeStuck:true});await assert.rejects(()=>f.writer.inspect(f.ref),/UI_NOT_READY:read-composer-closed/);assert.equal(f.closeCount,1);assert.equal(f.log.filter(value=>value==='click:10').length,1);
});
test('save does not contain a send method and honors exclusive operation ownership',async()=>{
  const f=fixture();assert.equal(f.writer.send,undefined);f.writer.active=true;await assert.rejects(()=>f.writer.save(packet,{beforeSave:async()=>{}}),/DRAFT_WRITER_BUSY/);assert.equal(f.createCount,0);
});

test('fresh adapter factory injection still uses the writer guarded tab',async()=>{
  const f=fixture();let selectedTab;const fresh=new GmailDraftWriter({tab:f.tab,accountId,assertExclusive:()=>true,beforeMutation:async()=>{},readerFactory({tab,accountId:account}){selectedTab=tab;return{accountId:account,tab,checkAccount(){},async search(){return{complete:true,rows:[]};},async inspectDraft(){},async ensureAddressExpanded(s){return s;}};}});assert.equal(fresh.reader.tab,fresh.guardedTab);assert.equal(selectedTab,fresh.guardedTab);assert.notEqual(selectedTab,f.tab);
  assert.throws(()=>new GmailDraftWriter({tab:f.tab,accountId,reader:{accountId:'wrong@example.test'}}),/READER_INTERFACE_INVALID/);
});


test('missing plain-text paste capability stops before creating or selecting a body',async()=>{
  const f=fixture();delete f.tab.paste;await assert.rejects(()=>f.writer.save(packet,{beforeSave:async()=>{}}),/GMAIL_PLAIN_TEXT_PASTE_REQUIRED/);assert.equal(f.createCount,0);assert.equal(f.log.some(entry=>entry.startsWith('key:')),false);
  const existing=fixture({existing:true});delete existing.tab.paste;await assert.rejects(()=>existing.writer.replace('editorIndex',packet.body),/GMAIL_PLAIN_TEXT_PASTE_REQUIRED/);assert.equal(existing.log.some(entry=>entry.startsWith('key:')),false);
});
test('body replacement uses one guarded plain-text paste without collapsing paragraph boundaries',async()=>{
  const f=fixture({existing:true});const exact='Opening\n\nMiddle paragraph\n\nOne question?';await f.writer.replace('editorIndex',exact);assert.equal(f.body,exact);assert.equal(f.log.filter(entry=>entry==='paste:46:text').length,1);assert.equal(f.log.includes('type:46'),false);assert.equal(f.log.includes('approval:paste'),true);assert.equal(f.log.includes('click:49'),false);
});
