/**
 * Chromium page bridge for the existing CUA-shaped mailbox adapter.
 * Only public CDP DOM/Accessibility/Input operations are used. No mailbox API,
 * cookie, token, storage, network interception or hidden send retries.
 */
const valueOf = value => value?.value ?? '';
const propertiesOf = node => Object.fromEntries((node.properties ?? []).map(p => [p.name, valueOf(p.value)]));
const oneLine = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const emailOnly = /^[^\s<>]+@[^\s<>]+\.[^\s<>]+$/u;
const attrObject = attributes => Object.fromEntries(Array.from({length:(attributes ?? []).length / 2}, (_, i) => [attributes[i*2],attributes[i*2+1]]));
const roleOf = node => String(valueOf(node.role));
// Chromium propagates AX editable onto text and anonymous shadow descendants.
// Only the actual DOM input/textarea/contenteditable owner has a complete value.
const editorKind = (node,meta) => {
  const tag=String(meta.nodeName??'').toUpperCase(),attr=meta.attributes??{};
  if(!tag||tag.startsWith('#'))return null;
  // Native text inputs keep their form semantics even if the UI also sets contenteditable.
  if(tag==='TEXTAREA')return 'plain';
  if(tag==='INPUT')return ['textbox','searchbox','combobox'].includes(roleOf(node))?'single':null;
  if(Object.hasOwn(attr,'contenteditable')&&['','true','plaintext-only'].includes(attr.contenteditable))return 'rich';
  return null;
};
const exactId = value => {const id=String(value??'');if(/[\r\n\t,]/u.test(id)||id!==id.trim())throw Error('DOM_ID_UNREPRESENTABLE');return id;};
const named = (label, name) => label + (name ? ' ' + name : '');
const identityOK = result => result === true || result?.ok === true;

const composeHostId = /^zmComposeEditor_Cmp[0-9]+$/;
const verifiedFrameSource = 'verified-zoho-compose-frame-v1';

// Resolve the iframe element in an isolated world of the top document. The
// browser's ordinary same-origin check, not the CDP frame's serialized URL
// origin, determines whether this owner can access its contentDocument.
const READ_COMPOSE_FRAME_OWNER = `function readComposeFrameOwner() {
  if(!this || !this.isConnected || this.nodeType!==1) return {connected:false};
  const host=this.closest('[id^="zmComposeEditor_Cmp"]');
  const parent=this.ownerDocument.defaultView,topDocument=parent===globalThis&&parent===parent.top;
  const visible=node=>{for(let current=node;current&&current.nodeType===1;current=current.parentElement){
    const style=current.ownerDocument.defaultView.getComputedStyle(current);
    if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0||current.hidden||current.getAttribute('aria-hidden')==='true')return false;
  }return true;};
  const r=this.getBoundingClientRect(),hit=this.ownerDocument.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
  let sameOriginDocument=false;
  if(topDocument&&this.tagName==='IFRAME'){
    try{
      const doc=this.contentDocument,child=this.contentWindow;
      sameOriginDocument=!!doc&&!!child&&doc.URL==='about:srcdoc'&&doc.defaultView===child
        &&child.document===doc&&child.frameElement===this&&child.origin===parent.origin;
    }catch{}
  }
  return {connected:true,topDocument,documentOrigin:parent.origin,sameOriginDocument,
    tag:this.tagName,title:this.getAttribute('title'),label:this.getAttribute('aria-label'),
    src:this.getAttribute('src'),srcdoc:this.hasAttribute('srcdoc'),hostId:host?.id??null,
    hostFrameCount:host?.querySelectorAll('iframe,frame,fencedframe,object,embed').length??0,
    visible:visible(this)&&r.width>0&&r.height>0,unobscured:hit===this,
    width:r.width,height:r.height};
}`;

// Recheck the owner's browser-enforced access together with each body read.
// This never enters a child execution context or obtains universal access.
const READ_COMPOSE_FRAME_BODY = `function readComposeFrameBody() {
  const owner=(${READ_COMPOSE_FRAME_OWNER}).call(this);
  if(!owner.sameOriginDocument||!owner.visible||!owner.unobscured)return {owner};
  const doc=this.contentDocument,body=doc?.body;
  if(!body||doc.URL!=='about:srcdoc')return {owner};
  const explicit=[...doc.querySelectorAll('[contenteditable]')].filter(node=>
    ['', 'true', 'plaintext-only'].includes(node.getAttribute('contenteditable'))&&node.isContentEditable);
  let editor;
  if(explicit.length===1)editor=explicit[0];
  else if(explicit.length===0&&doc.designMode.toLowerCase()==='on'&&body.isContentEditable)editor=body;
  if(!editor||!editor.isConnected||!editor.isContentEditable||!body.contains(editor))return {owner};
  const visible=node=>{for(let current=node;current&&current.nodeType===1;current=current.parentElement){
    const style=doc.defaultView.getComputedStyle(current);
    if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0||current.hidden||current.getAttribute('aria-hidden')==='true')return false;
  }return true;};
  const r=editor.getBoundingClientRect();
  if(!visible(editor)||r.width<=0||r.height<=0||body.querySelector('input,textarea,select,iframe,frame,fencedframe,object,embed'))return {owner};
  const compact=value=>String(value??'').replace(/\\s/gu,'');
  if(compact(body.textContent)!==compact(editor.textContent))return {owner};
  return {owner,body:{html:editor.innerHTML,innerText:editor.innerText,textContent:editor.textContent}};
}`;

