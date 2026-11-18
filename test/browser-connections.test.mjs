import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {connectBrowser,validateChromeExecutableSource} from '../src/browser-mail/connection.mjs';
import {connectEdge} from '../src/browser-mail/edge.mjs';
import {connectChrome} from '../src/browser-mail/chrome.mjs';
import {connectYandex} from '../src/browser-mail/yandex.mjs';
import {profileDirectory,acquireProfile} from '../src/browser-mail/browser-profiles.mjs';

const ids=['edge','chrome','yandex'];
const uas={
  edge:'Mozilla/5.0 Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0',
  chrome:'Mozilla/5.0 Chrome/148.0.0.0 Safari/537.36',
  yandex:'Mozilla/5.0 Chrome/146.0.0.0 YaBrowser/26.4.1.0 Safari/537.36'
};
function emptyTab(){
  return {getAXState:async()=>'',click:async()=>{},reload:async()=>{},typeText:async()=>{},pressKey:async()=>{}};
}
function folder(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'browser-connectors-')),connections=[];
  t.after(async()=>{
    for(const c of connections.reverse())try{await c.close();}catch{}
    assert.ok(root.startsWith(path.join(os.tmpdir(),'browser-connectors-')));
    fs.rmSync(root,{recursive:true,force:true});
  });
  const executablePath=path.join(root,'Yandex','browser.exe');fs.mkdirSync(path.dirname(executablePath),{recursive:true});fs.writeFileSync(executablePath,'synthetic executable placeholder');
  return {root,dataDirectory:path.join(root,'controller'),executablePath,manage(c){connections.push(c);return c;}};
}
function fake(browserId){
  const state={launches:[],spawns:[],connections:[],browserCloseCalls:0,ua:uas[browserId],product:'Chrome/148.0.0.0',targetId:'owned-target-'+browserId,closed:false,closeCalls:0,tabCloses:0,detaches:0,newPages:0,events:{}};
  const page={isClosed:()=>state.closed||state.pageClosed===true};
  const session={async send(method){
    if(state.protocolError)throw Error('Disconnected');
    if(method==='Browser.close'){state.browserCloseCalls++;state.closed=true;state.child?.exitNow();return {};}
    if(method==='Browser.getVersion')return {product:state.product,userAgent:state.ua};
    if(method==='Target.getTargetInfo')return {targetInfo:{targetId:state.targetId}};
    throw Error('Unexpected protocol method '+method);
  },async detach(){state.detaches++;}};
  const context={on(event,fn){state.events[event]=fn;},setDefaultTimeout(){},async newPage(){state.newPages++;return page;},async newCDPSession(){return session;},async close(){state.closeCalls++;if(state.closeError)throw Error('Close did not settle');state.closed=true;state.events.close?.();}};
  const driver={async launchPersistentContext(profile,options){state.launches.push({profile,options});if(state.launchError)throw Error('Launch failed');return context;},async connectOverCDP(endpoint,options){state.connections.push({endpoint,options});return {contexts:()=>[context],async close(){}};}};
  const spawnBrowser=(exe,args,options)=>{state.spawns.push({exe,args,options});const child=new EventEmitter();child.pid=987654;child.exitCode=null;child.exitNow=()=>{if(child.exitCode!==null)return;child.exitCode=0;child.emit('exit',0);};state.child=child;const profile=args.find(a=>a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);fs.writeFileSync(path.join(profile,'DevToolsActivePort'),'19222\n/devtools/browser/synthetic-owned\n');return child;};
  const tabFactory=async({page:provided,identityCheck})=>{assert.equal(provided,page);assert.equal((await identityCheck()).ok,true);return {...emptyTab(),async close(){state.tabCloses++;}};};
  return {state,driver,tabFactory,page,spawnBrowser,terminateOwnedProcess:async child=>child.exitNow()};
}
function options(browserId,f,d){return {browserId,mode:'launch',dataDirectory:f.dataDirectory,driver:d.driver,tabFactory:d.tabFactory,...(browserId==='yandex'?{executablePath:f.executablePath,spawnBrowser:d.spawnBrowser,terminateOwnedProcess:d.terminateOwnedProcess}:{})};}

