import {createHash} from 'node:crypto';
import {serializeVisiblePlainBody} from './browser-adapter.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0;
const binding = item => ({accountId:item.accountId,draftId:item.draftId,draftVersion:item.draftVersion,approvedHash:item.approvedHash});
const singleEmail = value => /^[A-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(value);
const quoteSearch = value => '"'+String(value).replace(/["\\]/g,' ')+'"';

function only(matches,code){if(matches.length!==1)throw Error(code);return matches[0];}
export function gmailAccountFromAX(state){
  const matches=[...state.matchAll(/^\s*\d+ button \((?:collapsed|expanded)\) Description: Google 账号：[^\n]*\(([^()\s]+@[^()\s]+)\)/gm)];
  return only(matches,'GMAIL_ACCOUNT_CONTROL_AMBIGUOUS')[1].toLowerCase();
}
export function gmailComposeIdFromAX(state){
  const line=state.split('\n').find(line=>/AXWebArea .*Gmail, URL:/.test(line));
  const value=line?.match(/[?&]compose=([^\s,"&]+)/)?.[1];
  if(!value||value==='new')throw Error('GMAIL_SAVED_COMPOSE_ID_MISSING');
  try{return decodeURIComponent(value);}catch{throw Error('GMAIL_COMPOSE_ID_INVALID');}
}
/** Trusted-host semantic input for the observed collapsed composer address
 * bar. Reads only visible DOM; the host retains exclusive UI ownership. */
export function createGmailVisibleAddressClicker(tab,{assertExclusive}={}){
  if(typeof assertExclusive!=='function')throw Error('GMAIL_ADDRESS_EXCLUSIVE_GUARD_REQUIRED');
  const guard=()=>{const result=assertExclusive();if(result?.then)throw Error('GMAIL_ADDRESS_EXCLUSIVE_GUARD_MUST_BE_SYNCHRONOUS');if(result===false)throw Error('GMAIL_ADDRESS_NOT_EXCLUSIVE');};
  return async({accountId,recipient,composeToken}={})=>{
    guard();if(!singleEmail(accountId)||!singleEmail(recipient)||!text(composeToken))throw Error('GMAIL_ADDRESS_CLICK_BINDING_INVALID');
    if(typeof tab?.playwright?.locator!=='function')throw Error('GMAIL_VISIBLE_ADDRESS_EXPAND_UNAVAILABLE');
    const current=await tab.getAXState({emit:false,disableDiffing:true});
    if(gmailAccountFromAX(current)!==accountId||gmailComposeIdFromAX(current)!==composeToken)throw Error('GMAIL_ADDRESS_COMPOSER_CHANGED');
    const selector='div.oL.aDm.az9 > span[email="'+recipient+'"][data-hovercard-id="'+recipient+'"]';
    const target=tab.playwright.locator(selector);
    if(await target.count()!==1)throw Error('GMAIL_VISIBLE_ADDRESS_TARGET_AMBIGUOUS');
    const evidence=await target.evaluate(element=>{const rect=element.getBoundingClientRect();return {visible:rect.width>0&&rect.height>0,email:element.getAttribute('email'),hovercard:element.getAttribute('data-hovercard-id')};});
    if(evidence?.visible!==true||evidence.email!==recipient||evidence.hovercard!==recipient)throw Error('GMAIL_VISIBLE_ADDRESS_TARGET_AMBIGUOUS');
    guard();await target.click();
  };
}
export function parseGmailCompose(state,accountId,ref){
  if(gmailAccountFromAX(state)!==accountId)throw Error('MAILBOX_ACCOUNT_CHANGED');
  const draftId=gmailComposeIdFromAX(state);
  if(draftId!==(ref.composeToken??ref.draftId))throw Error('ORIGINAL_DRAFT_ID_CHANGED');
  const sender=[...state.matchAll(/^\s*\d+ pop up button \((?:collapsed|expanded)\) [^\n]*<([^<>\s]+@[^<>\s]+)>, ID:/gm)];
  if(only(sender,'GMAIL_COMPOSE_SENDER_AMBIGUOUS')[1].toLowerCase()!==accountId)throw Error('COMPOSE_ACCOUNT_MISMATCH');
  const subjectMatch=only([...state.matchAll(/^\s*\d+ text field \(settable\) Description: 主题(?:,[^\n]*)?$/gm)],'GMAIL_SUBJECT_AMBIGUOUS');
  const editors=[...state.matchAll(/^\s*(\d+) text entry area \(settable\) Description: 邮件正文, ID: [^\n,]+, Value: ([\s\S]*?)(?=\n\s*\d+ (?:container|button|pop up button|text|checkbox|link)|(?![\s\S]))/gm)];
  const editor=only(editors,'GMAIL_EDITOR_AMBIGUOUS');
  const send=only([...state.matchAll(/^\s*(\d+) button Description: 发送 [^\n]*$/gm)],'SEND_CONTROL_AMBIGUOUS');
  const head=state.slice(state.indexOf('container 收件人 - 选择联系人'),subjectMatch.index);
  if(!head||head.length===state.length)throw Error('GMAIL_ADDRESS_LAYOUT_CHANGED');
  // Recipient chips are supplied by the visible reader because Gmail changes
  // their accessible wrapper names between input and committed-token states.
  const body=editor[2].replace(/\r\n?/g,'\n').trim(),subject=subjectMatch[0].match(/, Value: (.*?)(?:, ID: [^\n]*|$)/)?.[1]??'';
  if(!body)throw Error('EMPTY_BODY');
  if(subject!==ref.subject)throw Error('SUBJECT_CHANGED');
  const approvedHash=digest({accountId,recipient:ref.recipient,subject,body});
  return {...ref,accountId,draftId:ref.draftId,composeToken:draftId,subject,body,approvedHash,draftVersion:approvedHash,sendIndex:Number(send[1]),editorIndex:Number(editor[1]),bodySerialization:'gmail-ax-value-v1'};
}

function validateView(view,scope,query){
  if(!view||view.scope!==scope||view.query!==query||view.complete!==true||!Array.isArray(view.rows)||!Number.isSafeInteger(view.total)||view.total<0)throw Error('GMAIL_LIST_PROOF_INCOMPLETE');
  if(view.total!==view.rows.length)throw Error('GMAIL_LIST_PAGINATION_REQUIRES_REVIEW');
  const ids=new Set(),draftIds=new Set();
  for(const row of view.rows){
    if(!text(row.threadId)||!Number.isInteger(row.index)||row.index<0||typeof row.isDraft!=='boolean'||typeof row.subject!=='string')throw Error('GMAIL_LIST_ROW_UNVERIFIED');
    if(ids.has(row.threadId))throw Error('GMAIL_THREAD_ID_AMBIGUOUS');ids.add(row.threadId);
    if(row.isDraft&&row.draftId){if(draftIds.has(row.draftId))throw Error('GMAIL_DRAFT_ID_AMBIGUOUS');draftIds.add(row.draftId);}
  }
  return view;
}


function gmailVisibleQueryContext(state,query){
  const fields=[...state.matchAll(/^\s*\d+ text field \(settable\) (?:Description: )?搜索邮件, Value: ([^\n]*)$/gm)];
  if(fields.length!==1)return {complete:false,reason:'query_not_current'};
  const area=state.split('\n').find(line=>/AXWebArea .*Gmail, URL:/.test(line));
  const url=area?.match(/URL: ([^\s"']+)/)?.[1];
  // Gmail canonicalizes exactly this all-drafts query to its visible folder.
  // Filtered searches and other query mismatches retain the search-URL proof.
  if(query==='in:drafts'&&fields[0][1].trim()==='in:draft'&&/^(?:https:\/\/)?mail\.google\.com\/mail\/u\/\d+\/#drafts$/.test(url??'')){
    try{gmailAccountFromAX(state);}catch{return {complete:false,reason:'draft_folder_account_control_invalid'};}
    return {complete:true,profile:'drafts_folder_alias'};
  }
  if(fields[0][1].trim()!==query)return {complete:false,reason:'query_not_current'};
  const raw=url?.match(/^(?:https:\/\/)?mail\.google\.com\/mail\/u\/\d+\/#search\/([^\s"']*)/)?.[1];
  let urlQuery;try{urlQuery=raw===undefined?null:decodeURIComponent(raw.replace(/\+/g,' '));}catch{return {complete:false,reason:'query_url_invalid'};}
  if(urlQuery!==query)return {complete:false,reason:'query_url_not_current'};
  return {complete:true,profile:'exact_search_url'};
}
function gmailObservedDraftFolderEmpty(state){
  const lines=cleanAX(state).split('\n'),headings=lines.map((line,index)=>/^\s*\d+ heading 会话, Value: 2\s*$/.test(line)?index:-1).filter(index=>index>=0);
  if(headings.length!==1)return false;
  const heading=headings[0],indent=lines[heading].match(/^\s*/)[0].length;let table=heading+1;
  while(table<lines.length&&(!/^\s*\d+ /.test(lines[table])||lines[table].match(/^\s*/)[0].length>indent))table++;
  if(table>=lines.length||!/^\s*\d+ table\s*$/.test(lines[table]))return false;
  const tableIndent=lines[table].match(/^\s*/)[0].length;let end=table+1;
  while(end<lines.length&&(!/^\s*\d+ /.test(lines[end])||lines[end].match(/^\s*/)[0].length>tableIndent))end++;
  const texts=lines.slice(table+1,end).map(line=>line.match(/^\s*\d+ text (.*)$/)?.[1]).filter(value=>value!==undefined);
  return texts.length===2&&texts[0]==='您没有保存任何草稿。'&&texts[1]==='利用草稿保存功能，可先保存您暂时不想发送出去的邮件。';
}
export function parseGmailSearchCompletion(state,query){
  const context=gmailVisibleQueryContext(state,query);if(!context.complete)return context;
  if(/加载速度指示器|正在加载|progress indicator|Loading/i.test(state))return {complete:false,reason:'loading'};
  const dataRows=[...state.matchAll(/^\s*\d+ row(?: \([^\n)]*\))? ID: [^\n]+/gm)];
  if(context.profile==='drafts_folder_alias'&&/(?:您没有保存任何草稿。|利用草稿保存功能，可先保存您暂时不想发送出去的邮件。)/.test(state)){
    if(dataRows.length===0&&!/text entry area \(settable\) Description: 邮件正文|container 撰写： /.test(state)&&gmailObservedDraftFolderEmpty(state))return {complete:true,empty:true,total:0,query,profile:'drafts_folder_alias'};
    return {complete:false,reason:'draft_folder_empty_profile_incomplete'};
  }

  const empty=/^\s*\d+ text (?:找不到与您的搜索匹配的邮件。请尝试使用发件人、日期和大小等|没有任何邮件符合您的搜索条件。)\s*$/m.test(state);
  if(empty&&dataRows.length===0){
    if(context.profile==='drafts_folder_alias')return {complete:false,reason:'draft_folder_empty_profile_pending'};
    return {complete:true,empty:true,total:0,query};
  }
  if(empty&&dataRows.length)return {complete:false,reason:'stale_results_with_empty_notice'};
  return {complete:false,reason:'nonempty_result_profile_pending',rowCount:dataRows.length};
}
/** The empty-result form was observed in the actual Chinese Gmail UI. Nonempty
 * rows still require an independently validated visible-ID reader. */
export function createGmailVisibleListReader(tab){
  return async({state,scope,query})=>{
    const completion=listCompletion(state,query);
    if(!completion.complete)return {...completion,scope,query,complete:false,rows:[]};
    if(completion.empty){
      if(completion.profile==='drafts_folder_alias'){
        if(typeof tab?.playwright?.locator!=='function')throw Error('GMAIL_VISIBLE_LIST_DOM_READER_UNAVAILABLE');
        const visible=await tab.playwright.locator('[data-legacy-thread-id], [data-legacy-last-message-id], [data-legacy-standalone-draft-id], [data-legacy-message-id]').evaluateAll(elements=>elements.filter(element=>element.getBoundingClientRect().width>0&&element.getBoundingClientRect().height>0).length);
        if(visible!==0)return {scope,query,complete:false,rows:[],reason:'visible_ids_with_empty_draft_folder'};
        return {scope,query,complete:true,total:0,rows:[]};
      }
      if(!tab?.playwright?.getByRole)throw Error('GMAIL_VISIBLE_LIST_DOM_READER_UNAVAILABLE');
      const visible=await tab.playwright.getByRole('row').evaluateAll(rows=>rows.filter(row=>row.getBoundingClientRect().width>0&&row.getBoundingClientRect().height>0&&row.querySelector('[data-legacy-thread-id]')).length);
      if(visible!==0)return {scope,query,complete:false,rows:[],reason:'visible_rows_with_empty_notice'};
      return {scope,query,complete:true,total:0,rows:[]};
    }
    if(!tab?.playwright?.getByRole)throw Error('GMAIL_VISIBLE_LIST_DOM_READER_UNAVAILABLE');
    const dom=await tab.playwright.getByRole('row').evaluateAll(elements=>elements.filter(row=>row.getBoundingClientRect().width>0&&row.getBoundingClientRect().height>0&&row.querySelector('[data-legacy-thread-id]')).map(row=>({domId:row.id,subjects:Array.from(row.querySelectorAll('[data-legacy-thread-id]')).filter(subject=>subject.getBoundingClientRect().width>0&&subject.getBoundingClientRect().height>0).map(subject=>({subject:subject.textContent,threadId:subject.getAttribute('data-thread-id'),legacyThreadId:subject.getAttribute('data-legacy-thread-id'),legacyLastMessageId:subject.getAttribute('data-legacy-last-message-id'),standaloneDraftId:subject.getAttribute('data-standalone-draft-id'),legacyStandaloneDraftId:subject.getAttribute('data-legacy-standalone-draft-id')}))})));
    const rows=gmailListRowsFromEvidence(state,dom);
    if(completion.start!==1||completion.last!==completion.total||rows.length!==completion.total)return {scope,query,complete:false,total:completion.total,rows,reason:'pagination_incomplete'};
    return {scope,query,complete:true,total:completion.total,rows};
  };
}


const cleanAX=state=>String(state).split('\nThe focused UI element is ')[0];
export function gmailComposerMetadata(state){
  state=cleanAX(state);
  const sender=only([...state.matchAll(/^\s*\d+ pop up button \((?:collapsed|expanded)\) [^\n]*<([^<>\s]+@[^<>\s]+)>, ID:/gm)],'GMAIL_COMPOSE_SENDER_NOT_VISIBLE')[1].toLowerCase();
  const subjectLine=only([...state.matchAll(/^\s*\d+ text field \(settable\) Description: 主题(?:,[^\n]*)?$/gm)],'GMAIL_SUBJECT_AMBIGUOUS');
  const subject=subjectLine[0].match(/, Value: (.*?)(?:, ID: [^\n]*|$)/)?.[1]??'';
  const start=state.indexOf('container 收件人 - 选择联系人');if(start<0)throw Error('GMAIL_ADDRESS_LAYOUT_CHANGED');
  const section=state.slice(start,subjectLine.index);
  if(/combo box[^\n]*Description: [^\n]*(?:抄送|密送)/.test(section))throw Error('GMAIL_EXTRA_RECIPIENT_SECTION_REQUIRES_REVIEW');
  const to=[...section.matchAll(/^\s*\d+ Value: ([^\s<>]+@[^\s<>]+), ID: [^\n]+$/gm)].map(m=>m[1].toLowerCase());
  const editor=only([...state.matchAll(/^\s*(\d+) text entry area \(settable\) Description: 邮件正文, ID: [^\n,]+, Value: ([\s\S]*?)(?=\n\s*\d+ (?:container|button|pop up button|text|checkbox|link)|(?![\s\S]))/gm)],'GMAIL_EDITOR_AMBIGUOUS');
  const body=editor[2].replace(/\r\n?/g,'\n').trim();
  const lines=state.split('\n'),editorLine=lines.findIndex(line=>line.includes(editor[1]+' text entry area (settable) Description: 邮件正文'));
  const indent=lines[editorLine]?.match(/^\s*/)[0].length;if(indent===undefined)throw Error('GMAIL_EDITOR_SCOPE_UNVERIFIED');
  let editorEnd=editorLine+1;while(editorEnd<lines.length&&(!/^\s*\d+ /.test(lines[editorEnd])||lines[editorEnd].match(/^\s*/)[0].length>indent))editorEnd++;
  const outside=lines.slice(editorEnd).join('\n');
  if(/删除附件|移除附件|正在附加|已附加|\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/i.test(outside))throw Error('GMAIL_ATTACHMENT_REQUIRES_REVIEW');
  return {sender,to,cc:[],bcc:[],subject,body,editorIndex:Number(editor[1]),attachmentCount:0};
}
export function gmailListRowsFromEvidence(state,domRows){
  const rowMatches=[...cleanAX(state).matchAll(/^\s*(\d+) row(?: \(selected\))? ID: ([^,\s]+),([^\n]*)$/gm)];
  const indices=new Map(rowMatches.map(m=>[m[2],Number(m[1])]));
  const labels=new Map(rowMatches.map(m=>[m[2],m[3].split(',')[0].trim()]));
  if(!Array.isArray(domRows))throw Error('GMAIL_VISIBLE_ROWS_REQUIRED');
  const rows=[];
  for(const dom of domRows){
    if(!indices.has(dom.domId)||!Array.isArray(dom.subjects)||!dom.subjects.length)throw Error('GMAIL_ROW_AX_DOM_MISMATCH');
    const unique=new Map(dom.subjects.map(s=>[JSON.stringify(s),s]));if(unique.size!==1)throw Error('GMAIL_VISIBLE_ID_AMBIGUOUS');
    const subject=[...unique.values()][0];
    if(!text(subject.threadId)||!text(subject.legacyThreadId)||!text(subject.subject))throw Error('GMAIL_VISIBLE_ID_MISSING');
    const isDraft=!!subject.standaloneDraftId;
    if(isDraft&&!text(subject.legacyStandaloneDraftId))throw Error('GMAIL_STANDALONE_DRAFT_ID_MISSING');
    rows.push({index:indices.get(dom.domId),domId:dom.domId,threadId:subject.legacyThreadId,messageId:subject.legacyLastMessageId??null,draftId:isDraft?subject.legacyStandaloneDraftId:null,isDraft,draftThreadOnly:isDraft?labels.get(dom.domId)==='草稿':null,subject:subject.subject,recipient:null,attachments:/\d+\s*(?:KB|MB|GB)|附件/i.test(dom.attachmentText??'')});
  }
  if(rows.length!==indices.size)throw Error('GMAIL_ROW_COVERAGE_INCOMPLETE');return rows;
}
function listCompletion(state,query){
  const empty=parseGmailSearchCompletion(state,query);if(empty.complete)return empty;
  if(['query_not_current','query_url_invalid','query_url_not_current','loading','stale_results_with_empty_notice','draft_folder_account_control_invalid','draft_folder_empty_profile_pending','draft_folder_empty_profile_incomplete'].includes(empty.reason))return empty;
  const lines=cleanAX(state).split('\n');const counters=lines.map((line,index)=>/^\s*\d+ (?:pop up button|button) \([^\n]*\) Description: 显示更多邮件(?:,|$)/.test(line)?index:-1).filter(index=>index>=0);
  if(counters.length!==1)return {complete:false,reason:counters.length?'pagination_count_ambiguous':'pagination_count_not_visible'};
  const at=counters[0];
  const indent=lines[at].match(/^\s*/)[0].length;let end=at+1;while(end<lines.length&&(!/^\s*\d+ /.test(lines[end])||lines[end].match(/^\s*/)[0].length>indent))end++;
  const label=lines.slice(at+1,end).map(line=>line.match(/^\s*\d+ text (.*)$/)?.[1]??'').join('').replace(/\s+/g,'');
  const count=label.match(/^第(\d+)-(\d+)行，共(\d+)行$/);if(!count)return {complete:false,reason:'pagination_count_invalid'};
  const start=Number(count[1]),last=Number(count[2]),total=Number(count[3]);
  return {complete:true,empty:false,total,start,last,query};
}
function decodeGmailAttribute(value){
  const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'};
  if(/&(?!(?:#[0-9]+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);)[a-zA-Z#][a-zA-Z0-9#]*;/i.test(value))throw Error('GMAIL_BODY_ATTRIBUTE_ENTITY_UNSUPPORTED');
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi,(_whole,entity)=>{
    if(entity[0]!=='#')return named[entity.toLowerCase()];
    const code=entity[1]?.toLowerCase()==='x'?parseInt(entity.slice(2),16):Number(entity.slice(1));
    if(!Number.isSafeInteger(code)||code<=0||code>0x10ffff||code>=0xd800&&code<=0xdfff)throw Error('GMAIL_BODY_ATTRIBUTE_ENTITY_UNSUPPORTED');
    return String.fromCodePoint(code);
  });
}
function gmailBodyWithoutVerifiedMetadata(html){
  if(typeof html!=='string'||html.length>200000)throw Error('VISIBLE_BODY_HTML_INVALID');
  let result='',at=0;
  while(at<html.length){
    const start=html.indexOf('<',at);if(start<0){result+=html.slice(at);break;}
    result+=html.slice(at,start);let end=start+1,quote=null;
    for(;end<html.length;end++){const char=html[end];if(quote){if(char===quote)quote=null;}else if(char==='"'||char==="'")quote=char;else if(char==='>')break;}
    if(end===html.length||quote)throw Error('VISIBLE_BODY_HTML_INVALID');
    const token=html.slice(start+1,end).trim(),open=/^([A-Za-z][A-Za-z0-9]*)([\s\S]*?)(\/?)$/.exec(token);
    if(!open){result+=html.slice(start,end+1);at=end+1;continue;}
    const tag=open[1].toUpperCase(),attributes=new Map();let rest=open[2].trim();
    while(rest){
      const match=/^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*/.exec(rest);
      if(!match)throw Error('GMAIL_BODY_ATTRIBUTES_UNSUPPORTED');
      const name=match[1].toLowerCase();if(attributes.has(name))throw Error('GMAIL_BODY_ATTRIBUTES_DUPLICATE');
      attributes.set(name,{source:match[0].trim(),value:decodeGmailAttribute(match[2]??match[3])});rest=rest.slice(match[0].length);
    }
    if(tag==='DIV'&&['yj6qo','adL'].includes(attributes.get('class')?.value)){
      if(attributes.size!==1)throw Error('GMAIL_BODY_EMPTY_UI_WRAPPER_UNSUPPORTED');
      const closeAt=html.indexOf('<',end+1),close=closeAt<0?null:/^<\/div\s*>/i.exec(html.slice(closeAt));
      if(!close||decodeGmailAttribute(html.slice(end+1,closeAt)).trim())throw Error('GMAIL_BODY_EMPTY_UI_WRAPPER_UNSUPPORTED');
      // Gmail adds these empty presentation siblings around a sent body.
      // Never discard text, nested markup or wrappers with extra attributes.
      at=closeAt+close[0].length;continue;
    }
    if(attributes.has('id')&&tag==='DIV'&&/^avWBGd-\d+$/.test(attributes.get('id').value))attributes.delete('id');
    if(tag==='SPAN'){
      const spelling={'aria-invalid':'spelling','class':'LI ng'};
      const markers=[...attributes.keys()].filter(name=>/^zeum4c\d+$/.test(name));
      const marker=markers.length===1?attributes.get(markers[0]).value:null;
      // Marker indices identify this UI annotation, not any mail content.
      // The two observed marker fields must agree; exact body checks remain.
      if(attributes.size!==4||markers.length!==1||!/^PR_\d+_\d+$/.test(marker)||attributes.get('data-ddnwab')?.value!==marker||Object.entries(spelling).some(([name,value])=>attributes.get(name)?.value!==value))throw Error('GMAIL_BODY_SPELLING_ANNOTATION_UNSUPPORTED');
      const closeAt=html.indexOf('<',end+1),close=closeAt<0?null:/^<\/span\s*>/i.exec(html.slice(closeAt));
      if(!close||!decodeGmailAttribute(html.slice(end+1,closeAt)).trim())throw Error('GMAIL_BODY_SPELLING_ANNOTATION_UNSUPPORTED');
      // The observed annotation wraps one text node only. Any nested tag,
      // link, hidden/style attribute or changed marker remains a hold.
      result+=html.slice(end+1,closeAt);at=closeAt+close[0].length;continue;
    }
    if(attributes.has('dir')){if(tag!=='DIV'||attributes.get('dir').value!=='ltr')throw Error('GMAIL_BODY_DIRECTION_UNSUPPORTED');attributes.delete('dir');}
    if(attributes.has('data-saferedirecturl')){
      const href=attributes.get('href')?.value,redirect=attributes.get('data-saferedirecturl').value;let actual,via,target;
      try{actual=new URL(href);via=new URL(redirect);target=new URL(via.searchParams.get('q'));}catch{throw Error('GMAIL_BODY_REDIRECT_TARGET_MISMATCH');}
      const keys=[...via.searchParams.keys()];
      if(tag!=='A'||attributes.get('target')?.value!=='_blank'||!['http:','https:'].includes(actual.protocol)||actual.username||actual.password
        ||via.origin!=='https://www.google.com'||via.pathname!=='/url'||via.username||via.password||via.hash
        ||keys.some(key=>!['q','source','ust','usg'].includes(key))||['q','source','ust','usg'].some(key=>via.searchParams.getAll(key).length!==1)
        ||via.searchParams.get('source')!=='gmail'||!/^\d+$/.test(via.searchParams.get('ust'))||!/^[A-Za-z0-9_-]+$/.test(via.searchParams.get('usg'))
        ||target.href!==actual.href)throw Error('GMAIL_BODY_REDIRECT_TARGET_MISMATCH');
      attributes.delete('data-saferedirecturl');
    }
    result+='<'+open[1]+([...attributes.values()].length?' '+[...attributes.values()].map(entry=>entry.source).join(' '):'')+open[3]+'>';at=end+1;
  }
  return result;
}
/** Gmail-only metadata is checked before the unchanged strict body serializer.
 * Link text/actual href, hidden/style attributes and supported tags remain bound. */
export function serializeGmailVisiblePlainBody(snapshot,axBody){
  if(!snapshot||typeof snapshot.innerText!=='string'||typeof snapshot.textContent!=='string')throw Error('VISIBLE_BODY_TEXT_PROOF_REQUIRED');
  const canonical=serializeVisiblePlainBody({...snapshot,html:gmailBodyWithoutVerifiedMetadata(snapshot.html)},axBody);
  return {...canonical,bodySource:'visible-gmail-body',bodyEvidence:{...canonical.bodyEvidence,source:'visible-gmail-body',gmailMetadataPolicy:'verified-ltr-google-redirect-v1',gmailAnnotationPolicy:'exact-visible-spelling-v1',gmailRenderingPolicy:'verified-message-container-empty-ui-v1'}};
}
export function createGmailVisibleComposerReader(tab){
  return async({state,metadataOnly=false})=>{
    const meta=gmailComposerMetadata(state);
    if(metadataOnly)return {...meta,composeToken:(()=>{try{return gmailComposeIdFromAX(state);}catch(error){if(error.message==='GMAIL_SAVED_COMPOSE_ID_MISSING')return null;throw error;}})()};
    if(!tab.playwright?.getByRole)throw Error('GMAIL_VISIBLE_BODY_DOM_READER_UNAVAILABLE');
    const dom=await tab.playwright.getByRole('textbox',{name:'邮件正文',exact:true}).evaluate(el=>({html:el.innerHTML,innerText:el.innerText,textContent:el.textContent}));
    if(!meta.body){if(String(dom.innerText??'').trim()||String(dom.textContent??'').trim())throw Error('GMAIL_VISIBLE_COMPOSE_TEXT_MISMATCH');return {...meta,body:'',composeToken:(()=>{try{return gmailComposeIdFromAX(state);}catch(error){if(error.message==='GMAIL_SAVED_COMPOSE_ID_MISSING')return null;throw error;}})()};}
    const canonical=serializeGmailVisiblePlainBody(dom,meta.body);
    if(canonical.body!==meta.body)throw Error('GMAIL_VISIBLE_COMPOSE_TEXT_MISMATCH');
    return {...meta,body:canonical.body,composeToken:gmailComposeIdFromAX(state),bodySerialization:canonical.bodySerialization,bodyEvidence:canonical.bodyEvidence};
  };
}


function gmailHeaderMailbox(value,{plainDisplay=false}={}){
  value=String(value).trim();if(!value||/[\r\n,;]/.test(value))throw Error('GMAIL_SENT_ADDRESS_AMBIGUOUS');
  if(/[<>]/.test(value)){
    const match=/^([^<>]*)<([^<>]+)>$/.exec(value);if(!match||!singleEmail(match[2].trim()))throw Error('GMAIL_SENT_ADDRESS_AMBIGUOUS');
    const display=match[1].trim();if(display.includes('"')&&!/^"[^"\r\n]*"$/.test(display))throw Error('GMAIL_SENT_ADDRESS_AMBIGUOUS');
    return match[2].trim().toLowerCase();
  }
  if(singleEmail(value))return value.toLowerCase();
  if(!plainDisplay)throw Error('GMAIL_SENT_ADDRESS_AMBIGUOUS');
  const match=/^(.+)\s+([^\s<>]+@[^\s<>]+)$/.exec(value);if(!match||!singleEmail(match[2]))throw Error('GMAIL_SENT_ADDRESS_AMBIGUOUS');
  const actual=match[2].toLowerCase(),display=match[1].trim();
  if(display.includes('"')&&!/^"[^"\r\n]*"$/.test(display))throw Error('GMAIL_SENT_ADDRESS_AMBIGUOUS');
  const displayEmails=display.match(/[A-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)??[];
  // A single From value may repeat its own mailbox as the displayed name.
  // Without angle brackets, a different email in that prefix is ambiguous.
  if(displayEmails.some(email=>email.toLowerCase()!==actual))throw Error('GMAIL_SENT_ADDRESS_AMBIGUOUS');
  return actual;
}
export function gmailSentHeadersFromAX(state){
  const lines=cleanAX(state).split('\n'),tables=[];
  for(let at=0;at<lines.length;at++){
    if(!/^\s*\d+ table(?:\s+[^\n]*)?$/.test(lines[at]))continue;
    const indent=lines[at].match(/^\s*/)[0].length;let end=at+1;while(end<lines.length&&(!/^\s*\d+ /.test(lines[end])||lines[end].match(/^\s*/)[0].length>indent))end++;
    const block=lines.slice(at,end).join('\n');
    if(['发件人:','收件人:','日期:','主题:'].every(label=>block.includes('text '+label)))tables.push(block);
  }
  const block=only(tables,'GMAIL_SENT_HEADER_DETAILS_NOT_VISIBLE');
  const blockLines=block.split('\n'),values=new Map();
  for(let at=0;at<blockLines.length;at++){
    if(!/^\s*\d+ row(?:\s+[^\n]*)?$/.test(blockLines[at]))continue;
    const indent=blockLines[at].match(/^\s*/)[0].length;let end=at+1;while(end<blockLines.length&&(!/^\s*\d+ /.test(blockLines[end])||blockLines[end].match(/^\s*/)[0].length>indent))end++;
    const row=blockLines.slice(at,end).join('\n'),label=row.match(/^\s*\d+ text ([^\n]*:)\s*$/m)?.[1];
    if(label){if(values.has(label))throw Error('GMAIL_SENT_HEADER_AMBIGUOUS');values.set(label,row);}
  }
  if(values.has('抄送:')||values.has('密送:'))throw Error('GMAIL_SENT_EXTRA_RECIPIENTS');
  const address=label=>{
    const row=values.get(label)??'',popups=[...row.matchAll(/^\s*\d+ pop up button(?: \([^\n)]*\))? (?:Description: )?([^\n]*)$/gm)];
    const texts=[...row.matchAll(/^\s*\d+ text ([^\n]*)$/gm)].filter(match=>match[1]!==label);
    if(label==='收件人:'){
      if(popups.length!==1||texts.length)throw Error('GMAIL_SENT_ADDRESS_AMBIGUOUS');
      const rest=row.replace(popups[0][0],'');if(/[A-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(rest))throw Error('GMAIL_SENT_ADDRESS_AMBIGUOUS');
      return gmailHeaderMailbox(popups[0][1]);
    }
    if(popups.length+texts.length!==1)throw Error('GMAIL_SENT_ADDRESS_AMBIGUOUS');
    const selected=popups[0]??texts[0],rest=row.replace(selected[0],'');
    if(/[A-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(rest))throw Error('GMAIL_SENT_ADDRESS_AMBIGUOUS');
    return gmailHeaderMailbox(selected[1],{plainDisplay:true});
  };
  const value=label=>{const row=values.get(label)??'';const texts=[...row.matchAll(/^\s*\d+ text (.*)$/gm)].map(m=>m[1]).filter(v=>v!==label);return only(texts,'GMAIL_SENT_HEADER_AMBIGUOUS');};
  return {sender:address('发件人:'),recipient:address('收件人:'),subject:value('主题:'),date:value('日期:')};
}
export function createGmailVisibleMessageReader(tab){
  return async({state,row,item})=>{
    if(row.isDraft!==false||!text(row.messageId))throw Error('GMAIL_SENT_ROW_ID_REQUIRED');
    let current=state,headers;
    try{headers=gmailSentHeadersFromAX(current);}catch(error){
      if(error.message!=='GMAIL_SENT_HEADER_DETAILS_NOT_VISIBLE')throw error;
      const control=only([...current.matchAll(/^\s*(\d+) pop up button Description: 显示详细信息(?:,[^\n]*)?$/gm)],'GMAIL_SENT_DETAILS_CONTROL_AMBIGUOUS');
      await tab.click(Number(control[1]));
      for(let n=0;n<8;n++){current=await tab.getAXState({emit:false,disableDiffing:true});if(gmailAccountFromAX(current)!==item.accountId)throw Error('MAILBOX_ACCOUNT_CHANGED');try{headers=gmailSentHeadersFromAX(current);break;}catch(next){if(next.message!=='GMAIL_SENT_HEADER_DETAILS_NOT_VISIBLE')throw next;}}
      if(!headers)throw Error('GMAIL_SENT_HEADER_DETAILS_NOT_VISIBLE');
    }
    if(gmailAccountFromAX(current)!==item.accountId)throw Error('MAILBOX_ACCOUNT_CHANGED');
    if(!tab.playwright?.locator)throw Error('GMAIL_VISIBLE_MESSAGE_DOM_READER_UNAVAILABLE');
    const messages=await tab.playwright.locator('[data-message-id]').evaluateAll(elements=>elements.filter(el=>el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0).map(el=>({messageId:el.getAttribute('data-message-id'),legacyMessageId:el.getAttribute('data-legacy-message-id'),bodies:Array.from(el.querySelectorAll('.a3s')).filter(body=>body.getBoundingClientRect().width>0&&body.getBoundingClientRect().height>0).map(body=>({html:body.innerHTML,innerText:body.innerText,textContent:body.textContent}))})));
    const message=only(messages,'GMAIL_SENT_MESSAGE_CONTAINER_AMBIGUOUS');
    if(!text(message.messageId)||message.legacyMessageId!==row.messageId)throw Error('GMAIL_SENT_VISIBLE_MESSAGE_ID_MISMATCH');
    const body=only(message.bodies,'GMAIL_SENT_BODY_CONTAINER_AMBIGUOUS');
    if(typeof body.innerText!=='string'||typeof body.textContent!=='string'||body.innerText.replace(/\s/gu,'')!==body.textContent.replace(/\s/gu,''))throw Error('GMAIL_SENT_HIDDEN_OR_INCOMPLETE_BODY');
    const canonical=serializeGmailVisiblePlainBody(body,body.innerText);
    if(canonical.body!==body.innerText.replace(/\r\n?/g,'\n').trim())throw Error('GMAIL_SENT_VISIBLE_BODY_TEXT_MISMATCH');
    return {messageId:message.legacyMessageId,providerMessageId:message.messageId,...headers,body:canonical.body,sent:true,bodyEvidence:{...canonical.bodyEvidence,source:'visible-gmail-message-a3s',messageIdAttribute:'data-legacy-message-id',headerSource:'visible-details-table'}};
  };
}

/** Browser-UI adapter. Visible evidence readers must be based on a validated
 * Gmail page profile; an absent reader is a hold, never an inferred success. */
export class GmailBrowserMailAdapter{
  constructor({tab,accountId,preparedRefs=null,readVisibleList,readVisibleComposer,readVisibleMessage,observe,approvedPermanentDraftIds=[],functionalTest=null,clickVisibleAddress=null}={}){
    if(!tab||!singleEmail(accountId))throw Error('EXPLICIT_TAB_AND_ACCOUNT_REQUIRED');
    for(const callback of [readVisibleList,readVisibleComposer,readVisibleMessage])if(callback!==undefined&&typeof callback!=='function')throw Error('GMAIL_VISIBLE_READER_INVALID');
    this.tab=tab;this.accountId=accountId.toLowerCase();this.preparedRefs=preparedRefs;this.readVisibleList=readVisibleList??createGmailVisibleListReader(tab);this.readVisibleComposer=readVisibleComposer??createGmailVisibleComposerReader(tab);this.readVisibleMessage=readVisibleMessage??createGmailVisibleMessageReader(tab);this.observe=observe;
    if(clickVisibleAddress!==null&&typeof clickVisibleAddress!=='function')throw Error('GMAIL_ADDRESS_CLICKER_INVALID');
    this.clickVisibleAddress=clickVisibleAddress??(typeof tab.clickVisibleComposeAddress==='function'?(context=>tab.clickVisibleComposeAddress(context)):null);
    this.mode='cua-gmail-browser-ui';this.mailProfile='chinese-gmail-ui';this.lastReceipts=new Map();this.preflightIds=new Map();this.composeTokens=new Map();this.currentCompose=null;this.approvedPermanentDraftIds=new Set(approvedPermanentDraftIds.map(String));
    this.functionalTest=functionalTest;
    if(functionalTest!==null){
      if(functionalTest.kind!=='functional-test'||!singleEmail(functionalTest.recipient)||!Array.isArray(functionalTest.messages)||!functionalTest.messages.length)throw Error('GMAIL_TEST_PACKET_INVALID');
      const subjects=functionalTest.messages.map(m=>m.subject);if(new Set(subjects).size!==subjects.length||functionalTest.messages.some(m=>!text(m.subject)||!text(m.body)))throw Error('GMAIL_TEST_PACKET_INVALID');
    }
  }
  async snapshot(){const state=await this.tab.getAXState({emit:false,disableDiffing:true});this.checkAccount(state);this.observe?.(state);return state;}
  checkAccount(state){if(gmailAccountFromAX(state)!==this.accountId)throw Error('MAILBOX_ACCOUNT_CHANGED');}
  async waitFor(predicate,label,{attempts=8}={}){for(let n=0;n<attempts;n++){const state=await this.snapshot();if(predicate(state))return state;}throw Error('GMAIL_UI_NOT_READY:'+label);}

  async closeOwnedComposer(state){
    if(!/text entry area \(settable\) Description: 邮件正文/.test(state))return state;
    const token=gmailComposeIdFromAX(state);
    if(!this.currentCompose||this.currentCompose.composeToken!==token)throw Error('GMAIL_UNOWNED_COMPOSER_OPEN');
    const close=only([...state.matchAll(/^\s*(\d+) button Description: 保存并关闭(?:,[^\n]*)?$/gm)],'GMAIL_SAVE_CLOSE_AMBIGUOUS');
    await this.tab.click(Number(close[1]));this.currentCompose=null;
    return await this.waitFor(s=>!/text entry area \(settable\) Description: 邮件正文/.test(s),'saved composer closed');
  }
  async ensureAddressExpanded(state){
    if(/^\s*\d+ pop up button \((?:collapsed|expanded)\) [^\n]*<[^<>\s]+@[^<>\s]+>, ID:/m.test(state))return state;
    const source=cleanAX(state),start=source.indexOf('container 撰写： '),end=source.indexOf('text field (settable) Description: 主题',start);
    if(start<0||end<0)throw Error('GMAIL_COMPOSE_ADDRESS_BAR_MISSING');
    const choices=[...source.slice(start,end).matchAll(/^\s*(\d+) text ([^\s<>]+@[^\s<>]+)\s*$/gm)];
    const target=only(choices,'GMAIL_COMPOSE_ADDRESS_EXPAND_AMBIGUOUS');
    const token=gmailComposeIdFromAX(state);
    if(typeof this.clickVisibleAddress!=='function')throw Error('GMAIL_VISIBLE_ADDRESS_EXPAND_UNAVAILABLE');
    await this.clickVisibleAddress({accountId:this.accountId,recipient:target[2].toLowerCase(),composeToken:token});
    const expanded=await this.waitFor(s=>/^\s*\d+ pop up button \((?:collapsed|expanded)\) [^\n]*<[^<>\s]+@[^<>\s]+>, ID:/m.test(s),'visible compose sender');
    if(gmailComposeIdFromAX(expanded)!==token)throw Error('ORIGINAL_DRAFT_ID_CHANGED');
    const sender=only([...cleanAX(expanded).matchAll(/^\s*\d+ pop up button \((?:collapsed|expanded)\) [^\n]*<([^<>\s]+@[^<>\s]+)>, ID:/gm)],'GMAIL_COMPOSE_SENDER_AMBIGUOUS')[1].toLowerCase();
    if(sender!==this.accountId)throw Error('COMPOSE_ACCOUNT_MISMATCH');return expanded;
  }

  async search(query,scope){
    let state=await this.snapshot();state=await this.closeOwnedComposer(state);
    const field=only([...state.matchAll(/^\s*(\d+) text field \(settable\) (?:Description: )?搜索邮件(?:, Value: [^\n]*)?$/gm)],'GMAIL_SEARCH_CONTROL_AMBIGUOUS');
    await this.tab.click(Number(field[1]));await this.tab.pressKey(null,'Control_L+a');await this.tab.typeText(null,query);await this.tab.pressKey(null,'Return');
    state=await this.waitFor(s=>{const found=[...s.matchAll(/^\s*\d+ text field \(settable\) (?:Description: )?搜索邮件, Value: ([^\n]*)$/gm)];return found.length===1&&(found[0][1].trim()===query||gmailVisibleQueryContext(s,query).profile==='drafts_folder_alias');},'search query');
    if(!this.readVisibleList)throw Error('GMAIL_VISIBLE_LIST_READER_REQUIRED');
    let candidate=null;
    for(let n=0;n<8;n++){
      const view=await this.readVisibleList({state,scope,query});
      if(view?.complete===true){const valid=validateView(view,scope,query);const key=JSON.stringify({scope,query,total:valid.total,rows:valid.rows.map(row=>[row.threadId,row.draftId,row.subject,row.isDraft])});if(candidate===key)return valid;candidate=key;}else candidate=null;
      state=await this.snapshot();
    }
    throw Error('GMAIL_LIST_PROOF_INCOMPLETE');
  }
  draftQuery(ref){return 'in:drafts to:'+ref.recipient+' subject:'+quoteSearch(ref.subject);}
  async scanDrafts({limit=50}={}){
    if(!Number.isInteger(limit)||limit<1)throw Error('GMAIL_SCAN_LIMIT_INVALID');
    if(!this.preparedRefs)throw Error('GMAIL_EXACT_PREPARED_REFS_REQUIRED');
    const rows=this.preparedRefs.slice(0,limit);
    for(const ref of rows)if(ref.accountId!==this.accountId||!text(ref.draftId)||!singleEmail(ref.recipient)||!text(ref.subject))throw Error('GMAIL_PREPARED_REF_INVALID');
    return structuredClone(rows);
  }
  async findDraft(ref){
    if(ref.accountId!==this.accountId)throw Error('REF_ACCOUNT_MISMATCH');
    const view=await this.search(this.draftQuery(ref),'drafts');
    if(view.rows.some(row=>!row.isDraft||row.subject!==ref.subject||row.recipient&&row.recipient!==ref.recipient))throw Error('GMAIL_DRAFT_SEARCH_SCOPE_MISMATCH');
    const matches=view.rows.filter(row=>(row.draftId??row.threadId)===ref.draftId);
    if(matches.length>1)throw Error('DRAFT_ID_AMBIGUOUS');
    if(!matches.length){
      const allDrafts=await this.search('in:drafts','drafts');
      if(allDrafts.rows.some(row=>!row.isDraft))throw Error('GMAIL_DRAFT_SEARCH_SCOPE_MISMATCH');
      if(allDrafts.rows.some(row=>(row.draftId??row.threadId)===ref.draftId))throw Error('ORIGINAL_DRAFT_CHANGED');
      this.lastDraftLookup={accountId:this.accountId,draftId:ref.draftId,threadId:ref.threadId,complete:true,absent:true,scope:'all_drafts_stable_id'};return null;
    }
    const row=matches[0];if(!row.isDraft||row.subject!==ref.subject||row.recipient&&row.recipient!==ref.recipient||row.attachments===true)throw Error('ORIGINAL_DRAFT_CHANGED');
    this.lastDraftLookup={accountId:this.accountId,draftId:ref.draftId,threadId:ref.threadId,complete:true,absent:false};return row;
  }
  async composeSnapshot(state,ref){
    const token=ref.composeToken??this.composeTokens.get(ref.draftId);
    const item=parseGmailCompose(state,this.accountId,{...ref,...(token?{composeToken:token}:{})});
    if(!this.readVisibleComposer)throw Error('GMAIL_VISIBLE_COMPOSER_READER_REQUIRED');
    const proof=await this.readVisibleComposer({state,ref,item});
    if(!proof||proof.draftId!==undefined&&proof.draftId!==ref.draftId||proof.sender!==this.accountId||!Array.isArray(proof.to)||proof.to.length!==1||proof.to[0]!==ref.recipient||!Array.isArray(proof.cc)||proof.cc.length||!Array.isArray(proof.bcc)||proof.bcc.length||proof.attachmentCount!==0)throw Error('RECIPIENT_OR_CC_CHANGED');
    if(proof.subject!==item.subject||proof.body!==item.body)throw Error('GMAIL_VISIBLE_COMPOSE_TEXT_MISMATCH');
    return {...item,bodySerialization:proof.bodySerialization??item.bodySerialization,bodyEvidence:proof.bodyEvidence??{source:'visible-gmail-compose',serializer:item.bodySerialization},threadId:ref.threadId??item.threadId??null};
  }
  async inspectDraft(ref){
    const row=await this.findDraft(ref);if(!row)throw Error('DRAFT_MISSING');
    await this.tab.click(row.index);
    const state=await this.waitFor(s=>/text entry area \(settable\) Description: 邮件正文/.test(s),'draft compose');
    const token=gmailComposeIdFromAX(state);this.composeTokens.set(ref.draftId,token);this.currentCompose={draftId:ref.draftId,composeToken:token};
    const expanded=await this.ensureAddressExpanded(state);
    return await this.composeSnapshot(expanded,{...ref,threadId:row.threadId,composeToken:token});
  }
  sameItem(a,b){return ['accountId','draftId','threadId','recipient','subject','body','approvedHash','draftVersion'].every(key=>a[key]===b[key]);}
  async preflight(item){
    const query='in:anywhere {to:'+item.recipient+' from:'+item.recipient+'}';
    const view=await this.search(query,'anywhere');
    const original=view.rows.filter(row=>(row.draftId??row.threadId)===item.draftId&&row.isDraft);
    if(original.length!==1)return {ok:false,reason:'original_draft_not_in_completed_search'};
    if(original.some(row=>row.draftThreadOnly===false||row.messageId&&row.messageId!==item.draftId))return {ok:false,skip:true,reason:'existing_correspondence_in_draft_thread'};
    const others=view.rows.filter(row=>(row.draftId??row.threadId)!==item.draftId);
    if(others.some(row=>row.subject===item.subject))return {ok:false,skip:true,reason:'existing_same_subject_correspondence'};
    if(others.some(row=>/undeliver|delivery (?:fail|status)|returned mail|mail failure|退信|投递失败|unsubscribe|remove me|no thanks|stop contacting/i.test(row.subject)))return {ok:false,skip:true,reason:'delivery_or_stop_record'};
    if(this.functionalTest){
      const approved=this.functionalTest.messages.find(m=>m.subject===item.subject);
      if(this.functionalTest.recipient!==item.recipient||!approved||approved.body!==item.body)return {ok:false,reason:'outside_exact_function_test_packet'};
    }else if(others.length)return {ok:false,skip:true,reason:'existing_correspondence_requires_review'};
    this.preflightIds.set(item.draftId,new Set(view.rows.flatMap(row=>[row.threadId,row.messageId].filter(Boolean))));
    return {ok:true,checkedAt:new Date().toISOString(),mode:this.functionalTest?'functional-test':'outreach'};
  }
  async send(item,{beforeClick}={}){
    if(typeof this.readVisibleMessage!=='function')throw Error('GMAIL_VISIBLE_MESSAGE_READER_REQUIRED');
    if(typeof beforeClick!=='function')throw Error('HOST_REVALIDATION_HOOK_REQUIRED');
    let fresh=await this.inspectDraft(item),revalidated=false;
    if(!this.sameItem(fresh,item))throw Error('CONTENT_CHANGED_SINCE_APPROVAL');
    await beforeClick({revalidate:async()=>{fresh=await this.composeSnapshot(await this.snapshot(),item);if(!this.sameItem(fresh,item))throw Error('CONTENT_CHANGED_DURING_PACING_WAIT');revalidated=true;}});
    if(!revalidated)throw Error('HOST_REVALIDATION_HOOK_REQUIRED');
    await this.tab.click(fresh.sendIndex);
    await this.snapshot();
    return await this.reconcile(item);
  }
  async reconcile(item){
    const baseline=this.preflightIds.get(item.draftId);
    if(!baseline)return {status:'unknown',reason:'preflight_baseline_missing'};
    const view=await this.search('in:sent to:'+item.recipient+' subject:'+quoteSearch(item.subject),'sent');
    const matches=view.rows.filter(row=>!row.isDraft&&row.subject===item.subject&&(!row.recipient||row.recipient===item.recipient));
    if(matches.length!==1)return {status:'unknown',reason:'sent_receipt_missing_or_ambiguous'};
    const row=matches[0];await this.tab.click(row.index);const state=await this.snapshot();
    if(!this.readVisibleMessage)throw Error('GMAIL_VISIBLE_MESSAGE_READER_REQUIRED');
    const proof=await this.readVisibleMessage({state,row,item});
    if(!proof||!text(proof.messageId)||baseline.has(proof.messageId)||proof.sender!==this.accountId||proof.recipient!==item.recipient||proof.subject!==item.subject||proof.body!==item.body||proof.sent!==true)return {status:'unknown',reason:'sent_full_message_not_verified'};
    const receipt={status:'sent',authoritative:true,messageId:proof.messageId,recipient:item.recipient,...binding(item),mode:this.mode};
    this.lastReceipts.set(item.draftId,receipt);return receipt;
  }
  async cleanup(item,receipt,{beforeClick}={}){
    const expected=this.lastReceipts.get(item.draftId);
    if(!expected||JSON.stringify(expected)!==JSON.stringify(receipt))throw Error('NO_CONFIRMED_RECEIPT_FOR_CLEANUP');
    let fresh;try{fresh=await this.inspectDraft(item);}catch(error){
      if(error.message==='DRAFT_MISSING'&&this.lastDraftLookup?.complete&&this.lastDraftLookup.absent&&this.lastDraftLookup.scope==='all_drafts_stable_id'&&this.lastDraftLookup.draftId===item.draftId&&this.lastDraftLookup.accountId===item.accountId)return {status:'already_absent',authoritative:true,...binding(item),sentMessageId:receipt.messageId,removalMethod:'provider_consumed'};
      throw error;
    }
    if(!this.sameItem(fresh,item))throw Error('DRAFT_CHANGED_BEFORE_CLEANUP');
    if(!this.approvedPermanentDraftIds.has(item.draftId))throw Error('PERMANENT_DRAFT_DELETE_REQUIRES_CURRENT_APPROVAL');
    const state=await this.snapshot(),verify=await this.composeSnapshot(state,item);if(!this.sameItem(verify,item))throw Error('DRAFT_CHANGED_BEFORE_CLEANUP');
    const button=only([...state.matchAll(/^\s*(\d+) button Description: 舍弃草稿 [^\n]*$/gm)],'GMAIL_DISCARD_CONTROL_AMBIGUOUS');
    if(typeof beforeClick!=='function')throw Error('CLEANUP_GUARD_REQUIRED');
    await beforeClick();await this.tab.click(Number(button[1]));await this.snapshot();
    if(await this.findDraft(item))throw Error('ORIGINAL_DRAFT_REMOVAL_NOT_CONFIRMED');
    return {status:'already_absent',authoritative:true,...binding(item),sentMessageId:receipt.messageId,removalMethod:'permanent_draft_delete'};
  }
  async countDrafts(){
    const view=await this.search('in:drafts','drafts');
    if(view.rows.some(row=>!row.isDraft))throw Error('GMAIL_DRAFT_SEARCH_SCOPE_MISMATCH');
    if(view.rows.some(row=>!text(row.draftId)))throw Error('GMAIL_STANDALONE_DRAFT_COUNT_UNVERIFIED');
    return {value:view.total,exact:true,source:view.total===0?'gmail_empty_drafts_view':'gmail_visible_standalone_draft_count',observedAt:new Date().toISOString()};
  }
}
export async function gmailCompatibilityChecker({tab,accountId}){
  const state=await tab.getAXState({emit:false,disableDiffing:true});let account=false;try{account=gmailAccountFromAX(state)===accountId;}catch{}
  const checks=[{id:'account_matches',ok:account},{id:'drafts_control',ok:/link Description: (?:草稿|“草稿”中有 \d+ 封未读邮件), Value: mail\.google\.com\/mail\/u\/\d+\/#drafts/.test(state)},{id:'sent_control',ok:/link Description: 已发邮件, Value: mail\.google\.com\/mail\/u\/\d+\/#sent/.test(state)},{id:'search_control',ok:/text field \(settable\) (?:Description: )?搜索邮件/.test(state)}];
  return {compatible:checks.every(c=>c.ok),checks,requiresComposePreflight:true};
}
