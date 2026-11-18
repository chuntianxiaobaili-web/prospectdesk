import {BrowserMailAdapter, parseRows, parseCompose, createVisiblePlainBodyReader} from './browser-adapter.mjs';

const text = value => String(value ?? '');
const normalizeBody = value => text(value).replace(/\r\n?/g,'\n').trim();
const emailPattern = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const unique = (items, code) => { if(items.length!==1)throw Error(code);return items[0]; };
const indices = (state, regex) => [...state.matchAll(regex)].map(match=>({index:Number(match[1]),match}));
const checkSignal = signal => {if(signal?.aborted)throw Error('DRAFT_WRITE_ABORTED');};

/** Parse only the currently observed Chinese CUA composer layout.
 * Numeric controls are derived afresh; absent full editor Value is never guessed. */
export function composerControls(state, accountId) {
  if(!state.includes(`Zoho Mail (${accountId})`))throw Error('DRAFT_WRITE_ACCOUNT_CHANGED');
  unique(indices(state,/^\s*(\d+) button 发送\s*$/gm),'DRAFT_WRITE_COMPOSER_AMBIGUOUS');
  const sender=unique(indices(state,/^\s*(\d+) button From ([^\s]+)\s*$/gm),'DRAFT_WRITE_SENDER_AMBIGUOUS');
  if(sender.match[2]!==accountId)throw Error('DRAFT_WRITE_SENDER_CHANGED');
  const recipient=unique(indices(state,/^\s*(\d+) combo box \([^\n]*settable[^\n]*\) Description: 收件人(?:,[^\n]*)?$/gm),'DRAFT_WRITE_RECIPIENT_CONTROL_AMBIGUOUS');
  const editor=unique(indices(state,/^\s*(\d+) (?:container(?: \([^\n]*\))? (?:Description: )?富文本编辑区域|text entry area \(settable\) Description: 纯文本编辑区域)(?:, Value:[^\n]*)?\s*$/gm),'DRAFT_WRITE_EDITOR_AMBIGUOUS');
  const addressStart=state.indexOf('text 收件人：');
  if(addressStart<0)throw Error('DRAFT_WRITE_ADDRESS_SECTION_MISSING');
  const editorStart=editor.match.index;
  const beforeEditor=state.slice(addressStart,editorStart);
  const subjects=indices(beforeEditor,/^\s*(\d+) text field \(settable\)(?: (?!Description:)[^\n]*)?$/gm)
    .filter(item=>!item.match[0].includes('Description:'));
  const subject=unique(subjects,'DRAFT_WRITE_SUBJECT_CONTROL_AMBIGUOUS');
  const subjectOffset=addressStart+subject.match.index;
  const addressSection=state.slice(addressStart,subjectOffset);
  const addresses=[...addressSection.matchAll(/^\s*\d+ ([^\s<>]+@[^\s<>]+)\s*$/gm)].map(match=>match[1].toLowerCase());
  const valueMatch=subject.match[0].match(/ Value: (.*?)(?:, ID: .*|)$/);
  const subjectValue=valueMatch?valueMatch[1]:'';
  const save=indices(state,/^\s*(\d+) button 保存草稿\s*$/gm);
  const disabledSave=indices(state,/^\s*(\d+) button \(disabled\) 保存草稿\s*$/gm);
  const autoSave=indices(state,/^\s*(\d+) button 草稿 保存[：:]最后修改时间 @ [^\n]+$/gm);
  return {recipientIndex:recipient.index,subjectIndex:subject.index,editorIndex:editor.index,
    subjectValue,addresses,saveIndex:save.length===1?save[0].index:null,saveCount:save.length,
    disabledSaveCount:disabledSave.length,autoSaveCount:autoSave.length,editorKind:editor.match[0].includes('纯文本编辑区域')?'plain':'rich',subjectLine:subject.match[0],editorLine:editor.match[0]};
}

