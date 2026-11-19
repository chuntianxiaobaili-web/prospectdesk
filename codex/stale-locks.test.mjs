import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {recoverStaleBridgeLocks, splitWindowsCommandLine, commandLineUsesProfile,
  inspectWindowsChromeProfile} from './stale-locks.mjs';

const token = '11111111-2222-4333-8444-555555555555';
const deadPid = 197531;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prospectdesk-stale-lock-test-'));
  const dataDirectory = path.join(root, 'state');
  const profileDataDirectory = path.join(root, 'chrome-data');
  const profile = path.join(profileDataDirectory, 'profiles', 'chrome');
  fs.mkdirSync(dataDirectory, {recursive:true});
  fs.mkdirSync(profile, {recursive:true});
  const marker = path.join(profile, '.browser-mail-profile.json');
  const profileLock = path.join(profile, '.browser-mail-connection.lock');
  const stateLock = path.join(dataDirectory, 'state.lock');
  fs.writeFileSync(marker, JSON.stringify({application:'harness-browser-mail', schema:1, browserId:'chrome'}));
  const profileBytes = JSON.stringify({pid:deadPid, browserId:'chrome', token, createdAt:'2026-11-19T08:22:18.483Z'});
  const stateBytes = JSON.stringify({pid:deadPid});
  fs.writeFileSync(profileLock, profileBytes);
  fs.writeFileSync(stateLock, stateBytes);
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const options = {dataDirectory, profileDataDirectory, isProcessDead:() => true,
    inspectChrome:async () => ({known:true, active:false}),
    now:() => new Date('2026-11-19T09:04:00.000Z'), uniqueId:() => token};
  return {root, dataDirectory, profileDataDirectory, profile, marker, profileLock, stateLock,
    profileBytes, stateBytes, options};
}

test('dead owned profile and workflow locks are renamed with original bytes retained', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dataDirectory,'account-locks'));
  const accountLock = path.join(f.dataDirectory,'account-locks','account.lock');
  fs.writeFileSync(accountLock,'untouched');
  const history = path.join(f.dataDirectory,'state.json');
  fs.writeFileSync(history,'existing send and draft history');
  const browserData = path.join(f.profile,'Preferences');
  fs.writeFileSync(browserData,'existing profile data');
  const result = await recoverStaleBridgeLocks(f.options);
  assert.deepEqual(result.recovered.map(r=>r.kind), ['profile','workflow']);
  assert.equal(result.preserved.length,0);
  assert.equal(fs.existsSync(f.profileLock),false);
  assert.equal(fs.existsSync(f.stateLock),false);
  assert.equal(fs.readFileSync(result.recovered[0].backup,'utf8'),f.profileBytes);
  assert.equal(fs.readFileSync(result.recovered[1].backup,'utf8'),f.stateBytes);
  assert.equal(fs.readFileSync(accountLock,'utf8'),'untouched');
  assert.equal(fs.readFileSync(history,'utf8'),'existing send and draft history');
  assert.equal(fs.readFileSync(browserData,'utf8'),'existing profile data');
  assert.equal(fs.existsSync(f.profileLock+'.recovery'),false);
  assert.equal(fs.existsSync(f.stateLock+'.recovery'),false);
});

test('live or unknown owners preserve both locks without inspecting Chrome', async t => {
  const f = fixture(t);
  let inspected=0;
  const result = await recoverStaleBridgeLocks({...f.options, isProcessDead:() => false,
    inspectChrome:async () => { inspected++; return {known:true,active:false}; }});
  assert.equal(result.recovered.length,0);
  assert.equal(inspected,0);
  assert.equal(fs.readFileSync(f.profileLock,'utf8'),f.profileBytes);
  assert.equal(fs.readFileSync(f.stateLock,'utf8'),f.stateBytes);
});

test('a process probe error including EPERM is not treated as a dead owner', async t => {
  const f = fixture(t);
  const result = await recoverStaleBridgeLocks({...f.options, isProcessDead:() => {throw Object.assign(new Error('denied'),{code:'EPERM'});}});
  assert.equal(result.recovered.length,0);
  assert.equal(result.preserved[0].reason,'owner_not_provably_dead');
});

test('active Chrome and failed Chrome enumeration both preserve locks', async t => {
  const f = fixture(t);
  for (const browser of [{known:true,active:true},{known:false,active:false}]) {
    const result = await recoverStaleBridgeLocks({...f.options,inspectChrome:async()=>browser});
    assert.equal(result.recovered.length,0);
    assert.equal(result.preserved[0].reason,'profile_use_not_excluded');
  }
  assert.equal(fs.readFileSync(f.profileLock,'utf8'),f.profileBytes);
});