for(const browserId of ids)test(browserId+' launches only its own selected browser and dedicated profile',async t=>{
  const f=folder(t),d=fake(browserId),c=f.manage(await connectBrowser(options(browserId,f,d)));
  assert.equal(c.identity.browserId,browserId);assert.equal(c.identity.transport,'playwright');assert.equal(c.identity.identityVerified,true);
  assert.equal(c.identity.targetId,'owned-target-'+browserId);assert.equal(c.page,d.page);assert.equal(d.state.newPages,1);
  const expectedProfile=path.join(f.dataDirectory,'profiles',browserId);
  if(browserId==='yandex'){
    assert.equal(d.state.launches.length,0);assert.equal(d.state.spawns.length,1);assert.equal(d.state.spawns[0].exe,fs.realpathSync(f.executablePath));
    assert.ok(d.state.spawns[0].args.includes('--user-data-dir='+expectedProfile));assert.ok(d.state.spawns[0].args.includes('--remote-debugging-address=127.0.0.1'));
    assert.equal(d.state.spawns[0].options.windowsHide,true);assert.equal(d.state.connections[0].endpoint,'ws://127.0.0.1:19222/devtools/browser/synthetic-owned');
  }else{
    assert.equal(d.state.launches.length,1);assert.equal(d.state.launches[0].profile,expectedProfile);
    assert.equal(d.state.launches[0].options.chromiumSandbox,true);assert.equal(d.state.launches[0].options.headless,false);
    assert.equal(d.state.launches[0].options.channel,browserId==='edge'?'msedge':'chrome');
  }
  assert.ok(!JSON.stringify(c.identity).includes(f.root));
  await c.close();assert.equal(browserId==='yandex'?d.state.browserCloseCalls:d.state.closeCalls,1);assert.equal(d.state.tabCloses,1);
  assert.equal(fs.existsSync(path.join(expectedProfile,'.browser-mail-connection.lock')),false);
  await assert.rejects(c.verifyIdentity(),/CLOSED/);
});

