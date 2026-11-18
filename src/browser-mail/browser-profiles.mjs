import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const BROWSER_IDS = Object.freeze(['edge','chrome','yandex']);
export function requireBrowserId(value) {
  if (!BROWSER_IDS.includes(value)) throw Error('BROWSER_ID_MUST_BE_EDGE_CHROME_OR_YANDEX');
  return value;
}
function rejectDefaultProfile(value) {
  if (typeof value !== 'string' || !value.trim()) throw Error('DEDICATED_DATA_DIRECTORY_REQUIRED');
  const p=value.replaceAll('\\','/').toLowerCase();
  if (/(?:^|\/)(?:google\/chrome(?: beta| dev| sxs| canary)?|microsoft\/edge(?: beta| dev| sxs| canary)?|chromium|yandex\/yandexbrowser|yandexbrowser)\/user data(?:\/|$)/.test(p)
    || /(?:^|\/)\.config\/(?:google-chrome(?:-[^/]+)?|chromium|microsoft-edge(?:-[^/]+)?|yandex-browser(?:-[^/]+)?)(?:\/|$)/.test(p)
    || /(?:^|\/)library\/application support\/(?:google\/chrome(?: beta| dev| canary)?|microsoft edge(?: beta| dev| canary)?|chromium|yandex(?:browser)?)(?:\/|$)/.test(p)) {
    throw Error('DEFAULT_BROWSER_PROFILE_PROHIBITED');
  }
}
function noLinks(target) {
  let current=path.resolve(target);
  for (;;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('PROFILE_SYMLINK_PROHIBITED');
    const parent=path.dirname(current);if(parent===current)break;current=parent;
  }
}
export function profileDirectory(dataDirectory,browserId) {
  requireBrowserId(browserId);rejectDefaultProfile(dataDirectory);
  const root=path.resolve(dataDirectory);
  if(root===path.parse(root).root)throw Error('DEDICATED_DATA_DIRECTORY_REQUIRED');
  noLinks(root);if(fs.existsSync(root))rejectDefaultProfile(fs.realpathSync(root));
  const profile=path.join(root,'profiles',browserId);noLinks(profile);
  return profile;
}
/** Owns only the selected application profile lock. Account locking is separate. */
export function acquireProfile(dataDirectory,browserId) {
  const profile=profileDirectory(dataDirectory,browserId);
  fs.mkdirSync(profile,{recursive:true,mode:0o700});noLinks(profile);
  rejectDefaultProfile(fs.realpathSync(profile));
  const marker=path.join(profile,'.browser-mail-profile.json');
  if(!fs.existsSync(marker)) {
    if(fs.readdirSync(profile).length)throw Error('EXISTING_UNOWNED_PROFILE_PROHIBITED');
    try{fs.writeFileSync(marker,JSON.stringify({application:'harness-browser-mail',schema:1,browserId}),{flag:'wx',mode:0o600});}
    catch(error){if(error.code!=='EEXIST')throw error;}
  }
  if(fs.lstatSync(marker).isSymbolicLink())throw Error('PROFILE_MARKER_SYMLINK_PROHIBITED');
  const owner=JSON.parse(fs.readFileSync(marker,'utf8'));
  if(owner.application!=='harness-browser-mail'||owner.schema!==1||owner.browserId!==browserId)throw Error('PROFILE_OWNER_MISMATCH');
  const lockPath=path.join(profile,'.browser-mail-connection.lock');let fd;
  try{fd=fs.openSync(lockPath,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw Error('BROWSER_PROFILE_BUSY');throw error;}
  const stat=fs.fstatSync(fd),token=randomUUID();let released=false;
  const release=()=>{
    if(released)return;released=true;
    try{fs.closeSync(fd);}finally{
      try{
        const current=fs.statSync(lockPath);
        const record=JSON.parse(fs.readFileSync(lockPath,'utf8'));
        if(current.dev===stat.dev&&current.ino===stat.ino&&record.token===token)fs.unlinkSync(lockPath);
      }catch{} // A changed or unreadable lock is preserved, never blindly removed.
    }
  };
  try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,browserId,token,createdAt:new Date().toISOString()}));fs.fsyncSync(fd);}
  catch(error){try{fs.closeSync(fd);}catch{}try{const current=fs.statSync(lockPath);if(current.dev===stat.dev&&current.ino===stat.ino)fs.unlinkSync(lockPath);}catch{}released=true;throw error;}
  return {profile,lockPath,release};
}
