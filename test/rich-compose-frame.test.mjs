import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createChromiumTab,validateComposeFrameBinding} from '../src/browser-mail/chromium-tab.mjs';
import {BrowserMailAdapter,parseCompose} from '../src/browser-mail/browser-adapter.mjs';

const account='sender@example.test',recipient='buyer@example.test';
const hostId='zmComposeEditor_Cmp1';
const ref={accountId:account,draftId:'9000000000000000100',recipient,subject:'Existing customer update',attachments:false};
const top={id:'main',loaderId:'top-one',url:'https://mail.zoho.com/zm/#compose',securityOrigin:'https://mail.zoho.com'};
const frame={id:'rich',parentId:'main',loaderId:'rich-one',url:'about:srcdoc',securityOrigin:'://'};
const owner={connected:true,topDocument:true,documentOrigin:top.securityOrigin,sameOriginDocument:true,tag:'IFRAME',title:'文本编辑区域',label:'文本编辑区域',
  src:null,srcdoc:true,hostId,hostFrameCount:1,visible:true,unobscured:true,width:967,height:343};
const rawBody={ok:true,editableOwners:1,nodeName:'BODY',id:'',
  html:'<div>Hello team,<br></div><div><br></div><div>Here is the update.<br></div>',
  innerText:'Hello team,\n\n\n\nHere is the update.\n',textContent:'Hello team,Here is the update.'};
const canonicalBody='Hello team,\n\nHere is the update.';
const proof=()=>({source:'verified-zoho-compose-frame-v1',editorHostId:hostId,
  binding:validateComposeFrameBinding({top,frame,owner,hostId,ownerBackendNodeId:3}),
  snapshot:{html:rawBody.html,innerText:rawBody.innerText,textContent:rawBody.textContent}});
const richCompose=[
  '1 AXWebArea Zoho Mail ('+account+')','  2 button 发送','  3 button From '+account,
  '    4 container','    5 button 选择联系人','    6 listbox 搜索字段','      7 '+recipient,
  '    8 combo box (collapsed, settable) Description: 1被选中','    9 container',
  '    10 button 添加密件抄送的收件人','    11 container','    12 button 选择联系人',
  '    13 listbox 搜索字段','    14 combo box (collapsed, settable) Description: 已选择“无”',
  '    15 text field (settable) 主题, Value: '+ref.subject+', ID: subject',
  '    16 container','    17 text '+ref.subject,'    18 container, ID: '+hostId,
  '      19 toolbar 格式选项','        20 button 粗体（Ctrl B）','        21 text field (settable) 字体大小, Value: 10',
  '      22 button 选择文本模式','    23 tab (selected) Description: compose'
].join('\n');

function fixture(options={}){
  const client=new EventEmitter(),page=new EventEmitter(),calls=[];
  let treeReads=0,bodyReads=0,ownerReads=0;
  const element=(id,nodeName,attributes={},children=[])=>({backendNodeId:id,nodeName,
    attributes:Object.entries(attributes).flat(),children});
  const iframe=element(3,'IFRAME',{title:'文本编辑区域','aria-label':'文本编辑区域',srcdoc:'<body contenteditable="true"></body>'});
  const host=element(2,'DIV',{id:hostId},[iframe]);
  if(options.multipleOwners)host.children.push(element(4,'IFRAME'));
  const doc=element(1,'#document',{},[host]);
  const nodes=[
    {nodeId:'a1',backendDOMNodeId:1,frameId:'main',role:{value:'RootWebArea'},name:{value:'Mailbox'},childIds:['a2']},
    {nodeId:'a2',backendDOMNodeId:2,role:{value:'generic'},name:{value:''},childIds:['a3']},
    {nodeId:'a3',backendDOMNodeId:3,role:{value:'Iframe'},name:{value:'文本编辑区域'},childIds:[]}
  ];
  client.send=async(method,params={})=>{
    calls.push({method,params});
    if(method==='DOM.enable'||method==='Accessibility.enable'||method==='Runtime.releaseObject')return {};
    if(method==='Page.getFrameTree'){
      treeReads++;
      return {frameTree:{frame:{...top},childFrames:[{frame:{...frame,
        ...(options.foreign?{securityOrigin:'https://other.example'}:{}),
        ...(options.changedLoader&&treeReads>=4?{loaderId:'rich-two'}:{})}}]}};
    }
    if(method==='DOM.getDocument')return {root:doc};
    if(method==='Accessibility.getFullAXTree')return {nodes};
    if(method==='DOM.getFrameOwner')return {backendNodeId:options.changedOwner&&treeReads>=4?4:3};
    if(method==='DOM.resolveNode'){
      assert.equal(params.backendNodeId,3);assert.equal(params.executionContextId,17);
      return {object:{objectId:'node:'+params.backendNodeId}};
    }
    if(method==='Runtime.callFunctionOn'){
      assert.match(params.functionDeclaration,/contentDocument/);
      const liveOwner={...owner,...(options.hidden?{visible:false}:{}),
        ...(options.unrelated?{hostId:'other-host'}:{}),
        ...(options.opaque?{sameOriginDocument:false}:{})};
      if(params.functionDeclaration.startsWith('function readComposeFrameBody(')){
        bodyReads++;
        return {result:{value:{owner:liveOwner,body:options.multipleEditors?undefined:
          {...rawBody,...(options.changedBody&&bodyReads>1?{innerText:rawBody.innerText+'changed'}:{})}}}};
      }
      ownerReads++;
      return {result:{value:liveOwner}};
    }
    if(method==='Page.createIsolatedWorld'){
      assert.equal(params.frameId,'main');assert.equal(params.grantUniveralAccess,undefined);
      return {executionContextId:17};
    }
    throw Error('UNEXPECTED_CDP_METHOD:'+method);
  };
  client.detach=async()=>{};page.context=()=>({newCDPSession:async()=>client});
  page.url=()=>top.url;page.isClosed=()=>false;page.mainFrame=()=>page;
  return {page,calls,get bodyReads(){return bodyReads;},get ownerReads(){return ownerReads;}};
}
async function open(options={}){
  const f=fixture(options),tab=await createChromiumTab({page:f.page,identityCheck:async()=>({ok:true}),frameScope:'top-document'});
  await tab.getAXState();return {page:f.page,calls:f.calls,tab,
    get bodyReads(){return f.bodyReads;},get ownerReads(){return f.ownerReads;}};
}

