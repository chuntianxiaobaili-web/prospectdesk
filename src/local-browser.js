import fs from 'node:fs';
import path from 'node:path';
const channels=new Set(['chromium','chrome','msedge']);
export function assertDedicatedRoot(input){
  if(typeof input!=='string'||!input.trim())throw Error('Dedicated application data directory required');
  const p=input.replace(/\\/g,'/').toLowerCase();
  if(/(?:^|\/)(?:google\/chrome(?: beta| dev| sxs| canary)?|microsoft\/edge(?: beta| dev| sxs| canary)?|chromium)\/user data(?:\/|$)/.test(p)||/(?:^|\/)\.config\/(?:google-chrome(?:-(?:beta|unstable|dev|canary))?|chromium|microsoft-edge(?:-(?:beta|dev|canary))?)(?:\/|$)/.test(p)||/(?:^|\/)library\/application support\/(?:google\/chrome(?: beta| dev| canary)?|microsoft edge(?: beta| dev| canary)?|chromium)(?:\/|$)/.test(p))throw Error('Default browser profile trees are prohibited');
  return input;
}
export function noSymlinkAncestors(target){let current=path.resolve(target);for(;;){if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('Symlink/junction profile ancestry prohibited');const parent=path.dirname(current);if(parent===current)break;current=parent;}}
export function validateDataDirectory(input){assertDedicatedRoot(input);const root=path.resolve(input);noSymlinkAncestors(root);if(fs.existsSync(root))assertDedicatedRoot(fs.realpathSync(root));for(const child of ['browser-binaries','browser-profiles','demo-workflow','mock-mailbox',...['chromium','chrome','msedge'].map(x=>'browser-profiles/'+x)])noSymlinkAncestors(path.join(root,child));return root;}
export class DedicatedBrowser {
  constructor({dataDirectory,browser='chromium',driver,headless=false,onPause=()=>{}}){
    validateDataDirectory(dataDirectory);if(!channels.has(browser))throw Error('Supported browsers: chromium, chrome, msedge');
    this.root=path.resolve(dataDirectory);noSymlinkAncestors(this.root);if(fs.existsSync(this.root))assertDedicatedRoot(fs.realpathSync(this.root));
    this.browser=browser;this.driver=driver;this.headless=headless;this.onPause=onPause;this.profile=path.join(this.root,'browser-profiles',browser);this.state='closed';this.context=null;this.action=null;this.launching=false;this.lastError=null;
  }
  status(){return {state:this.state,browser:this.browser,profile:this.profile,busy:!!this.action,liveProviderSupported:false,lastError:this.lastError};}
  launch(){if(this.closing)return Promise.reject(Error('Browser is closing'));if(this.launchPromise)return this.launchPromise;const pending=this._launch();this.launchPromise=pending;pending.finally(()=>{if(this.launchPromise===pending)this.launchPromise=null;}).catch(()=>{});return pending;}
  async _launch(){
    if(this.context)return this.status();if(this.action||this.lockFd!=null)throw Error('Previous browser action/lock must settle before relaunch');if(this.launching)throw Error('Browser launch already in progress');this.launching=true;let acquired=false;
    try{
      noSymlinkAncestors(this.profile);fs.mkdirSync(this.profile,{recursive:true,mode:0o700});assertDedicatedRoot(fs.realpathSync(this.profile));
      const marker=path.join(this.profile,'.b2b-dedicated-profile.json');
      if(!fs.existsSync(marker)){if(fs.readdirSync(this.profile).length)throw Error('Refusing existing unowned browser profile');fs.writeFileSync(marker,JSON.stringify({application:'b2b-sales-local',version:1}),{flag:'wx',mode:0o600});}
      else if(fs.lstatSync(marker).isSymbolicLink()||JSON.parse(fs.readFileSync(marker)).application!=='b2b-sales-local')throw Error('Profile ownership marker mismatch');
      this.lockPath=path.join(this.profile,'.controller.lock');this.lockFd=fs.openSync(this.lockPath,'wx',0o600);acquired=true;fs.writeFileSync(this.lockFd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
      const driver=this.driver??(await import('playwright')).chromium;
      this.context=await driver.launchPersistentContext(this.profile,{headless:this.headless,chromiumSandbox:true,...(this.browser==='chromium'?{}:{channel:this.browser})});
      this.context.setDefaultTimeout?.(30000);
      this.context.on?.('close',()=>{this.context=null;this.state='closed';this.abort?.abort();this.onPause();if(!this.action)this.releaseLock();});
      this.state='paused';this.lastError=null;return this.status();
    }catch(e){this.lastError=e.message;this.state='closed';if(acquired)this.releaseLock();throw e;}finally{this.launching=false;}
  }
  resumeAutomation(){if(!this.context)throw Error('Open dedicated browser first');if(this.action)throw Error('Wait for previous browser action');this.state='ready';return this.status();}
  pause(){this.abort?.abort();if(this.context)this.state='paused';this.onPause();return this.status();}
  async takeover(){this.pause();if(this.action)await this.action.catch(()=>{});if(this.context)this.state='manual';return this.status();}
  async runAutomation(fn){
    if(this.state!=='ready'||!this.context)throw Error('Browser is paused, manual, or closed');if(this.action)throw Error('One browser action at a time');
    this.abort=new AbortController();const context=this.context,signal=this.abort.signal;
    const active=Promise.resolve().then(()=>{if(signal.aborted)throw Error('Paused before browser action');return fn({context,signal});});this.action=active;
    try{return await active;}finally{if(this.action===active){this.action=null;this.abort=null;}if(!this.context)this.releaseLock();}
  }
  close(){if(this.closePromise)return this.closePromise;this.closing=true;const pending=this._close();this.closePromise=pending;pending.finally(()=>{this.closing=false;if(this.closePromise===pending)this.closePromise=null;}).catch(()=>{});return pending;}
  async _close(){this.pause();if(this.launchPromise)await this.launchPromise.catch(()=>{});const context=this.context;
    if(context)await context.close();if(this.action)await this.action.catch(()=>{});this.context=null;this.state='closed';this.releaseLock();return this.status();}
  releaseLock(){if(this.lockFd!=null){fs.closeSync(this.lockFd);this.lockFd=null;try{fs.unlinkSync(this.lockPath);}catch(e){if(e.code!=='ENOENT')throw e;}}}
}
