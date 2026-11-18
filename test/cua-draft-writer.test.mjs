import test from 'node:test';
import assert from 'node:assert/strict';
import {CuaDraftWriter,composerControls,readComposerPacket} from '../src/browser-mail/cua-draft-writer.mjs';

const accountId='sender@example.test';
const packet={accountId,recipient:'buyer@example.test',subject:'A specific material comparison',body:'Hello team,\n\nApproved full message.\n\nFSARCAN team'};

class FakeTab {
  constructor({open=false,extraCc=false,duplicateSubject=false,unknownSave=false,missingBodyValue=false,signature='Jensen Yan',autoSave=false,hiddenComposer=false,plainMode=true,autoCaption=false,richEnterExpansion=false}={}) {
    Object.assign(this,{open,extraCc,duplicateSubject,unknownSave,missingBodyValue,autoSave,hiddenComposer,plainMode,autoCaption,richEnterExpansion});
    this.signature=signature;this.recipient='';this.pendingRecipient='';this.subject='';this.body=signature;
    this.saved=false;this.showModeMenu=false;this.showModeDialog=false;this.mailboxDraftId='1790000000000000001';this.composerId='Cmp1';this.epoch=0;this.map=new Map();this.log=[];this.selected=null;this.onAction=null;
  }
  async getAXState() {
    this.epoch++;this.map=new Map();let n=this.epoch*100;
    const line=(name,value)=>{const i=++n;this.map.set(i,name);return '\t'+i+' '+value;};
    const rows=['0 AXWebArea '+(this.open?'新建邮件':'草稿')+' - Zoho Mail ('+accountId+')'+(this.open?', URL: mail.test/#compose/draft/'+this.mailboxDraftId:'')];
    rows.push(line('new','button 新建邮件'));
    if(!this.open){if(this.hiddenComposer)rows.push(line('hidden','tab (selectable, settable, boolean) Description: Existing work, ID: jstabBtn-Cmp9, Value: 0'));return rows.join('\n');}
    rows.push(line('send','button 发送'),line('schedule','button 定时发送'),
      line('save',this.saved&&this.autoCaption?'button 草稿 保存：最后修改时间 @ 08:05 下午':'button '+(this.saved?'(disabled) ':'')+'保存草稿'),
      line('discard','button 丢弃草稿'),line('sender','button From '+accountId),
      line('address','text 收件人：'),line('to','combo box (collapsed, settable) Description: 收件人, Secondary Actions: Expand'));
    if(this.recipient)rows.push(line('address-chip',this.recipient));
    rows.push(line('cc-label','text 抄送'),line('cc','combo box (collapsed, settable) Description: 抄送人, Secondary Actions: Expand'));
    if(this.extraCc)rows.push(line('cc-chip','other@example.test'));
    rows.push(line('subject','text field (settable) '+(this.subject?'Value: '+this.subject:'input-_r_11_')));
    if(this.duplicateSubject)rows.push(line('subject-extra','text field (settable) input-_r_22_'));
    rows.push(line('font','text field (settable) Description: 字体大小, Value: 10'),
      line('frame','AXWebArea about:srcdoc'),
      line('mode','pop up button (collapsed) Description: '+(this.plainMode?'切换至富文本':'选择文本模式')+', Secondary Actions: Expand'),
      line('body',this.missingBodyValue?(this.plainMode?'text entry area (settable) Description: 纯文本编辑区域':'container 富文本编辑区域'):(this.plainMode?'text entry area (settable) Description: 纯文本编辑区域, Value: ':'container Description: 富文本编辑区域, Value: ')+this.body),
      line('child','text '+(this.body.split('\n')[0]||'body')));
    rows.push(line('pane','container Description: '+(this.subject||'（无主题）')+', ID: jstab-'+this.composerId),line('tab','tab (selected, settable, boolean) Description: '+(this.subject||'（无主题）')+', ID: jstabBtn-'+this.composerId+', Value: 1'));
    if(this.showModeMenu)rows.push(line('rich-option','富文本'),line('plain-option','纯文本'));
    if(this.showModeDialog)rows.push(line('dialog','container 切换编辑器到纯文本？'),line('heading','heading 切换编辑器到纯文本？'),line('message','text 切换至纯文本模式后，所有格式与图片将会丢失。是否切换至纯文本模式？'),line('cancel','button 取消'),line('confirm','button 切换'));
    if(this.saved&&!this.unknownSave)rows.push(line('toast','text 草稿已保存'));
    return rows.join('\n');
  }
  control(index){if(!this.map.has(index))throw Error('STALE_TEST_REFERENCE');return this.map.get(index);}
  async click(index){
    const name=this.control(index);this.log.push(['click',name]);this.onAction?.('click',name);
    if(name==='send'||name==='schedule'||name==='discard')throw Error('FORBIDDEN_TEST_ACTION');
    if(name==='new'){this.open=true;return;}
    if(name==='mode'){this.showModeMenu=true;return;}
    if(name==='plain-option'){this.showModeMenu=false;this.showModeDialog=true;return;}
    if(name==='confirm'){this.showModeDialog=false;this.plainMode=true;return;}
    if(name==='save'){if(!this.unknownSave)this.saved=true;return;}
  }
  async pressKey(index,key){
    const name=this.control(index);this.log.push(['key',name,key]);this.onAction?.('key',name);
    if(key==='Control_L+a'){this.selected=name;return;}
    if(name==='to'&&key==='Return'){this.recipient=this.pendingRecipient.toLowerCase();this.pendingRecipient='';return;}
    throw Error('UNEXPECTED_TEST_KEY');
  }
  async typeText(index,value) {
    const name=this.control(index);this.log.push(['type',name,value]);this.onAction?.('type',name);
    if(name==='to')this.pendingRecipient=value;
    else if(name==='subject'||name==='body'){
      const entered=name==='body'&&!this.plainMode&&this.richEnterExpansion?value.replace(/\n\n/g,'\n\n\n'):value;
      this[name]=this.selected===name?entered:this[name]+entered;this.selected=null;if(name==='body'&&this.autoSave)this.saved=true;
    }else throw Error('UNEXPECTED_TEST_TYPE');
  }
  async reload(){this.log.push(['reload']);}
}
function setup(options={}) {
  const tab=new FakeTab(options);let exclusive=true,mutations=0;
  const writer=new CuaDraftWriter({tab,accountId,assertExclusive:()=>{assert.equal(exclusive,true);},beforeMutation:async()=>{mutations++;}});
  return {tab,writer,setExclusive:v=>{exclusive=v;},mutations:()=>mutations};
}