test('Yandex requires an explicit existing executable and never falls back',async t=>{
  const f=folder(t),d=fake('yandex');
  await assert.rejects(connectBrowser({...options('yandex',f,d),executablePath:undefined}),/YANDEX_EXECUTABLE_PATH_REQUIRED/);
  await assert.rejects(connectBrowser({...options('yandex',f,d),executablePath:path.join(f.root,'missing.exe')}),/ENOENT/);
  assert.equal(d.state.launches.length,0);
});
test('Chrome and Edge accept an explicit installed executable and verify its brand',async t=>{
  const f=folder(t);
  for(const browserId of ['edge','chrome']){
    if(browserId==='chrome'&&process.platform!=='win32')continue;
    const previousRoot=process.env.ProgramFiles,installRoot=path.join(f.root,'ProgramFiles');
    const d=fake(browserId),exe=browserId==='chrome'?path.join(installRoot,'Google','Chrome','Application','chrome.exe'):path.join(f.root,'msedge.exe');
    fs.mkdirSync(path.dirname(exe),{recursive:true});fs.writeFileSync(exe,'synthetic browser executable');
    if(browserId==='chrome')process.env.ProgramFiles=installRoot;
    try{
      const c=f.manage(await connectBrowser({...options(browserId,f,d),executablePath:exe}));
      assert.equal(c.identity.browserId,browserId);assert.equal(d.state.launches[0].options.executablePath,fs.realpathSync(exe));
      assert.equal(d.state.launches[0].options.channel,undefined);
      if(browserId==='chrome')assert.equal(c.sourceEvidence,'windows_google_install_path');await c.close();
    }finally{if(previousRoot===undefined)delete process.env.ProgramFiles;else process.env.ProgramFiles=previousRoot;}
  }
});
test('explicit Edge or Chrome path never overrides the requested brand',async t=>{
  const f=folder(t);
  for(const browserId of ['edge','chrome']){
    if(browserId==='chrome'&&process.platform!=='win32')continue;
    const previousRoot=process.env.ProgramFiles,installRoot=path.join(f.root,'ProgramFiles');
    const exe=browserId==='chrome'?path.join(installRoot,'Google','Chrome','Application','chrome.exe'):f.executablePath;
    fs.mkdirSync(path.dirname(exe),{recursive:true});fs.writeFileSync(exe,'synthetic browser executable');
    if(browserId==='chrome')process.env.ProgramFiles=installRoot;
    try{
      const d=fake(browserId);d.state.ua=browserId==='edge'?uas.chrome:uas.edge;
      await assert.rejects(connectBrowser({...options(browserId,f,d),executablePath:exe}),/BRAND_MISMATCH/);
      assert.equal(d.state.launches.length,1);assert.equal(d.state.closeCalls,1);
    }finally{if(previousRoot===undefined)delete process.env.ProgramFiles;else process.env.ProgramFiles=previousRoot;}
  }
});
test('explicit browser executable must be an existing absolute file',async t=>{
  const f=folder(t),d=fake('edge');
  await assert.rejects(connectBrowser({...options('edge',f,d),executablePath:'relative/msedge.exe'}),/MUST_BE_ABSOLUTE/);
  await assert.rejects(connectBrowser({...options('edge',f,d),executablePath:f.root}),/NOT_A_FILE/);
  assert.equal(d.state.launches.length,0);
});
test('brand mismatch closes owned browser and does not try another browser',async t=>{
  const f=folder(t),d=fake('yandex');d.state.ua=uas.chrome;
  await assert.rejects(connectBrowser(options('yandex',f,d)),/BRAND_MISMATCH/);
  assert.equal(d.state.spawns.length,1);assert.equal(d.state.connections.length,1);assert.equal(d.state.browserCloseCalls,1);
  assert.equal(fs.existsSync(path.join(f.dataDirectory,'profiles','yandex','.browser-mail-connection.lock')),false);
});
test('selected target and browser brand are rechecked after connection',async t=>{
  const f=folder(t),d=fake('edge'),c=f.manage(await connectBrowser(options('edge',f,d)));
  d.state.targetId='another-window';await assert.rejects(c.verifyIdentity(),/TARGET_CHANGED/);
  d.state.targetId='owned-target-edge';d.state.ua=uas.chrome;await assert.rejects(c.verifyIdentity(),/BRAND_MISMATCH/);
});
test('closed page or disconnected browser invalidates the binding',async t=>{
  const f=folder(t),d=fake('chrome'),c=f.manage(await connectBrowser(options('chrome',f,d)));
  d.state.pageClosed=true;await assert.rejects(c.verifyIdentity(),/CLOSED/);
  d.state.pageClosed=false;d.state.protocolError=true;await assert.rejects(c.verifyIdentity(),/Disconnected/);
});
test('owned profile lock blocks a second connection before browser launch',async t=>{
  const f=folder(t),d=fake('chrome'),c=f.manage(await connectBrowser(options('chrome',f,d))),second=fake('chrome');
  await assert.rejects(connectBrowser(options('chrome',f,second)),/PROFILE_BUSY/);assert.equal(second.state.launches.length,0);
  await c.close();
  const reopened=f.manage(await connectBrowser(options('chrome',f,second)));assert.equal(reopened.identity.browserId,'chrome');
});
test('three browsers use separate profiles under one explicit data directory',async t=>{
  const f=folder(t),profiles=[];
  for(const browserId of ids){const d=fake(browserId);f.manage(await connectBrowser(options(browserId,f,d)));profiles.push(path.join(f.dataDirectory,'profiles',browserId));}
  assert.equal(new Set(profiles).size,3);
});
test('default browser profile trees are rejected including Yandex',()=>{
  for(const p of ['C:/Users/Tester/AppData/Local/Google/Chrome/User Data','C:/Users/Tester/AppData/Local/Microsoft/Edge/User Data/Default','C:/Users/Tester/AppData/Local/Yandex/YandexBrowser/User Data','/home/tester/.config/yandex-browser','/Users/tester/Library/Application Support/Yandex'])assert.throws(()=>profileDirectory(p,'yandex'),/DEFAULT_BROWSER_PROFILE/);
});
test('existing unowned profile and mismatched profile marker are rejected',t=>{
  const f=folder(t),p=profileDirectory(f.dataDirectory,'edge');fs.mkdirSync(p,{recursive:true});fs.writeFileSync(path.join(p,'Preferences'),'private fixture');
  assert.throws(()=>acquireProfile(f.dataDirectory,'edge'),/UNOWNED_PROFILE/);
  fs.writeFileSync(path.join(p,'.browser-mail-profile.json'),JSON.stringify({application:'another-app',schema:1,browserId:'edge'}));
  assert.throws(()=>acquireProfile(f.dataDirectory,'edge'),/OWNER_MISMATCH/);
});
test('profile release never deletes a replacement lock owned by someone else',t=>{
  const f=folder(t),p=acquireProfile(f.dataDirectory,'edge');
  fs.writeFileSync(p.lockPath,JSON.stringify({token:'different-owner'}));p.release();
  assert.equal(fs.existsSync(p.lockPath),true);
});
test('failed launch releases only the profile lock it acquired',async t=>{
  const f=folder(t),d=fake('chrome');d.state.launchError=true;
  await assert.rejects(connectBrowser(options('chrome',f,d)),/Launch failed/);
  assert.equal(fs.existsSync(path.join(f.dataDirectory,'profiles','chrome','.browser-mail-connection.lock')),false);
});
test('a close failure retains profile ownership until a real close is observed',async t=>{
  const f=folder(t),d=fake('chrome'),c=f.manage(await connectBrowser(options('chrome',f,d)));
  d.state.closeError=true;await assert.rejects(c.close(),/Close did not settle/);
  const lock=path.join(f.dataDirectory,'profiles','chrome','.browser-mail-connection.lock');assert.equal(fs.existsSync(lock),true);
  d.state.events.close();assert.equal(fs.existsSync(lock),false);
});