export function readComposerSnapshot(state, accountId, packet) {
  const controls=composerControls(state,accountId);
  if(controls.addresses.length!==1||controls.addresses[0]!==packet.recipient)throw Error('DRAFT_WRITE_RECIPIENT_OR_CC_CHANGED');
  if(controls.subjectValue!==packet.subject)throw Error('DRAFT_WRITE_SUBJECT_CHANGED');
  // CUA can name the same rich editor without the Description prefix. Only
  // normalize this visible label; parseCompose still requires a complete Value.
  const canonical=state.replace(/^([ \t]*\d+) container(?: \([^\n]*\))? 富文本编辑区域(?=, Value:)/gm,'$1 container Description: 富文本编辑区域')
    .replace(controls.subjectLine,controls.subjectLine.replace(/text field \(settable\).*? Value:/,'text field (settable) Value:'));
  const item=parseCompose(canonical,accountId,{accountId,recipient:packet.recipient,subject:packet.subject,attachments:false});
  return item;
}
export function readComposerPacket(state, accountId, packet) {
  const item=readComposerSnapshot(state,accountId,packet);
  if(normalizeBody(item.body)!==normalizeBody(packet.body))throw Error('DRAFT_WRITE_BODY_CHANGED');
  return item;
}

export function currentComposerIdentity(state,accountId){
  composerControls(state,accountId);
  const panes=[...state.matchAll(/^\s*\d+ container Description:[^\n]*, ID: (jstab-Cmp\d+)\s*$/gm)];
  const selected=[...state.matchAll(/^\s*\d+ tab \([^\n]*\bselected\b[^\n]*\) Description:[^\n]*, ID: jstabBtn-(Cmp\d+), Value: 1\s*$/gm)];
  const pane=unique(panes,'DRAFT_WRITER_REPAIR_COMPOSER_AMBIGUOUS')[1];
  if('jstab-'+unique(selected,'DRAFT_WRITER_REPAIR_COMPOSER_AMBIGUOUS')[1]!==pane)throw Error('DRAFT_WRITER_REPAIR_COMPOSER_AMBIGUOUS');
  const ids=[...new Set([...state.matchAll(/#compose\/draft\/(\d{10,})/g)].map(match=>match[1]))];
  if(ids.length!==1)throw Error('DRAFT_WRITER_REPAIR_DRAFT_ID_AMBIGUOUS');
  return {composerId:pane,mailboxDraftId:ids[0]};
}

/** Creates and saves a draft through an explicitly connected CUA tab.
 * It has no send method. The caller must hold the shared account lock and
 * provide an already-approved packet through saveApprovedDraft.
 * This current profile supports CUA rich-text iframe access; it does not claim
 * that the separate Chromium multi-frame bridge has been validated. */
export class CuaDraftWriter {
  constructor({tab,accountId,assertExclusive,beforeMutation,identity=null}={}) {
    if(!tab||!accountId)throw Error('DRAFT_WRITER_EXPLICIT_TAB_ACCOUNT_REQUIRED');
    for(const method of ['getAXState','click','reload','typeText','pressKey'])if(typeof tab[method]!=='function')throw Error('DRAFT_WRITER_TAB_INTERFACE_INCOMPLETE');
    if(assertExclusive!==undefined&&typeof assertExclusive!=='function')throw Error('DRAFT_WRITER_EXCLUSIVE_GUARD_REQUIRED');
    if(beforeMutation!==undefined&&typeof beforeMutation!=='function')throw Error('DRAFT_WRITER_MUTATION_GUARD_REQUIRED');
    this.identity=identity?Object.freeze({browserId:identity.browserId??null,targetId:identity.targetId??null}):null;
    this.tab=tab;this.accountId=accountId;this.assertExclusive=assertExclusive;this.beforeMutation=beforeMutation;this.active=false;this.currentSignal=null;this.repairTarget=null;
    const writer=this;
    const guardedTab=new Proxy(tab,{get(target,property){
      const value=target[property];
      if(['click','reload','typeText','pressKey'].includes(property))return async(...args)=>writer.dispatch(property,args,writer.currentSignal);
      return typeof value==='function'?value.bind(target):value;
    }});
    this.reader=new BrowserMailAdapter({tab:guardedTab,accountId,readComposeBody:createVisiblePlainBodyReader(tab)});
  }
  guard(signal) {
    checkSignal(signal);
    if(typeof this.assertExclusive!=='function'||typeof this.beforeMutation!=='function')throw Error('DRAFT_WRITER_MUTATION_NOT_AUTHORIZED');
    const result=this.assertExclusive();
    if(result?.then)throw Error('DRAFT_WRITER_EXCLUSIVE_GUARD_MUST_BE_SYNCHRONOUS');
    if(result===false)throw Error('DRAFT_WRITER_ACCOUNT_NOT_EXCLUSIVE');
  }
  async dispatch(method,args,signal,beforeSave) {
    this.guard(signal);
    await this.beforeMutation({kind:method,args:[...args]});
    this.guard(signal);
    if(beforeSave){await beforeSave();this.guard(signal);}
    return await this.tab[method](...args);
  }
  async operation(signal,fn) {
    if(this.active)throw Error('DRAFT_WRITER_BUSY');
    checkSignal(signal);this.active=true;this.currentSignal=signal;
    try{return await fn();}finally{this.active=false;this.currentSignal=null;this.repairTarget=null;}
  }
  async snapshot(signal) {
    checkSignal(signal);const state=await this.tab.getAXState({emit:false,disableDiffing:true});checkSignal(signal);
    this.reader.checkAccount(state);
    if(this.repairTarget){const actual=currentComposerIdentity(state,this.accountId);if(actual.composerId!==this.repairTarget.composerId||actual.mailboxDraftId!==this.repairTarget.mailboxDraftId)throw Error('DRAFT_WRITER_REPAIR_TARGET_MISMATCH');}
    return state;
  }
  async readExisting({accountId,recipient,signal}={}) {
    return await this.operation(signal,async()=>{
      if(accountId!==this.accountId||!emailPattern.test(text(recipient)))throw Error('DRAFT_WRITER_READ_BINDING_INVALID');
      const state=await this.reader.searchDraftsForRecipient(recipient);
      checkSignal(signal);this.reader.checkAccount(state);
      const rows=parseRows(state);
      const count=state.match(/来自邮件的结果 \((\d+)\)/);
      const absent=state.includes('无与搜索条件相匹配的消息');
      const complete=count?Number(count[1])===rows.length&&(!absent||Number(count[1])===0):absent&&rows.length===0;
      if(!state.includes('Description: 文件夹内, Value: 草稿/')||
        !complete ||
        rows.some(row=>!row.created||!row.recipient))throw Error('DRAFT_WRITER_EXISTING_SEARCH_INCOMPLETE');
      const seen=new Set();for(const row of rows){if(seen.has(row.draftId))throw Error('DRAFT_WRITER_EXISTING_ID_AMBIGUOUS');seen.add(row.draftId);}
      return {accountId,complete:true,drafts:rows.map(row=>({accountId,draftId:row.draftId,recipient:row.recipient,subject:row.subject,attachments:row.attachments,locatedBy:'draft_search'}))};
    });
  }
  async inspect(ref,{signal}={}) {
    return await this.operation(signal,async()=>{
      if(ref?.accountId!==this.accountId)throw Error('DRAFT_WRITER_READ_BINDING_INVALID');
      const item=await this.reader.inspectDraft(ref);checkSignal(signal);return item;
    });
  }
  async replace(field,textValue,signal) {
    let state=await this.snapshot(signal),controls=composerControls(state,this.accountId);
    const index=controls[field];
    await this.dispatch('pressKey',[index,'Control_L+a'],signal);
    state=await this.snapshot(signal);controls=composerControls(state,this.accountId);
    await this.dispatch('typeText',[controls[field],textValue],signal);
    return await this.snapshot(signal);
  }

  packetValid(packet) {
    if(packet?.accountId!==this.accountId||!emailPattern.test(text(packet.recipient))||
      !packet.subject||/[\r\n]/.test(packet.subject)||packet.subject.length>300||
      !normalizeBody(packet.body)||text(packet.body).length>40000||packet.attachments===true||
      Array.isArray(packet.attachments)&&packet.attachments.length>0)throw Error('DRAFT_WRITER_PACKET_INVALID');
  }
  async observeUntil(predicate,signal,label) {
    for(let attempt=0;attempt<8;attempt++){
      const state=await this.snapshot(signal);if(predicate(state))return state;
    }
    throw Error('DRAFT_WRITER_UI_NOT_READY:'+label);
  }
  async ensurePlainText(signal) {
    let state=await this.snapshot(signal),controls=composerControls(state,this.accountId);
    if(controls.editorKind==='plain')return state;
    const mode=unique(indices(state,/^\s*(\d+) pop up button \([^\n]*\) Description: 选择文本模式(?:,[^\n]*)?$/gm),'DRAFT_WRITER_TEXT_MODE_CONTROL_AMBIGUOUS');
    await this.dispatch('click',[mode.index],signal);
    state=await this.observeUntil(s=>indices(s,/^\s*(\d+) 纯文本\s*$/gm).length===1,signal,'plain-text-option');
    const plain=unique(indices(state,/^\s*(\d+) 纯文本\s*$/gm),'DRAFT_WRITER_PLAIN_TEXT_OPTION_AMBIGUOUS');
    await this.dispatch('click',[plain.index],signal);
    state=await this.snapshot(signal);
    if(!/text entry area \(settable\) Description: 纯文本编辑区域/.test(state)){
      if(!state.includes('切换编辑器到纯文本？')||!state.includes('切换至纯文本模式后，所有格式与图片将会丢失。是否切换至纯文本模式？'))throw Error('DRAFT_WRITER_PLAIN_TEXT_CONFIRMATION_MISSING');
      const confirm=unique(indices(state,/^\s*(\d+) button 切换\s*$/gm),'DRAFT_WRITER_PLAIN_TEXT_CONFIRMATION_AMBIGUOUS');
      await this.dispatch('click',[confirm.index],signal);
    }
    return await this.observeUntil(s=>composerControls(s,this.accountId).editorKind==='plain',signal,'plain-text-editor');
  }
  async observeSavedCandidate(packet,signal) {
    // Saving may settle one accessibility observation after the click. Only
    // reread the same composer; never repeat input, Save, or draft creation.
    for(let observation=0;observation<8;observation++){
      const state=await this.snapshot(signal);readComposerPacket(state,this.accountId,packet);
      const controls=composerControls(state,this.accountId);
      const savedLabel=controls.saveCount===0&&controls.disabledSaveCount+controls.autoSaveCount===1;
      if(savedLabel||/草稿(?:已保存|保存成功|已成功保存)|已保存到草稿/.test(state))return;
    }
    throw Error('DRAFT_SAVE_OUTCOME_UNKNOWN');
  }
  async saveCurrent(packet,beforeSave,signal) {
    let state=await this.snapshot(signal);readComposerPacket(state,this.accountId,packet);
    const controls=composerControls(state,this.accountId);
    if(controls.saveCount===0&&controls.disabledSaveCount+controls.autoSaveCount===1){
      this.guard(signal);await this.beforeMutation({kind:'autosave_readback',args:[]});this.guard(signal);
      await beforeSave();this.guard(signal);
      await this.observeSavedCandidate(packet,signal);
      return {status:'saved',saveMethod:'provider_autosave_candidate',requiresReadback:true};
    }
    if(controls.saveCount!==1||controls.saveIndex===null||controls.disabledSaveCount+controls.autoSaveCount!==0)throw Error('DRAFT_WRITER_SAVE_CONTROL_NOT_READY');
    await this.dispatch('click',[controls.saveIndex],signal,beforeSave);
    await this.observeSavedCandidate(packet,signal);
    return {status:'saved'};
  }
  async writeCurrentApprovedComposer(packet,{beforeSave,expectedComposerId,expectedMailboxDraftId,signal}={}) {
    return await this.operation(signal,async()=>{
      this.packetValid(packet);
      if(typeof beforeSave!=='function')throw Error('DRAFT_WRITER_SAVE_HOOK_REQUIRED');
      if(!/^jstab-Cmp\d+$/.test(text(expectedComposerId))||!/^\d{10,}$/.test(text(expectedMailboxDraftId)))throw Error('DRAFT_WRITER_REPAIR_BINDING_REQUIRED');
      this.guard(signal);
      let state=await this.snapshot(signal);
      const identity=currentComposerIdentity(state,this.accountId);
      if(identity.composerId!==expectedComposerId||identity.mailboxDraftId!==expectedMailboxDraftId)throw Error('DRAFT_WRITER_REPAIR_TARGET_MISMATCH');
      this.repairTarget={composerId:expectedComposerId,mailboxDraftId:expectedMailboxDraftId};
      const observed=readComposerSnapshot(state,this.accountId,packet);
      // This is a repair precondition, never an approval/body-hash comparison:
      // only line-break translation from this program's prior input is accepted.
      if(normalizeBody(observed.body).replace(/\n/g,'')!==normalizeBody(packet.body).replace(/\n/g,''))throw Error('DRAFT_WRITER_REPAIR_BODY_NOT_LINEBREAK_ONLY');
      await this.ensurePlainText(signal);
      state=await this.snapshot(signal);
      const afterMode=currentComposerIdentity(state,this.accountId);
      if(afterMode.composerId!==expectedComposerId||afterMode.mailboxDraftId!==expectedMailboxDraftId)throw Error('DRAFT_WRITER_REPAIR_TARGET_MISMATCH');
      const controls=composerControls(state,this.accountId);
      if(controls.addresses.length!==1||controls.addresses[0]!==packet.recipient||controls.subjectValue!==packet.subject)throw Error('DRAFT_WRITER_REPAIR_TARGET_MISMATCH');
      await this.replace('editorIndex',normalizeBody(packet.body),signal);
      state=await this.snapshot(signal);
      const finalIdentity=currentComposerIdentity(state,this.accountId);
      if(finalIdentity.composerId!==expectedComposerId||finalIdentity.mailboxDraftId!==expectedMailboxDraftId)throw Error('DRAFT_WRITER_REPAIR_TARGET_MISMATCH');
      readComposerPacket(state,this.accountId,packet);
      return await this.saveCurrent(packet,beforeSave,signal);
    });
  }
  async save(packet,{beforeSave,signal}={}) {
    return await this.operation(signal,async()=>{
      this.packetValid(packet);
      if(typeof beforeSave!=='function')throw Error('DRAFT_WRITER_SAVE_HOOK_REQUIRED');
      this.guard(signal);
      let state=await this.snapshot(signal);
      if(/^\s*\d+ button 发送\s*$/m.test(state)||/#compose(?:\b|$)/.test(state)||/^\s*\d+ tab \([^\n]*\)[^\n]*ID: jstabBtn-Cmp[^,\s]*/m.test(state))throw Error('DRAFT_WRITER_EXISTING_COMPOSER_OPEN');
      const entry=unique(indices(state,/^\s*(\d+) button 新建邮件\s*$/gm),'DRAFT_WRITER_NEW_MAIL_AMBIGUOUS');
      await this.dispatch('click',[entry.index],signal);
      state=await this.snapshot(signal);
      let controls=composerControls(state,this.accountId);
      if(controls.addresses.length||controls.subjectValue)throw Error('DRAFT_WRITER_NEW_COMPOSER_NOT_EMPTY');
      await this.ensurePlainText(signal);state=await this.snapshot(signal);controls=composerControls(state,this.accountId);
      await this.dispatch('typeText',[controls.recipientIndex,packet.recipient],signal);
      state=await this.snapshot(signal);controls=composerControls(state,this.accountId);
      await this.dispatch('pressKey',[controls.recipientIndex,'Return'],signal);
      state=await this.snapshot(signal);controls=composerControls(state,this.accountId);
      if(controls.addresses.length!==1||controls.addresses[0]!==packet.recipient)throw Error('DRAFT_WRITER_RECIPIENT_NOT_COMMITTED');
      await this.replace('subjectIndex',packet.subject,signal);
      await this.replace('editorIndex',normalizeBody(packet.body),signal);
      return await this.saveCurrent(packet,beforeSave,signal);
    });
  }
}