function composeFrameTopOrigin(top) {
  let topUrl;try{topUrl=new URL(top?.url);}catch{throw Error('COMPOSE_FRAME_TOP_URL_UNVERIFIED');}
  if(topUrl.origin!=='https://mail.zoho.com'||topUrl.pathname!=='/zm/'||topUrl.hash!=='#compose'
    ||!top.id||!top.loaderId||top.parentId)throw Error('COMPOSE_FRAME_TOP_URL_UNVERIFIED');
  return topUrl.origin;
}

function verifyComposeFrameMetadata(top,frame,origin) {
  // Some Chromium builds serialize srcdoc as "://" in Page.getFrameTree,
  // including documents whose effective origin inherits the parent.
  if(!frame?.id||!frame.loaderId||frame.parentId!==top.id||frame.url!=='about:srcdoc'
    ||![origin,'://'].includes(frame.securityOrigin))throw Error('COMPOSE_FRAME_ORIGIN_UNVERIFIED');
}

export function validateComposeFrameBinding({top,frame,owner,hostId,ownerBackendNodeId}) {
  const origin=composeFrameTopOrigin(top);
  verifyComposeFrameMetadata(top,frame,origin);
  if(!composeHostId.test(hostId??'')||!Number.isSafeInteger(ownerBackendNodeId)||ownerBackendNodeId<=0
    ||owner?.connected!==true||owner.topDocument!==true||owner.tag!=='IFRAME'
    ||owner.title!=='文本编辑区域'||owner.label!=='文本编辑区域'||owner.src!==null||owner.srcdoc!==true
    ||owner.hostId!==hostId||owner.hostFrameCount!==1||owner.visible!==true||owner.unobscured!==true
    ||!Number.isFinite(owner.width)||!Number.isFinite(owner.height)||owner.width<=0||owner.height<=0)
    throw Error('COMPOSE_FRAME_OWNER_UNVERIFIED');
  if(owner.documentOrigin!==origin||owner.sameOriginDocument!==true)throw Error('COMPOSE_FRAME_ORIGIN_UNVERIFIED');
  return {topFrameId:top.id,topLoaderId:top.loaderId,frameId:frame.id,
    frameLoaderId:frame.loaderId,securityOrigin:origin,ownerBackendNodeId,hostId};
}

export function indexDOMTree(root, {frameScope='strict'}={}) {
  if(!['strict','top-document'].includes(frameScope))throw Error('INVALID_FRAME_SCOPE');
  const map = new Map();
  const visit = (node, pseudo=false) => {
    if (!node) return;
    if (node.backendNodeId) map.set(node.backendNodeId, {
      nodeName:node.nodeName, attributes:attrObject(node.attributes), backendNodeId:node.backendNodeId, pseudo
    });
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) visit(child,pseudo);
    if(frameScope==='top-document')for(const styleNode of node.pseudoElements??[])visit(styleNode,true);
    // Frames are intentionally not flattened into the top-level mailbox.
    if (node.contentDocument && frameScope==='strict') throw Error('UNVERIFIED_FRAME_TREE');
  };
  visit(root);
  return map;
}

const embeddedDocuments=new Set(['IFRAME','FRAME','FENCEDFRAME','OBJECT','EMBED']);

