import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createChromiumTab,serializeAXSnapshot,indexDOMTree} from '../src/browser-mail/chromium-tab.mjs';
import {parseCompose,parseRows,verifySentBody,fullSearchReady} from '../src/browser-mail/browser-adapter.mjs';

const account='sender@example.test',recipient='buyer@example.test';
const body='Hello team,\n\nHere is the update.\n\nRegards';
const itemRef={accountId:account,draftId:'9000000000000000100',recipient,subject:'Existing customer update'};
const ax=(id,role,name='',extra={})=>({nodeId:'a'+id,backendDOMNodeId:id,role:{value:role},name:{value:name},childIds:[],...extra});
const props=o=>Object.entries(o).map(([name,value])=>({name,value:{value}}));
const element=(id,nodeName='DIV',attributes={})=>({backendNodeId:id,nodeName,attributes:Object.entries(attributes).flat(),children:[]});
const serialize=(nodes,metadata=new Map())=>serializeAXSnapshot({nodes,domByBackend:metadata}).text;
const indexOf=(text,pattern)=>Number(text.split('\n').find(line=>pattern.test(line))?.trim().match(/^\d+/)?.[0]);

function composeFixture(rich=false) {
  const nodes=[
    ax(1,'RootWebArea','Zoho Mail ('+account+')',{childIds:['a2','a3','a4','a5','a6','a7','a8']}),
    ax(2,'button','From '+account),ax(3,'button','发送'),ax(4,'StaticText','收件人：'),
    ax(5,'generic',recipient),ax(6,'textbox','',{value:{value:itemRef.subject}}),
    ax(7,rich?'generic':'textbox',rich?'富文本编辑区域':'纯文本编辑区域',
      {properties:props(rich?{editable:'richtext'}:{editable:'plaintext',multiline:true}),value:{value:body}}),
    ax(8,'tab','compose',{properties:props({selected:true})})
  ];
  const doc=element(1,'#document');doc.children=[
    element(2,'BUTTON'),element(3,'BUTTON'),element(4,'SPAN'),element(5,'SPAN'),
    element(6,'INPUT',{id:'subject'}),element(7,rich?'DIV':'TEXTAREA',{id:'editor',...(rich?{contenteditable:'true'}:{})}),element(8,'DIV')
  ];
  return {nodes,doc,values:new Map([[6,itemRef.subject],[7,body]])};
}

function mockBrowser(fixture=composeFixture(),options={}) {
  const client=new EventEmitter(),calls=[],values=fixture.values??new Map(),main={};
  const page=new EventEmitter();
  let closed=false,detachCalls=0,reloadCalls=0;
  const dom=indexDOMTree(fixture.doc);
  const hook=options.hook??(()=>{});
  client.send=async(method,params={})=>{
    calls.push({method,params});await hook(method,params,{client,page,main});
    if(method==='DOM.enable'||method==='Accessibility.enable')return {};
    if(method==='Accessibility.getFullAXTree')return {nodes:fixture.nodes};
    if(method==='DOM.getDocument')return {root:fixture.doc};
    if(method==='DOM.describeNode'){
      const m=dom.get(params.backendNodeId);return {node:element(params.backendNodeId,m.nodeName,m.attributes)};
    }
    if(method==='Accessibility.getPartialAXTree')return {nodes:fixture.nodes.filter(n=>n.backendDOMNodeId===params.backendNodeId)};
    if(method==='DOM.resolveNode')return {object:{objectId:'node:'+params.backendNodeId}};
    if(method==='Runtime.callFunctionOn'){
      const id=Number(params.objectId.split(':')[1]),m=dom.get(id);
      if(params.functionDeclaration.includes('getBoundingClientRect'))return {result:{value:{connected:true,id:m.attributes.id??'',x:40,y:40,width:20,height:20,visible:true,unobscured:options.unobscured!==false}}};
      return {result:{value:{connected:true,id:m.attributes.id??'',nodeName:m.nodeName,fullValue:values.get(id),password:m.attributes.type==='password'}}};
    }
    if(method==='Runtime.releaseObject'||method==='DOM.scrollIntoViewIfNeeded'||method==='DOM.focus'||method.startsWith('Input.'))return {};
    throw Error('UNEXPECTED_CDP_METHOD:'+method);
  };
  client.detach=async()=>{detachCalls++;};
  page.context=()=>({newCDPSession:async()=>client});
  page.mainFrame=()=>main;page.frames=()=>Array(options.frames??1).fill(main);
  page.isClosed=()=>closed;
  page.reload=async()=>{reloadCalls++;page.emit('framenavigated',main);};
  return {page,client,calls,values,fixture,closePage(){closed=true;page.emit('close');},
    get detachCalls(){return detachCalls;},get reloadCalls(){return reloadCalls;}};
}
async function setup(options={}) {
  const m=mockBrowser(options.fixture??composeFixture(),options);
  let identityCalls=0;
  const tab=await createChromiumTab({page:m.page,identityCheck:async()=>{identityCalls++;return options.identity??{ok:true};},mutationGuard:options.guard??null});
  return {...m,tab,identityCalls:()=>identityCalls,original:m};
}