test('malformed lock and unowned profile marker cannot authorize recovery', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.profileLock,'{not json');
  const malformed = await recoverStaleBridgeLocks(f.options);
  assert.equal(malformed.recovered.length,0);
  assert.equal(malformed.preserved[0].reason,'lock_record_unverified');
  fs.writeFileSync(f.marker,JSON.stringify({application:'someone-else',schema:1,browserId:'chrome'}));
  const unowned = await recoverStaleBridgeLocks(f.options);
  assert.equal(unowned.recovered.length,0);
  assert.equal(unowned.preserved[0].reason,'owned_profile_marker_unverified');
});

test('a lock changed during browser inspection is preserved', async t => {
  const f = fixture(t);
  const changed = JSON.stringify({pid:deadPid+1,browserId:'chrome',token,createdAt:'2026-11-19T09:00:00Z'});
  const result = await recoverStaleBridgeLocks({...f.options,inspectChrome:async()=>{
    fs.writeFileSync(f.profileLock,changed);return {known:true,active:false};
  }});
  assert.equal(result.recovered.length,0);
  assert.equal(result.preserved[0].reason,'lock_or_marker_changed');
  assert.equal(fs.readFileSync(f.profileLock,'utf8'),changed);
});

test('an owner becoming live during inspection is preserved', async t => {
  const f = fixture(t);
  let probes=0;
  const result = await recoverStaleBridgeLocks({...f.options,isProcessDead:()=>++probes===1});
  assert.equal(result.recovered.length,0);
  assert.equal(result.preserved[0].reason,'owner_became_live_or_unknown');
});

test('file symlinks never move a lock or its target', async t => {
  const f = fixture(t);
  const outside = path.join(f.root,'outside.json');
  fs.writeFileSync(outside,f.profileBytes);
  fs.unlinkSync(f.profileLock);
  try { fs.symlinkSync(outside,f.profileLock,'file'); }
  catch (error) { if (['EPERM','EACCES','ENOSYS'].includes(error.code)) {t.skip('Host cannot create test symlink');return;}throw error; }
  const result = await recoverStaleBridgeLocks(f.options);
  assert.equal(result.recovered.length,0);
  assert.equal(fs.lstatSync(f.profileLock).isSymbolicLink(),true);
  assert.equal(fs.readFileSync(outside,'utf8'),f.profileBytes);
});

test('state-only stale recovery still requires verified profile ownership and absence', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.profileLock);
  const result = await recoverStaleBridgeLocks(f.options);
  assert.deepEqual(result.recovered.map(r=>r.kind),['workflow']);
  assert.equal(fs.readFileSync(result.recovered[0].backup,'utf8'),f.stateBytes);
});

test('a dangling profile-lock symlink also preserves the workflow lock', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.profileLock);
  try { fs.symlinkSync(path.join(f.root,'missing.json'),f.profileLock,'file'); }
  catch (error) { if (['EPERM','EACCES','ENOSYS'].includes(error.code)) {t.skip('Host cannot create test symlink');return;}throw error; }
  const result = await recoverStaleBridgeLocks(f.options);
  assert.equal(result.recovered.length,0);
  assert.equal(fs.lstatSync(f.profileLock).isSymbolicLink(),true);
  assert.equal(fs.readFileSync(f.stateLock,'utf8'),f.stateBytes);
});