// The CDP top-frame AX tree must agree with the main document's DOM index.
// Embedded document owners have stable DOM nodes but may never be controls.
function scopeTopDocument(nodes,root,dom,frameId) {
  const pageRoots=nodes?.filter(node=>roleOf(node)==='RootWebArea'&&node.frameId===frameId)??[];
  if(root?.nodeName!=='#document'||pageRoots.length!==1||
     pageRoots[0].backendDOMNodeId!==root.backendNodeId)
    throw Error('TOP_DOCUMENT_AX_ROOT_UNVERIFIED');

  const byId=new Map();
  for(const node of nodes){
    const previous=byId.get(node.nodeId);
    if(previous){
      // Chrome may emit the same anonymous inline text run twice. It is never
      // an actionable node. Any conflicting or DOM-bound duplicate is suspect.
      if(!node.backendDOMNodeId&&roleOf(node)==='InlineTextBox'&&
         JSON.stringify(previous)===JSON.stringify(node))continue;
      throw Error('ACCESSIBILITY_NODE_ID_AMBIGUOUS');
    }
    byId.set(node.nodeId,node);
  }
  const retained=[],seen=new Set();
  // Begin at the verified top root. Chromium can expose CSS pseudo-elements
  // and iframe hosts in that tree. Their subtrees are irrelevant to mailbox UI.
  const visit=node=>{
    if(!node)throw Error('ACCESSIBILITY_TREE_INCOMPLETE');
    if(seen.has(node.nodeId))throw Error('ACCESSIBILITY_TREE_CYCLE');
    seen.add(node.nodeId);
    if(node.frameId&&node.frameId!==frameId)throw Error('AX_NODE_OUTSIDE_TOP_DOCUMENT');
    const meta=node.backendDOMNodeId?dom.get(node.backendDOMNodeId):undefined;
    if(node.backendDOMNodeId&&!meta)throw Error('AX_NODE_OUTSIDE_TOP_DOCUMENT');
    if(meta?.pseudo||embeddedDocuments.has(meta?.nodeName)){
      retained.push({...node,ignored:true,backendDOMNodeId:undefined,childIds:[]});
      return;
    }
    // Chrome's generated text runs do not always have DOM IDs. The verified
    // root scopes their visibility; absence of a backend ID makes them read-only.
    if(!node.ignored&&!meta&&!['InlineTextBox','StaticText'].includes(roleOf(node)))
      throw Error('AX_NODE_WITHOUT_TOP_DOCUMENT_BINDING');
    retained.push(node);
    for(const id of node.childIds??[])visit(byId.get(id));
  };
  visit(pageRoots[0]);
  return retained;
}

function fullValue(node, meta) {
  if (meta.attributes?.type?.toLowerCase() === 'password') return '';
  const text = meta.fullValue ?? valueOf(node.value);
  if (/\n\t+\d+ /u.test(String(text))) throw Error('SNAPSHOT_VALUE_STRUCTURE_AMBIGUOUS');
  return String(text ?? '');
}

/** Pure conversion. Every ID, name and value comes from the supplied browser
 * tree. Virtual text lines only expand an existing accessible label/text node. */