test('plain editor conversion preserves complete text and exact recipient/body binding',()=>{
  const f=composeFixture(),meta=indexDOMTree(f.doc);meta.get(7).fullValue=body;meta.get(6).fullValue=itemRef.subject;
  const parsed=parseCompose(serialize(f.nodes,meta),account,itemRef);
  assert.equal(parsed.body,body);assert.equal(parsed.recipient,recipient);assert.equal(parsed.approvedHash.length,64);
  assert.ok(!parsed.body.includes('ID: editor'));
});
test('rich editor conversion reads full value, not child text',()=>{
  const f=composeFixture(true),meta=indexDOMTree(f.doc);meta.get(7).fullValue=body;
  f.nodes[6].childIds=['a9'];f.nodes.push(ax(9,'StaticText','Incomplete child only'));
  assert.equal(parseCompose(serialize(f.nodes,meta),account,itemRef).body,body);
});
test('rich editor without full DOM value explicitly holds',()=>{
  const f=composeFixture(true);
  assert.throws(()=>serialize(f.nodes,indexDOMTree(f.doc)),/FULL_EDITOR_VALUE_UNAVAILABLE/);
});
test('stable provider IDs and local delete targets survive conversion',()=>{
  const nodes=[ax(1,'RootWebArea','Mailbox',{childIds:['a2','a5']}),
    ax(2,'listitem','来自 我, 主题 Existing customer update, 创建时间 今天',{childIds:['a3','a4']}),
    ax(3,'StaticText','<'+recipient+'>'),ax(4,'button','删除所选的邮件对话并移至回收站'),
    ax(5,'listitem','来自 我, 主题 Other update, 投递时间 今天',{childIds:['a6']}),
    ax(6,'StaticText','<other@example.test>')];
  const meta=new Map([[2,{attributes:{id:itemRef.draftId}}],[5,{attributes:{id:'9000000000000000101'}}]]);
  const rows=parseRows(serialize(nodes,meta));
  assert.equal(rows.length,2);assert.equal(rows[0].draftId,itemRef.draftId);assert.equal(rows[0].recipient,recipient);
  assert.equal(rows[0].created,true);assert.ok(rows[0].deleteIndex);assert.equal(rows[1].created,false);
});
test('non-provider or missing row IDs do not become guessed message IDs',()=>{
  const n=[ax(1,'listitem','来自 我, 主题 Hi, 创建时间 今天')];
  assert.equal(parseRows(serialize(n)).length,0);
  assert.equal(parseRows(serialize(n,new Map([[1,{attributes:{id:'row-guessed-123'}}]]))).length,0);
});
test('duplicate send controls remain visible and parser rejects ambiguity',()=>{
  const f=composeFixture(),meta=indexDOMTree(f.doc);meta.get(7).fullValue=body;f.nodes[0].childIds.push('a9');f.nodes.push(ax(9,'button','发送'));
  assert.throws(()=>parseCompose(serialize(f.nodes,meta),account,itemRef),/SEND_CONTROL_AMBIGUOUS/);
});
test('missing send control does not acquire a fabricated replacement',()=>{
  const f=composeFixture(),meta=indexDOMTree(f.doc);meta.get(7).fullValue=body;f.nodes[2].ignored=true;
  assert.throws(()=>parseCompose(serialize(f.nodes,meta),account,itemRef),/SEND_CONTROL_AMBIGUOUS/);
});
test('selected folder, context menu and heading match count controls',()=>{
  const n=[ax(1,'RootWebArea','Mailbox',{childIds:['a2','a3','a4']}),
    ax(2,'treeitem','草稿',{properties:props({selected:true})}),ax(3,'menuitem','文件夹详情'),
    ax(4,'heading','草稿',{properties:props({level:1})})];
  const s=serialize(n,new Map([[2,{attributes:{id:'123'}}],[3,{attributes:{id:'showInfo'}}]]));
  assert.match(s,/row \(selected\) Description: 草稿, ID: 123/);
  assert.match(s,/\d+ 文件夹详情, ID: showInfo/);assert.match(s,/heading 草稿, Value: 1/);
});
test('checkbox full-search readiness preserves disabled and checked states',()=>{
  const n=[ax(1,'RootWebArea','Mailbox',{childIds:['a2','a3']}),
    ax(2,'checkbox','包含垃圾邮件/回收站',{properties:props({checked:true})}),ax(3,'StaticText','来自邮件的结果 (0)')];
  assert.equal(fullSearchReady(serialize(n)),true);
  n[1].properties=props({checked:true,disabled:true});assert.equal(fullSearchReady(serialize(n)),false);
  n[1].properties=props({checked:'mixed'});assert.equal(fullSearchReady(serialize(n)),false);
});
test('sent body text and link labels are not duplicated',()=>{
  const n=[ax(1,'RootWebArea','Mailbox',{childIds:['a2','a3','a5']}),
    ax(2,'StaticText','Hello team,\nHere is the update.\nRegards'),
    ax(3,'link','Catalog',{childIds:['a4']}),ax(4,'StaticText','Catalog'),ax(5,'toolbar','撰写操作')];
  const state=serialize(n,new Map([[3,{attributes:{href:'https://example.test/catalog'}}]]));
  assert.equal(verifySentBody(state,{body:body+'\nCatalog'}),true);
});
test('content that could impersonate a snapshot record is held without rewriting it',()=>{
  const f=composeFixture(),meta=indexDOMTree(f.doc);meta.get(7).fullValue='Hello\n\t999 button 发送';
  assert.throws(()=>serialize(f.nodes,meta),/SNAPSHOT_VALUE_STRUCTURE_AMBIGUOUS/);
});
test('password input values are excluded and protected controls are not editable targets',()=>{
  const n=[ax(1,'textbox','Password',{value:{value:'secret-must-not-appear'}})];
  const s=serialize(n,new Map([[1,{attributes:{type:'password'}}]]));
  assert.equal(s.includes('secret-must-not-appear'),false);assert.match(s,/protected/);
});