test('Windows command-line profile matching is exact and quote-aware', () => {
  const canonicalize=value=>value;
  const profile='C:\\Dedicated Mail\\profiles\\chrome';
  assert.deepEqual(splitWindowsCommandLine('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "--user-data-dir=C:\\Dedicated Mail\\profiles\\chrome" --flag'),
    ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','--user-data-dir=C:\\Dedicated Mail\\profiles\\chrome','--flag']);
  assert.equal(commandLineUsesProfile('chrome.exe "--user-data-dir=C:\\Dedicated Mail\\profiles\\chrome"',profile,{canonicalize}),true);
  assert.equal(commandLineUsesProfile('chrome.exe --user-data-dir "c:\\dedicated mail\\profiles\\CHROME\\"',profile,{canonicalize}),null);
  assert.equal(commandLineUsesProfile('chrome.exe --user-data-dir="C:\\Dedicated Mail\\profiles\\chrome"',profile,{canonicalize}),true);
  assert.equal(commandLineUsesProfile('chrome.exe --USER-DATA-DIR="C:\\Dedicated Mail\\profiles\\chrome"',profile,{canonicalize}),true);
  assert.equal(commandLineUsesProfile('chrome.exe --user-data-dir="C:\\Dedicated Mail\\profiles\\chrome-other"',profile,{canonicalize}),false);
  assert.equal(commandLineUsesProfile('chrome.exe --user-data-dir=relative',profile,{canonicalize}),null);
  assert.equal(commandLineUsesProfile('chrome.exe --user-data-dir="C:\\unterminated',profile,{canonicalize}),null);
  assert.equal(commandLineUsesProfile('chrome.exe --type=renderer',profile,{canonicalize}),false);
  assert.equal(commandLineUsesProfile('chrome.exe --user-data-dir=C:\\x --user-data-dir=C:\\y',profile,{canonicalize}),null);
});

test('Windows enumeration requires local disks and unambiguous Chrome process data', async () => {
  const profile = 'C:\\Dedicated Mail\\profiles\\chrome';
  const report = (processes, localDrives = ['C:']) => async () => ({
    stdout: JSON.stringify({localDrives, processes})
  });
  const options = {platform:'win32', canonicalize:value=>value};
  const unknown = {known:false, active:false};
  assert.deepEqual(await inspectWindowsChromeProfile(profile,{...options,execute:report([{CommandLine:null}])}),unknown);
  assert.deepEqual(await inspectWindowsChromeProfile(profile,{...options,execute:report([])}),{known:true,active:false});
  assert.deepEqual(await inspectWindowsChromeProfile(profile,{...options,execute:report([{CommandLine:'chrome.exe "--user-data-dir=C:\\Dedicated Mail\\profiles\\chrome"'}])}),{known:true,active:true});
  assert.deepEqual(await inspectWindowsChromeProfile(profile,{...options,execute:report([],['D:'])}),unknown);
  assert.deepEqual(await inspectWindowsChromeProfile(profile,{...options,stateDirectory:'Q:\\Shared State',execute:report([])}),unknown);
  assert.deepEqual(await inspectWindowsChromeProfile('\\\\other-host\\share\\chrome',{...options,execute:report([])}),unknown);
  assert.deepEqual(await inspectWindowsChromeProfile(profile,{...options,execute:async()=>{throw new Error('CIM unavailable');}}),unknown);
  assert.deepEqual(await inspectWindowsChromeProfile(profile,{...options,platform:'linux',execute:report([])}),unknown);
});

test('an unresolved Windows profile alias never counts as a confirmed mismatch', () => {
  const profile = 'C:\\Dedicated Mail\\profiles\\chrome';
  const canonicalize = value => {
    if (value.startsWith('Q:')) throw new Error('inaccessible');
    return value;
  };
  assert.equal(commandLineUsesProfile('chrome.exe --user-data-dir=Q:\\Restricted\\Chrome',profile,{canonicalize}),null);
});

test('foreign host records and custom browser executable names preserve locks', async t => {
  const f = fixture(t);
  const browser = await recoverStaleBridgeLocks({...f.options,executablePath:'C:\\custom\\chromium.exe'});
  assert.equal(browser.preserved[0].reason,'chrome_executable_unverified');
  fs.writeFileSync(f.profileLock,JSON.stringify({...JSON.parse(f.profileBytes),hostname:'other-host'}));
  const result = await recoverStaleBridgeLocks(f.options);
  assert.equal(result.recovered.length,0);
  assert.equal(result.preserved[0].reason,'lock_record_unverified');
  assert.equal(fs.readFileSync(f.stateLock,'utf8'),f.stateBytes);
  fs.unlinkSync(f.profileLock);
  fs.writeFileSync(f.stateLock,JSON.stringify({pid:deadPid,hostname:'other-host'}));
  const state = await recoverStaleBridgeLocks(f.options);
  assert.equal(state.recovered.length,0);
  assert.equal(state.preserved[0].reason,'lock_record_unverified');
});

test('a competing recovery claim preserves both originals', async t => {
  const f = fixture(t);
  const claim = f.profileLock + '.recovery';
  fs.writeFileSync(claim,'another recovery');
  const result = await recoverStaleBridgeLocks(f.options);
  assert.equal(result.recovered.length,0);
  assert.equal(result.preserved[0].reason,'recovery_busy_or_unavailable');
  assert.equal(fs.readFileSync(f.profileLock,'utf8'),f.profileBytes);
  assert.equal(fs.readFileSync(f.stateLock,'utf8'),f.stateBytes);
  assert.equal(fs.readFileSync(claim,'utf8'),'another recovery');
});

test('a new browser connection appearing during workflow recovery preserves the state lock', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.profileLock);
  const result = await recoverStaleBridgeLocks({...f.options,inspectChrome:async () => {
    fs.writeFileSync(f.profileLock,JSON.stringify({pid:process.pid,browserId:'chrome',token,createdAt:'2026-11-19T09:00:00Z'}));
    return {known:true,active:false};
  }});
  assert.equal(result.recovered.length,0);
  assert.equal(result.preserved[0].reason,'profile_lock_unresolved');
  assert.equal(fs.readFileSync(f.stateLock,'utf8'),f.stateBytes);
});
