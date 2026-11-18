import {createHash} from 'node:crypto';

const normalize = s => String(s).replace(/\s+/gu,' ').trim();
const digest = o => createHash('sha256').update(JSON.stringify(o)).digest('hex');
const emailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
export const searchRowsReady = state => {
  if(state.includes('无与搜索条件相匹配的消息'))return parseRows(state).length===0;
  const count=state.match(/来自邮件的结果 \((\d+)\)/);
  return !!count&&parseRows(state).length===Math.min(50,Number(count[1]));
};
export const fullSearchReady = state => /checkbox \(settable, integer\) 1\n\s*\d+ text 包含垃圾邮件\/回收站/.test(state)&&searchRowsReady(state);
export function parseRows(state) {
  const lines=state.split('\n'), rows=[];
  for(let i=0;i<lines.length;i++) {
    const line=lines[i];
    if(!/^\s*\d+ (?:\(selected\) )?(?:Value:|ID:)/.test(line)||!line.includes('主题 '))continue;
    const id=line.match(/ID: (\d{10,})/), subject=line.match(/主题 (.*?), (?:创建时间|投递时间|收到时间|接收时间)/);
    if(!id||!subject)continue;
    let end=i+1;while(end<lines.length&&!/^\s*\d+ (?:\(selected\) )?(?:Value:|ID:)/.test(lines[end])&&!/tab \(/.test(lines[end]))end++;
    const block=lines.slice(i,end).join('\n');
    const addressLine=lines.slice(i+1,end).find(l=>/text .*<[^<>]+@[^<>]+>/.test(l));
    const emails=addressLine?.match(emailPattern)||[];
    const trash=block.match(/\n\s*(\d+) button 删除所选的邮件对话并移至回收站/);
    rows.push({draftId:id[1],index:Number(line.trim().split(' ')[0]),subject:subject[1],recipient:emails.length===1?emails[0].toLowerCase():null,created:line.includes('创建时间'),attachments:/\d+ 个附件/.test(line),deleteIndex:trash?Number(trash[1]):null});
  }
  return rows;
}
export function parseCompose(state,accountId,ref) {
  if(!state.includes(`From ${accountId}`))throw Error('COMPOSE_ACCOUNT_MISMATCH');
  const send=[...state.matchAll(/^\s*(\d+) button 发送\s*$/gm)];
  if(send.length!==1)throw Error('SEND_CONTROL_AMBIGUOUS');
  const addressStart=state.indexOf('text 收件人：');
  const editors=[...state.matchAll(/^\s*\d+ (?:text entry area \(settable\) Description: 纯文本编辑区域|container (?:Description: )?富文本编辑区域)(?:, Value:[^\n]*)?\s*$/gm)];
  if(editors.length!==1)throw Error('COMPOSE_EDITOR_AMBIGUOUS');
  const bodyMatch=/(?:text entry area \(settable\) Description: 纯文本编辑区域|container (?:Description: )?富文本编辑区域), Value: ([\s\S]*?)(?=\n\t+\d+ |$)/.exec(state);
  if(addressStart<0||!bodyMatch)throw Error('COMPOSE_LAYOUT_CHANGED');
  const subjectMatches=[...state.slice(addressStart,bodyMatch.index).matchAll(/^\s*\d+ text field \(settable\) Value: (.*?)(?:, ID: .*|)$/gm)];
  if(subjectMatches.length!==1)throw Error('SUBJECT_AMBIGUOUS');
  const subject=subjectMatches[0][1];
  const addressSection=state.slice(addressStart,state.indexOf(subjectMatches[0][0],addressStart));
  const addresses=[...addressSection.matchAll(/^\s*\d+ ([^\s<>]+@[^\s<>]+)\s*$/gm)].map(m=>m[1].toLowerCase());
  if(addresses.length!==1||addresses[0]!==ref.recipient)throw Error('RECIPIENT_OR_CC_CHANGED');
  if(subject!==ref.subject)throw Error('SUBJECT_CHANGED');
  if(ref.attachments)throw Error('ATTACHMENT_REQUIRES_REVIEW');
  const body=bodyMatch[1].trim();
  if(!body)throw Error('EMPTY_BODY');
  const approvedHash=digest({accountId,recipient:addresses[0],subject,body});
  return {...ref,accountId,recipient:addresses[0],subject,body,approvedHash,draftVersion:approvedHash,sendIndex:Number(send[0][1])};
}
export function verifySentBody(state,item) {
  const startText=item.body.split(/\r?\n/).find(s=>s.trim());
  const lines=state.split('\n');
  const starts=lines.map((s,i)=>s.includes('text '+startText)?i:-1).filter(i=>i>=0);
  if(starts.length!==1)return false;
  const end=lines.findIndex((s,i)=>i>starts[0]&&s.includes('toolbar 撰写操作'));
  if(end<0)return false;
  const text=lines.slice(starts[0],end).map(s=>{
    const plain=s.match(/^\s*\d+ text (.*)$/);if(plain)return plain[1];
    const link=s.match(/^\s*\d+ link Description: (.*?), Value:/);return link?.[1]||'';
  }).filter(Boolean).join(' ');
  return normalize(text)===normalize(item.body);
}


const nonWhitespace = value => String(value).replace(/\s/gu,'');
const bodySerializer = 'visible-plain-lines-v1';

function decodeVisibleEntities(value) {
  const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'};
  if(/&(?!(?:#[0-9]+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);)[a-zA-Z#][a-zA-Z0-9#]*;/i.test(value))throw Error('VISIBLE_BODY_ENTITY_UNSUPPORTED');
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi,(whole,entity)=>{
    if(entity[0]!=='#')return named[entity.toLowerCase()];
    const code=entity[1]?.toLowerCase()==='x'?parseInt(entity.slice(2),16):Number(entity.slice(1));
    if(!Number.isSafeInteger(code)||code<=0||code>0x10ffff||code>=0xd800&&code<=0xdfff)throw Error('VISIBLE_BODY_ENTITY_UNSUPPORTED');
    return String.fromCodePoint(code);
  });
}
function visibleAttributes(source,tag) {
  const attributes={};let rest=source.trim();
  while(rest){
    const match=/^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*/.exec(rest);
    if(!match)throw Error('VISIBLE_BODY_ATTRIBUTES_UNSUPPORTED');
    const name=match[1].toLowerCase();if(Object.hasOwn(attributes,name))throw Error('VISIBLE_BODY_ATTRIBUTES_UNSUPPORTED');
    attributes[name]=decodeVisibleEntities(match[2]??match[3]);rest=rest.slice(match[0].length);
  }
  const allowed=tag==='A'?new Set(['href','target','rel']):tag==='BR'?new Set():new Set(['style']);
  if(Object.keys(attributes).some(name=>!allowed.has(name)))throw Error('VISIBLE_BODY_HIDDEN_OR_UNSUPPORTED_ATTRIBUTE');
  if(attributes.style!==undefined){
    for(const declaration of attributes.style.split(';').filter(s=>s.trim())){
      const colon=declaration.indexOf(':');if(colon<0)throw Error('VISIBLE_BODY_STYLE_UNSUPPORTED');
      const name=declaration.slice(0,colon).trim().toLowerCase(),value=declaration.slice(colon+1).trim();
      if(name==='font-family'){if(!/^[A-Za-z0-9 ,"'-]+$/.test(value))throw Error('VISIBLE_BODY_STYLE_UNSUPPORTED');}
      else if(name==='font-size'){if(!/^[1-9][0-9]*(?:\.[0-9]+)?(?:pt|px|em|rem|%)$/.test(value))throw Error('VISIBLE_BODY_STYLE_UNSUPPORTED');}
      else throw Error('VISIBLE_BODY_HIDDEN_OR_UNSUPPORTED_STYLE');
    }
  }
  if(tag==='A'){
    if(!attributes.href||attributes.target!==undefined&&!['_blank','_self'].includes(attributes.target)||
      attributes.rel!==undefined&&!/^[a-zA-Z\s-]+$/.test(attributes.rel))throw Error('VISIBLE_BODY_LINK_UNSUPPORTED');
  }
  return attributes;
}
function parseVisibleBodyHTML(html) {
  if(typeof html!=='string'||html.length>200000)throw Error('VISIBLE_BODY_HTML_INVALID');
  const root={tag:'BODY',children:[]},stack=[root];let at=0,nodes=0;
  const add=node=>{if(++nodes>10000)throw Error('VISIBLE_BODY_DOM_TOO_LARGE');stack.at(-1).children.push(node);};
  while(at<html.length){
    if(html[at]!=='<'){
      const end=html.indexOf('<',at),stop=end<0?html.length:end;
      add({text:decodeVisibleEntities(html.slice(at,stop))});at=stop;continue;
    }
    let end=at+1,quote=null;
    for(;end<html.length;end++){
      const char=html[end];if(quote){if(char===quote)quote=null;}
      else if(char==='"'||char==="'")quote=char;else if(char==='>')break;
    }
    if(end===html.length||quote)throw Error('VISIBLE_BODY_HTML_INVALID');
    const token=html.slice(at+1,end).trim();at=end+1;
    const close=/^\/([A-Za-z][A-Za-z0-9]*)\s*$/.exec(token);
    if(close){if(stack.length===1||stack.at(-1).tag!==close[1].toUpperCase())throw Error('VISIBLE_BODY_HTML_UNBALANCED');stack.pop();continue;}
    const open=/^([A-Za-z][A-Za-z0-9]*)([\s\S]*?)(\/?)$/.exec(token);
    if(!open)throw Error('VISIBLE_BODY_DOM_UNSUPPORTED');
    const tag=open[1].toUpperCase();if(!['DIV','P','BR','A'].includes(tag))throw Error('VISIBLE_BODY_DOM_UNSUPPORTED:'+tag);
    const node={tag,attributes:visibleAttributes(open[2],tag),children:[]};add(node);
    if(tag!=='BR'){if(open[3])throw Error('VISIBLE_BODY_HTML_INVALID');stack.push(node);if(stack.length>32)throw Error('VISIBLE_BODY_DOM_TOO_DEEP');}
  }
  if(stack.length!==1)throw Error('VISIBLE_BODY_HTML_UNBALANCED');
  return root;
}
function visibleNodeText(node) {
  if(Object.hasOwn(node,'text'))return node.text;
  if(node.tag==='BR')return '\n';
  const body=node.children.map(visibleNodeText).join('');
  if(node.tag==='A'){
    if(node.children.some(child=>!Object.hasOwn(child,'text'))||/[\r\n]/.test(body))throw Error('VISIBLE_BODY_LINK_UNSUPPORTED');
    const href=node.attributes.href;
    if(/^mailto:/i.test(href)){
      if(href.slice(7).toLowerCase()!==body.toLowerCase()||!emailPatternForLink(body))throw Error('VISIBLE_BODY_LINK_TARGET_MISMATCH');
    }else{
      let actual,shown;try{actual=new URL(href);shown=new URL(body);}catch{throw Error('VISIBLE_BODY_LINK_TARGET_MISMATCH');}
      if(!['http:','https:'].includes(actual.protocol)||actual.username||actual.password||actual.href!==shown.href)throw Error('VISIBLE_BODY_LINK_TARGET_MISMATCH');
    }
    return body;
  }
  if(node.tag==='BODY')return body;
  if(!node.children.length)throw Error('VISIBLE_BODY_EMPTY_BLOCK_UNVERIFIED');
  return body.endsWith('\n')?body:body+'\n';
}
function emailPatternForLink(value){return /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(value);}

/** Deterministic serialization of the visibly read DIV/P/BR/A-only editor body.
 * It does not collapse blank lines. Unsupported/hidden structure is a hold. */
export function serializeVisiblePlainBody(snapshot,axBody) {
  if(!snapshot||typeof snapshot.innerText!=='string'||typeof snapshot.textContent!=='string')throw Error('VISIBLE_BODY_TEXT_PROOF_REQUIRED');
  const body=visibleNodeText(parseVisibleBodyHTML(snapshot.html)).replace(/\r\n?/g,'\n').trim();
  if(!body)throw Error('VISIBLE_BODY_EMPTY');
  const content=nonWhitespace(body);
  if(content!==nonWhitespace(snapshot.innerText)||content!==nonWhitespace(snapshot.textContent)||content!==nonWhitespace(axBody))throw Error('VISIBLE_BODY_TEXT_MISMATCH');
  return {body,bodySerialization:bodySerializer,bodySource:'visible-iframe-body',
    bodyEvidence:{source:'visible-iframe-body',serializer:bodySerializer,structure:'div-p-br-a-text',
      axTextComparison:'non-whitespace-equal',domTextComparison:'non-whitespace-equal'}};
}
export function createVisiblePlainBodyReader(tab) {
  return async({state,item}={})=>{
    if(!item||typeof item.body!=='string')throw Error('VISIBLE_BODY_PARSED_ITEM_REQUIRED');
    if(/text entry area \(settable\) Description: 纯文本编辑区域, Value:/.test(state)){
      return {body:item.body,bodySerialization:'ax-plain-value-v1',bodySource:'ax-plain-value',
        bodyEvidence:{source:'ax-plain-value',serializer:'ax-plain-value-v1'}};
    }
    if(!/(?:container (?:Description: )?富文本编辑区域), Value:/.test(state))throw Error('VISIBLE_BODY_EDITOR_UNSUPPORTED');
    if(typeof tab?.playwright?.frameLocator!=='function')throw Error('VISIBLE_BODY_DOM_READER_UNAVAILABLE');
    const snapshot=await tab.playwright.frameLocator('iframe').locator('body').evaluate(body=>({
      html:body.innerHTML,innerText:body.innerText,textContent:body.textContent
    }));
    return serializeVisiblePlainBody(snapshot,item.body);
  };
}

/** Requires an explicitly supplied, already connected CUA tab. No mailbox API,
 * credentials, network requests, default browser discovery or hidden retries. */
export class BrowserMailAdapter {
  constructor({tab,accountId,preparedRefs=null,approvedPermanentDraftIds=[],observe,readComposeBody,visibleReadyTimeoutMs=30000}) {
    if(!tab||!accountId)throw Error('EXPLICIT_TAB_AND_ACCOUNT_REQUIRED');
    if(readComposeBody!==undefined&&typeof readComposeBody!=='function')throw Error('READ_COMPOSE_BODY_CALLBACK_REQUIRED');
    if(!Number.isSafeInteger(visibleReadyTimeoutMs)||visibleReadyTimeoutMs<1||visibleReadyTimeoutMs>30000)throw Error('VISIBLE_READY_TIMEOUT_MUST_BE_1_TO_30000_MS');
    this.visibleReadyTimeoutMs=visibleReadyTimeoutMs;
    this.tab=tab;this.accountId=accountId;this.preparedRefs=preparedRefs;this.observe=observe;this.readComposeBody=readComposeBody;
    this.mode='cua-browser-ui';this.lastReceipts=new Map();this.preflightIds=new Map();this.history=[];
    this.approvedPermanentDraftIds=new Set(approvedPermanentDraftIds.map(String));
  }
  async snapshot(){const s=await this.tab.getAXState({emit:false,disableDiffing:true});this.observe?.(s);return s;}
  async waitFor(test,label,timeout=this.visibleReadyTimeoutMs) {
    if(!Number.isSafeInteger(timeout)||timeout<1||timeout>30000)throw Error('VISIBLE_READY_TIMEOUT_MUST_BE_1_TO_30000_MS');
    const end=Date.now()+timeout;let s='';
    do {s=await this.snapshot();if(test(s))return s;}while(Date.now()<end);
    throw Error(`UI_NOT_READY:${label}`);
  }
  checkAccount(s){if(!s.includes(`Zoho Mail (${this.accountId})`))throw Error('MAILBOX_ACCOUNT_CHANGED');}
  async folder(name,{refresh=true}={}) {
    let s=await this.waitFor(x=>x.includes(`Zoho Mail (${this.accountId})`),'mailbox');this.checkAccount(s);
    const matches=[...s.matchAll(new RegExp('^\\s*(\\d+) row \\([^\\n]+\\) Description: '+name+', ID: \\d+','gm'))];
    if(matches.length!==1)throw Error(`FOLDER_CONTROL_AMBIGUOUS:${name}`);
    await this.tab.click(Number(matches[0][1]));await this.snapshot();
    if(refresh){await this.tab.reload();}
    s=await this.waitFor(x=>x.includes(`当前处于文件夹 ${name}，`)&&(parseRows(x).length>0||/此文件夹为空|没有邮件|没有消息/.test(x)),name);
    this.checkAccount(s);return s;
  }
  async scanDrafts({limit=50}={}) {
    if(this.preparedRefs)return this.preparedRefs.slice(0,limit);
    const s=await this.folder('草稿');
    return parseRows(s).filter(r=>r.created&&r.recipient).slice(0,limit).map(r=>({...r,accountId:this.accountId}));
  }
  async collectDraftPage() {
    const s=await this.snapshot();this.checkAccount(s);
    if(!s.includes('当前处于文件夹 草稿，'))throw Error('NOT_DRAFT_FOLDER');
    return parseRows(s).filter(r=>r.created&&r.recipient).map(r=>({...r,accountId:this.accountId}));
  }
  async nextDraftPage() {
    throw Error('PAGINATION_REQUIRES_PROFILE_VALIDATION');
  }
  async findDraft(ref) {
    this.lastDraftLookup=null;
    let s=ref.locatedBy==='draft_search'?await this.searchDraftsForRecipient(ref.recipient):await this.folder('草稿');
    let matches=parseRows(s).filter(r=>r.draftId===ref.draftId);
    if(matches.length===0&&ref.locatedBy!=='draft_search'){s=await this.searchDraftsForRecipient(ref.recipient);matches=parseRows(s).filter(r=>r.draftId===ref.draftId);}
    if(matches.length>1)throw Error('DRAFT_ID_AMBIGUOUS');
    if(matches.length===0){
      const total=s.match(/来自邮件的结果 \((\d+)\)/);
      const complete=s.includes('Description: 文件夹内, Value: 草稿/')&&(s.includes('无与搜索条件相匹配的消息')||(total&&Number(total[1])===parseRows(s).length));
      if(!complete)throw Error('ORIGINAL_DRAFT_ABSENCE_INCOMPLETE');
      this.lastDraftLookup={draftId:ref.draftId,accountId:this.accountId,complete:true,absent:true};return null;
    }
    const r=matches[0];if(!r.created||r.subject!==ref.subject||r.recipient!==ref.recipient)throw Error('ORIGINAL_DRAFT_CHANGED');return r;
  }
  async searchDraftsForRecipient(recipient) {
    let s=await this.folder('草稿');
    const search=s.match(/^\s*(\d+) text field \(settable\) 搜索 \( \/ \)\s*$/m);
    if(!search)throw Error('CLEAN_SEARCH_CONTROL_MISSING');
    await this.tab.click(Number(search[1]));s=await this.waitFor(x=>/^\s*\d+ 文件夹内: 草稿\//m.test(x),'draft folder filter');
    const folder=s.match(/^\s*(\d+) 文件夹内: 草稿\//m);if(!folder)throw Error('DRAFT_FOLDER_FILTER_MISSING');
    await this.tab.click(Number(folder[1]));s=await this.waitFor(x=>x.includes('Description: 文件夹内, Value: 草稿/')&&/^\s*\d+ text field \(settable\)\s*$/m.test(x),'folder search input');
    const field=s.match(/^\s*(\d+) text field \(settable\)\s*$/m);if(!field)throw Error('FILTER_SEARCH_INPUT_MISSING');
    await this.tab.typeText(Number(field[1]),recipient);await this.tab.pressKey(Number(field[1]),'Return');
    s=await this.waitFor(x=>x.includes(`Value: ${recipient}`)&&searchRowsReady(x),'exact draft search');
    if(!s.includes('Description: 文件夹内, Value: 草稿/'))throw Error('DRAFT_FOLDER_SCOPE_LOST');
    return s;
  }
  async parseComposeSnapshot(state,ref){
    const item=parseCompose(state,this.accountId,ref);if(!this.readComposeBody)return item;
    const result=await this.readComposeBody({state,item:Object.freeze({...item})});
    if(!result||typeof result.body!=='string'||!result.body.trim()||!['visible-plain-lines-v1','ax-plain-value-v1'].includes(result.bodySerialization))throw Error('VISIBLE_BODY_READER_RESULT_INVALID');
    const body=result.body.replace(/\r\n?/g,'\n').trim();
    if(nonWhitespace(body)!==nonWhitespace(item.body))throw Error('VISIBLE_BODY_TEXT_MISMATCH');
    const approvedHash=digest({accountId:this.accountId,recipient:item.recipient,subject:item.subject,body});
    return {...item,body,approvedHash,draftVersion:approvedHash,axBodyHash:item.approvedHash,bodySerialization:result.bodySerialization,bodySource:result.bodySource,bodyEvidence:result.bodyEvidence};
  }
  async inspectDraft(ref) {
    if(ref.accountId!==this.accountId)throw Error('REF_ACCOUNT_MISMATCH');
    const r=await this.findDraft(ref);if(!r)throw Error('DRAFT_MISSING');
    await this.tab.click(r.index);
    const s=await this.waitFor(x=>/(?:text entry area \(settable\) Description: 纯文本编辑区域|container (?:Description: )?富文本编辑区域), Value:/.test(x)&&/^\s*\d+ button 发送\s*$/m.test(x),'compose');
    return await this.parseComposeSnapshot(s,{...ref,attachments:r.attachments});
  }
  async searchRecipient(recipient) {
    const s=await this.folder('草稿');
    const search=[...s.matchAll(/^\s*(\d+) text field \(settable\) 搜索 \( \/ \)\s*$/gm)];
    if(search.length!==1)throw Error('CLEAN_SEARCH_CONTROL_MISSING');
    await this.tab.typeText(Number(search[0][1]),recipient);await this.tab.pressKey(Number(search[0][1]),'Return');
    let result=await this.waitFor(x=>x.includes(`Value: ${recipient}`)&&searchRowsReady(x),'search');
    if(!result.includes(`Value: ${recipient}`))throw Error('SEARCH_QUERY_MISMATCH');
    // Include recoverable deleted messages and bounce reports in the read-only search.
    const include=result.match(/\n\s*(\d+) checkbox \(settable, integer\) 0\n\s*\d+ text 包含垃圾邮件\/回收站/);
    if(include){
      await this.tab.click(Number(include[1]));await this.snapshot();
      // This control becomes disabled/unchecked during the request and only
      // becomes enabled/checked after the refreshed full search is rendered.
      result=await this.waitFor(fullSearchReady,'full search complete');
    }
    if(!fullSearchReady(result))throw Error('FULL_SEARCH_SCOPE_UNCONFIRMED');
    return {rows:parseRows(result),state:result};
  }
  async preflight(ref) {
    const result=await this.searchRecipient(ref.recipient),rows=result.rows;
    if(!rows.some(r=>r.draftId===ref.draftId))return {ok:false,reason:'original_draft_not_in_completed_search'};
    const duplicate=rows.filter(r=>r.draftId!==ref.draftId&&r.subject===ref.subject);
    if(duplicate.length)return {ok:false,skip:true,reason:'existing_same_subject_correspondence',messageIds:duplicate.map(r=>r.draftId)};
    if(rows.some(r=>r.draftId!==ref.draftId&&!r.created))return {ok:false,skip:true,reason:'existing_correspondence_requires_review'};
    if(rows.some(r=>/undeliver|delivery (?:fail|status)|returned mail|mail failure|退信|投递失败|unsubscribe|remove me|no thanks|stop contacting/i.test(r.subject)))return {ok:false,skip:true,reason:'delivery_or_stop_record'};
    const count=result.state.match(/来自邮件的结果 \((\d+)\)/);
    if(count&&Number(count[1])>rows.length)return {ok:false,skip:true,reason:'history_requires_full_review'};
    this.preflightIds.set(ref.draftId,new Set(rows.map(r=>r.draftId)));
    return {ok:true,checkedAt:new Date().toISOString()};
  }
  sameItem(a,b){return ['accountId','draftId','recipient','subject','body','approvedHash','draftVersion'].every(k=>a[k]===b[k]);}
  async send(item,{beforeClick}) {
    let fresh=await this.inspectDraft(item);
    let revalidated=false;
    if(!this.sameItem(fresh,item))throw Error('CONTENT_CHANGED_SINCE_APPROVAL');
    await beforeClick({revalidate:async()=>{
      fresh=await this.parseComposeSnapshot(await this.snapshot(),item);
      if(!this.sameItem(fresh,item))throw Error('CONTENT_CHANGED_DURING_PACING_WAIT');
      revalidated=true;
    }});
    if(!revalidated)throw Error('HOST_REVALIDATION_HOOK_REQUIRED');
    await this.tab.click(fresh.sendIndex);
    const state=await this.waitFor(x=>x.includes('信息已发送')||/发送失败|发送频率|暂时被阻止|超过.*限制|发送受限/.test(x),'send result',15000);
    if(!state.includes('信息已发送'))return {status:'unknown',reason:'provider_did_not_confirm'};
    return await this.reconcile(item);
  }
  async reconcile(item) {
    const state=await this.folder('已发送');
    const matches=parseRows(state).filter(r=>r.subject===item.subject&&r.recipient===item.recipient);
    if(matches.length!==1)return {status:'unknown',reason:'sent_receipt_missing_or_ambiguous'};
    const row=matches[0],baseline=this.preflightIds.get(item.draftId);
    if(!baseline||baseline.has(row.draftId))return {status:'unknown',reason:'sent_receipt_not_new'};
    await this.tab.click(row.index);
    const full=await this.waitFor(x=>x.includes(`ID: zm_Container_m${row.draftId}`)&&x.includes('toolbar 撰写操作'),'sent message');
    if(!full.includes(this.accountId)||!verifySentBody(full,item))return {status:'unknown',reason:'sent_body_not_verified'};
    const receipt={status:'sent',authoritative:true,messageId:row.draftId,accountId:this.accountId,draftId:item.draftId,recipient:item.recipient,approvedHash:item.approvedHash,draftVersion:item.draftVersion,mode:this.mode};
    this.lastReceipts.set(item.draftId,receipt);return receipt;
  }
  async cleanup(item,receipt,{beforeClick}) {
    const expected=this.lastReceipts.get(item.draftId);
    if(!expected||JSON.stringify(expected)!==JSON.stringify(receipt))throw Error('NO_CONFIRMED_RECEIPT_FOR_CLEANUP');
    let fresh;
    try {fresh=await this.inspectDraft(item);}catch(error){
      if(error.message==='DRAFT_MISSING'&&this.lastDraftLookup?.complete===true&&this.lastDraftLookup.absent===true&&this.lastDraftLookup.accountId===item.accountId&&this.lastDraftLookup.draftId===item.draftId){
        return {status:'already_absent',authoritative:true,draftId:item.draftId,accountId:this.accountId,approvedHash:item.approvedHash,draftVersion:item.draftVersion,sentMessageId:receipt.messageId,removalMethod:'provider_consumed'};
      }
      throw error;
    }
    if(!this.sameItem(fresh,item))throw Error('DRAFT_CHANGED_BEFORE_CLEANUP');
    // This profile's draft deletion is permanent despite the row tooltip.
    // Never infer consent from a generic cleanup request or a prior run.
    if(!this.approvedPermanentDraftIds.has(item.draftId))throw Error('PERMANENT_DRAFT_DELETE_REQUIRES_CURRENT_APPROVAL');
    const row=await this.findDraft(item);
    if(!row||!row.deleteIndex)throw Error('ORIGINAL_DRAFT_DELETE_CONTROL_MISSING');
    await beforeClick();await this.tab.click(row.deleteIndex);await this.snapshot();
    const remaining=await this.searchDraftsForRecipient(item.recipient);
    if(!searchRowsReady(remaining)||parseRows(remaining).some(r=>r.draftId===item.draftId))throw Error('ORIGINAL_DRAFT_REMOVAL_NOT_CONFIRMED');
    return {status:'already_absent',authoritative:true,draftId:item.draftId,accountId:this.accountId,approvedHash:item.approvedHash,draftVersion:item.draftVersion,sentMessageId:receipt.messageId,removalMethod:'permanent_draft_delete'};
  }
  async countDrafts() {
    let state=await this.folder('草稿');
    const folder=state.match(/^\s*(\d+) row \(selected\) Description: 草稿, ID:/m);
    if(!folder)throw Error('DRAFT_FOLDER_CONTROL_MISSING');
    await this.tab.click(Number(folder[1]),{mouseButton:'right'});
    state=await this.waitFor(x=>/^\s*\d+ 文件夹详情, ID: showInfo/m.test(x),'folder context');
    const details=state.match(/^\s*(\d+) 文件夹详情, ID: showInfo/m);
    await this.tab.click(Number(details[1]));
    state=await this.waitFor(x=>/heading 草稿, Value: 1/.test(x)&&/button 邮件总数 \d+/.test(x),'folder total');
    this.checkAccount(state);
    const count=Number(state.match(/button 邮件总数 (\d+)/)[1]);
    const close=[...state.matchAll(/^\s*(\d+) button 关闭\s*$/gm)];
    if(close.length!==1)throw Error('FOLDER_DETAILS_CLOSE_AMBIGUOUS');
    await this.tab.click(Number(close[0][1]));await this.snapshot();
    return {value:count,source:'folder_details_total',exact:true,observedAt:new Date().toISOString()};
  }
}
