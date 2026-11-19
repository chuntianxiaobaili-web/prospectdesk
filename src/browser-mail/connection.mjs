import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {acquireProfile,requireBrowserId} from './browser-profiles.mjs';

const hasId=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=512&&!/[\r\n@]/.test(value)&&!value.includes('://');
const versionOf=(value)=>typeof value==='string'?value.slice(0,160):'unknown';
const methods=['getAXState','click','reload','typeText','pressKey'];
function assertTab(tab) {
  if(!tab||methods.some(name=>typeof tab[name]!=='function'))throw Error('BROWSER_TAB_INTERFACE_INCOMPLETE');
}
function provenIdentity(browserId,transport,evidence,expectedTarget) {
  if(!evidence||evidence.identityVerified!==true||evidence.browserId!==browserId||!hasId(evidence.targetId))throw Error('BROWSER_IDENTITY_UNVERIFIED');
  if(expectedTarget!==undefined&&evidence.targetId!==expectedTarget)throw Error('BROWSER_TARGET_CHANGED');
  if(evidence.transport!==undefined&&evidence.transport!==transport)throw Error('BROWSER_TRANSPORT_CHANGED');
  return Object.freeze({browserId,transport,targetId:evidence.targetId,browserVersion:versionOf(evidence.browserVersion),identityVerified:true});
}
function brandMatches(browserId,version) {
  const ua=String(version.userAgent??''),product=String(version.product??'');
  if(browserId==='edge')return /Edg(?:e|A|iOS)?\//.test(ua)||/^Edg(?:e)?\//.test(product);
  if(browserId==='yandex')return /YaBrowser\//.test(ua)||/^(?:YaBrowser|Yandex)\//.test(product);
  return /(?:Chrome|HeadlessChrome)\//.test(ua+' '+product)&&!/(?:Edg(?:e|A|iOS)?|YaBrowser|OPR)\//.test(ua+' '+product);
}
function selectedVersion(browserId,raw) {
  const prefix=browserId==='edge'?'Edg(?:e|A|iOS)?':browserId==='yandex'?'(?:YaBrowser|Yandex)':'(?:Chrome|HeadlessChrome)';
  // Browser.getVersion.product preserves the exact build when UA reduction
  // replaces minor/build/patch with zeros. Prefer the matching brand product.
  return String(raw.product??'').match(new RegExp('^(?:'+prefix+')/([0-9.]+)$'))?.[1]
    ??String(raw.userAgent??'').match(new RegExp('(?:'+prefix+')/([0-9.]+)'))?.[1]
    ??versionOf(raw.product);
}


const windowsPath=value=>path.win32.normalize(value).replace(/[\\/]+$/,'').toLowerCase();
const envValue=(environment,key)=>Object.entries(environment).find(([name])=>name.toLowerCase()===key.toLowerCase())?.[1];
async function registeredChromePaths(){
  const paths=[];
  for(const hive of ['HKCU','HKLM']){
    try{
      const stdout=await new Promise((resolve,reject)=>execFile('reg.exe',
        ['query',hive+'\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe','/ve'],
        {windowsHide:true,timeout:1500,encoding:'utf8'},
        (error,out)=>error?reject(error):resolve(out)));
      const value=stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/m)?.[1]?.trim().replace(/^"|"$/g,'');
      if(value)paths.push(value.replace(/%([^%]+)%/g,(_m,key)=>envValue(process.env,key)??'%'+key+'%'));
    }catch{}
  }
  return paths;
}
/** Source evidence is the local installation location/registration plus protocol
 * brand and target. It is not a cryptographic publisher-signature attestation. */
export async function validateChromeExecutableSource(canonicalExecutable,{platform=process.platform,environment=process.env,readRegisteredPaths=registeredChromePaths}={}){
  if(platform!=='win32')throw Error('CHROME_EXECUTABLE_SOURCE_NOT_VALIDATED_ON_THIS_PLATFORM');
  if(typeof canonicalExecutable!=='string'||!path.win32.isAbsolute(canonicalExecutable)
    ||path.win32.basename(canonicalExecutable).toLowerCase()!=='chrome.exe')throw Error('GOOGLE_CHROME_EXECUTABLE_SOURCE_REQUIRED');
  const candidate=windowsPath(canonicalExecutable);
  const standardRoots=['ProgramFiles','ProgramFiles(x86)','LOCALAPPDATA'].map(key=>envValue(environment,key)).filter(value=>typeof value==='string'&&path.win32.isAbsolute(value));
  if(standardRoots.some(root=>windowsPath(path.win32.join(root,'Google','Chrome','Application','chrome.exe'))===candidate)){
    return 'windows_google_install_path';
  }
  for(const registered of await readRegisteredPaths()){
    if(typeof registered!=='string'||!path.win32.isAbsolute(registered)||path.win32.basename(registered).toLowerCase()!=='chrome.exe')continue;
    let resolved=registered;try{resolved=fs.realpathSync(registered);}catch{}
    if(windowsPath(resolved)===candidate)return 'windows_chrome_app_paths';
  }
  throw Error('GOOGLE_CHROME_EXECUTABLE_SOURCE_REQUIRED');
}