test('bridge takes read-only snapshots and full editor values through public CDP',async()=>{
  const m=await setup();try{
    const state=await m.tab.getAXState();assert.equal(parseCompose(state,account,itemRef).body,body);
    assert.equal(m.identityCalls(),1);assert.equal(m.calls.some(c=>c.method.startsWith('Input.')),false);
    assert.equal(m.calls.some(c=>/Network|Fetch|Storage|cookie/i.test(c.method)),false);
  }finally{await m.tab.close();}
});
test('snapshot indices never alias older snapshots',async()=>{
  const m=await setup({guard:()=>{}});try{
    const a=await m.tab.getAXState(),old=indexOf(a,/button 发送$/),b=await m.tab.getAXState(),fresh=indexOf(b,/button 发送$/);
    assert.notEqual(old,fresh);await assert.rejects(()=>m.tab.click(old),/STALE_SNAPSHOT_REFERENCE/);
    await m.tab.click(fresh);assert.equal(m.calls.filter(c=>c.method==='Input.dispatchMouseEvent').length,2);
  }finally{await m.tab.close();}
});
test('navigation invalidates every prior node reference',async()=>{
  const m=await setup({guard:()=>{}});try{
    const s=await m.tab.getAXState(),id=indexOf(s,/button 发送$/);m.page.emit('framenavigated',m.page.mainFrame());
    await assert.rejects(()=>m.tab.click(id),/STALE_SNAPSHOT_REFERENCE/);
  }finally{await m.tab.close();}
});
test('missing mutation guard blocks even geometry or input work',async()=>{
  const m=await setup();try{
    const id=indexOf(await m.tab.getAXState(),/button 发送$/),before=m.calls.length;
    await assert.rejects(()=>m.tab.click(id),/MUTATION_GUARD_REQUIRED/);
    assert.equal(m.calls.length,before);
  }finally{await m.tab.close();}
});
test('final synchronous guard executes after geometry and can stop physical click',async()=>{
  const order=[];const m=await setup({hook:(method)=>{if(method==='Runtime.callFunctionOn')order.push('read');},
    guard:context=>{order.push('guard');assert.equal(context.kind,'click');assert.equal(context.name,'发送');throw Error('DEADLINE');}});
  try{
    const id=indexOf(await m.tab.getAXState(),/button 发送$/);await assert.rejects(()=>m.tab.click(id),/DEADLINE/);
    assert.equal(order.at(-1),'guard');assert.ok(order.filter(x=>x==='read').length>=2);
    assert.equal(m.calls.some(c=>c.method.startsWith('Input.')),false);
  }finally{await m.tab.close();}
});
test('click performs no asynchronous identity recheck after authorization',async()=>{
  const m=await setup({guard:()=>{}});try{
    const id=indexOf(await m.tab.getAXState(),/button 发送$/),before=m.identityCalls();await m.tab.click(id);
    assert.equal(m.identityCalls(),before);
  }finally{await m.tab.close();}
});
test('right mouse option matches the existing adapter and only clicks once',async()=>{
  const m=await setup({guard:()=>{}});try{
    const id=indexOf(await m.tab.getAXState(),/button 发送$/);await m.tab.click(id,{mouseButton:'right'});
    assert.deepEqual(m.calls.filter(c=>c.method==='Input.dispatchMouseEvent').map(c=>c.params.button),['right','right']);
  }finally{await m.tab.close();}
});
test('changed label or disabled control after snapshot blocks input',async()=>{
  for(const change of ['label','disabled']){
    const m=await setup({guard:()=>{}});try{
      const id=indexOf(await m.tab.getAXState(),/button 发送$/);
      if(change==='label')m.fixture.nodes[2].name.value='Different action';else m.fixture.nodes[2].properties=props({disabled:true});
      await assert.rejects(()=>m.tab.click(id),/CONTROL_CHANGED_SINCE_SNAPSHOT/);
      assert.equal(m.calls.some(c=>c.method.startsWith('Input.')),false);
    }finally{await m.tab.close();}
  }
});
test('obscured element is not clicked',async()=>{
  const m=await setup({guard:()=>{},unobscured:false});try{
    const id=indexOf(await m.tab.getAXState(),/button 发送$/);await assert.rejects(()=>m.tab.click(id),/CONTROL_NOT_CLICKABLE/);
  }finally{await m.tab.close();}
});
test('type and Return target the selected real input using Input events',async()=>{
  const m=await setup({guard:()=>{}});try{
    const id=indexOf(await m.tab.getAXState(),/text field.*Value: Existing/);
    await m.tab.typeText(id,'buyer@example.test');await m.tab.pressKey(id,'Return');
    assert.deepEqual(m.calls.filter(c=>c.method==='Input.insertText').map(c=>c.params.text),['buyer@example.test']);
    assert.equal(m.calls.filter(c=>c.method==='Input.dispatchKeyEvent'&&c.params.key==='Enter').length,2);
    await assert.rejects(()=>m.tab.pressKey(id,'UnrecognizedKey'),/UNSUPPORTED_KEY/);
  }finally{await m.tab.close();}
});
test('navigation during focus prevents typing into the replacement page',async()=>{
  let interrupt=false;const m=await setup({guard:()=>{},hook:(method,_p,ctx)=>{if(interrupt&&method==='DOM.focus')ctx.page.emit('framenavigated',ctx.main);}});
  try{
    const id=indexOf(await m.tab.getAXState(),/text field.*Value: Existing/);interrupt=true;
    await assert.rejects(()=>m.tab.typeText(id,'anything'),/STALE_SNAPSHOT_REFERENCE/);
    assert.equal(m.calls.some(c=>c.method==='Input.insertText'),false);
  }finally{await m.tab.close();}
});
test('promise-returning guards are rejected before click dispatch',async()=>{
  const m=await setup({guard:async()=>{}});try{
    const id=indexOf(await m.tab.getAXState(),/button 发送$/);await assert.rejects(()=>m.tab.click(id),/MUST_BE_SYNCHRONOUS/);
    assert.equal(m.calls.some(c=>c.method.startsWith('Input.')),false);
  }finally{await m.tab.close();}
});
test('identity mismatch and unverified frames hold snapshot without mailbox actions',async()=>{
  for(const options of [{identity:{ok:false}},{frames:2}]){
    const m=await setup(options);try{
      await assert.rejects(()=>m.tab.getAXState(),/BROWSER_IDENTITY_CHANGED|UNVERIFIED_FRAME_TREE/);
      assert.equal(m.calls.some(c=>c.method==='Accessibility.getFullAXTree'),false);
      assert.equal(m.calls.some(c=>c.method.startsWith('Input.')),false);
    }finally{await m.tab.close();}
  }
});
test('reload verifies identity and clears prior references; close only detaches',async()=>{
  const m=await setup({guard:()=>{}}),tab=m.tab;
  const id=indexOf(await tab.getAXState(),/button 发送$/);
  await tab.reload();assert.equal(m.original.reloadCalls,1);assert.equal(m.identityCalls(),2);
  await assert.rejects(()=>tab.click(id),/STALE_SNAPSHOT_REFERENCE/);
  await tab.close();await tab.close();assert.equal(m.original.detachCalls,1);assert.equal(m.page.isClosed(),false);
  await assert.rejects(()=>tab.getAXState(),/BROWSER_TAB_CLOSED/);
});
test('DOM frames and incomplete accessibility trees are explicit failures',()=>{
  assert.throws(()=>indexDOMTree({...element(1),contentDocument:element(2)}),/UNVERIFIED_FRAME_TREE/);
  assert.throws(()=>serialize([ax(1,'RootWebArea','',{childIds:['missing']})]),/TREE_INCOMPLETE/);
});