test('actual empty-composer layout parses subject without choosing font size',()=>{
  const source='0 AXWebArea 新建邮件 - Zoho Mail ('+accountId+')\n'+[
    '17 button 新建邮件','681 button 发送','682 button 定时发送','686 button (disabled) 保存草稿',
    '691 button From '+accountId,'695 text 收件人：','698 combo box (collapsed, settable) Description: 收件人, Secondary Actions: Expand',
    '702 text 抄送','705 combo box (collapsed, settable) Description: 抄送人, Secondary Actions: Expand',
    '706 text field (settable) input-_r_11_','734 text field (settable) Description: 字体大小, Value: 10',
    '810 AXWebArea about:srcdoc','811 container Description: 富文本编辑区域, Value: Jensen Yan','820 text Jensen Yan'
  ].map(line=>'\t'+line).join('\n');
  const controls=composerControls(source,accountId);
  assert.equal(controls.subjectIndex,706);assert.equal(controls.recipientIndex,698);assert.equal(controls.editorIndex,811);
  assert.equal(controls.subjectValue,'');assert.deepEqual(controls.addresses,[]);
});

test('save replaces default signature and exact fields using fresh references; never sends',async()=>{
  const {tab,writer}=setup();let saves=0;
  const result=await writer.save(packet,{beforeSave:async()=>{saves++;assert.equal(tab.log.at(-1)[0],'type');}});
  assert.deepEqual(result,{status:'saved'});assert.equal(saves,1);assert.equal(tab.subject,packet.subject);assert.equal(tab.body,packet.body);
  assert.equal(tab.body.includes('Jensen Yan'),false);assert.equal(tab.recipient,packet.recipient);
  assert.equal(tab.log.filter(x=>x[0]==='click'&&x[1]==='save').length,1);
  assert.equal(tab.log.some(x=>['send','schedule','discard'].includes(x[1])),false);
});