/** CUA bindings must be attested by the trusted host's current browser inventory.
 * A browserId string alone never proves which browser owns an existing tab. */
async function connectCua({browserId,tab,metadata,verifyIdentity:verifyHost}) {
  assertTab(tab);
  if(typeof verifyHost!=='function'||metadata?.browserId!==browserId||!hasId(metadata?.targetId))throw Error('CUA_HOST_IDENTITY_BINDING_REQUIRED');
  let closed=false;
  const expectedTarget=metadata.targetId;
  const verifyIdentity=async()=>{
    if(closed)throw Error('BROWSER_CONNECTION_CLOSED');
    const evidence=await verifyHost();
    if(closed)throw Error('BROWSER_CONNECTION_CLOSED');
    return {ok:true,...provenIdentity(browserId,'cua',evidence,expectedTarget)};
  };
  const initial=await verifyIdentity();
  const identity=Object.freeze(Object.fromEntries(Object.entries(initial).filter(([key])=>key!=='ok')));
  return {tab,identity,verifyIdentity,async close(){closed=true;return {closed:true,ownedBrowser:false};}};
}


function debugPortPath(profile){return path.join(profile,'DevToolsActivePort');}
async function launchedYandex({chromium,executable,owned,headless,spawnBrowser=spawn,terminateOwnedProcess,onExit}){
  const activePort=debugPortPath(owned.profile);
  // This file belongs only to the profile whose application lock we hold.
  if(fs.existsSync(activePort)){
    if(fs.lstatSync(activePort).isSymbolicLink())throw Error('DEBUG_PORT_FILE_SYMLINK_PROHIBITED');
    fs.unlinkSync(activePort);
  }
  const args=['--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',
    '--user-data-dir='+owned.profile,'--no-first-run','--no-default-browser-check',
    ...(headless?['--headless=new']:[]),'about:blank'];
  const child=spawnBrowser(executable,args,{windowsHide:true,stdio:'ignore'});
  let exited=false,spawnError,browser;
  child.once('exit',()=>{exited=true;onExit();});
  child.once('error',error=>{spawnError=error;});
  const waitExit=async timeout=>{const until=Date.now()+timeout;while(!exited&&Date.now()<until)await delay(40);return exited;};
  const closeOwned=async session=>{
    if(!exited&&session)try{await Promise.race([session.send('Browser.close'),delay(1500)]);}catch{}
    await waitExit(2000);
    if(!exited&&child.exitCode==null&&child.signalCode==null&&Number.isSafeInteger(child.pid)&&child.pid>0){
      if(terminateOwnedProcess)await terminateOwnedProcess(child);
      else if(process.platform==='win32'){
        // The pid is from this spawn handle, never from browser discovery.
        await new Promise((resolve,reject)=>execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000},error=>{if(error&&!exited)reject(error);else resolve();}));
      }else child.kill('SIGTERM');
      await waitExit(2000);
      if(!exited&&process.platform!=='win32'){child.kill('SIGKILL');await waitExit(2000);}
    }
    if(!exited&&child.pid)throw Error('OWNED_YANDEX_PROCESS_STILL_RUNNING');
    if(browser)try{await browser.close();}catch{}
  };
  try{
    if(!Number.isSafeInteger(child.pid)||child.pid<=0)throw spawnError??Error('YANDEX_PROCESS_DID_NOT_START');
    let endpoint;
    const until=Date.now()+20000;
    while(Date.now()<until){
      if(spawnError)throw spawnError;
      if(exited)throw Error('YANDEX_EXITED_BEFORE_CONNECTION');
      if(fs.existsSync(activePort)){
        if(fs.lstatSync(activePort).isSymbolicLink())throw Error('DEBUG_PORT_FILE_SYMLINK_PROHIBITED');
        const lines=fs.readFileSync(activePort,'utf8').trim().split(/\r?\n/);
        const port=Number(lines[0]);
        if(Number.isInteger(port)&&port>=1&&port<=65535&&/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(lines[1]??'')){
          endpoint='ws://127.0.0.1:'+port+lines[1];break;
        }
      }
      await delay(50);
    }
    if(!endpoint)throw Error('YANDEX_LOCAL_DEBUG_PORT_TIMEOUT');
    if(typeof chromium.connectOverCDP!=='function')throw Error('CHROMIUM_CDP_CONNECT_REQUIRED');
    browser=await chromium.connectOverCDP(endpoint,{timeout:8000});
    const contexts=browser.contexts();
    if(contexts.length!==1)throw Error('YANDEX_CONTEXT_AMBIGUOUS');
    return {context:contexts[0],closeOwned};
  }catch(error){
    try{await closeOwned();}catch(closeError){error.cleanupError=closeError.message;error.ownedProcessStillRunning=true;}
    throw error;
  }
}

/** Start only an application-owned profile; never copy or attach a daily profile.
 * driver/tabFactory are trusted-host test seams, not serialized configuration. */