test('provider DOM identifiers are not trimmed or reinterpreted',()=>{
  assert.throws(()=>serialize([ax(1,'listitem','来自 我, 主题 Hi, 创建时间 今天')],new Map([[1,{attributes:{id:' 9000000000000000100'}}]])),/DOM_ID_UNREPRESENTABLE/);
});
test('readonly input is not advertised as a settable search control',()=>{
 const n=[ax(1,'textbox','Search',{properties:props({readonly:true})})];
 assert.match(serialize(n),/text field \(readonly\)/);
 assert.doesNotMatch(serialize(n),/settable/);
});

// Real Chromium inherits editable onto text and anonymous input descendants.
test('inherited AX editable never reads text nodes or anonymous descendants as full editors',async()=>{
 const f=composeFixture(true);
 f.nodes[6].childIds=['a9'];
 f.nodes.push(ax(9,'StaticText','Complete child text',{properties:props({editable:'richtext'})}));
 f.nodes[5].childIds=['a10'];
 f.nodes.push(ax(10,'generic','',{properties:props({editable:'plaintext'})}));
 f.doc.children[5].children.push(element(9,'#text'));
 f.doc.children[4].children.push(element(10,'DIV'));
 const m=await setup({fixture:f});
 try{
  const state=await m.tab.getAXState();
  assert.equal(parseCompose(state,account,itemRef).body,body);
  assert.equal(m.calls.some(c=>c.method==='DOM.resolveNode'&&[9,10].includes(c.params.backendNodeId)),false);
  assert.match(state,/text Complete child text/);
 }finally{await m.tab.close();}
});