for(const browserId of ids)test(browserId+' CUA binding requires matching host evidence and never closes the external tab',async()=>{
  let externalClose=0,evidence={browserId,targetId:'host-tab-'+browserId,browserVersion:'148.1',identityVerified:true};
  const tab={...emptyTab(),close(){externalClose++;}};
  const c=await connectBrowser({browserId,mode:'cua',tab,metadata:{browserId,targetId:evidence.targetId},verifyIdentity:async()=>evidence});
  assert.equal(c.tab,tab);assert.equal(c.identity.transport,'cua');assert.equal((await c.verifyIdentity()).ok,true);
  evidence={...evidence,targetId:'changed'};await assert.rejects(c.verifyIdentity(),/TARGET_CHANGED/);
  await c.close();assert.equal(externalClose,0);await assert.rejects(c.verifyIdentity(),/CLOSED/);
});
test('CUA browser label or a boolean alone cannot establish identity',async()=>{
  const tab=emptyTab(),common={browserId:'yandex',mode:'cua',tab,metadata:{browserId:'yandex',targetId:'t'}};
  await assert.rejects(connectBrowser(common),/HOST_IDENTITY_BINDING_REQUIRED/);
  await assert.rejects(connectBrowser({...common,verifyIdentity:async()=>true}),/IDENTITY_UNVERIFIED/);
  await assert.rejects(connectBrowser({...common,verifyIdentity:async()=>({browserId:'chrome',targetId:'t',identityVerified:true})}),/IDENTITY_UNVERIFIED/);
  await assert.rejects(connectBrowser({...common,metadata:{browserId:'chrome',targetId:'t'},verifyIdentity:async()=>({})}),/HOST_IDENTITY_BINDING_REQUIRED/);
});
test('CUA verification completing after close is rejected',async()=>{
  let release,wait=false;
  const evidence={browserId:'chrome',targetId:'t',identityVerified:true};
  const c=await connectBrowser({browserId:'chrome',mode:'cua',tab:emptyTab(),metadata:evidence,verifyIdentity:async()=>{if(wait)await new Promise(r=>{release=r;});return evidence;}});
  wait=true;const verifying=c.verifyIdentity();await c.close();release();await assert.rejects(verifying,/CLOSED/);
});
test('thin entrypoints pin their browser and reject an override',async()=>{
  for(const [browserId,entry] of [['edge',connectEdge],['chrome',connectChrome],['yandex',connectYandex]]){
    assert.throws(()=>entry({browserId:browserId==='edge'?'chrome':'edge'}),/ENTRY_OVERRIDE/);
    const proof={browserId,targetId:'t-'+browserId,identityVerified:true};
    const c=await entry({mode:'cua',tab:emptyTab(),metadata:proof,verifyIdentity:async()=>proof});
    assert.equal(c.identity.browserId,browserId);await c.close();
  }
});
test('unknown browser, mode and incomplete tab are rejected',async()=>{
  await assert.rejects(connectBrowser({browserId:'firefox',mode:'launch'}),/BROWSER_ID/);
  await assert.rejects(connectBrowser({browserId:'chrome'}),/BROWSER_MODE/);
  await assert.rejects(connectBrowser({browserId:'chrome',mode:'cua',tab:{getAXState(){}}}),/INTERFACE_INCOMPLETE/);
});