test('readback parser requires exact full body and rejects appended signature',async()=>{
  const {tab}=setup({open:true});tab.recipient=packet.recipient;tab.subject=packet.subject;tab.body=packet.body;
  const state=await tab.getAXState();assert.equal(readComposerPacket(state,accountId,packet).body,packet.body);
  tab.body+='\nJensen Yan';assert.throws(()=>readComposerPacket(awaitable(),accountId,packet));
  function awaitable(){return state.replace(packet.body,tab.body);}
});

test('missing complete editor Value is not inferred from visible text children',async()=>{
  const {tab,writer}=setup({missingBodyValue:true});
  await assert.rejects(()=>writer.save(packet,{beforeSave:async()=>{}}),/COMPOSE_LAYOUT_CHANGED/);
  assert.equal(tab.log.some(x=>x[0]==='click'&&x[1]==='save'),false);
});

test('preexisting open composer is left untouched',async()=>{
  const {tab,writer}=setup({open:true});
  await assert.rejects(()=>writer.save(packet,{beforeSave:async()=>{}}),/EXISTING_COMPOSER_OPEN/);
  assert.deepEqual(tab.log,[]);
});

test('unexpected CC recipient prevents body entry and saving',async()=>{
  const {tab,writer}=setup({extraCc:true});
  await assert.rejects(()=>writer.save(packet,{beforeSave:async()=>{}}),/NEW_COMPOSER_NOT_EMPTY/);
  assert.equal(tab.log.some(x=>x[0]==='type'),false);
});

test('ambiguous subject control prevents editing the new composer',async()=>{
  const {tab,writer}=setup({duplicateSubject:true});
  await assert.rejects(()=>writer.save(packet,{beforeSave:async()=>{}}),/SUBJECT_CONTROL_AMBIGUOUS/);
  assert.equal(tab.log.some(x=>x[0]==='type'),false);
});

test('beforeSave rejection leaves filled draft without save click or delete',async()=>{
  const {tab,writer}=setup();let invoked=0;
  await assert.rejects(()=>writer.save(packet,{beforeSave:async()=>{invoked++;throw Error('APPROVAL_EXPIRED');}}),/APPROVAL_EXPIRED/);
  assert.equal(invoked,1);assert.equal(tab.log.some(x=>x[0]==='click'&&x[1]==='save'),false);
});

test('final synchronous lock guard follows async identity work and save authorization',async()=>{
  const {tab,writer,setExclusive}=setup();
  await assert.rejects(()=>writer.save(packet,{beforeSave:async()=>{setExclusive(false);}}),/false !== true/);
  assert.equal(tab.log.some(x=>x[0]==='click'&&x[1]==='save'),false);
});

test('unknown save acknowledgement is never retried',async()=>{
  const {tab,writer}=setup({unknownSave:true});let hooks=0;
  await assert.rejects(()=>writer.save(packet,{beforeSave:async()=>{hooks++;}}),/SAVE_OUTCOME_UNKNOWN/);
  assert.equal(hooks,1);assert.equal(tab.log.filter(x=>x[0]==='click'&&x[1]==='save').length,1);
  assert.equal(tab.log.some(x=>x[1]==='discard'),false);
});

test('missing guards disables mutations by default',async()=>{
  const tab=new FakeTab();const writer=new CuaDraftWriter({tab,accountId});
  await assert.rejects(()=>writer.save(packet,{beforeSave:async()=>{}}),/MUTATION_NOT_AUTHORIZED/);assert.deepEqual(tab.log,[]);
});

