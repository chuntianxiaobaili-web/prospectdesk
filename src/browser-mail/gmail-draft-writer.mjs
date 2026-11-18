import {GmailBrowserMailAdapter,gmailAccountFromAX,gmailComposeIdFromAX,createGmailVisibleAddressClicker} from './gmail-adapter.mjs';

const normalizeBody=value=>String(value??'').replace(/\r\n?/g,'\n').trim();
const singleEmail=value=>/^[A-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(String(value??''));
const only=(items,code)=>{if(items.length!==1)throw Error(code);return items[0];};
const checkSignal=signal=>{if(signal?.aborted)throw Error('DRAFT_WRITE_ABORTED');};
const cleanAX=state=>String(state).split('\nThe focused UI element is ')[0];

/** Fresh controls from the observed Chinese Gmail composer. It never returns
 * a send control: this writer owns only creation, exact input and save/close. */
export function gmailComposerControls(state,accountId){
  state=cleanAX(state);if(gmailAccountFromAX(state)!==accountId)throw Error('DRAFT_WRITE_ACCOUNT_CHANGED');
  const compose=[...state.matchAll(/^\s*\d+ container 撰写： [^\n]*$/gm)];
  const editor=only([...state.matchAll(/^\s*(\d+) text entry area \(settable\) Description: 邮件正文, ID: [^\n,]+, Value: ([\s\S]*?)(?=\n\s*\d+ (?:container|button|pop up button|text|checkbox|link)|(?![\s\S]))/gm)],'DRAFT_WRITE_EDITOR_AMBIGUOUS');
  if(!compose.length)throw Error('DRAFT_WRITE_COMPOSER_MISSING');
  const subject=only([...state.matchAll(/^\s*(\d+) text field \(settable\) Description: 主题(?:,[^\n]*)?$/gm)],'DRAFT_WRITE_SUBJECT_CONTROL_AMBIGUOUS');
  const subjectValue=subject[0].match(/, Value: (.*?)(?:, ID: [^\n]*|$)/)?.[1]??'';
  const recipients=[...state.matchAll(/^\s*(\d+) combo box \([^\n]*settable[^\n]*\) Description: 发送至收件人(?:,[^\n]*)?$/gm)];
  const close=only([...state.matchAll(/^\s*(\d+) button Description: 保存并关闭(?:,[^\n]*)?$/gm)],'DRAFT_WRITE_SAVE_CLOSE_AMBIGUOUS');
  const from=[...state.matchAll(/^\s*\d+ pop up button \((?:collapsed|expanded)\) [^\n]*<([^<>\s]+@[^<>\s]+)>, ID:/gm)];
  if(from.length>1||from.length===1&&from[0][1].toLowerCase()!==accountId)throw Error('DRAFT_WRITE_SENDER_CHANGED');
  return {subjectIndex:Number(subject[1]),subjectValue,editorIndex:Number(editor[1]),body:normalizeBody(editor[2]),recipientIndex:recipients.length===1?Number(recipients[0][1]):null,closeIndex:Number(close[1]),senderVisible:from.length===1};
}

export class GmailDraftWriter{
  constructor({tab,accountId,assertExclusive,beforeMutation,identity=null,readVisibleList,readVisibleComposer,readVisibleMessage,reader=null,readerFactory=null,clickVisibleAddress=null}={}){
    if(!tab||!singleEmail(accountId))throw Error('DRAFT_WRITER_EXPLICIT_TAB_ACCOUNT_REQUIRED');
    for(const method of ['getAXState','click','typeText','pressKey'])if(typeof tab[method]!=='function')throw Error('DRAFT_WRITER_TAB_INTERFACE_INCOMPLETE');
    if(assertExclusive!==undefined&&typeof assertExclusive!=='function')throw Error('DRAFT_WRITER_EXCLUSIVE_GUARD_REQUIRED');
    if(beforeMutation!==undefined&&typeof beforeMutation!=='function')throw Error('DRAFT_WRITER_MUTATION_GUARD_REQUIRED');
    this.tab=tab;this.accountId=accountId.toLowerCase();this.assertExclusive=assertExclusive;this.beforeMutation=beforeMutation;this.identity=identity?Object.freeze({browserId:identity.browserId??null,targetId:identity.targetId??null}):null;this.active=false;this.currentSignal=null;
    const writer=this,guardedTab=new Proxy(tab,{get(target,property){const value=target[property];if(['click','reload','typeText','pressKey','paste'].includes(property))return async(...args)=>writer.dispatch(property,args,writer.currentSignal);return typeof value==='function'?value.bind(target):value;}});
    this.guardedTab=guardedTab;
    if(clickVisibleAddress!==null&&typeof clickVisibleAddress!=='function')throw Error('GMAIL_ADDRESS_CLICKER_INVALID');
    const visibleAddress=clickVisibleAddress??(typeof tab.clickVisibleComposeAddress==='function'?(context=>tab.clickVisibleComposeAddress(context)):typeof tab.playwright?.locator==='function'?createGmailVisibleAddressClicker(tab,{assertExclusive:()=>writer.guard(writer.currentSignal)}):null);
    this.clickVisibleAddress=visibleAddress?async context=>{writer.guard(writer.currentSignal);await writer.beforeMutation({kind:'expandComposeAddress',args:[{...context}]});writer.guard(writer.currentSignal);return await visibleAddress(context);}:null;
    if(readerFactory!==null&&typeof readerFactory!=='function')throw Error('GMAIL_READER_FACTORY_REQUIRED');
    this.reader=readerFactory?readerFactory({tab:guardedTab,accountId:this.accountId,clickVisibleAddress:this.clickVisibleAddress}):reader??new GmailBrowserMailAdapter({tab:guardedTab,accountId:this.accountId,readVisibleList,readVisibleComposer,readVisibleMessage,clickVisibleAddress:this.clickVisibleAddress});
    if(!this.reader||this.reader.accountId!==this.accountId||['checkAccount','search','inspectDraft','ensureAddressExpanded'].some(method=>typeof this.reader[method]!=='function'))throw Error('GMAIL_READER_INTERFACE_INVALID');
    this.reader.tab=guardedTab;
  }
  guard(signal){
    checkSignal(signal);if(typeof this.assertExclusive!=='function'||typeof this.beforeMutation!=='function')throw Error('DRAFT_WRITER_MUTATION_NOT_AUTHORIZED');
    const result=this.assertExclusive();if(result?.then)throw Error('DRAFT_WRITER_EXCLUSIVE_GUARD_MUST_BE_SYNCHRONOUS');if(result===false)throw Error('DRAFT_WRITER_ACCOUNT_NOT_EXCLUSIVE');
  }
  async dispatch(method,args,signal,beforeSave){this.guard(signal);await this.beforeMutation({kind:method,args:[...args]});this.guard(signal);if(beforeSave){await beforeSave();this.guard(signal);}return await this.tab[method](...args);}
  async operation(signal,fn){if(this.active)throw Error('DRAFT_WRITER_BUSY');checkSignal(signal);this.active=true;this.currentSignal=signal;try{return await fn();}finally{this.active=false;this.currentSignal=null;}}
  async snapshot(signal){checkSignal(signal);const state=await this.tab.getAXState({emit:false,disableDiffing:true});checkSignal(signal);this.reader.checkAccount(state);return state;}
  async observeUntil(predicate,signal,label){for(let n=0;n<8;n++){const state=await this.snapshot(signal);if(predicate(state))return state;}throw Error('DRAFT_WRITER_UI_NOT_READY:'+label);}
  packetValid(packet){if(packet?.accountId!==this.accountId||!singleEmail(packet.recipient)||!packet.subject||/[\r\n]/.test(packet.subject)||packet.subject.length>300||!normalizeBody(packet.body)||String(packet.body).length>40000||packet.attachments===true||Array.isArray(packet.attachments)&&packet.attachments.length)throw Error('DRAFT_WRITER_PACKET_INVALID');}
  async closeReadComposer(item,signal){
    // Only a successfully read, exact original owned by this reader can be
    // saved and closed. A foreign/changed composer remains open for review.
    const verify=async()=>{
      const state=await this.snapshot(signal),token=gmailComposeIdFromAX(state);
      if(item?.accountId!==this.accountId||!item.composeToken||item.composeToken!==token
        ||this.reader.currentCompose?.draftId!==item.draftId||this.reader.currentCompose?.composeToken!==token)throw Error('DRAFT_WRITER_READ_COMPOSER_NOT_OWNED');
      if(typeof this.reader.composeSnapshot!=='function')throw Error('DRAFT_WRITER_READ_REVALIDATION_REQUIRED');
      const current=await this.reader.composeSnapshot(state,item);
      if(['accountId','draftId','threadId','composeToken','recipient','subject','body','approvedHash','draftVersion'].some(key=>current[key]!==item[key]))throw Error('DRAFT_WRITER_READ_COMPOSER_CHANGED');
      const controls=gmailComposerControls(state,this.accountId);return {state,closeIndex:controls.closeIndex};
    };
    const before=await verify();
    await this.dispatch('click',[before.closeIndex],signal,async()=>{
      const fresh=await verify();if(fresh.closeIndex!==before.closeIndex)throw Error('DRAFT_WRITER_READ_CLOSE_CONTROL_CHANGED');
    });
    this.reader.currentCompose=null;
    await this.observeUntil(state=>!/text entry area \(settable\) Description: 邮件正文/.test(state)&&!/[?&]compose=/.test(state),signal,'read-composer-closed');
  }
  async readExisting({accountId,recipient,signal}={}){
    return await this.operation(signal,async()=>{
      if(accountId!==this.accountId||!singleEmail(recipient))throw Error('DRAFT_WRITER_READ_BINDING_INVALID');
      const view=await this.reader.search('in:drafts to:'+recipient,'drafts');checkSignal(signal);
      if(view.rows.some(row=>!row.isDraft||row.recipient&&row.recipient!==recipient||!row.draftId&&!row.threadId))throw Error('DRAFT_WRITER_EXISTING_SEARCH_INCOMPLETE');
      const drafts=[];
      for(const row of view.rows){const ref={accountId,draftId:row.draftId??row.threadId,threadId:row.threadId,recipient,subject:row.subject,attachments:row.attachments===true,locatedBy:'gmail_draft_search'};const exact=await this.reader.inspectDraft(ref);if(exact.recipient!==recipient)throw Error('DRAFT_WRITER_EXISTING_SEARCH_INCOMPLETE');await this.closeReadComposer(exact,signal);drafts.push({...ref,recipient:exact.recipient});}
      if(new Set(drafts.map(row=>row.draftId)).size!==drafts.length)throw Error('DRAFT_WRITER_EXISTING_ID_AMBIGUOUS');
      return {accountId,complete:true,drafts};
    });
  }
  async inspect(ref,{signal}={}){return await this.operation(signal,async()=>{if(ref?.accountId!==this.accountId)throw Error('DRAFT_WRITER_READ_BINDING_INVALID');const item=await this.reader.inspectDraft(ref);checkSignal(signal);await this.closeReadComposer(item,signal);return item;});}
  async replace(field,value,signal){const body=field==='editorIndex';if(body&&typeof this.tab.paste!=='function')throw Error('GMAIL_PLAIN_TEXT_PASTE_REQUIRED');let state=await this.snapshot(signal),controls=gmailComposerControls(state,this.accountId);await this.dispatch('pressKey',[controls[field],'Control_L+a'],signal);state=await this.snapshot(signal);controls=gmailComposerControls(state,this.accountId);await this.dispatch(body?'paste':'typeText',body?[controls[field],value,{format:'text'}]:[controls[field],value],signal);return await this.snapshot(signal);}
  async save(packet,{beforeSave,signal}={}){
    return await this.operation(signal,async()=>{
      this.packetValid(packet);if(typeof beforeSave!=='function')throw Error('DRAFT_WRITER_SAVE_HOOK_REQUIRED');this.guard(signal);if(typeof this.tab.paste!=='function')throw Error('GMAIL_PLAIN_TEXT_PASTE_REQUIRED');
      let state=await this.snapshot(signal);
      if(/text entry area \(settable\) Description: 邮件正文/.test(state)||/[?&]compose=/.test(state))throw Error('DRAFT_WRITER_EXISTING_COMPOSER_OPEN');
      const create=only([...state.matchAll(/^\s*(\d+) button 写邮件\s*$/gm)],'DRAFT_WRITER_NEW_MAIL_AMBIGUOUS');
      await this.dispatch('click',[Number(create[1])],signal);state=await this.snapshot(signal);let controls=gmailComposerControls(state,this.accountId);
      if(controls.subjectValue||controls.recipientIndex===null||!controls.senderVisible)throw Error('DRAFT_WRITER_NEW_COMPOSER_NOT_EMPTY');
      if(typeof this.reader.readVisibleComposer!=='function')throw Error('GMAIL_VISIBLE_COMPOSER_READER_REQUIRED');
      const empty=await this.reader.readVisibleComposer({state,ref:null,item:null,metadataOnly:true});
      if(!empty||empty.sender!==this.accountId||!Array.isArray(empty.to)||empty.to.length||!Array.isArray(empty.cc)||empty.cc.length||!Array.isArray(empty.bcc)||empty.bcc.length||empty.attachmentCount!==0)throw Error('DRAFT_WRITER_NEW_COMPOSER_NOT_EMPTY');
      await this.dispatch('typeText',[controls.recipientIndex,packet.recipient],signal);state=await this.snapshot(signal);controls=gmailComposerControls(state,this.accountId);
      if(controls.recipientIndex===null)throw Error('DRAFT_WRITER_RECIPIENT_CONTROL_MISSING');
      await this.dispatch('pressKey',[controls.recipientIndex,'Return'],signal);await this.snapshot(signal);
      await this.replace('subjectIndex',packet.subject,signal);await this.replace('editorIndex',normalizeBody(packet.body),signal);
      state=await this.snapshot(signal);state=await this.reader.ensureAddressExpanded(state);controls=gmailComposerControls(state,this.accountId);
      if(controls.subjectValue!==packet.subject||controls.body!==normalizeBody(packet.body))throw Error('DRAFT_WRITE_BODY_OR_SUBJECT_CHANGED');
      const exact=await this.reader.readVisibleComposer({state,ref:null,item:null});
      if(!exact||exact.sender!==this.accountId||exact.to?.length!==1||exact.to[0]!==packet.recipient||exact.cc?.length!==0||exact.bcc?.length!==0||exact.subject!==packet.subject||exact.body!==normalizeBody(packet.body)||exact.attachmentCount!==0)throw Error('DRAFT_WRITE_EXACT_PACKET_NOT_VERIFIED');
      // Gmail autosaves while typing. The explicit core hook is still consumed
      // exactly once immediately before the observed Save-and-close action.
      await this.dispatch('click',[controls.closeIndex],signal,beforeSave);
      await this.observeUntil(s=>!/text entry area \(settable\) Description: 邮件正文/.test(s)&&!/[?&]compose=/.test(s),signal,'saved-composer-closed');
      return {status:'saved',saveMethod:'gmail_autosave_close_candidate',requiresReadback:true};
    });
  }
}