test('exact product build is retained when browser user agent is reduced',async t=>{
  const f=folder(t);
  for(const [browserId,product,ua,expected] of [
    ['edge','Edg/157.0.4341.60','Mozilla/5.0 Chrome/157.0.0.0 Edg/157.0.0.0','157.0.4341.60'],
    ['chrome','Chrome/157.0.8103.51','Mozilla/5.0 Chrome/157.0.0.0','157.0.8103.51'],
    ['yandex','YaBrowser/26.8.3.115','Mozilla/5.0 Chrome/150.0.0.0 YaBrowser/26.8.0.0','26.8.3.115']
  ]){
    const d=fake(browserId);d.state.product=product;d.state.ua=ua;
    const c=f.manage(await connectBrowser(options(browserId,f,d)));
    assert.equal(c.identity.browserVersion,expected);assert.equal((await c.verifyIdentity()).browserVersion,expected);
  }
});

test('Chrome source accepts canonical Google installation and App Paths registration',async()=>{
  const environment={ProgramFiles:'C:/Program Files',LOCALAPPDATA:'C:/Users/Tester/AppData/Local'};
  const common={platform:'win32',environment,readRegisteredPaths:async()=>[]};
  assert.equal(await validateChromeExecutableSource('C:/Program Files/Google/Chrome/Application/chrome.exe',common),'windows_google_install_path');
  assert.equal(await validateChromeExecutableSource('c:/users/tester/appdata/local/google/chrome/application/CHROME.EXE',common),'windows_google_install_path');
  assert.equal(await validateChromeExecutableSource('D:/ManagedApps/Chrome/chrome.exe',{
    ...common,readRegisteredPaths:async()=>['D:/ManagedApps/Chrome/chrome.exe']
  }),'windows_chrome_app_paths');
});
test('Chrome source rejects Brave and unregistered Chromium despite Chrome-compatible branding',async t=>{
  const f=folder(t),d=fake('chrome');
  for(const relative of ['BraveSoftware/Brave-Browser/Application/brave.exe','Chromium/Application/chrome.exe']){
    const exe=path.join(f.root,relative);fs.mkdirSync(path.dirname(exe),{recursive:true});fs.writeFileSync(exe,'synthetic Chrome-compatible browser');
    if(process.platform==='win32')await assert.rejects(connectBrowser({...options('chrome',f,d),executablePath:exe}),/GOOGLE_CHROME_EXECUTABLE_SOURCE_REQUIRED/);
    else await assert.rejects(connectBrowser({...options('chrome',f,d),executablePath:exe}),/SOURCE_NOT_VALIDATED_ON_THIS_PLATFORM/);
  }
  assert.equal(d.state.launches.length,0);
  const common={platform:'win32',environment:{ProgramFiles:'C:/Program Files'},readRegisteredPaths:async()=>[]};
  await assert.rejects(validateChromeExecutableSource('C:/Program Files/Chromium/Application/chrome.exe',common),/SOURCE_REQUIRED/);
  await assert.rejects(validateChromeExecutableSource('C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',common),/SOURCE_REQUIRED/);
});
test('explicit Chrome installation-source checks are not guessed on other platforms',async()=>{
  await assert.rejects(validateChromeExecutableSource('/opt/google/chrome/chrome',{platform:'linux'}),/SOURCE_NOT_VALIDATED_ON_THIS_PLATFORM/);
});