test('cancellation after async guard blocks actual input',async()=>{
  const tab=new FakeTab(),controller=new AbortController();
  const writer=new CuaDraftWriter({tab,accountId,assertExclusive:()=>{},beforeMutation:async()=>controller.abort()});
  await assert.rejects(()=>writer.save(packet,{beforeSave:async()=>{},signal:controller.signal}),/DRAFT_WRITE_ABORTED/);assert.deepEqual(tab.log,[]);
});

function searchState({count=1,recipient=packet.recipient,duplicate=false,scope=true,created=true}={}){
  return '0 AXWebArea Zoho Mail ('+accountId+')\n1 text field (settable) Value: '+packet.recipient+'\n'+
    (scope?'2 container Description: 文件夹内, Value: 草稿/\n':'')+'3 text 来自邮件的结果 ('+count+')\n'+
    (count===0?'4 text 无与搜索条件相匹配的消息':[
    '4 Value: 来自 我, 主题 '+packet.subject+', '+(created?'创建时间':'投递时间')+' 今天, ID: 1790000000000000001',
    '5 text <'+recipient+'>',
    ...(duplicate?['6 Value: 来自 我, 主题 '+packet.subject+', 创建时间 今天, ID: 1790000000000000001','7 text <'+recipient+'>']:[])].join('\n'));
}
test('readExisting returns stable scoped refs only with completed full draft results',async()=>{
  const {writer}=setup();writer.reader.searchDraftsForRecipient=async()=>searchState();
  const result=await writer.readExisting({accountId,recipient:packet.recipient});
  assert.equal(result.complete,true);assert.equal(result.drafts[0].draftId,'1790000000000000001');
  assert.equal(result.drafts[0].locatedBy,'draft_search');assert.equal(result.drafts[0].accountId,accountId);
});

test('readExisting accepts complete zero result and rejects scope/count/recipient ambiguity',async()=>{
  for(const options of [{count:51},{scope:false},{recipient:'not-an-email'},{created:false},{count:2,duplicate:true}]){
    const {writer}=setup();writer.reader.searchDraftsForRecipient=async()=>searchState(options);
    await assert.rejects(()=>writer.readExisting({accountId,recipient:packet.recipient}),/INCOMPLETE|ID_AMBIGUOUS/);
  }
  const {writer}=setup();writer.reader.searchDraftsForRecipient=async()=>searchState({count:0});
  assert.deepEqual((await writer.readExisting({accountId,recipient:packet.recipient})).drafts,[]);
});

test('inspect uses exact existing-draft reader and retains authoritative full content',async()=>{
  const {writer}=setup();const item={...packet,draftId:'1790000000000000001',approvedHash:'hash',draftVersion:'hash'};
  let seen;writer.reader.inspectDraft=async ref=>{seen=ref;return item;};
  const result=await writer.inspect({accountId,draftId:item.draftId,recipient:packet.recipient,subject:packet.subject});
  assert.equal(seen.draftId,item.draftId);assert.deepEqual(result,item);
});

test('second concurrent writer operation is rejected',async()=>{
  const {writer}=setup();let resolve;
  writer.reader.searchDraftsForRecipient=()=>new Promise(r=>{resolve=r;});
  const first=writer.readExisting({accountId,recipient:packet.recipient});
  await assert.rejects(()=>writer.readExisting({accountId,recipient:packet.recipient}),/DRAFT_WRITER_BUSY/);
  resolve(searchState({count:0}));await first;
});