export function serializeAXSnapshot({nodes,domByBackend=new Map(),startIndex=1}) {
  if (!Array.isArray(nodes) || !nodes.length) throw Error('ACCESSIBILITY_TREE_EMPTY');
  if (!Number.isSafeInteger(startIndex) || startIndex < 1) throw Error('INVALID_SNAPSHOT_INDEX');
  const byId = new Map(nodes.map(node => [node.nodeId,node]));
  if (byId.size !== nodes.length) throw Error('ACCESSIBILITY_NODE_ID_AMBIGUOUS');
  const childIds = new Set(nodes.flatMap(node => node.childIds ?? []));
  const roots = nodes.filter(node => !childIds.has(node.nodeId));
  const refs = new Map(), lines=[],visited=new Set();
  let nextIndex=startIndex;
  const emit=(text,ref,depth)=>{
    if (!Number.isSafeInteger(nextIndex)) throw Error('SNAPSHOT_INDEX_EXHAUSTED');
    const index=nextIndex++;
    refs.set(index,ref);
    lines.push('\t'.repeat(Math.max(1,depth)) + index + ' ' + text);
  };
  const visit=(node,depth=1)=>{
    if (visited.has(node.nodeId)) throw Error('ACCESSIBILITY_TREE_CYCLE');
    visited.add(node.nodeId);
    const meta=domByBackend.get(node.backendDOMNodeId) ?? {attributes:{}};
    const attr=meta.attributes ?? {}, prop=propertiesOf(node);
    const role=roleOf(node),name=oneLine(valueOf(node.name));
    const description=oneLine(valueOf(node.description));
    const domId=exactId(attr.id);
    const disabled=prop.disabled===true||attr.disabled!==undefined||attr['aria-disabled']==='true';
    const readOnly=prop.readonly===true||attr.readonly!==undefined||attr['aria-readonly']==='true';
    const kind=editorKind(node,meta),editable=kind!==null;
    const rawValue=fullValue(node,meta);
    const rich=kind==='rich';
    const ref={backendNodeId:node.backendDOMNodeId,axNodeId:node.nodeId,role,name,description,domId,disabled,
      editable:!readOnly&&editable,password:attr.type?.toLowerCase()==='password'};
    let skipChildren=false;
    if (!node.ignored && role!=='InlineTextBox' && role!=='none') {
      let text='';
      const idSuffix=domId?', ID: '+domId:'';
      if(role==='RootWebArea'||role==='WebArea') text=named('AXWebArea',name);
      else if(role==='StaticText'||role==='text') {
        for (const line of String(valueOf(node.name)).split(/\r?\n/u)) if(line) emit('text '+line,ref,depth);
        skipChildren=true;
      } else if (/^\d{10,}$/u.test(domId) && /主题 .*?, (?:创建时间|投递时间|收到时间|接收时间)/u.test(name)) {
        text=(prop.selected===true?'(selected) ':'')+'Value: '+name+idSuffix;
      } else if (role==='row'||role==='treeitem') {
        text='row ('+(prop.selected===true?'selected':'selectable')+') Description: '+(description||name)+idSuffix;
      } else if (rich) {
        if(meta.fullValue===undefined)throw Error('FULL_EDITOR_VALUE_UNAVAILABLE');
        text='container Description: '+(description||name)+', Value: '+rawValue;
      } else if (role==='textbox'||role==='searchbox') {
        if (ref.password) text='text field (protected)';
        else {
          const multiline=prop.multiline===true||meta.nodeName==='TEXTAREA';
          const label=multiline?'text entry area':'text field';
          text=label+' ('+(disabled?'disabled, ':'')+(readOnly||!editable?'readonly':'settable')+')';
          if(multiline)text+=' Description: '+(description||name);
          else if(name)text+=' '+name;
          if(rawValue || multiline)text+=(name||multiline?', ':' ')+'Value: '+rawValue;
          if(!multiline && /[\r\n]|, ID:/u.test(rawValue))throw Error('SINGLE_LINE_VALUE_AMBIGUOUS');
          if(!multiline)text+=idSuffix;
        }
      } else if (role==='checkbox') {
        const checked=prop.checked;
        text='checkbox ('+(disabled?'disabled, ':'')+'settable'+(checked===true||checked===false||checked==='true'||checked==='false'?', integer':'')+') '+
          (checked===true||checked==='true'?'1':checked===false||checked==='false'?'0':'mixed');
        emit(text,ref,depth);
        if(name)emit('text '+name,{...ref,backendNodeId:null,virtual:true},depth+1);
        text='';skipChildren=true;
      } else if (emailOnly.test(name)&&['generic','listitem','option','button'].includes(role)) {
        text=name;skipChildren=true;
      } else if (role==='button') {text='button '+(disabled?'(disabled) ':'')+name;skipChildren=true;}
      else if (role==='link') {
        const href=meta.href??attr.href;
        text='link Description: '+name+(href?', Value: '+href:'')+idSuffix;skipChildren=true;
      } else if (role==='heading') text=named('heading',name)+(prop.level?', Value: '+prop.level:'')+idSuffix;
      else if (role==='toolbar') text=named('toolbar',name)+idSuffix;
      else if (role==='tab') text='tab ('+(prop.selected===true?'selected':'selectable')+') Description: '+(description||name)+idSuffix;
      else if (role==='menuitem'||role==='option') text=name+idSuffix;
      else if (role==='combobox') text='combo box ('+(prop.expanded===true?'expanded':'collapsed')+', settable) Description: '+(description||name)+idSuffix;
      else {
        text=named(role==='generic'?'container':role.toLowerCase(),name);
        if(description)text+=' Description: '+description;
        if(rawValue)text+=(description?', ':' ')+'Value: '+rawValue;
        text+=idSuffix;
      }
      if(text.trim())emit(text,ref,depth);
    }
    if(!skipChildren)for(const id of node.childIds ?? []) {
      const child=byId.get(id);if(!child)throw Error('ACCESSIBILITY_TREE_INCOMPLETE');
      visit(child,depth+1);
    }
  };
  for(const root of roots)visit(root);
  if(!lines.length)throw Error('ACCESSIBILITY_TREE_EMPTY');
  return {text:lines.join('\n'),refs,nextIndex};
}

