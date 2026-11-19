import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const positivePid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function entryExists(filename) {
  try { fs.lstatSync(filename); return true; }
  catch (error) { return error.code !== 'ENOENT'; }
}

function noLinks(target) {
  let current = path.resolve(target);
  for (;;) {
    try { if (fs.lstatSync(current).isSymbolicLink()) return false; }
    catch (error) { if (error.code !== 'ENOENT') return false; }
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function fileSnapshot(filename) {
  if (!noLinks(filename)) return null;
  try {
    const before = fs.lstatSync(filename, {bigint:true});
    if (!before.isFile() || before.nlink !== 1n || before.size > 4096n) return null;
    const bytes = fs.readFileSync(filename);
    const after = fs.lstatSync(filename, {bigint:true});
    if (!sameStat(before, after)) return null;
    return {filename, bytes, stat:after};
  } catch { return null; }
}

function sameStat(a, b) {
  return ['dev','ino','mode','nlink','size','mtimeNs','ctimeNs'].every(key => a[key] === b[key]);
}

function unchanged(snapshot) {
  const current = fileSnapshot(snapshot.filename);
  return !!current && sameStat(snapshot.stat, current.stat) && current.bytes.equals(snapshot.bytes);
}

function jsonObject(snapshot) {
  try {
    const value = JSON.parse(snapshot.bytes.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

export function isPidProvablyDead(pid) {
  if (!positivePid(pid)) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

// Parse Windows command-line quoting without invoking another shell. An
// incomplete quoted argument is unknown, never evidence that a profile is free.
export function splitWindowsCommandLine(commandLine) {
  if (typeof commandLine !== 'string' || !commandLine.trim() || commandLine.length > 32768) return null;
  const args = [];
  let value = '', quoted = false, started = false;
  for (let i = 0; i < commandLine.length; i++) {
    const char = commandLine[i];
    if (!quoted && /\s/.test(char)) {
      if (started) { args.push(value); value = ''; started = false; }
      continue;
    }
    started = true;
    if (char === '\\') {
      let end = i;
      while (commandLine[end] === '\\') end++;
      const count = end - i;
      if (commandLine[end] === '"') {
        value += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) value += '"'; else quoted = !quoted;
        i = end;
      } else { value += '\\'.repeat(count); i = end - 1; }
    } else if (char === '"') quoted = !quoted;
    else value += char;
  }
  if (quoted) return null;
  if (started) args.push(value);
  return args;
}

function windowsDrive(value) {
  if (typeof value !== 'string' || !path.win32.isAbsolute(value)) return null;
  return /^[a-z]:/i.exec(value)?.[0].toUpperCase() ?? null;
}

function windowsCanonical(value, canonicalize) {
  if (!windowsDrive(value)) return null;
  let resolved;
  try { resolved = canonicalize(value); } catch { return null; }
  if (!windowsDrive(resolved)) return null;
  return path.win32.normalize(resolved).replace(/[\\/]+$/, '').toLowerCase();
}

export function commandLineUsesProfile(commandLine, profile, {canonicalize=fs.realpathSync.native}={}) {
  const args = splitWindowsCommandLine(commandLine);
  const expected = windowsCanonical(profile, canonicalize);
  if (!args || !expected) return null;
  const values = [];
  for (let i = 1; i < args.length; i++) {
    const flag = args[i].toLowerCase();
    if (flag === '--user-data-dir') {
      if (!args[i+1] || args[i+1].startsWith('--')) return null;
      values.push(args[++i]);
    } else if (flag.startsWith('--user-data-dir=')) values.push(args[i].slice('--user-data-dir='.length));
  }
  if (values.length > 1) return null;
  if (!values.length) return false;
  const actual = windowsCanonical(values[0], canonicalize);
  return actual === null ? null : actual === expected;
}

/** Successful enumeration plus an exact canonical profile argument is required.
 * A failed query, inaccessible command line or ambiguous argument preserves locks.
 * Command lines are consumed locally and are not included in the result. */
export async function inspectWindowsChromeProfile(profile, {
  stateDirectory = profile, platform = process.platform, execute = execFileAsync,
  canonicalize = fs.realpathSync.native
} = {}) {
  const unknown = {known:false, active:false};
  if (platform !== 'win32') return unknown;
  const profilePath = windowsCanonical(profile, canonicalize);
  const statePath = windowsCanonical(stateDirectory, canonicalize);
  if (!profilePath || !statePath) return unknown;
  try {
    const script = [
      "$ErrorActionPreference='Stop'",
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$disks=@(Get-CimInstance Win32_LogicalDisk -Filter "DriveType = 3" | Select-Object -ExpandProperty DeviceID)',
      '$processes=@(Get-CimInstance Win32_Process -Filter "Name = \'chrome.exe\'" | Select-Object CommandLine)',
      'ConvertTo-Json -InputObject @{localDrives=$disks; processes=$processes} -Compress'
    ].join('; ');
    const result = await execute('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script],
      {windowsHide:true, timeout:10000, maxBuffer:1048576, encoding:'utf8'});
    const snapshot = JSON.parse(String(result.stdout).trim());
    if (!Array.isArray(snapshot.localDrives) || !Array.isArray(snapshot.processes)
        || ![profilePath, statePath].every(value => snapshot.localDrives.includes(windowsDrive(value)))) return unknown;
    let ambiguous = false;
    for (const row of snapshot.processes) {
      const match = commandLineUsesProfile(row?.CommandLine, profilePath, {canonicalize});
      if (match === true) return {known:true, active:true};
      if (match === null) ambiguous = true;
    }
    return {known:!ambiguous, active:false};
  } catch { return unknown; }
}

function backupUnchangedLock({snapshot, marker, backup, blocked}) {
  const claim = snapshot.filename + '.recovery';
  let fd;
  try { fd = fs.openSync(claim, 'wx', 0o600); }
  catch { return 'recovery_busy_or_unavailable'; }
  let stat;
  try {
    stat = fs.fstatSync(fd, {bigint:true});
    if (blocked()) return 'profile_lock_unresolved';
    if (!unchanged(marker) || !unchanged(snapshot)) return 'lock_or_marker_changed';
    if (entryExists(backup)) return 'backup_already_exists';
    fs.renameSync(snapshot.filename, backup);
    return null;
  } catch { return 'backup_rename_failed'; }
  finally {
    try { fs.closeSync(fd); } catch {}
    try {
      const current = fs.lstatSync(claim, {bigint:true});
      if (stat && sameStat(stat, current)) fs.unlinkSync(claim);
    } catch {}
  }
}

/** Recover only the two application-owned startup locks, never account locks.
 * Each original is atomically renamed next to itself, retaining its exact bytes.
 * This function does not inspect or alter browser data, mail or processes. */
export async function recoverStaleBridgeLocks({dataDirectory, profileDataDirectory, executablePath,
  isProcessDead=isPidProvablyDead, inspectChrome=inspectWindowsChromeProfile,
  now=() => new Date(), uniqueId=randomUUID}={}) {
  if (typeof dataDirectory !== 'string' || typeof profileDataDirectory !== 'string'
      || !path.isAbsolute(dataDirectory) || !path.isAbsolute(profileDataDirectory))
    throw new Error('STALE_RECOVERY_ABSOLUTE_DIRECTORIES_REQUIRED');
  const stateRoot = path.resolve(dataDirectory);
  const profile = path.join(path.resolve(profileDataDirectory), 'profiles', 'chrome');
  const results = [];
  if (executablePath && path.win32.basename(executablePath).toLowerCase() !== 'chrome.exe')
    return {recovered:[], preserved:[{reason:'chrome_executable_unverified'}]};
  if (!noLinks(stateRoot) || !noLinks(profile)) return {recovered:[], preserved:[{reason:'directory_link_or_unreadable'}]};
  const marker = fileSnapshot(path.join(profile, '.browser-mail-profile.json'));
  const owner = marker && jsonObject(marker);
  if (!owner || owner.application !== 'harness-browser-mail' || owner.schema !== 1 || owner.browserId !== 'chrome')
    return {recovered:[], preserved:[{reason:'owned_profile_marker_unverified'}]};
  let canonicalProfile;
  try { canonicalProfile = fs.realpathSync.native(profile); }
  catch { return {recovered:[], preserved:[{reason:'profile_unreadable'}]}; }
  const targets = [
    {kind:'profile', filename:path.join(profile, '.browser-mail-connection.lock')},
    {kind:'workflow', filename:path.join(stateRoot, 'state.lock')}
  ];
  let profileLockUnresolved = entryExists(targets[0].filename);
  for (const target of targets) {
    if (!entryExists(target.filename)) continue;
    if (target.kind === 'workflow' && profileLockUnresolved) {
      results.push({kind:target.kind, path:target.filename, recovered:false, reason:'profile_lock_unresolved'});
      continue;
    }
    const snapshot = fileSnapshot(target.filename);
    const record = snapshot && jsonObject(snapshot);
    const valid = record && positivePid(record.pid) && (target.kind === 'profile'
      ? Object.keys(record).length === 4 && record.browserId === 'chrome' && typeof record.token === 'string' && uuid.test(record.token) && typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt))
      : Object.keys(record).length === 1);
    const preserve = reason => results.push({kind:target.kind, path:target.filename, recovered:false, reason});
    if (!valid) { preserve('lock_record_unverified'); continue; }
    let dead;
    try { dead = await isProcessDead(record.pid); } catch { dead = false; }
    if (dead !== true) { preserve('owner_not_provably_dead'); continue; }
    let browser;
    try {
      browser = await inspectChrome(canonicalProfile, {stateDirectory: target.kind === 'workflow' ? stateRoot : canonicalProfile});
    } catch { browser = null; }
    if (browser?.known !== true || browser.active !== false) { preserve('profile_use_not_excluded'); continue; }
    // No await occurs between this last filesystem validation and the rename.
    // Recheck both ownership evidence and the dead PID after browser enumeration.
    try { dead = await isProcessDead(record.pid); } catch { dead = false; }
    if (dead !== true) { preserve('owner_became_live_or_unknown'); continue; }
    if (!unchanged(marker) || !unchanged(snapshot)) { preserve('lock_or_marker_changed'); continue; }
    let stamp, token;
    try { stamp = now().toISOString().replace(/[^0-9TZ]/g,''); token = uniqueId(); }
    catch { preserve('backup_name_unavailable'); continue; }
    if (!uuid.test(token)) { preserve('backup_name_unavailable'); continue; }
    const backup = target.filename + '.stale-' + stamp + '-' + token + '.json';
    if (path.dirname(backup) !== path.dirname(target.filename) || entryExists(backup)) { preserve('backup_already_exists'); continue; }
    const failure = backupUnchangedLock({
      snapshot, marker, backup,
      blocked: () => target.kind === 'workflow' && entryExists(targets[0].filename)
    });
    if (failure) { preserve(failure); continue; }
    if (target.kind === 'profile') profileLockUnresolved = false;
    results.push({kind:target.kind, path:target.filename, recovered:true, backup, ownerPid:record.pid});
  }
  return {recovered:results.filter(item=>item.recovered), preserved:results.filter(item=>!item.recovered)};
}