test('inactive existing composer tabs are not ignored when starting another draft',async()=>{
  const {tab,writer}=setup({hiddenComposer:true});
  await assert.rejects(()=>writer.save(packet,{beforeSave:async()=>{}}),/EXISTING_COMPOSER_OPEN/);
  assert.deepEqual(tab.log,[]);
});
test('provider autosave returns only a readback-required candidate without disabled-button click',async()=>{
  const {tab,writer}=setup({autoSave:true});let calls=0;
  const result=await writer.save(packet,{beforeSave:async()=>{calls++;}});
  assert.deepEqual(result,{status:'saved',saveMethod:'provider_autosave_candidate',requiresReadback:true});
  assert.equal(calls,1);assert.equal(tab.log.filter(x=>x[0]==='click'&&x[1]==='save').length,0);
  assert.equal(tab.body,packet.body);
});
test('expired approval prevents accepting an autosave candidate',async()=>{
  const {tab,writer}=setup({autoSave:true});
  await assert.rejects(()=>writer.save(packet,{beforeSave:async()=>{throw Error('EXACT_CORE_APPROVAL_EXPIRED');}}),/APPROVAL_EXPIRED/);
  assert.equal(tab.log.some(x=>x[0]==='click'&&x[1]==='save'),false);
});
test('cancellation during the final save hook prevents save click',async()=>{
  const {tab,writer}=setup(),controller=new AbortController();
  await assert.rejects(()=>writer.save(packet,{beforeSave:async()=>controller.abort(),signal:controller.signal}),/DRAFT_WRITE_ABORTED/);
  assert.equal(tab.log.some(x=>x[0]==='click'&&x[1]==='save'),false);
});
test('unrepresented attachments are not silently omitted',async()=>{
  const {tab,writer}=setup();
  await assert.rejects(()=>writer.save({...packet,attachments:['file.pdf']},{beforeSave:async()=>{}}),/PACKET_INVALID/);
  assert.deepEqual(tab.log,[]);
});
test('CC appearing while writing the body prevents the final save',async()=>{
  const {tab,writer}=setup();tab.onAction=(kind,name)=>{if(kind==='type'&&name==='body')tab.extraCc=true;};
  await assert.rejects(()=>writer.save(packet,{beforeSave:async()=>{}}),/RECIPIENT_OR_CC_CHANGED/);
  assert.equal(tab.log.some(x=>x[0]==='click'&&x[1]==='save'),false);
});
test('contradictory no-match and positive count never prove an empty draft list',async()=>{
  const {writer}=setup();
  writer.reader.searchDraftsForRecipient=async()=>searchState({count:0}).replace('结果 (0)','结果 (1)');
  await assert.rejects(()=>writer.readExisting({accountId,recipient:packet.recipient}),/SEARCH_INCOMPLETE/);
});
test('async exclusivity callbacks are rejected before browser mutation',async()=>{
  const tab=new FakeTab();const writer=new CuaDraftWriter({tab,accountId,assertExclusive:async()=>{},beforeMutation:async()=>{}});
  await assert.rejects(()=>writer.save(packet,{beforeSave:async()=>{}}),/MUST_BE_SYNCHRONOUS/);assert.deepEqual(tab.log,[]);
});