async function connectLaunched(options) {
  const {browserId,dataDirectory,headless=false,driver,tabFactory,executablePath,frameScope='strict'}=options;
  if(!['strict','top-document'].includes(frameScope))throw Error('INVALID_FRAME_SCOPE');
  if(typeof headless!=='boolean')throw Error('HEADLESS_MUST_BE_BOOLEAN');
  let executable,sourceEvidence=browserId==='yandex'?'explicit_yandex_executable':'playwright_installed_channel';
  if(browserId==='yandex'&&executablePath===undefined)throw Error('YANDEX_EXECUTABLE_PATH_REQUIRED');
  if(executablePath!==undefined){
    if(typeof executablePath!=='string'||!path.isAbsolute(executablePath))throw Error('BROWSER_EXECUTABLE_PATH_MUST_BE_ABSOLUTE');
    if(!fs.statSync(executablePath).isFile())throw Error('BROWSER_EXECUTABLE_NOT_A_FILE');
    executable=fs.realpathSync(executablePath);
    if(browserId==='chrome')sourceEvidence=await validateChromeExecutableSource(executable);
    else sourceEvidence='explicit_'+browserId+'_executable';
  }
  const owned=acquireProfile(dataDirectory,browserId);
  let context,session,tab,page,closed=false,contextClosed=false,closePromise,closeOwned,spawned=false;
  const release=()=>owned.release();
  try{
    const chromium=driver??(await import('playwright')).chromium;
    if(browserId==='yandex'){
      spawned=true;
      const native=await launchedYandex({chromium,executable,owned,headless,spawnBrowser:options.spawnBrowser,terminateOwnedProcess:options.terminateOwnedProcess,onExit:()=>{contextClosed=true;closed=true;release();}});
      context=native.context;closeOwned=native.closeOwned;
    }else{
      if(typeof chromium?.launchPersistentContext!=='function')throw Error('CHROMIUM_DRIVER_REQUIRED');
      context=await chromium.launchPersistentContext(owned.profile,{headless,chromiumSandbox:true,
        ...(executable?{executablePath:executable}:{channel:browserId==='edge'?'msedge':'chrome'})});
      closeOwned=async()=>{await context.close();contextClosed=true;release();};
    }
    context.on?.('close',()=>{closed=true;if(!spawned){contextClosed=true;release();}});
    context.setDefaultTimeout?.(15000);
    page=await context.newPage(); // Select a fresh, owned target, not a restored user tab.
    session=await context.newCDPSession(page);
    const target=(await session.send('Target.getTargetInfo')).targetInfo;
    if(!hasId(target?.targetId))throw Error('BROWSER_TARGET_UNAVAILABLE');
    const targetId=target.targetId;
    const verifyIdentity=async()=>{
      if(closed||contextClosed||page.isClosed())throw Error('BROWSER_CONNECTION_CLOSED');
      const [version,current]=await Promise.all([session.send('Browser.getVersion'),session.send('Target.getTargetInfo')]);
      if(closed||contextClosed||page.isClosed())throw Error('BROWSER_CONNECTION_CLOSED');
      if(!brandMatches(browserId,version))throw Error('BROWSER_BRAND_MISMATCH');
      if(current.targetInfo?.targetId!==targetId)throw Error('BROWSER_TARGET_CHANGED');
      return {ok:true,...provenIdentity(browserId,'playwright',{
        browserId,targetId,browserVersion:selectedVersion(browserId,version),identityVerified:true
      },targetId)};
    };
    const first=await verifyIdentity();
    const identity=Object.freeze(Object.fromEntries(Object.entries(first).filter(([key])=>key!=='ok')));
    const createTab=tabFactory??(await import('./chromium-tab.mjs')).createChromiumTab;
    tab=await createTab({page,identityCheck:verifyIdentity,frameScope});
    assertTab(tab);
    return {
      tab,page,identity,verifyIdentity,sourceEvidence,
      close(){
        if(closePromise)return closePromise;
        closed=true;
        closePromise=(async()=>{
          try{await tab.close?.();}catch{}
          // For Yandex, Browser.close precedes detaching the session so the
          // separately owned browser process really exits.
          await closeOwned(session);
          try{await session.detach();}catch{}
          contextClosed=true;release();
          return {closed:true,ownedBrowser:true};
        })();
        return closePromise;
      }
    };
  }catch(error){
    let settled=!context&&!error.ownedProcessStillRunning;
    if(tab)try{await tab.close?.();}catch{}
    if(context&&closeOwned)try{await closeOwned(session);settled=true;}catch{}
    if(session)try{await session.detach();}catch{}
    if(settled||contextClosed)release();
    throw error;
  }
}
export async function connectBrowser(options={}) {
  const browserId=requireBrowserId(options.browserId);
  if(options.mode==='cua')return connectCua({...options,browserId});
  if(options.mode==='launch')return connectLaunched({...options,browserId});
  throw Error('BROWSER_MODE_MUST_BE_CUA_OR_LAUNCH');
}
export function forBrowser(browserId,options={}) {
  requireBrowserId(browserId);
  if(options.browserId!==undefined&&options.browserId!==browserId)throw Error('BROWSER_ENTRY_OVERRIDE_PROHIBITED');
  return connectBrowser({...options,browserId});
}