const READ_ELEMENT = `function() {
  if(!this || !this.isConnected || this.nodeType!==1) return {connected:false};
  const password=this.tagName==='INPUT' && this.type==='password';
  const editable=this.isContentEditable || this.tagName==='TEXTAREA' || this.tagName==='INPUT';
  return {connected:true,id:this.id||'',nodeName:this.tagName,password,
    topDocument:this.ownerDocument.defaultView===globalThis.top,
    focused:this.getRootNode().activeElement===this,
    inputType:this.tagName==='INPUT'?this.type:undefined,
    fullValue:password?undefined:(editable?(typeof this.value==='string'?this.value:this.innerText):undefined),
    href:this.tagName==='A'?this.href:undefined};
}`;
const READ_POINT = `function() {
  if(!this || !this.isConnected || this.nodeType!==1) return {connected:false};
  const r=this.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
  const hit=this.ownerDocument.elementFromPoint(x,y);
  return {connected:true,id:this.id||'',x,y,width:r.width,height:r.height,
    topDocument:this.ownerDocument.defaultView===globalThis.top,
    visible:r.width>0&&r.height>0,unobscured:hit===this||this.contains(hit)};
}`;
const keys={
  Space:{key:' ',code:'Space',windowsVirtualKeyCode:32,text:' '},
  Return:{key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'},
  Enter:{key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'},
  Escape:{key:'Escape',code:'Escape',windowsVirtualKeyCode:27},
  Tab:{key:'Tab',code:'Tab',windowsVirtualKeyCode:9},
  Backspace:{key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8},
  Delete:{key:'Delete',code:'Delete',windowsVirtualKeyCode:46},
  ArrowLeft:{key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37},
  ArrowUp:{key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38},
  ArrowRight:{key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39},
  ArrowDown:{key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40}
};

export async function createChromiumTab({page,identityCheck,mutationGuard=null,frameScope='strict'}={}) {
  if(!['strict','top-document'].includes(frameScope))throw Error('INVALID_FRAME_SCOPE');
  const topDocumentOnly=frameScope==='top-document';
  if(!page?.context || typeof page.context().newCDPSession!=='function')throw Error('EXPLICIT_PLAYWRIGHT_PAGE_REQUIRED');
  if(typeof identityCheck!=='function')throw Error('BROWSER_IDENTITY_CHECK_REQUIRED');
  if(mutationGuard!==null&&typeof mutationGuard!=='function')throw Error('SYNCHRONOUS_MUTATION_GUARD_REQUIRED');
  const client=await page.context().newCDPSession(page);
  let refs=new Map(),nextIndex=1,epoch=0,closed=false,busy=false,guard=mutationGuard;
  let snapshotFrame;
  const invalidate=()=>{epoch++;refs=new Map();snapshotFrame=undefined;};
  const navigation=frame=>{if(!page.mainFrame||frame===page.mainFrame())invalidate();};
  page.on?.('framenavigated',navigation);
  page.on?.('close',invalidate);
  client.on?.('DOM.documentUpdated',invalidate);
  await client.send('DOM.enable');
  await client.send('Accessibility.enable');
  const ensureOpen=()=>{if(closed||page.isClosed?.())throw Error('BROWSER_TAB_CLOSED');};
  const checkIdentity=async()=>{
    ensureOpen();
    if(!identityOK(await identityCheck()))throw Error('BROWSER_IDENTITY_CHANGED');
    if(!topDocumentOnly&&(page.frames?.()??[]).length>1)throw Error('UNVERIFIED_FRAME_TREE');
  };
  const topFrame=async()=>{
    const {frameTree}=await client.send('Page.getFrameTree');
    const frame=frameTree?.frame;
    if(!frame?.id||!frame.loaderId||frame.parentId)throw Error('TOP_DOCUMENT_IDENTITY_UNVERIFIED');
    return {id:frame.id,loaderId:frame.loaderId};
  };
  const sameFrame=(a,b)=>!!a&&a.id===b.id&&a.loaderId===b.loaderId;
  const checkSnapshotScope=async(index,ref)=>{
    if(!topDocumentOnly)return;
    const at=epoch, expected=snapshotFrame;
    if(!expected||!sameFrame(expected,await topFrame())){
      invalidate();throw Error('TOP_DOCUMENT_CHANGED_SINCE_SNAPSHOT');
    }
    if(at!==epoch||refs.get(index)!==ref)throw Error('STALE_SNAPSHOT_REFERENCE');
  };
  const exclusive=async(fn)=>{
    ensureOpen();if(busy)throw Error('BROWSER_TAB_OPERATION_IN_PROGRESS');busy=true;
    try{return await fn();}finally{busy=false;}
  };
  const requireGuard=()=>{if(typeof guard!=='function')throw Error('MUTATION_GUARD_REQUIRED');};
  const invokeGuard=context=>{
    requireGuard();const result=guard(context);
    if(result?.then){Promise.resolve(result).catch(()=>{});throw Error('MUTATION_GUARD_MUST_BE_SYNCHRONOUS');}
    if(result===false)throw Error('BROWSER_MUTATION_NOT_AUTHORIZED');
  };
  const refFor=index=>{
    if(!Number.isSafeInteger(index)||!refs.has(index))throw Error('STALE_SNAPSHOT_REFERENCE');
    const ref=refs.get(index);
    if(!ref.backendNodeId||ref.virtual)throw Error('CONTROL_HAS_NO_DOM_TARGET');
    if(ref.disabled)throw Error('CONTROL_DISABLED');
    if(ref.password)throw Error('PROTECTED_INPUT_UNSUPPORTED');
    return ref;
  };
  const remoteRead=async(backendNodeId,functionDeclaration,executionContextId)=>{
    const resolved=await client.send('DOM.resolveNode',executionContextId===undefined?{backendNodeId}:{backendNodeId,executionContextId});
    const objectId=resolved.object?.objectId;
    if(!objectId)throw Error('CONTROL_DOM_TARGET_MISSING');
    try{
      const result=await client.send('Runtime.callFunctionOn',{objectId,functionDeclaration,returnByValue:true});
      if(result.exceptionDetails||result.result?.subtype==='error')throw Error('DOM_READ_FAILED');
      return result.result?.value;
    }finally{await client.send('Runtime.releaseObject',{objectId}).catch(()=>{});}
  };
  const currentRef=async(index)=>{
    const ref=refFor(index),at=epoch;
    if(topDocumentOnly){await checkIdentity();await checkSnapshotScope(index,ref);}
    const {nodes}=await client.send('Accessibility.getPartialAXTree',{backendNodeId:ref.backendNodeId,fetchRelatives:false});
    const node=nodes?.find(n=>n.nodeId===ref.axNodeId&&!n.ignored)??nodes?.find(n=>n.backendDOMNodeId===ref.backendNodeId&&!n.ignored&&roleOf(n)===ref.role);
    if(!node||roleOf(node)!==ref.role||oneLine(valueOf(node.name))!==ref.name||oneLine(valueOf(node.description))!==ref.description||propertiesOf(node).disabled===true)throw Error('CONTROL_CHANGED_SINCE_SNAPSHOT');
    const meta=await remoteRead(ref.backendNodeId,READ_ELEMENT);
    if(!meta?.connected||String(meta.id??'')!==ref.domId||meta.password)throw Error('CONTROL_CHANGED_SINCE_SNAPSHOT');
    if(topDocumentOnly&&(!meta.topDocument||embeddedDocuments.has(meta.nodeName)||
       (node.frameId&&node.frameId!==snapshotFrame?.id)))throw Error('CONTROL_OUTSIDE_TOP_DOCUMENT');
    if(at!==epoch||refs.get(index)!==ref)throw Error('STALE_SNAPSHOT_REFERENCE');
    return ref;
  };
  const verifyFocusedTarget=async(index,ref,{nativeCheckbox=false}={})=>{
    if(!topDocumentOnly)return;
    await checkSnapshotScope(index,ref);
    const live=await remoteRead(ref.backendNodeId,READ_ELEMENT);
    if(!live?.connected||!live.topDocument||!live.focused||live.password||String(live.id??'')!==ref.domId)
      throw Error('TOP_DOCUMENT_INPUT_FOCUS_UNVERIFIED');
    if(nativeCheckbox&&(live.nodeName!=='INPUT'||live.inputType!=='checkbox'))throw Error('NATIVE_CHECKBOX_REQUIRED');
    if(refs.get(index)!==ref)throw Error('STALE_SNAPSHOT_REFERENCE');
  };
  const contextFor=(kind,index,ref)=>({kind,index,role:ref.role,name:ref.name,description:ref.description});
  const keyStroke=async(key,index,ref,modifiers=0)=>{
    const context=contextFor('pressKey',index,ref);
    invokeGuard(context);
    await client.send('Input.dispatchKeyEvent',{type:'keyDown',...key,modifiers});
    await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:key.key,code:key.code,windowsVirtualKeyCode:key.windowsVirtualKeyCode,modifiers});
  };
  const readComposeFrame=async(editorHostId)=>{
    if(!topDocumentOnly||!composeHostId.test(editorHostId??''))throw Error('COMPOSE_FRAME_SCOPE_REQUIRED');
    await checkIdentity();
    const at=epoch,expectedTop=snapshotFrame;
    if(!expectedTop)throw Error('COMPOSE_FRAME_FRESH_SNAPSHOT_REQUIRED');
    const [{frameTree},{root}]=await Promise.all([
      client.send('Page.getFrameTree'),client.send('DOM.getDocument',{depth:-1,pierce:true})
    ]);
    const top={...frameTree?.frame,url:page.url?.()};
    if(!sameFrame(expectedTop,top)||at!==epoch)throw Error('COMPOSE_FRAME_TOP_CHANGED');
    const hosts=[],visit=node=>{
      if(!node)return;
      const attributes=attrObject(node.attributes);
      if(composeHostId.test(attributes.id??''))hosts.push(node);
      for(const child of [...(node.children??[]),...(node.shadowRoots??[])])visit(child);
    };
    visit(root);
    if(hosts.length!==1||attrObject(hosts[0].attributes).id!==editorHostId)throw Error('COMPOSE_FRAME_HOST_AMBIGUOUS');
    const owners=[],visitOwner=node=>{
      if(!node)return;
      if(embeddedDocuments.has(node.nodeName)){owners.push(node);return;}
      for(const child of [...(node.children??[]),...(node.shadowRoots??[])])visitOwner(child);
    };
    visitOwner(hosts[0]);
    if(owners.length!==1||owners[0].nodeName!=='IFRAME')throw Error('COMPOSE_FRAME_OWNER_AMBIGUOUS');
    const ownerBackendNodeId=owners[0].backendNodeId;
    const matching=[];
    for(const child of frameTree?.childFrames??[]){
      if(child.frame?.url!=='about:srcdoc')continue;
      const owner=await client.send('DOM.getFrameOwner',{frameId:child.frame.id});
      if(owner.backendNodeId===ownerBackendNodeId)matching.push(child.frame);
    }
    if(matching.length!==1)throw Error('COMPOSE_FRAME_BINDING_AMBIGUOUS');
    const frame=matching[0];
    verifyComposeFrameMetadata(top,frame,composeFrameTopOrigin(top));
    const world=await client.send('Page.createIsolatedWorld',{frameId:top.id,worldName:'prospectdesk-read-only-compose-editor'});
    if(!Number.isSafeInteger(world.executionContextId)||world.executionContextId<=0)throw Error('COMPOSE_FRAME_CONTEXT_UNVERIFIED');
    const contextId=world.executionContextId;
    const owner=await remoteRead(ownerBackendNodeId,READ_COMPOSE_FRAME_OWNER,contextId);
    const binding=validateComposeFrameBinding({top,frame,owner,hostId:editorHostId,ownerBackendNodeId});
    const readBody=async()=>{
      const read=await remoteRead(ownerBackendNodeId,READ_COMPOSE_FRAME_BODY,contextId);
      validateComposeFrameBinding({top,frame,owner:read?.owner,hostId:editorHostId,ownerBackendNodeId});
      const value=read.body;
      if(typeof value?.html!=='string'||value.html.length>200000||typeof value.innerText!=='string'
        ||typeof value.textContent!=='string'||!value.innerText.trim())throw Error('COMPOSE_FRAME_BODY_UNVERIFIED');
      return value;
    };
    const body=await readBody();
    if(JSON.stringify(body)!==JSON.stringify(await readBody()))throw Error('COMPOSE_FRAME_BODY_CHANGED_DURING_READ');
    const afterTree=(await client.send('Page.getFrameTree')).frameTree;
    const afterTop={...afterTree?.frame,url:page.url?.()};
    const afterFrame=(afterTree?.childFrames??[]).find(child=>child.frame?.id===frame.id)?.frame;
    const afterOwnerId=(await client.send('DOM.getFrameOwner',{frameId:frame.id})).backendNodeId;
    if(afterOwnerId!==ownerBackendNodeId)throw Error('COMPOSE_FRAME_CHANGED_DURING_READ');
    const afterOwner=await remoteRead(afterOwnerId,READ_COMPOSE_FRAME_OWNER,contextId);
    const afterBinding=validateComposeFrameBinding({top:afterTop,frame:afterFrame,owner:afterOwner,
      hostId:editorHostId,ownerBackendNodeId:afterOwnerId});
    if(JSON.stringify(binding)!==JSON.stringify(afterBinding)||at!==epoch)throw Error('COMPOSE_FRAME_CHANGED_DURING_READ');
    await checkIdentity();
    if(at!==epoch||!sameFrame(expectedTop,await topFrame()))throw Error('COMPOSE_FRAME_TOP_CHANGED');
    return {source:verifiedFrameSource,editorHostId,binding,
      snapshot:{html:body.html,innerText:body.innerText,textContent:body.textContent}};
  };
  return {
    transport:'playwright-cdp',
    frameScope,
    async readVerifiedComposeFrame({editorHostId}={}) {
      return await exclusive(()=>readComposeFrame(editorHostId));
    },
    setMutationGuard(fn){if(fn!==null&&typeof fn!=='function')throw Error('SYNCHRONOUS_MUTATION_GUARD_REQUIRED');guard=fn;},
    async getAXState(){
      return await exclusive(async()=>{
        // DOM.documentUpdated can arrive just after navigation. Retry only this
        // explicit read race; inputs and every other error remain single-attempt.
        for(let attempt=0;attempt<3;attempt++){
          try{
        refs=new Map();snapshotFrame=undefined;await checkIdentity();const at=epoch;
        const frame=topDocumentOnly?await topFrame():undefined;
        const [{nodes},{root}]=await Promise.all([
          client.send('Accessibility.getFullAXTree',frame?{frameId:frame.id}:{}),
          client.send('DOM.getDocument',{depth:-1,pierce:true})
        ]);
        if(at!==epoch)throw Error('DOCUMENT_CHANGED_DURING_SNAPSHOT');
        const dom=indexDOMTree(root,{frameScope});
        const scoped=frame?scopeTopDocument(nodes,root,dom,frame.id):nodes;
        for(const node of scoped??[]) {
          if(node.ignored||!node.backendDOMNodeId)continue;
          let meta=dom.get(node.backendDOMNodeId);
          if(!meta) {
            const described=await client.send('DOM.describeNode',{backendNodeId:node.backendDOMNodeId,depth:0});
            meta=indexDOMTree(described.node).get(node.backendDOMNodeId);if(!meta)throw Error('DOM_TREE_INCOMPLETE');
            dom.set(node.backendDOMNodeId,meta);
          }
          const role=roleOf(node),props=propertiesOf(node),attr=meta.attributes;
          const needsValue=editorKind(node,meta)!==null;
          if(needsValue&&attr.type?.toLowerCase()!=='password') {
            const live=await remoteRead(node.backendDOMNodeId,READ_ELEMENT);
            if(!live?.connected)throw Error('EDITOR_DOM_CHANGED:'+role+':'+meta.nodeName);
            if(topDocumentOnly&&!live.topDocument)throw Error('EDITOR_OUTSIDE_TOP_DOCUMENT');
            Object.assign(meta,live);
          }
        }
        if(frame&&!sameFrame(frame,await topFrame()))throw Error('DOCUMENT_CHANGED_DURING_SNAPSHOT');
        if(at!==epoch)throw Error('DOCUMENT_CHANGED_DURING_SNAPSHOT');
        const result=serializeAXSnapshot({nodes:scoped,domByBackend:dom,startIndex:nextIndex});
        refs=result.refs;nextIndex=result.nextIndex;snapshotFrame=frame;return result.text;
          }catch(error){
            if(error?.message!=='DOCUMENT_CHANGED_DURING_SNAPSHOT'||attempt===2)throw error;
            await new Promise(resolve=>setTimeout(resolve,50));
          }
        }
      });
    },
    async click(index,options={}) {
      return await exclusive(async()=>{
        requireGuard();
        const mouseButton=options.mouseButton??options.button??'left';
        if(!['left','right'].includes(mouseButton))throw Error('UNSUPPORTED_MOUSE_BUTTON');
        const ref=await currentRef(index),at=epoch;
        await client.send('DOM.scrollIntoViewIfNeeded',{backendNodeId:ref.backendNodeId});
        const point=await remoteRead(ref.backendNodeId,READ_POINT);
        if(!point?.connected||!point.visible||!point.unobscured||String(point.id??'')!==ref.domId)throw Error('CONTROL_NOT_CLICKABLE');
        if(topDocumentOnly&&!point.topDocument)throw Error('CONTROL_OUTSIDE_TOP_DOCUMENT');
        if(topDocumentOnly)await checkSnapshotScope(index,ref);
        if(at!==epoch||refs.get(index)!==ref)throw Error('STALE_SNAPSHOT_REFERENCE');
        // No awaited identity/read/geometry work after this final synchronous guard.
        invokeGuard(contextFor('click',index,ref));
        await client.send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:mouseButton,clickCount:1});
        await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:mouseButton,clickCount:1});
      });
    },
    async typeText(index,text) {
      return await exclusive(async()=>{
        requireGuard();if(typeof text!=='string'||text.length>1000000)throw Error('BOUNDED_TEXT_REQUIRED');
        const ref=await currentRef(index);
        if(!ref.editable)throw Error('CONTROL_NOT_EDITABLE');
        await client.send('DOM.focus',{backendNodeId:ref.backendNodeId});
        if(refs.get(index)!==ref)throw Error('STALE_SNAPSHOT_REFERENCE');
        // Select only the focused, verified input via normal keyboard events.
        if(topDocumentOnly)await verifyFocusedTarget(index,ref);
        invokeGuard(contextFor('typeText',index,ref));
        await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
        await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
        if(refs.get(index)!==ref)throw Error('STALE_SNAPSHOT_REFERENCE');
        if(topDocumentOnly)await verifyFocusedTarget(index,ref);
        invokeGuard(contextFor('typeText',index,ref));
        await client.send('Input.insertText',{text});
      });
    },
    async pressKey(index,key) {
      return await exclusive(async()=>{
        requireGuard();if(!Object.hasOwn(keys,key))throw Error('UNSUPPORTED_KEY');
        const ref=await currentRef(index);
        if(key==='Space'&&(!topDocumentOnly||ref.role!=='checkbox'))throw Error('NATIVE_CHECKBOX_REQUIRED');
        await client.send('DOM.focus',{backendNodeId:ref.backendNodeId});
        if(refs.get(index)!==ref)throw Error('STALE_SNAPSHOT_REFERENCE');
        if(topDocumentOnly)await verifyFocusedTarget(index,ref,{nativeCheckbox:key==='Space'});
        await keyStroke(keys[key],index,ref);
      });
    },
    async reload() {
      return await exclusive(async()=>{await checkIdentity();invalidate();await page.reload({waitUntil:'domcontentloaded'});invalidate();});
    },
    async close() {
      if(closed)return;closed=true;invalidate();
      page.off?.('framenavigated',navigation);page.off?.('close',invalidate);
      client.off?.('DOM.documentUpdated',invalidate);
      await client.detach();
    }
  };
}