test('one navigation event during first snapshot triggers a bounded read-only retry',async()=>{
 let reads=0;
 const m=await setup({hook:(method,_p,ctx)=>{if(method==='DOM.getDocument'&&++reads===1)ctx.client.emit('DOM.documentUpdated');}});
 try{
  assert.equal(parseCompose(await m.tab.getAXState(),account,itemRef).body,body);
  assert.equal(reads,2);assert.equal(m.identityCalls(),2);
  assert.equal(m.calls.some(c=>c.method.startsWith('Input.')),false);
 }finally{await m.tab.close();}
});
test('continuously changing snapshots stop after three reads without usable stale refs',async()=>{
 let reads=0;
 const m=await setup({guard:()=>{},hook:(method,_p,ctx)=>{if(method==='DOM.getDocument'){reads++;ctx.client.emit('DOM.documentUpdated');}}});
 try{
  await assert.rejects(()=>m.tab.getAXState(),/DOCUMENT_CHANGED_DURING_SNAPSHOT/);
  assert.equal(reads,3);assert.equal(m.identityCalls(),3);
  await assert.rejects(()=>m.tab.click(1),/STALE_SNAPSHOT_REFERENCE/);
  assert.equal(m.calls.some(c=>c.method.startsWith('Input.')),false);
 }finally{await m.tab.close();}
});
test('snapshot failures other than the specific navigation race are never retried',async()=>{
 let reads=0;
 const m=await setup({hook:method=>{if(method==='DOM.getDocument'){reads++;throw Error('SOURCE_DOWN');}}});
 try{await assert.rejects(()=>m.tab.getAXState(),/SOURCE_DOWN/);assert.equal(reads,1);assert.equal(m.identityCalls(),1);}
 finally{await m.tab.close();}
});
test('input errors are never retried even if their text resembles a snapshot race',async()=>{
 const m=await setup({guard:()=>{},hook:(method,params)=>{if(method==='Input.dispatchMouseEvent'&&params.type==='mousePressed')throw Error('DOCUMENT_CHANGED_DURING_SNAPSHOT');}});
 try{
  const id=indexOf(await m.tab.getAXState(),/button 发送$/);
  await assert.rejects(()=>m.tab.click(id),/DOCUMENT_CHANGED_DURING_SNAPSHOT/);
  assert.equal(m.calls.filter(c=>c.method==='Input.dispatchMouseEvent').length,1);
 }finally{await m.tab.close();}
});
