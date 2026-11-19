import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {connectChrome} from '../src/browser-mail/chrome.mjs';
import {serializeVisiblePlainBody} from '../src/browser-mail/browser-adapter.mjs';

// Explicit opt-in only. This opens an isolated headless installed Chrome with
// a new disposable profile. It never uses an existing browser or real mailbox.
const enabled=process.env.PROSPECTDESK_REAL_CHROME_TEST==='1';
const fixtureUrl='https://mail.zoho.com/zm/';
const editorHtml='<div>Hello fixture,<br></div><div><br></div><div>Second line.<br></div>';
const attribute=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;');
const fixture=(body=editorHtml)=>'<!doctype html><html><head><title>Synthetic editor fixture</title></head><body>'+
  '<h1>Synthetic fixture only</h1><div id="zmComposeEditor_Cmp1" style="width:600px;height:300px">'+
  '<iframe title="文本编辑区域" aria-label="文本编辑区域" style="display:block;width:600px;height:300px;border:0" srcdoc="'+
  attribute('<!doctype html><html><body contenteditable="true">'+body+'</body></html>')+'"></iframe></div></body></html>';
function installedChromePath(){
  if(process.platform!=='win32')return undefined;
  const environment=new Map(Object.entries(process.env).map(([key,value])=>[key.toLowerCase(),value]));
  const drive=environment.get('systemdrive')??'C:';
  for(const base of [environment.get('programfiles'),environment.get('programfiles(x86)'),environment.get('localappdata'),
    path.join(drive+'/','Program Files'),path.join(drive+'/','Program Files (x86)')]){
    if(!base)continue;
    const candidate=path.join(base,'Google','Chrome','Application','chrome.exe');
    if(fs.statSync(candidate,{throwIfNoEntry:false})?.isFile())return candidate;
  }
  return undefined;
}

test('installed Chrome srcdoc integration uses only synthetic routed documents', {skip:!enabled,timeout:60000},async t=>{
  const temporaryRoot=fs.realpathSync(os.tmpdir());
  const directory=fs.mkdtempSync(path.join(temporaryRoot,'prospectdesk-rich-frame-integration-'));
  let connection;
  try{
    const executablePath=installedChromePath();
    connection=await connectChrome({mode:'launch',dataDirectory:directory,headless:true,frameScope:'top-document',
      ...(executablePath?{executablePath}:{})});
    const requests=[];
    await connection.page.context().route('**/*',async route=>{
      const request=route.request();
      const allowed=request.url()===fixtureUrl&&request.method()==='GET'&&request.resourceType()==='document';
      requests.push({url:request.url(),method:request.method(),action:allowed?'local_fixture':'aborted'});
      if(allowed)
        return await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:fixture()});
      return await route.abort('blockedbyclient');
    });
    await connection.page.goto(fixtureUrl+'#compose',{waitUntil:'load'});
    const editorFrame=connection.page.frames().find(frame=>frame.url()==='about:srcdoc');
    assert.ok(editorFrame,'synthetic srcdoc frame loaded');
    await editorFrame.waitForFunction(()=>document.body?.isContentEditable===true);
    const cdp=await connection.page.context().newCDPSession(connection.page);
    const tree=(await cdp.send('Page.getFrameTree')).frameTree;
    const rich=tree.childFrames?.find(child=>child.frame.url==='about:srcdoc')?.frame;
    assert.ok(['://','https://mail.zoho.com'].includes(rich?.securityOrigin),
      'Chrome reports an inherited or about-scheme srcdoc origin');
    assert.ok(rich.loaderId);await cdp.detach();
    await connection.tab.getAXState();
    const read=await connection.tab.readVerifiedComposeFrame({editorHostId:'zmComposeEditor_Cmp1'});
    assert.equal(read.snapshot.html,editorHtml);
    assert.equal(read.snapshot.textContent,'Hello fixture,Second line.');
    assert.equal(serializeVisiblePlainBody(read.snapshot,read.snapshot.innerText).body,'Hello fixture,\n\nSecond line.');
    assert.equal(read.binding.securityOrigin,'https://mail.zoho.com');

    // Fixture-only DOM changes test actual visibility and editable ownership.
    const owner=connection.page.locator('iframe[title="文本编辑区域"]');
    await owner.evaluate(node=>{node.hidden=true;});
    await connection.tab.getAXState();
    await assert.rejects(()=>connection.tab.readVerifiedComposeFrame({editorHostId:'zmComposeEditor_Cmp1'}),/COMPOSE_FRAME_OWNER_UNVERIFIED/);
    await owner.evaluate(node=>{node.hidden=false;node.srcdoc='<!doctype html><html><body><div contenteditable="true">One</div><div contenteditable="true">Two</div></body></html>';});
    await editorFrame.waitForFunction(()=>document.querySelectorAll('[contenteditable]').length===2);
    await connection.tab.getAXState();
    await assert.rejects(()=>connection.tab.readVerifiedComposeFrame({editorHostId:'zmComposeEditor_Cmp1'}),/COMPOSE_FRAME_BODY_UNVERIFIED/);

    await owner.evaluate(node=>new Promise(resolve=>{
      node.addEventListener('load',resolve,{once:true});
      node.setAttribute('sandbox','');
      node.srcdoc='<!doctype html><html><body contenteditable="true">Opaque child.</body></html>';
    }));
    assert.equal(await owner.evaluate(node=>node.contentDocument===null),true);
    await connection.tab.getAXState();
    await assert.rejects(()=>connection.tab.readVerifiedComposeFrame({editorHostId:'zmComposeEditor_Cmp1'}),/COMPOSE_FRAME_(?:ORIGIN_UNVERIFIED|BINDING_AMBIGUOUS)/);
    assert.ok(requests.length>=1);
    assert.equal(requests.filter(request=>request.action==='local_fixture').length,1);
    assert.equal(requests.some(request=>request.action!=='aborted'&&(request.url!==fixtureUrl||request.method!=='GET')),false);
    t.diagnostic('Synthetic installed Chrome '+connection.identity.browserVersion+': CDP srcdoc origin '+JSON.stringify(rich.securityOrigin)+', exact body read, hidden, multiple-editor and sandboxed holds verified; no real mail or user profile.');
  }finally{
    if(connection)await connection.close();
    const actual=fs.realpathSync(directory),relative=path.relative(temporaryRoot,actual);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative)
      ||!path.basename(actual).startsWith('prospectdesk-rich-frame-integration-'))throw Error('UNSAFE_FIXTURE_CLEANUP_PATH');
    fs.rmSync(actual,{recursive:true,force:false});
  }
});