const repairOptions={expectedComposerId:'jstab-Cmp1',expectedMailboxDraftId:'1790000000000000001'};
function repairSetup(options={}){
  const fixture=setup({open:true,plainMode:true,...options});
  fixture.tab.recipient=packet.recipient;fixture.tab.subject=packet.subject;
  fixture.tab.body=packet.body.replace(/\n\n/g,'\n\n\n');
  return fixture;
}
test('new rich composer switches through observed plain-text menu before typing approved body',async()=>{
  const {tab,writer}=setup({plainMode:false,richEnterExpansion:true});
  let withheld=false;const snapshot=tab.getAXState.bind(tab);
  tab.getAXState=async()=>{const state=await snapshot();if(tab.showModeMenu&&!withheld){withheld=true;return state.replace(/^\s*\d+ (?:纯文本|富文本)\s*$/gm,'');}return state;};
  await writer.save(packet,{beforeSave:async()=>{}});
  assert.equal(tab.plainMode,true);assert.equal(tab.body,packet.body);assert.equal(withheld,true);
  assert.equal(tab.log.filter(x=>x[0]==='click'&&x[1]==='mode').length,1);
  assert.equal(tab.log.filter(x=>x[0]==='click'&&x[1]==='plain-option').length,1);
  assert.equal(tab.log.filter(x=>x[0]==='click'&&x[1]==='confirm').length,1);
});
test('timed provider autosave label is only a readback-required candidate',async()=>{
  const {tab,writer}=setup({autoSave:true,autoCaption:true});let hooks=0;
  const result=await writer.save(packet,{beforeSave:async()=>{hooks++;}});
  assert.equal(result.requiresReadback,true);assert.equal(result.saveMethod,'provider_autosave_candidate');
  assert.equal(hooks,1);assert.equal(tab.log.some(x=>x[0]==='click'&&x[1]==='save'),false);
});
test('repair rewrites only the bound current draft with exact approved newlines and never opens new',async()=>{
  const {tab,writer}=repairSetup();let hooks=0;
  const result=await writer.writeCurrentApprovedComposer(packet,{...repairOptions,beforeSave:async()=>{hooks++;}});
  assert.equal(result.status,'saved');assert.equal(tab.body,packet.body);assert.equal(hooks,1);
  assert.equal(tab.log.some(x=>x[0]==='click'&&x[1]==='new'),false);
  assert.equal(tab.log.some(x=>['send','schedule','discard'].includes(x[1])),false);
  assert.equal(writer.repairTarget,null);
});
test('repair can switch the same current rich draft to plain text without weakening final body equality',async()=>{
  const {tab,writer}=repairSetup({plainMode:false,richEnterExpansion:true});
  await writer.writeCurrentApprovedComposer(packet,{...repairOptions,beforeSave:async()=>{}});
  assert.equal(tab.plainMode,true);assert.equal(tab.body,packet.body);
});
test('repair requires both provider draft ID and exact selected composer ID',async()=>{
  for(const options of [{...repairOptions,expectedMailboxDraftId:'1790000000000000002'},{...repairOptions,expectedComposerId:'jstab-Cmp2'},{expectedComposerId:'jstab-Cmp1'}]){
    const {tab,writer}=repairSetup();
    await assert.rejects(()=>writer.writeCurrentApprovedComposer(packet,{...options,beforeSave:async()=>{}}),/REPAIR_TARGET_MISMATCH|REPAIR_BINDING_REQUIRED/);
    assert.deepEqual(tab.log,[]);
  }
});
test('repair will not overwrite unrelated textual edits merely because recipient and subject match',async()=>{
  const {tab,writer}=repairSetup();tab.body+=' Unrelated edit.';
  await assert.rejects(()=>writer.writeCurrentApprovedComposer(packet,{...repairOptions,beforeSave:async()=>{}}),/REPAIR_BODY_NOT_LINEBREAK_ONLY/);
  assert.deepEqual(tab.log,[]);
});
test('repair with no provider ID in the current visible URL is held before inputs',async()=>{
  const {tab,writer}=repairSetup();const snapshot=tab.getAXState.bind(tab);
  tab.getAXState=async()=>(await snapshot()).replace(/#compose\/draft\/\d+/g,'#compose');
  await assert.rejects(()=>writer.writeCurrentApprovedComposer(packet,{...repairOptions,beforeSave:async()=>{}}),/REPAIR_DRAFT_ID_AMBIGUOUS/);assert.deepEqual(tab.log,[]);
});
test('target change during plaintext conversion stops repair before rewriting',async()=>{
  const {tab,writer}=repairSetup({plainMode:false});
  tab.onAction=(kind,name)=>{if(kind==='click'&&name==='confirm')tab.mailboxDraftId='1790000000000000002';};
  await assert.rejects(()=>writer.writeCurrentApprovedComposer(packet,{...repairOptions,beforeSave:async()=>{}}),/REPAIR_TARGET_MISMATCH/);
  assert.equal(tab.log.some(x=>x[0]==='type'),false);
});
test('persisting wrong newlines even in plain mode remains a body mismatch, never an approval hash change',async()=>{
  const {tab,writer}=repairSetup();const input=tab.typeText.bind(tab);
  tab.typeText=async(index,value)=>{await input(index,value);if(tab.control(index)==='body')tab.body=tab.body.replace(/\n\n/g,'\n\n\n');};
  await assert.rejects(()=>writer.writeCurrentApprovedComposer(packet,{...repairOptions,beforeSave:async()=>{}}),/DRAFT_WRITE_BODY_CHANGED/);
  assert.equal(tab.log.some(x=>x[0]==='click'&&x[1]==='save'),false);
});

test('Save confirmation may arrive on the next fresh read without a second Save click',async()=>{
  const {tab,writer}=setup({unknownSave:true,autoCaption:true});let afterClick=false,reads=0,hooks=0;
  tab.onAction=(kind,name)=>{if(kind==='click'&&name==='save')afterClick=true;};
  const snapshot=tab.getAXState.bind(tab);
  tab.getAXState=async()=>{if(afterClick&&++reads===2)tab.saved=true;return await snapshot();};
  const result=await writer.save(packet,{beforeSave:async()=>{hooks++;}});
  assert.equal(result.status,'saved');assert.equal(reads,2);assert.equal(hooks,1);
  assert.equal(tab.log.filter(x=>x[0]==='click'&&x[1]==='save').length,1);
  assert.equal(tab.log.filter(x=>x[0]==='click'&&x[1]==='new').length,1);
});
test('persistent absent Save acknowledgement stops after eight reads without repeating mutations',async()=>{
  const {tab,writer}=setup({unknownSave:true});let afterClick=false,reads=0;
  tab.onAction=(kind,name)=>{if(kind==='click'&&name==='save')afterClick=true;};
  const snapshot=tab.getAXState.bind(tab);
  tab.getAXState=async()=>{if(afterClick)reads++;return await snapshot();};
  await assert.rejects(()=>writer.save(packet,{beforeSave:async()=>{}}),/DRAFT_SAVE_OUTCOME_UNKNOWN/);
  assert.equal(reads,8);assert.equal(tab.log.filter(x=>x[0]==='click'&&x[1]==='save').length,1);
  assert.equal(tab.log.filter(x=>x[0]==='click'&&x[1]==='new').length,1);
});
test('body change during delayed Save confirmation stops immediately instead of waiting for a label',async()=>{
  const {tab,writer}=setup({unknownSave:true});let afterClick=false,reads=0;
  tab.onAction=(kind,name)=>{if(kind==='click'&&name==='save')afterClick=true;};
  const snapshot=tab.getAXState.bind(tab);
  tab.getAXState=async()=>{if(afterClick&&++reads===2){tab.body+=' Changed';tab.saved=true;}return await snapshot();};
  await assert.rejects(()=>writer.save(packet,{beforeSave:async()=>{}}),/DRAFT_WRITE_BODY_CHANGED/);
  assert.equal(reads,2);assert.equal(tab.log.filter(x=>x[0]==='click'&&x[1]==='save').length,1);
});
test('autosave candidate can settle after a fresh read without clicking its status button',async()=>{
  const {tab,writer}=setup({autoSave:true,autoCaption:true});let confirming=false,reads=0,hooks=0;
  const snapshot=tab.getAXState.bind(tab);
  tab.getAXState=async()=>{if(confirming&&++reads===2)tab.saved=true;return await snapshot();};
  const result=await writer.save(packet,{beforeSave:async()=>{hooks++;confirming=true;tab.saved=false;}});
  assert.equal(result.requiresReadback,true);assert.equal(reads,2);assert.equal(hooks,1);
  assert.equal(tab.log.filter(x=>x[0]==='click'&&x[1]==='save').length,0);
});
test('cancellation during saved-candidate observations stops further reads and never resubmits',async()=>{
  const {tab,writer}=setup({unknownSave:true}),controller=new AbortController();let afterClick=false,reads=0;
  tab.onAction=(kind,name)=>{if(kind==='click'&&name==='save')afterClick=true;};
  const snapshot=tab.getAXState.bind(tab);
  tab.getAXState=async()=>{const state=await snapshot();if(afterClick){reads++;controller.abort();}return state;};
  await assert.rejects(()=>writer.save(packet,{beforeSave:async()=>{},signal:controller.signal}),/DRAFT_WRITE_ABORTED/);
  assert.equal(reads,1);assert.equal(tab.log.filter(x=>x[0]==='click'&&x[1]==='save').length,1);
});