test('verified visible srcdoc editor is read without granting frame mutation access',async()=>{
  const f=await open();try{
    const result=await f.tab.readVerifiedComposeFrame({editorHostId:hostId});
    assert.deepEqual(result,proof());assert.equal(f.bodyReads,2);assert.equal(f.ownerReads,2);
    assert.equal(f.calls.some(c=>/^Input\.|Network|Storage|Fetch/i.test(c.method)),false);
    const snapshot=await f.tab.getAXState();assert.equal(snapshot.includes('Hello team'),false);
  }finally{await f.tab.close();}
});
test('unverified, hidden, unrelated, duplicate and foreign editor frames are rejected before body read',async()=>{
  for(const options of [{hidden:true},{unrelated:true},{multipleOwners:true},{opaque:true},{foreign:true}]){
    const f=await open(options);try{
      await assert.rejects(()=>f.tab.readVerifiedComposeFrame({editorHostId:hostId}),/COMPOSE_FRAME_/);
      assert.equal(f.bodyReads,0);
    }finally{await f.tab.close();}
  }
});
test('owner, loader, contenteditable count and body changes are not accepted as a stable proof',async()=>{
  for(const options of [{changedOwner:true},{changedLoader:true},{multipleEditors:true},{changedBody:true}]){
    const f=await open(options);try{
      await assert.rejects(()=>f.tab.readVerifiedComposeFrame({editorHostId:hostId}),/COMPOSE_FRAME_/);
    }finally{await f.tab.close();}
  }
});
test('frame read requires a current top-document snapshot and exact editor host',async()=>{
  const f=fixture(),tab=await createChromiumTab({page:f.page,identityCheck:async()=>true,frameScope:'top-document'});
  try{
    await assert.rejects(()=>tab.readVerifiedComposeFrame({editorHostId:hostId}),/FRESH_SNAPSHOT_REQUIRED/);
    await tab.getAXState();
    await assert.rejects(()=>tab.readVerifiedComposeFrame({editorHostId:'other'}),/SCOPE_REQUIRED/);
    await assert.rejects(()=>tab.readVerifiedComposeFrame({editorHostId:'zmComposeEditor_Cmp2'}),/HOST_AMBIGUOUS/);
  }finally{await tab.close();}
});
test('frame origin proof excludes remote, unlabelled, obscured and non-compose owners',()=>{
  assert.deepEqual(proof().binding,validateComposeFrameBinding({top,frame:{...frame,securityOrigin:top.securityOrigin},owner,hostId,ownerBackendNodeId:3}));
  for(const change of [
    {owner:{...owner,sameOriginDocument:false}},{owner:{...owner,documentOrigin:'https://other.example'}},
    {frame:{...frame,securityOrigin:'null'}},
    {top:{...top,url:'https://other.example/#compose'}},
    {frame:{...frame,url:'https://mail.zoho.com/remote'}},
    {frame:{...frame,parentId:'unrelated'}},
    {owner:{...owner,title:'other'}},{owner:{...owner,label:null}},
    {owner:{...owner,unobscured:false}},{owner:{...owner,src:'https://mail.zoho.com/editor'}}
  ])assert.throws(()=>validateComposeFrameBinding({top,frame,owner,hostId,ownerBackendNodeId:3,...change}),/COMPOSE_FRAME_/);
});
test('bound frame body uses complete canonical text and keeps strict account/header checks',()=>{
  const parsed=parseCompose(richCompose,account,ref,{verifiedFrame:proof()});
  assert.equal(parsed.body,canonicalBody);assert.equal(parsed.recipient,recipient);assert.equal(parsed.approvedHash.length,64);
  assert.equal(parsed.bodySource,'verified-zoho-compose-frame-v1');
  assert.equal(parsed.bodyEvidence.axTextComparison,'not_applicable_frame_bound_dom');
  for(const state of [
    richCompose.replace('已选择“无”','1被选中'),
    richCompose.replace('button 添加密件抄送的收件人','listbox 搜索字段'),
    richCompose.replace('    16 container','    16 listbox 搜索字段\n    30 extra@example.test'),
    richCompose.replace('From '+account,'From other@example.test'),
    richCompose.replace('Value: '+ref.subject,'Value: Changed'),
    richCompose+'\n  99 button 发送',
    richCompose+'\n  98 container Description: 富文本编辑区域, Value: Unrelated body'
  ])assert.throws(()=>parseCompose(state,account,ref,{verifiedFrame:proof()}),/RECIPIENT|ACCOUNT|SUBJECT|SEND_CONTROL|EDITOR_AMBIGUOUS/);
  assert.throws(()=>parseCompose(richCompose,account,{...ref,attachments:true},{verifiedFrame:proof()}),/ATTACHMENT/);
});
test('rich iframe without proof or with mismatched host cannot be reconstructed from toolbar text',()=>{
  assert.throws(()=>parseCompose(richCompose,account,ref),/COMPOSE_EDITOR_AMBIGUOUS/);
  assert.throws(()=>parseCompose(richCompose,account,ref,{verifiedFrame:{...proof(),editorHostId:'zmComposeEditor_Cmp2'}}),/FRAME_PROOF_REQUIRED/);
});
test('address blocks appended after a rich editor host cannot hide outside header verification',()=>{
  for(const suffix of [
    '\n    90 listbox 搜索字段\n    91 extra@example.test\n    92 combo box (collapsed, settable) Description: 1被选中',
    '\n    90 button 选择联系人',
    '\n    90 button 添加密件抄送的收件人',
    '\n    90 text field (settable) Cc, Value: extra@example.test',
    '\n    90 text field (settable) Bcc, Value: extra@example.test',
    '\n    90 text field (settable) Value: extra@example.test',
    '\n    90 text field (settable)',
    '\n    90 combo box (collapsed, settable) Description: 添加联系人',
    '\n    90 text field (settable) 字体大小, Value: 10',
    '\n    90 toolbar 格式选项\n      91 text field (settable) 字体大小, Value: ex@extra.test',
    '\n    90 button From '+account,
    '\n    90 text field (settable) 主题, Value: '+ref.subject
  ])assert.throws(()=>parseCompose(richCompose+suffix,account,ref,{verifiedFrame:proof()}),/RECIPIENT_LAYOUT_UNVERIFIED/);
});
test('rich frame links must expose their actual target and complete DOM text',()=>{
  const bad=proof();bad.snapshot={html:'<div><a href="https://wrong.example">https://shown.example</a><br></div>',
    innerText:'https://shown.example',textContent:'https://shown.example'};
  assert.throws(()=>parseCompose(richCompose,account,ref,{verifiedFrame:bad}),/VISIBLE_BODY_LINK_TARGET_MISMATCH/);
  const changed=proof();changed.snapshot.textContent+='Hidden';
  assert.throws(()=>parseCompose(richCompose,account,ref,{verifiedFrame:changed}),/VISIBLE_BODY_TEXT_MISMATCH/);
});
test('adapter re-reads the verified rich body at final pacing guard and stops on any change',async()=>{
  let reads=0,clicks=0;
  const tab={async readVerifiedComposeFrame(){reads++;const result=proof();if(reads>=3){
    result.snapshot={html:'<div>Changed<br></div>',innerText:'Changed',textContent:'Changed'};
  }return result;},async click(){clicks++;}};
  const a=new BrowserMailAdapter({tab,accountId:account});
  const item=await a.parseComposeSnapshot(richCompose,ref);
  a.inspectDraft=()=>a.parseComposeSnapshot(richCompose,ref);a.snapshot=async()=>richCompose;
  await assert.rejects(()=>a.send(item,{beforeClick:async({revalidate})=>revalidate()}),/CONTENT_CHANGED_DURING_PACING_WAIT/);
  assert.equal(clicks,0);assert.equal(reads,3);
});
test('adapter frame readiness still requires the unique Send and exact host; read failures do not send',async()=>{
  let reads=0;
  const a=new BrowserMailAdapter({accountId:account,tab:{async click(){},async readVerifiedComposeFrame(){reads++;return proof();}}});
  a.findDraft=async()=>({...ref,index:7});
  a.waitFor=async predicate=>{assert.equal(predicate(richCompose),true);
    assert.equal(predicate(richCompose.replace('button 发送','button disabled')),false);return richCompose;};
  assert.equal((await a.inspectDraft(ref)).body,canonicalBody);assert.equal(reads,1);
});
