import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';

const copy = value => structuredClone(value);
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const entry of Object.values(value)) freeze(entry);
  }
  return value;
};
const keyOf = value => `${value.accountId}\u0000${value.draftId}`;
const fields = ['accountId', 'draftId', 'draftVersion', 'approvedHash'];
const hasText = value => typeof value === 'string' && value.trim().length > 0;
const MAX_TIMER_MS = 2147483647;
const RUNTIME_REMINDER_MS = 8 * 60 * 60 * 1000;
const terminalPhases = new Set(['target_reached', 'exhausted', 'stopped', 'deadline', 'halted']);

export class SessionStoppedError extends Error {
  constructor(reason) { super(reason); this.name = 'SessionStoppedError'; this.code = 'SESSION_STOPPED'; }
}

/** Synchronous, atomic writes keep the dispatch intent on disk before the click. */
export class AtomicJsonJournal {
  constructor(filename) {
    this.filename = path.resolve(filename);
    fs.mkdirSync(path.dirname(this.filename), {recursive: true});
    let fd;
    try { fd = fs.openSync(this.filename, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw Error('Journal already exists; never reuse an earlier run journal');
      throw error;
    }
    try {
      fs.writeFileSync(fd, '{"reserved":true,"status":"not_started"}\n', 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
  save(state) {
    const temporary = `${this.filename}.writing`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.filename);
  }
}

/**
 * Independent browser-controller acceptance run, not the research/drafting core.
 * The adapter owns UI details. Its beforeClick hook MUST be awaited immediately
 * before the exact send/delete UI call, without any intervening awaited work.
 * send/reconcile must return authoritative evidence, not just a successful click.
 * This class never schedules random timing and never retries an uncertain send.
 */
export class MailSessionRunner {
  constructor({adapter, durationMs = null, target = 50, intervalMs = 72000,
    prepareAheadMs = 0, retainSentDrafts = false, journalPath, store, clock, timers, sleep, onRuntimeReminder = null} = {}) {
    if (!adapter) throw Error('A browser adapter is required');
    for (const name of ['scanDrafts', 'inspectDraft', 'preflight', 'send', 'reconcile', 'cleanup', 'countDrafts']) {
      if (typeof adapter[name] !== 'function') throw Error(`Adapter method missing: ${name}`);
    }
    if (durationMs !== null && (!Number.isSafeInteger(durationMs) || durationMs <= 0)) throw Error('durationMs must be a positive safe integer or null');
    if (onRuntimeReminder !== null && typeof onRuntimeReminder !== 'function') throw Error('onRuntimeReminder must be a function or null');
    if (!Number.isInteger(target) || target < 1) throw Error('target must be a positive integer');
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw Error('intervalMs must be positive');
    if (typeof retainSentDrafts !== 'boolean') throw Error('retainSentDrafts must be a boolean');
    if (!Number.isFinite(prepareAheadMs) || prepareAheadMs < 0 || prepareAheadMs > 60000) {
      throw Error('prepareAheadMs must be between zero and 60000 milliseconds');
    }
    if (!journalPath && !store) throw Error('Provide journalPath or an explicit synchronous test store');
    this.adapter = adapter;
    this.clock = clock ?? {monotonic: () => performance.now(), wall: () => Date.now()};
    this.timers = timers ?? {setTimeout: (...args) => setTimeout(...args), clearTimeout: handle => clearTimeout(handle)};
    this.sleep = sleep ?? ((milliseconds, {signal} = {}) => new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new SessionStoppedError(String(signal.reason ?? 'stopped'))); return; }
      let handle;
      const onAbort = () => {
        this.timers.clearTimeout(handle);
        reject(new SessionStoppedError(String(signal.reason ?? 'stopped')));
      };
      signal?.addEventListener('abort', onAbort, {once: true});
      handle = this.timers.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
    }));
    this.store = store ?? new AtomicJsonJournal(journalPath);
    if (typeof this.store.save !== 'function') throw Error('The journal store requires a synchronous save function');
    this.timer = null;
    this.reminderTimer = null;
    this.startedMono = null;
    this.continuousStartedMono = null;
    this.onRuntimeReminder = onRuntimeReminder;
    this.reminderDelivery = null;
    this.busy = false;
    this.abort = new AbortController();
    this.deadlineMono = null;
    this.nextDueMono = null;
    this.state = {
      formatVersion: 1, kind: 'independent-browser-mail-controller', runId: randomUUID(),
      phase: 'new', createdAt: this.iso(), config: {durationMs, target, intervalMs, prepareAheadMs, retainSentDrafts},
      startedAt: null, deadlineAt: null, deadlineReached: false, stopReason: null,
      runtimeReminder: {thresholdMs: RUNTIME_REMINDER_MS, notificationId: null, dueAt: null, continuousStartedAt: null,
        notificationStatus: 'not_due', attemptedAt: null, deliveredAt: null},
      scanCoverage: null, initialMailboxCount: null, finalMailboxCount: null, records: [], exclusions: [], events: [],
    };
  }

  iso() { return new Date(this.clock.wall()).toISOString(); }

  persist(type, detail = {}) {
    this.state.events.push({sequence: this.state.events.length + 1, at: this.iso(), type, ...copy(detail)});
    try {
      const result = this.store.save(copy(this.state));
      if (result && typeof result.then === 'function') throw Error('Journal save must be synchronous');
    } catch (error) {
      this.state.phase = 'halted';
      this.state.stopReason = 'journal_failure';
      this.abort.abort('journal_failure');
      throw error;
    }
  }

  normalizeCount(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return {count: value, exact: false, source: 'adapter_reported_count'};
    }
    if (value && typeof value === 'object') return copy(value);
    return {count: null, exact: false, source: 'unavailable'};
  }

  async initialize({excludeDraftIds = []} = {}) {
    if (this.state.phase === 'ready') return this.status();
    if (this.state.phase !== 'new' || this.busy) throw Error('Initialize is available only for a fresh session');
    this.busy = true;
    try {
      const scanned = await this.adapter.scanDrafts({limit: this.state.config.target, excludeDraftIds, includeCoverage: true});
      const refs = Array.isArray(scanned) ? scanned : scanned?.drafts;
      if (!Array.isArray(refs)) throw Error('scanDrafts must return draft refs or {drafts}');
      this.state.scanCoverage = copy(scanned.coverage ?? null);
      const seen = new Set();
      const excluded = new Set(excludeDraftIds.map(String));
      for (const reference of refs) {
        const ref = copy(reference);
        if (!hasText(ref.draftId) || !hasText(ref.accountId)) throw Error('Draft refs require stable accountId and draftId');
        const key = keyOf(ref);
        if (seen.has(key) || excluded.has(ref.draftId)) {
          this.state.exclusions.push({draftId: ref.draftId, accountId: ref.accountId,
            reason: excluded.has(ref.draftId) ? 'explicit_exclusion' : 'duplicate_draft_id'});
          continue;
        }
        seen.add(key);
        if (this.state.records.length < this.state.config.target) this.state.records.push({ref, status: 'pending', cleanup: 'not_eligible'});
      }
      if (this.state.scanCoverage?.complete === false && this.state.records.length < this.state.config.target) {
        throw Error(`DRAFT_SCAN_TARGET_EXCEEDS_COVERAGE: target=${this.state.config.target}, verified=${this.state.records.length}, scope=${this.state.scanCoverage.scope}`);
      }
      this.state.initialMailboxCount = this.normalizeCount(await this.adapter.countDrafts());
      this.state.phase = 'ready';
      this.persist('initialized', {planned: this.state.records.length, excluded: this.state.exclusions.length});
      return this.status();
    } catch (error) {
      this.state.phase = 'halted';
      this.state.stopReason = 'initialization_failed';
      try { this.persist('initialization_failed', {error: String(error.message ?? error)}); } catch {}
      throw error;
    } finally { this.busy = false; }
  }

  start() {
    if (this.state.startedAt) return this.status();
    if (this.busy || this.state.phase !== 'ready') throw Error('Initialize the session before starting');
    const now = this.clock.monotonic();
    this.startedMono = now;
    this.continuousStartedMono = now;
    this.deadlineMono = this.state.config.durationMs === null ? null : now + this.state.config.durationMs;
    this.nextDueMono = now;
    this.state.startedAt = this.iso();
    this.state.runtimeReminder.continuousStartedAt = this.state.startedAt;
    this.state.deadlineAt = this.state.config.durationMs === null ? null : new Date(this.clock.wall() + this.state.config.durationMs).toISOString();
    this.state.phase = this.state.records.length ? 'running' : 'exhausted';
    this.persist('started');
    this.armDeadline();
    this.armRuntimeReminder();
    return this.status();
  }

  armDeadline() {
    if (this.deadlineMono === null || terminalPhases.has(this.state.phase)) return;
    const remaining = this.deadlineMono - this.clock.monotonic();
    if (remaining <= 0) { this.checkDeadline(); return; }
    this.timer = this.timers.setTimeout(() => {
      try {
        if (this.clock.monotonic() < this.deadlineMono) this.armDeadline();
        else this.checkDeadline();
      } catch (error) { this.state.timerError = String(error.message ?? error); }
    }, Math.min(MAX_TIMER_MS, remaining));
    this.timer?.unref?.();
  }

  clearTimers() {
    for (const key of ['timer', 'reminderTimer']) {
      if (this[key] !== null) this.timers.clearTimeout(this[key]);
      this[key] = null;
    }
  }

  armRuntimeReminder() {
    if (this.state.phase !== 'running' || this.state.runtimeReminder.notificationId || this.continuousStartedMono === null) return;
    if (this.deadlineMono !== null && this.deadlineMono <= this.continuousStartedMono + RUNTIME_REMINDER_MS) return;
    if (this.reminderTimer !== null) this.timers.clearTimeout(this.reminderTimer);
    const remaining = this.continuousStartedMono + RUNTIME_REMINDER_MS - this.clock.monotonic();
    if (remaining <= 0) { this.checkRuntimeReminder(); return; }
    this.reminderTimer = this.timers.setTimeout(() => {
      this.reminderTimer = null;
      try { this.checkDeadline(); this.checkRuntimeReminder(); this.armRuntimeReminder(); }
      catch (error) { this.state.timerError = String(error.message ?? error); }
    }, Math.min(MAX_TIMER_MS, remaining));
    this.reminderTimer?.unref?.();
  }

  checkRuntimeReminder() {
    const reminder = this.state.runtimeReminder;
    if (this.state.phase !== 'running' || reminder.notificationId || this.continuousStartedMono === null
      || this.clock.monotonic() - this.continuousStartedMono < RUNTIME_REMINDER_MS) return false;
    const event = {type: 'work_duration_reminder', runId: this.state.runId,
      notificationId: randomUUID(), startedAt: this.state.startedAt,
      continuousStartedAt: reminder.continuousStartedAt,
      elapsedMs: this.clock.monotonic() - this.continuousStartedMono,
      thresholdMs: RUNTIME_REMINDER_MS, deadlineAt: this.state.deadlineAt, continuesRunning: true};
    reminder.notificationId = event.notificationId;
    reminder.dueAt = this.iso();
    reminder.notificationStatus = this.onRuntimeReminder ? 'pending' : 'unconfigured';
    this.persist('runtime_reminder_due', {notificationId: event.notificationId, elapsedMs: event.elapsedMs,
      thresholdMs: event.thresholdMs, continuesRunning: true});
    if (this.reminderTimer !== null) this.timers.clearTimeout(this.reminderTimer);
    this.reminderTimer = null;
    if (!this.onRuntimeReminder) return true;
    // Persist the attempt before handing it to a host. A failed or interrupted
    // notification is recorded for review, never silently sent a second time.
    reminder.notificationStatus = 'attempting'; reminder.attemptedAt = this.iso();
    this.persist('runtime_reminder_notification_attempted', {notificationId: event.notificationId});
    const settle = (error) => {
      reminder.notificationStatus = error ? 'failed' : 'delivered';
      if (error) reminder.error = String(error.message ?? error).slice(0, 300);
      else reminder.deliveredAt = this.iso();
      this.persist(error ? 'runtime_reminder_notification_failed' : 'runtime_reminder_notification_delivered',
        {notificationId: event.notificationId});
    };
    try {
      const result = this.onRuntimeReminder(freeze(copy(event)));
      if (result && typeof result.then === 'function') {
        this.reminderDelivery = Promise.resolve(result).then(() => settle(), error => settle(error));
        this.reminderDelivery.catch(error => { this.state.timerError = String(error.message ?? error); });
      } else settle();
    } catch (error) { settle(error); }
    return true;
  }

  acknowledgeRuntimeReminder(notificationId) {
    const reminder = this.state.runtimeReminder;
    if (!hasText(notificationId) || notificationId !== reminder.notificationId) throw Error('RUNTIME_REMINDER_ID_MISMATCH');
    if (['delivered', 'delivered-by-host'].includes(reminder.notificationStatus)) return this.status();
    if (reminder.notificationStatus === 'attempting') throw Error('RUNTIME_REMINDER_DELIVERY_IN_PROGRESS');
    if (!['unconfigured', 'pending', 'failed'].includes(reminder.notificationStatus)) throw Error('RUNTIME_REMINDER_NOT_DUE');
    // A trusted active host calls this only after it actually displayed the
    // reminder; reading status or reaching eight hours does not acknowledge it.
    reminder.notificationStatus = 'delivered-by-host';
    reminder.deliveredAt = this.iso();
    this.persist('runtime_reminder_host_delivered', {notificationId});
    return this.status();
  }

  resetContinuousRuntime() {
    if (this.state.phase !== 'running') return;
    this.continuousStartedMono = this.clock.monotonic();
    this.state.runtimeReminder.continuousStartedAt = this.iso();
    this.armRuntimeReminder();
  }

  checkDeadline() {
    if (['target_reached', 'exhausted', 'stopped'].includes(this.state.phase)) return this.state.deadlineReached;
    if (this.deadlineMono !== null && !this.state.deadlineReached && this.clock.monotonic() >= this.deadlineMono) {
      this.state.deadlineReached = true;
      if (this.state.phase !== 'halted' && this.state.phase !== 'stopped') this.state.phase = 'deadline';
      this.state.stopReason ??= 'deadline';
      this.abort.abort('deadline');
      this.clearTimers();
      this.persist('deadline_reached');
    }
    return this.state.deadlineReached;
  }

  guard() {
    this.checkDeadline();
    this.checkRuntimeReminder();
    if (this.state.deadlineReached || this.state.phase !== 'running' || this.abort.signal.aborted) {
      throw new SessionStoppedError(this.state.stopReason ?? this.state.phase);
    }
  }

  stop(reason = 'manual_stop') {
    if (!this.state.startedAt) throw Error('Session has not started');
    this.state.phase = 'stopped'; this.state.stopReason = reason;
    this.abort.abort(reason);
    this.clearTimers();
    this.persist('stopped', {reason});
    return this.status();
  }

  status() {
    this.checkDeadline();
    this.checkRuntimeReminder();
    const records = this.state.records;
    const trashed = records.filter(r => r.cleanup === 'trashed').length;
    const alreadyAbsent = records.filter(r => r.cleanup === 'already_absent').length;
    const sent = records.filter(r => r.status === 'sent').length;
    return copy({
      runId: this.state.runId, phase: this.state.phase, startedAt: this.state.startedAt,
      deadlineAt: this.state.deadlineAt, deadlineReached: this.state.deadlineReached,
      durationMs: this.state.config.durationMs, timeLimited: this.state.config.durationMs !== null,
      retainSentDrafts: this.state.config.retainSentDrafts,
      runtimeReminder: this.state.runtimeReminder,
      stopReason: this.state.stopReason, target: this.state.config.target, planned: records.length,
      sent, cleaned: trashed + alreadyAbsent, trashed, alreadyAbsent,
      skipped: records.filter(r => r.status === 'skipped').length,
      unknown: records.filter(r => r.status === 'unknown').length,
      pending: records.filter(r => r.status === 'pending').length,
      remainingPlanned: records.length - sent,
      cleanupPending: records.filter(r => r.status === 'sent' && !['trashed', 'already_absent'].includes(r.cleanup)).length,
      retainedOriginalDrafts: records.filter(r => r.status === 'sent' && r.cleanupReason === 'retained_by_send_only_policy').length,
      scanCoverage: this.state.scanCoverage ?? null,
      initialMailboxCount: this.state.initialMailboxCount, finalMailboxCount: this.state.finalMailboxCount,
      busy: this.busy,
      waitMs: this.state.phase === 'running' ? Math.max(0, this.nextDueMono - this.clock.monotonic() - this.state.config.prepareAheadMs) : 0,
      sendWaitMs: this.state.phase === 'running' ? Math.max(0, this.nextDueMono - this.clock.monotonic()) : 0,
      remainingMs: this.deadlineMono === null ? null : Math.max(0, this.deadlineMono - this.clock.monotonic()),
    });
  }

  assertItem(item, ref) {
    for (const field of [...fields, 'recipient', 'subject', 'body']) {
      if (!hasText(item[field])) throw Error(`Inspected draft is missing ${field}`);
    }
    if (keyOf(item) !== keyOf(ref)) throw Error('Inspected draft binding differs from the selected draft');
  }

  validReceipt(receipt, item) {
    return receipt?.status === 'sent' && receipt.authoritative === true && hasText(receipt.messageId)
      && fields.every(field => receipt[field] === item[field])
      && receipt.recipient === item.recipient;
  }

  validCleanup(result, item, receipt) {
    return ['trashed', 'already_absent'].includes(result?.status) && result.authoritative === true
      && fields.every(field => result[field] === item[field]) && result.sentMessageId === receipt.messageId;
  }

  halt(reason, detail = {}) {
    this.state.phase = 'halted'; this.state.stopReason = reason;
    this.abort.abort(reason);
    this.clearTimers();
    this.persist('halted', {reason, ...detail});
  }

  async step() {
    await this.stepOnce();
    return this.status();
  }

  async stepOnce() {
    this.checkDeadline();
    this.checkRuntimeReminder();
    if (this.busy) throw Error('Only one session step may run at a time');
    if (this.state.phase !== 'running') return this.status();
    if (this.clock.monotonic() < this.nextDueMono - this.state.config.prepareAheadMs) return this.status();
    const record = this.state.records.find(r => r.status === 'pending');
    if (!record) { this.state.phase = 'exhausted'; this.persist('queue_exhausted'); return this.status(); }
    this.busy = true;
    let sendAuthorized = false;
    let sendHookCalled = false;
    let item;
    try {
      this.guard();
      record.status = 'inspecting';
      item = freeze(copy(await this.adapter.inspectDraft(copy(record.ref))));
      this.assertItem(item, record.ref);
      record.item = copy(item);
      this.guard();
      const preflight = await this.adapter.preflight(item);
      this.guard();
      if (preflight?.ok !== true) {
        record.status = preflight?.skip === true ? 'skipped' : 'held';
        record.reason = preflight?.reason ?? 'preflight_not_approved';
        this.persist('preflight_hold', {draftId: item.draftId, reason: record.reason, skipped: record.status === 'skipped'});
        if (record.status !== 'skipped') this.halt('preflight_hold', {draftId: item.draftId});
        return this.status();
      }
      const beforeSendClick = async ({revalidate} = {}) => {
        if (sendHookCalled) throw Error('Send hook may be used only once per draft');
        sendHookCalled = true;
        // Prepare the next draft ahead of time, but never shorten the interval
        // between actual send clicks. The deadline timer aborts this wait.
        while (this.clock.monotonic() < this.nextDueMono) {
          this.guard();
          await this.sleep(Math.min(60000, this.nextDueMono - this.clock.monotonic()), {signal: this.abort.signal});
        }
        this.guard();
        // A prepared compose page may change while pacing. Let the adapter
        // refresh its content and current control identity AFTER the wait.
        if (typeof revalidate === 'function') await revalidate();
        this.guard();
        record.status = 'attempting';
        record.attemptAt = this.iso();
        this.persist('send_intent', {draftId: item.draftId, approvedHash: item.approvedHash});
        this.guard();
        sendAuthorized = true;
        this.nextDueMono = this.clock.monotonic() + this.state.config.intervalMs;
        record.clickAuthorizedAt = this.iso();
      };
      let receipt;
      let sendError;
      try { receipt = await this.adapter.send(item, {beforeClick: beforeSendClick, signal: this.abort.signal}); }
      catch (error) { sendError = error; }
      if (!sendAuthorized) {
        if (sendError) throw sendError;
        throw Error('Adapter returned without obtaining its send-click authorization');
      }
      if (!this.validReceipt(receipt, item)) {
        record.status = 'unknown';
        record.sendError = sendError ? String(sendError.message ?? sendError) : 'Missing or mismatched authoritative receipt';
        this.persist('send_uncertain', {draftId: item.draftId, error: record.sendError});
        try { receipt = await this.adapter.reconcile(item); }
        catch (error) { record.reconcileError = String(error.message ?? error); }
      }
      if (!this.validReceipt(receipt, item)) {
        record.status = 'unknown'; this.halt('send_unknown', {draftId: item.draftId});
        return this.status();
      }
      record.status = 'sent'; record.receipt = copy(receipt); record.cleanup = 'pending';
      this.persist('sent_confirmed', {draftId: item.draftId, messageId: receipt.messageId});
      if (!this.checkDeadline() && this.state.phase === 'running') {
        let cleanupHookCalled = false;
        let cleanupAuthorized = false;
        try {
          const result = await this.adapter.cleanup(item, freeze(copy(receipt)), {
            signal: this.abort.signal,
            beforeClick: async () => {
              if (cleanupHookCalled) throw Error('Cleanup hook may be used only once per original draft');
              cleanupHookCalled = true;
              this.guard();
              this.persist('cleanup_intent', {draftId: item.draftId, sentMessageId: receipt.messageId});
              this.guard();
              cleanupAuthorized = true;
            },
          });
          if (!this.validCleanup(result, item, receipt) || (result.status === 'trashed' && !cleanupAuthorized)) {
            throw Error('Missing or mismatched authoritative original-draft cleanup evidence');
          }
          record.cleanup = result.status; record.cleanupReceipt = copy(result);
          this.persist('cleanup_confirmed', {draftId: item.draftId, status: result.status});
        } catch (error) {
          record.cleanup = cleanupAuthorized ? 'unknown' : 'pending';
          record.cleanupError = String(error.message ?? error);
          // This opt-in policy retains the actual original; it never fabricates
          // absence or grants delete permission. Only an unattempted permission
          // hold after an exact confirmed send can leave later sends runnable.
          const retained = this.state.config.retainSentDrafts === true
            && !cleanupHookCalled && !cleanupAuthorized
            && record.cleanupError === 'PERMANENT_DRAFT_DELETE_REQUIRES_CURRENT_APPROVAL'
            && record.status === 'sent' && this.validReceipt(record.receipt, item)
            && this.state.phase === 'running' && !this.abort.signal.aborted;
          if (retained) record.cleanupReason = 'retained_by_send_only_policy';
          this.persist('cleanup_pending', {draftId: item.draftId, reason: record.cleanupError});
          if (retained) {
            this.persist('cleanup_retained', {draftId: item.draftId, sentMessageId: receipt.messageId,
              reason: record.cleanupReason, originalPreserved: true});
          } else if (!(error instanceof SessionStoppedError)) this.halt('cleanup_unknown', {draftId: item.draftId});
        }
      } else {
        this.persist('cleanup_deferred', {draftId: item.draftId, reason: this.state.stopReason ?? this.state.phase});
      }
      if (this.state.phase === 'running') {
        if (this.state.records.filter(r => r.status === 'sent').length >= this.state.config.target) {
          this.state.phase = 'target_reached'; this.persist('target_reached');
        } else if (!this.state.records.some(r => r.status === 'pending')) {
          this.state.phase = 'exhausted'; this.persist('queue_exhausted');
        }
      }
      return this.status();
    } catch (error) {
      record.status = record.receipt ? 'sent' : (sendAuthorized ? 'unknown' : 'not_attempted');
      record.error = String(error.message ?? error);
      if (error instanceof SessionStoppedError) {
        this.persist('step_stopped', {draftId: record.ref.draftId, attempted: sendAuthorized, reason: record.error});
      } else {
        this.halt(sendAuthorized ? 'send_unknown' : 'step_failed', {draftId: record.ref.draftId, error: record.error});
      }
      return this.status();
    } finally {
      this.busy = false;
      if (terminalPhases.has(this.state.phase)) this.clearTimers();
    }
  }

  /** Read-only final reconciliation/count. Calling this does not resume a run. */
  async finish() {
    if (this.busy) throw Error('Wait for the in-flight step before collecting the final report');
    this.checkDeadline();
    try { this.state.finalMailboxCount = this.normalizeCount(await this.adapter.countDrafts()); }
    catch (error) { this.state.finalMailboxCount = {count: null, exact: false, source: 'unavailable', error: String(error.message ?? error)}; }
    this.state.reportedAt = this.iso();
    this.persist('final_count_read');
    return this.status();
  }
}
