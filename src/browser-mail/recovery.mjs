/** Resume only an explicitly unattempted UI setup failure within the SAME run.
 * This helper never sends, cleans, resets timing, or resolves an uncertain send.
 */
export async function resumeUnattempted(runner, {checkCompatibility, intervalMs} = {}) {
  if (typeof checkCompatibility !== 'function') throw Error('COMPATIBILITY_CHECK_REQUIRED');
  if (intervalMs !== undefined && (!Number.isFinite(intervalMs) || intervalMs <= 0)) throw Error('RECOVERY_INTERVAL_MUST_BE_POSITIVE');
  const inspect = () => {
    runner.checkDeadline();
    const state = runner.state;
    if (runner.busy) throw Error('RECOVERY_REQUIRES_IDLE_RUNNER');
    if (state.phase !== 'halted' || !['step_failed', 'preflight_hold'].includes(state.stopReason)) throw Error('RECOVERY_REQUIRES_UNATTEMPTED_STEP_FAILURE');
    const needsPreflight = state.stopReason === 'preflight_hold';
    if (!state.startedAt || state.deadlineReached || (runner.deadlineMono===null ? state.config.durationMs!==null : !Number.isFinite(runner.deadlineMono))
      || (runner.deadlineMono!==null && runner.clock.monotonic() >= runner.deadlineMono)) throw Error('RECOVERY_WINDOW_EXPIRED');
    if (!Number.isFinite(runner.nextDueMono)) throw Error('RECOVERY_TIMING_MISSING');
    if (state.records.some(r => r.status === 'unknown' || ['pending', 'unknown'].includes(r.cleanup)
      || (r.status === 'sent' && !['trashed', 'already_absent'].includes(r.cleanup)))) {
      throw Error('RECOVERY_HAS_UNKNOWN_OR_PENDING_CLEANUP');
    }
    const failed = state.records.filter(r => r.status === (needsPreflight ? 'held' : 'not_attempted'));
    if (failed.length !== 1) throw Error('RECOVERY_REQUIRES_ONE_UNATTEMPTED_RECORD');
    const record = failed[0];
    if (needsPreflight && record.reason !== 'original_draft_not_in_completed_search') throw Error('RECOVERY_PREFLIGHT_HOLD_NOT_ELIGIBLE');
    if (state.records.some(r => r !== record && ['held', 'not_attempted'].includes(r.status))) throw Error('RECOVERY_HAS_OTHER_HELD_RECORD');
    if (['attemptAt', 'clickAuthorizedAt', 'receipt'].some(key => Object.hasOwn(record, key))) {
      throw Error('RECOVERY_RECORD_HAS_SEND_EVIDENCE');
    }
    if (state.events.some(event => ['send_intent', 'send_uncertain', 'sent_confirmed'].includes(event.type)
      && event.draftId === record.ref.draftId)) throw Error('RECOVERY_RECORD_HAS_SEND_INTENT');
    if (state.records.some(r => ['inspecting', 'attempting'].includes(r.status))) throw Error('RECOVERY_HAS_ACTIVE_RECORD');
    const accountId = record.ref.accountId;
    if (typeof accountId !== 'string' || !accountId) throw Error('RECOVERY_ACCOUNT_MISSING');
    return {record, accountId, needsPreflight, signature: JSON.stringify({runId: state.runId,
      startedAt: state.startedAt, deadlineAt: state.deadlineAt, deadlineMono: runner.deadlineMono,
      nextDueMono: runner.nextDueMono, eventCount: state.events.length, records: state.records})};
  };
  const before = inspect();
  const compatibility = await checkCompatibility({accountId: before.accountId, draftId: before.record.ref.draftId,
    requiresPreflight: before.needsPreflight});
  const after = inspect();
  if (after.signature !== before.signature || after.record !== before.record) throw Error('RECOVERY_STATE_CHANGED_DURING_CHECK');
  if (compatibility?.ok !== true || compatibility.accountId !== before.accountId) throw Error('RECOVERY_COMPATIBILITY_NOT_CONFIRMED');
  if (before.needsPreflight && (compatibility.draftId !== before.record.ref.draftId || compatibility.preflightOk !== true)) {
    throw Error('RECOVERY_FRESH_PREFLIGHT_NOT_CONFIRMED');
  }
  const originalError = before.record.error ?? null;
  if (intervalMs !== undefined && intervalMs !== runner.state.config.intervalMs) {
    const previousIntervalMs = runner.state.config.intervalMs;
    runner.state.config.intervalMs = intervalMs;
    runner.persist('fixed_interval_updated', {previousIntervalMs, intervalMs,
      appliesTo: 'future_send_clicks', currentNextDuePreserved: true, deadlinePreserved: true});
  }
  before.record.status = 'pending';
  runner.abort = new AbortController();
  runner.state.phase = 'running';
  runner.state.stopReason = null;
  runner.armDeadline?.();
  runner.resetContinuousRuntime?.();
  runner.persist('recovered', {reason: before.needsPreflight
    ? 'fresh_preflight_confirmed_original_after_incomplete_search'
    : 'compatible_host_restored_before_any_send_attempt',
    draftId: before.record.ref.draftId, accountId: before.accountId, originalError});
  return runner.status();
}

/** Read-only reconciliation of one already-sent message's uncertain cleanup.
 * The callback must NOT send, delete, archive or otherwise mutate the mailbox.
 * Evidence may be recorded after cutoff, but the original run never resumes then.
 */
export async function reconcileCleanupAndResume(runner, {reconcileCleanup} = {}) {
  if (typeof reconcileCleanup !== 'function') throw Error('READ_ONLY_CLEANUP_CHECK_REQUIRED');
  const inspect = () => {
    runner.checkDeadline();
    const state = runner.state;
    if (runner.busy || state.phase !== 'halted' || state.stopReason !== 'cleanup_unknown') throw Error('CLEANUP_RECOVERY_REQUIRES_IDLE_CLEANUP_HALT');
    if (!state.startedAt || (runner.deadlineMono===null ? state.config.durationMs!==null : !Number.isFinite(runner.deadlineMono)) || !Number.isFinite(runner.nextDueMono)) throw Error('CLEANUP_RECOVERY_ORIGINAL_WINDOW_MISSING');
    if (state.records.some(r => ['unknown', 'attempting', 'inspecting'].includes(r.status))) throw Error('CLEANUP_RECOVERY_HAS_UNCERTAIN_SEND');
    const candidates = state.records.filter(r => r.status === 'sent' && !['trashed', 'already_absent'].includes(r.cleanup));
    if (candidates.length !== 1) throw Error('CLEANUP_RECOVERY_REQUIRES_ONE_CONFIRMED_SENT_RECORD');
    const record = candidates[0];
    if (!record.item || !['pending', 'unknown'].includes(record.cleanup)
      || record.item.draftId !== record.ref.draftId || record.item.accountId !== record.ref.accountId
      || !runner.validReceipt(record.receipt, record.item)) throw Error('CLEANUP_RECOVERY_SEND_RECEIPT_INVALID');
    if (state.records.some(r => r !== record && ['pending', 'unknown'].includes(r.cleanup))) throw Error('CLEANUP_RECOVERY_HAS_OTHER_PENDING_CLEANUP');
    return {record, signature: JSON.stringify({runId: state.runId, startedAt: state.startedAt,
      deadlineAt: state.deadlineAt, deadlineMono: runner.deadlineMono, nextDueMono: runner.nextDueMono,
      config: state.config, records: state.records})};
  };
  const before = inspect();
  const evidence = await reconcileCleanup({item: structuredClone(before.record.item),
    receipt: structuredClone(before.record.receipt), accountId: before.record.ref.accountId,
    draftId: before.record.ref.draftId});
  const after = inspect();
  if (after.signature !== before.signature || after.record !== before.record) throw Error('CLEANUP_RECOVERY_STATE_CHANGED_DURING_CHECK');
  if (evidence?.status !== 'already_absent' || evidence.authoritative !== true
    || evidence.removalMethod !== 'ui_delete_confirmed_absent'
    || !runner.validCleanup(evidence, before.record.item, before.record.receipt)) throw Error('CLEANUP_RECOVERY_EXACT_ABSENCE_NOT_CONFIRMED');
  before.record.cleanup = 'already_absent';
  before.record.cleanupReceipt = structuredClone(evidence);
  runner.persist('cleanup_reconciled', {draftId: before.record.ref.draftId,
    sentMessageId: before.record.receipt.messageId, status: evidence.status, removalMethod: evidence.removalMethod});
  runner.checkDeadline();
  if (runner.state.deadlineReached || (runner.deadlineMono!==null && runner.clock.monotonic() >= runner.deadlineMono)) {
    runner.state.phase = 'deadline';
    runner.state.stopReason = 'deadline';
    runner.abort.abort('deadline');
    runner.persist('recovery_not_resumed', {reason: 'deadline', draftId: before.record.ref.draftId});
    return runner.status();
  }
  runner.abort = new AbortController();
  runner.state.phase = 'running';
  runner.state.stopReason = null;
  runner.armDeadline?.();
  runner.resetContinuousRuntime?.();
  runner.persist('recovered', {reason: 'read_only_cleanup_reconciliation_confirmed_original_absence',
    draftId: before.record.ref.draftId, sentMessageId: before.record.receipt.messageId});
  return runner.status();
}

/** Retry one permission-held cleanup after NEW explicit user approval.
 * Trusted hosts call this inside the original service's exclusive operation.
 * This never sends, chooses another draft, rebuilds a run, or alters its window.
 * Approval identity and statement must come from an actual user review; these
 * structural checks do not authenticate an arbitrary caller as that user.
 */
export async function retryApprovedCleanupAndResume(runner, {approval, checkCompatibility} = {}) {
  if (checkCompatibility !== undefined && typeof checkCompatibility !== 'function') throw Error('CLEANUP_RETRY_COMPATIBILITY_CHECK_INVALID');
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) throw Error('CURRENT_CLEANUP_APPROVAL_REQUIRED');
  const approved = structuredClone(approval);
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const exactIds = value => Array.isArray(value) && value.length > 0 && value.length <= 10000
    && value.every(text) && new Set(value).size === value.length;
  const isoTime = value => {
    if (!text(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
    const [year,month,day,hour,minute,second] = value.slice(0,19).split(/[-T:]/).map(Number);
    const calendar = new Date(Date.UTC(year,month-1,day,hour,minute,second));
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month-1 || calendar.getUTCDate() !== day
      || calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second) return NaN;
    return Date.parse(value);
  };
  if (!text(approved.runId) || !text(approved.accountId) || !text(approved.reviewer) || !text(approved.statement)
    || !exactIds(approved.selectedDraftIds) || !exactIds(approved.approvedPermanentDraftIds)) throw Error('CURRENT_CLEANUP_APPROVAL_INCOMPLETE');
  const approvedAt = isoTime(approved.approvedAt), expiresAt = isoTime(approved.expiresAt);
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || expiresAt <= approvedAt) throw Error('CURRENT_CLEANUP_APPROVAL_TIME_INVALID');
  const approvalCurrent = () => {
    const now = runner.clock.wall();
    if (approvedAt > now || now >= expiresAt) throw Error('CURRENT_CLEANUP_APPROVAL_EXPIRED_OR_FUTURE');
  };
  const originalWindow = () => JSON.stringify({runId:runner.state.runId,startedAt:runner.state.startedAt,
    deadlineAt:runner.state.deadlineAt,deadlineMono:runner.deadlineMono,nextDueMono:runner.nextDueMono,config:runner.state.config});
  const assertWindow = () => {
    runner.checkDeadline();
    const state = runner.state;
    if (!state.startedAt || state.deadlineReached || !Number.isFinite(runner.nextDueMono)
      || (runner.deadlineMono === null ? state.config.durationMs !== null || state.deadlineAt !== null : !Number.isFinite(runner.deadlineMono))
      || (runner.deadlineMono !== null && runner.clock.monotonic() >= runner.deadlineMono)) throw Error('CLEANUP_RETRY_WINDOW_EXPIRED_OR_MISSING');
  };
  if (runner.busy) throw Error('CLEANUP_RETRY_REQUIRES_IDLE_RUNNER');
  assertWindow(); approvalCurrent();
  const state = runner.state;
  if (state.phase !== 'halted' || state.stopReason !== 'cleanup_unknown') throw Error('CLEANUP_RETRY_REQUIRES_PERMISSION_HALT');
  if (approved.runId !== state.runId || approvedAt < Date.parse(state.startedAt)) throw Error('CURRENT_CLEANUP_APPROVAL_RUN_MISMATCH');
  const selected = state.records.map(record => record.ref.draftId);
  if (new Set(selected).size !== selected.length || selected.length !== approved.selectedDraftIds.length
    || state.records.some(record => record.ref.accountId !== approved.accountId)
    || selected.some(id => !approved.selectedDraftIds.includes(id))) throw Error('CURRENT_CLEANUP_APPROVAL_SELECTION_MISMATCH');
  if (approved.approvedPermanentDraftIds.some(id => !selected.includes(id))) throw Error('CURRENT_CLEANUP_APPROVAL_OUTSIDE_SELECTED_DRAFTS');
  if (state.records.some(record => ['unknown','attempting','inspecting'].includes(record.status))) throw Error('CLEANUP_RETRY_HAS_UNCERTAIN_SEND');
  if (state.records.some(record => ['held','not_attempted'].includes(record.status))) throw Error('CLEANUP_RETRY_HAS_OTHER_HELD_RECORD');
  const candidates = state.records.filter(record => record.status === 'sent' && !['trashed','already_absent'].includes(record.cleanup));
  if (candidates.length !== 1) throw Error('CLEANUP_RETRY_REQUIRES_ONE_CONFIRMED_SENT_RECORD');
  const record = candidates[0];
  if (record.cleanup !== 'pending' || record.cleanupError !== 'PERMANENT_DRAFT_DELETE_REQUIRES_CURRENT_APPROVAL'
    || !record.item || record.item.accountId !== approved.accountId || record.item.draftId !== record.ref.draftId
    || !runner.validReceipt(record.receipt,record.item)) throw Error('CLEANUP_RETRY_RECORD_NOT_PERMISSION_HELD');
  if (!approved.approvedPermanentDraftIds.includes(record.ref.draftId)) throw Error('CURRENT_CLEANUP_APPROVAL_MISSING_SENT_DRAFT');
  if (state.records.some(other => other !== record && ['pending','unknown'].includes(other.cleanup))
    || state.events.some(event => event.type === 'cleanup_intent' && event.draftId === record.ref.draftId)) throw Error('CLEANUP_RETRY_HAS_PRIOR_OR_OTHER_CLEANUP_INTENT');
  const adapter = runner.adapter;
  let activeAdapter = adapter;
  const permanentIds = adapter.approvedPermanentDraftIds;
  if (!(permanentIds instanceof Set) || [...permanentIds].some(id => !selected.includes(id))) throw Error('CLEANUP_RETRY_APPROVAL_SET_INVALID');
  const permanentBefore = new Set(permanentIds);
  const window = originalWindow();
  const recordBefore = JSON.stringify(record);
  const others = () => JSON.stringify(state.records.filter(other => other !== record));
  const othersBefore = others();
  const assertOriginal = () => {
    assertWindow();
    if (runner.state !== state || runner.adapter !== activeAdapter || originalWindow() !== window || state.runId !== approved.runId || !state.records.includes(record)
      || others() !== othersBefore || JSON.stringify(record) !== recordBefore || record.status !== 'sent' || !runner.validReceipt(record.receipt,record.item)) throw Error('CLEANUP_RETRY_ORIGINAL_STATE_CHANGED');
  };
  const approvalSnapshot = JSON.stringify(approved);
  const cleanupRunIdentity = JSON.stringify({runId:state.runId,startedAt:state.startedAt,
    deadlineAt:state.deadlineAt,deadlineMono:runner.deadlineMono,durationMs:state.config.durationMs});
  const assertCleanupApproval = (item,receipt) => {
    if (!runner.busy) throw Error('CLEANUP_RETRY_REQUIRES_EXCLUSIVE_RUNNER');
    approvalCurrent();
    if (runner.state !== state || runner.adapter !== activeAdapter || state.runId !== approved.runId
      || JSON.stringify({runId:state.runId,startedAt:state.startedAt,deadlineAt:state.deadlineAt,
        deadlineMono:runner.deadlineMono,durationMs:state.config.durationMs}) !== cleanupRunIdentity
      || JSON.stringify(state.permanentDraftDeleteApproval) !== approvalSnapshot) throw Error('CURRENT_CLEANUP_APPROVAL_RUN_CHANGED');
    const currentIds = state.records.map(entry => entry.ref.draftId);
    if (currentIds.length !== selected.length || new Set(currentIds).size !== currentIds.length
      || currentIds.some(id => !selected.includes(id)) || state.records.some(entry => entry.ref.accountId !== approved.accountId)
      || item?.accountId !== approved.accountId || !approved.approvedPermanentDraftIds.includes(item?.draftId)
      || !permanentIds.has(item?.draftId)) throw Error('CURRENT_CLEANUP_APPROVAL_OUTSIDE_SELECTED_DRAFTS');
    const bound = state.records.find(entry => entry.ref.draftId === item.draftId);
    if (!bound || bound.status !== 'sent' || bound.cleanup !== 'pending'
      || !runner.validReceipt(bound.receipt,bound.item) || JSON.stringify(receipt) !== JSON.stringify(bound.receipt)
      || ['accountId','draftId','draftVersion','approvedHash','recipient','subject','body'].some(key => item[key] !== bound.item[key])) {
      throw Error('CURRENT_CLEANUP_APPROVAL_SENT_BINDING_CHANGED');
    }
  };
  const approvalProtectedAdapter = () => {
    let cleanupActive = false;
    let dispatcher = null;
    const closeGuardFailure = () => {
      if (state.deadlineReached) { state.phase = 'deadline'; state.stopReason = 'deadline'; }
      else if (!['stopped','deadline'].includes(state.phase)) { state.phase = 'halted'; if (state.stopReason !== 'journal_failure') state.stopReason = 'cleanup_unknown'; }
      try { runner.abort.abort(state.stopReason ?? 'cleanup_unknown'); } catch {}
      try { runner.clearTimers?.(); } catch {}
    };
    const ensureDispatcher = () => {
      if (dispatcher) return dispatcher;
      const previous = Object.getOwnPropertyDescriptor(runner,'guard');
      const originalGuard = runner.guard;
      if (typeof originalGuard !== 'function' || previous?.configurable === false) throw Error('CLEANUP_RETRY_GUARD_NOT_WRAPPABLE');
      const slot = {originalGuard,current:originalGuard,owner:null};
      const readGuard = () => slot.current;
      const writeGuard = replacement => {
        if (replacement === slot.current) return;
        if (slot.owner) { slot.owner.lost = true; closeGuardFailure(); }
        throw Error('CLEANUP_RETRY_GUARD_OWNERSHIP_LOST');
      };
      // This one run retains an immutable dispatcher descriptor. Between
      // cleanup calls its getter returns the exact original guard function.
      // Only the private function slot changes during a serialized cleanup,
      // so geometry-time property redefinition cannot bypass the final check.
      Object.defineProperty(runner,'guard',{configurable:false,enumerable:previous?.enumerable??false,get:readGuard,set:writeGuard});
      dispatcher = {slot,readGuard,writeGuard};
      runner.persist('cleanup_guard_dispatcher_installed',{runId:state.runId,scope:'this_run_only',
        purpose:'trusted_same_process_accidental_guard_redefinition',idleGuard:'original_function',immutableDescriptor:true});
      return dispatcher;
    };
    return new Proxy(adapter,{get(target,property){
      const value = Reflect.get(target,property,target);
      if (property !== 'cleanup' || typeof value !== 'function') return value;
      return async (item,receipt,options={}) => {
        if (typeof options.beforeClick !== 'function') throw Error('CLEANUP_RETRY_GUARDED_HOOK_REQUIRED');
        if (cleanupActive) throw Error('CLEANUP_RETRY_ALREADY_IN_PROGRESS');
        cleanupActive = true;
        const upstream = options.beforeClick;
        let owned = null,controller = null;
        const ownsGuard = () => {
          if (!owned || !controller) return false;
          const descriptor = Object.getOwnPropertyDescriptor(runner,'guard');
          return descriptor?.get === controller.readGuard && descriptor?.set === controller.writeGuard
            && descriptor.configurable === false && controller.slot.owner === owned && controller.slot.current === cleanupGuard;
        };
        function cleanupGuard(...args) {
          if (owned?.lost || !ownsGuard()) { closeGuardFailure(); throw Error('CLEANUP_RETRY_GUARD_OWNERSHIP_LOST'); }
          // The service calls this again after awaited geometry preparation.
          controller.slot.originalGuard.apply(runner,args);
          assertCleanupApproval(item,receipt);
        }
        try {
          controller = ensureDispatcher();
          if (controller.slot.owner !== null || controller.slot.current !== controller.slot.originalGuard) throw Error('CLEANUP_RETRY_GUARD_OWNERSHIP_LOST');
          owned = {lost:false};
          controller.slot.owner = owned; controller.slot.current = cleanupGuard;
          cleanupGuard();
          return await value.call(target,item,receipt,{...options,beforeClick:async hookOptions => {
            cleanupGuard();
            await upstream(hookOptions);
            cleanupGuard();
          }});
        } finally {
          cleanupActive = false;
          if (owned) {
            if (ownsGuard()) {
              // Restore only the private slot owned by this cleanup. The
              // descriptor stays fixed on this run; no prototype is changed.
              controller.slot.current = controller.slot.originalGuard; controller.slot.owner = null;
            } else { owned.lost = true; closeGuardFailure(); }
            if (owned.lost) throw Error('CLEANUP_RETRY_GUARD_OWNERSHIP_LOST');
          }
        }
      };
    }});
  };
  runner.busy = true;
  let cleanupIntent = false, cleanupAuthorized = false, hookCalled = false;
  try {
    if (checkCompatibility) {
      const proof = await checkCompatibility({accountId:approved.accountId,runId:state.runId,draftId:record.ref.draftId,requiresCleanup:true});
      assertOriginal(); approvalCurrent();
      if (proof?.ok !== true || proof.accountId !== approved.accountId) throw Error('CLEANUP_RETRY_COMPATIBILITY_NOT_CONFIRMED');
    }
    assertOriginal(); approvalCurrent();
    if (state.phase !== 'halted' || state.stopReason !== 'cleanup_unknown' || JSON.stringify(record) !== recordBefore
      || runner.adapter.approvedPermanentDraftIds !== permanentIds) throw Error('CLEANUP_RETRY_ORIGINAL_STATE_CHANGED');
    try {
      state.permanentDraftDeleteApproval = structuredClone(approved);
      runner.persist('permanent_draft_delete_approved', {approval:structuredClone(approved),scope:'this_run_exact_selected_originals'});
      for (const id of approved.approvedPermanentDraftIds) permanentIds.add(id);
      const protectedAdapter = approvalProtectedAdapter();
      runner.adapter = protectedAdapter; activeAdapter = protectedAdapter;
      runner.abort = new AbortController();
      state.phase = 'running'; state.stopReason = null;
      runner.clearTimers?.(); runner.armDeadline?.(); runner.resetContinuousRuntime?.();
      runner.persist('approved_cleanup_retry_started', {draftId:record.ref.draftId,sentMessageId:record.receipt.messageId});
      const result = await activeAdapter.cleanup(structuredClone(record.item),structuredClone(record.receipt),{
        signal:runner.abort.signal,
        beforeClick:async () => {
          if (hookCalled) throw Error('CLEANUP_RETRY_HOOK_ALREADY_USED');
          hookCalled = true;
          assertOriginal(); approvalCurrent(); runner.guard();
          if (!permanentIds.has(record.ref.draftId)) throw Error('CURRENT_CLEANUP_APPROVAL_REMOVED');
          runner.persist('cleanup_intent',{draftId:record.ref.draftId,sentMessageId:record.receipt.messageId,recovery:'new_current_approval'});
          cleanupIntent = true;
          assertOriginal(); approvalCurrent(); runner.guard();
          cleanupAuthorized = true;
        },
      });
      // A no-click result is valid only for the provider consuming this exact
      // original. Permanent removal and trash results need our guarded intent.
      if (!runner.validCleanup(result,record.item,record.receipt)
        || (!cleanupAuthorized && (result.status !== 'already_absent' || result.removalMethod !== 'provider_consumed'))) throw Error('CLEANUP_RETRY_AUTHORITATIVE_EVIDENCE_MISSING');
      if (runner.state !== state || runner.adapter !== activeAdapter || originalWindow() !== window || others() !== othersBefore || JSON.stringify(record) !== recordBefore) throw Error('CLEANUP_RETRY_ORIGINAL_STATE_CHANGED');
      record.cleanup = result.status; record.cleanupReceipt = structuredClone(result);
      delete record.cleanupError;
      runner.persist('cleanup_confirmed',{draftId:record.ref.draftId,status:result.status,recovery:'new_current_approval'});
      runner.checkDeadline();
      if (state.phase === 'running') {
        const sent = state.records.filter(entry => entry.status === 'sent').length;
        if (sent >= state.config.target) { state.phase = 'target_reached'; runner.persist('target_reached'); }
        else if (!state.records.some(entry => entry.status === 'pending')) { state.phase = 'exhausted'; runner.persist('queue_exhausted'); }
        else runner.persist('recovered',{reason:'new_user_approval_confirmed_sent_original_cleanup',draftId:record.ref.draftId});
      }
      if (state.phase !== 'running') runner.clearTimers?.();
    } catch (error) {
      record.status = 'sent'; record.cleanup = cleanupIntent || cleanupAuthorized ? 'unknown' : 'pending';
      record.cleanupError = 'APPROVED_CLEANUP_RETRY_FAILED: '+String(error.message ?? error);
      // Close the run BEFORE fallible timer cleanup or journal writes. Even a
      // setup failure must never leave the remaining pending queue runnable.
      if (!state.deadlineReached && !['stopped','deadline'].includes(state.phase)) {
        state.phase = 'halted';
        if (state.stopReason !== 'journal_failure') state.stopReason = 'cleanup_unknown';
      }
      try { runner.abort.abort(state.stopReason ?? 'cleanup_unknown'); } catch {}
      try { runner.clearTimers?.(); } catch (timerError) { state.cleanupRetryTimerError = String(timerError.message ?? timerError); }
      // A failed installation must not leave a raw Set as the only guard.
      // Installed wrappers remain in place and check every later cleanup.
      if (runner.adapter === adapter) {
        for (const id of approved.approvedPermanentDraftIds) if (!permanentBefore.has(id)) {
          try { permanentIds.delete(id); } catch {}
        }
      }
      try { runner.persist('approved_cleanup_retry_failed',{draftId:record.ref.draftId,intentWritten:cleanupIntent,error:String(error.message ?? error)}); }
      catch { state.phase = 'halted'; state.stopReason = 'journal_failure'; try { runner.abort.abort('journal_failure'); } catch {} }
      throw error;
    }
  } finally { runner.busy = false; }
  return runner.status();
}

/** Retry only an already-approved original cleanup that failed before dispatch.
 * The trusted host keeps the SAME run and its previously installed protection.
 * No new approval, adapter wrapper, dispatcher, draft selection or send occurs.
 */
export async function retryPreviouslyApprovedUnattemptedCleanupAndResume(runner, {runId,accountId,selectedDraftIds,checkCompatibility} = {}) {
  const text=value=>typeof value==='string'&&value.trim().length>0;
  const ids=value=>Array.isArray(value)&&value.length>0&&value.length<=10000&&value.every(text)&&new Set(value).size===value.length;
  if (!text(runId)||!text(accountId)||!ids(selectedDraftIds)) throw Error('PREVIOUS_CLEANUP_RETRY_CONTEXT_REQUIRED');
  if (checkCompatibility!==undefined&&typeof checkCompatibility!=='function') throw Error('PREVIOUS_CLEANUP_RETRY_COMPATIBILITY_INVALID');
  if (runner.busy) throw Error('PREVIOUS_CLEANUP_RETRY_REQUIRES_IDLE_RUNNER');
  const state=runner.state,adapter=runner.adapter,approval=state.permanentDraftDeleteApproval;
  if (state.phase!=='halted'||state.stopReason!=='cleanup_unknown'||state.runId!==runId) throw Error('PREVIOUS_CLEANUP_RETRY_REQUIRES_ORIGINAL_HALT');
  const scope=state.records.map(record=>record.ref.draftId);
  if (!ids(scope)||scope.length!==selectedDraftIds.length||scope.some(id=>!selectedDraftIds.includes(id))
    ||state.records.some(record=>record.ref.accountId!==accountId)) throw Error('PREVIOUS_CLEANUP_RETRY_SELECTION_MISMATCH');
  if (!approval||approval.runId!==runId||approval.accountId!==accountId||!text(approval.reviewer)||!text(approval.statement)
    ||!ids(approval.selectedDraftIds)||approval.selectedDraftIds.length!==scope.length||scope.some(id=>!approval.selectedDraftIds.includes(id))
    ||!ids(approval.approvedPermanentDraftIds)||approval.approvedPermanentDraftIds.some(id=>!scope.includes(id))) throw Error('PREVIOUS_CLEANUP_APPROVAL_MISSING_OR_MISMATCHED');
  const approvalSnapshot=JSON.stringify(approval);
  const existingApproval=state.events.some(event=>event.type==='permanent_draft_delete_approved'&&JSON.stringify(event.approval)===approvalSnapshot);
  const installed=state.events.some(event=>event.type==='cleanup_guard_dispatcher_installed'&&event.runId===runId&&event.scope==='this_run_only'&&event.immutableDescriptor===true);
  const descriptor=Object.getOwnPropertyDescriptor(runner,'guard');
  const permanent=adapter?.approvedPermanentDraftIds;
  if (!existingApproval||!installed||descriptor?.configurable!==false||typeof descriptor.get!=='function'||typeof descriptor.set!=='function'
    ||!(permanent instanceof Set)||permanent.size!==approval.approvedPermanentDraftIds.length||[...permanent].some(id=>!approval.approvedPermanentDraftIds.includes(id))) {
    throw Error('PREVIOUS_CLEANUP_PROTECTION_NOT_INSTALLED');
  }
  const currentApproval=()=>{
    const now=runner.clock.wall(),at=Date.parse(approval.approvedAt),expires=Date.parse(approval.expiresAt);
    if (!Number.isFinite(at)||!Number.isFinite(expires)||at<Date.parse(state.startedAt)||at>now||expires<=at||now>=expires) throw Error('PREVIOUS_CLEANUP_APPROVAL_EXPIRED_OR_INVALID');
    if (JSON.stringify(state.permanentDraftDeleteApproval)!==approvalSnapshot||adapter.approvedPermanentDraftIds!==permanent
      ||permanent.size!==approval.approvedPermanentDraftIds.length||[...permanent].some(id=>!approval.approvedPermanentDraftIds.includes(id))) throw Error('PREVIOUS_CLEANUP_APPROVAL_CHANGED');
  };
  const window=()=>JSON.stringify({runId:state.runId,startedAt:state.startedAt,deadlineAt:state.deadlineAt,
    deadlineMono:runner.deadlineMono,nextDueMono:runner.nextDueMono,config:state.config});
  const validWindow=()=>{
    runner.checkDeadline();
    if (!state.startedAt||state.deadlineReached||!Number.isFinite(runner.nextDueMono)
      ||(runner.deadlineMono===null?state.config.durationMs!==null||state.deadlineAt!==null:!Number.isFinite(runner.deadlineMono))
      ||(runner.deadlineMono!==null&&runner.clock.monotonic()>=runner.deadlineMono)) throw Error('PREVIOUS_CLEANUP_RETRY_WINDOW_EXPIRED_OR_MISSING');
  };
  validWindow();currentApproval();
  if (state.records.some(record=>['unknown','attempting','inspecting','held','not_attempted'].includes(record.status))) throw Error('PREVIOUS_CLEANUP_RETRY_HAS_OTHER_HOLD');
  const candidates=state.records.filter(record=>record.status==='sent'&&!['trashed','already_absent'].includes(record.cleanup));
  if (candidates.length!==1) throw Error('PREVIOUS_CLEANUP_RETRY_REQUIRES_ONE_CONFIRMED_SENT_RECORD');
  const record=candidates[0];
  if (record.cleanup!=='pending'||!/^UI_NOT_READY:[^\r\n]+$/.test(record.cleanupError??'')
    ||!record.item||record.item.accountId!==accountId||record.item.draftId!==record.ref.draftId
    ||!runner.validReceipt(record.receipt,record.item)||!approval.approvedPermanentDraftIds.includes(record.ref.draftId)) throw Error('PREVIOUS_CLEANUP_RETRY_NOT_PRE_DISPATCH_UI_HOLD');
  if (state.events.some(event=>event.type==='cleanup_intent'&&event.draftId===record.ref.draftId)
    ||state.records.some(other=>other!==record&&['pending','unknown'].includes(other.cleanup))) throw Error('PREVIOUS_CLEANUP_RETRY_HAS_CLEANUP_INTENT_OR_OTHER_HOLD');
  const originalWindow=window(),originalRecord=JSON.stringify(record);
  const others=()=>JSON.stringify(state.records.filter(other=>other!==record));
  const originalOthers=others(),eventCount=state.events.length;
  const unchanged=()=>{
    validWindow();currentApproval();
    if (runner.state!==state||runner.adapter!==adapter||window()!==originalWindow||JSON.stringify(record)!==originalRecord
      ||others()!==originalOthers||!state.records.includes(record)) throw Error('PREVIOUS_CLEANUP_RETRY_ORIGINAL_STATE_CHANGED');
  };
  runner.busy=true;
  let intent=false,authorized=false,hookCalled=false;
  try {
    if (checkCompatibility) {
      const proof=await checkCompatibility({runId,accountId,draftId:record.ref.draftId,requiresCleanup:true});
      unchanged();
      if (proof?.ok!==true||proof.accountId!==accountId) throw Error('PREVIOUS_CLEANUP_RETRY_COMPATIBILITY_NOT_CONFIRMED');
    }
    unchanged();
    if (state.phase!=='halted'||state.stopReason!=='cleanup_unknown'||state.events.length!==eventCount) throw Error('PREVIOUS_CLEANUP_RETRY_ORIGINAL_STATE_CHANGED');
    try {
      runner.abort=new AbortController();state.phase='running';state.stopReason=null;
      runner.clearTimers?.();runner.armDeadline?.();runner.resetContinuousRuntime?.();
      runner.persist('previously_approved_cleanup_retry_started',{draftId:record.ref.draftId,sentMessageId:record.receipt.messageId,priorError:record.cleanupError});
      const result=await adapter.cleanup(structuredClone(record.item),structuredClone(record.receipt),{
        signal:runner.abort.signal,beforeClick:async()=>{
          if (hookCalled) throw Error('PREVIOUS_CLEANUP_RETRY_HOOK_ALREADY_USED');hookCalled=true;
          unchanged();runner.guard();
          runner.persist('cleanup_intent',{draftId:record.ref.draftId,sentMessageId:record.receipt.messageId,recovery:'previous_approval_pre_dispatch_ui_hold'});
          intent=true;unchanged();runner.guard();authorized=true;
        },
      });
      if (!runner.validCleanup(result,record.item,record.receipt)
        ||(!authorized&&(result.status!=='already_absent'||result.removalMethod!=='provider_consumed'))) throw Error('PREVIOUS_CLEANUP_RETRY_AUTHORITATIVE_EVIDENCE_MISSING');
      if (runner.state!==state||runner.adapter!==adapter||window()!==originalWindow||JSON.stringify(record)!==originalRecord||others()!==originalOthers) throw Error('PREVIOUS_CLEANUP_RETRY_ORIGINAL_STATE_CHANGED');
      record.cleanup=result.status;record.cleanupReceipt=structuredClone(result);delete record.cleanupError;
      runner.persist('cleanup_confirmed',{draftId:record.ref.draftId,status:result.status,recovery:'previous_approval_pre_dispatch_ui_hold'});
      runner.checkDeadline();
      if (state.phase==='running') {
        if (state.records.filter(entry=>entry.status==='sent').length>=state.config.target) {state.phase='target_reached';runner.persist('target_reached');}
        else if (!state.records.some(entry=>entry.status==='pending')) {state.phase='exhausted';runner.persist('queue_exhausted');}
        else runner.persist('recovered',{reason:'previous_approval_pre_dispatch_ui_cleanup_completed',draftId:record.ref.draftId});
      }
      if (state.phase!=='running')runner.clearTimers?.();
    } catch (error) {
      record.status='sent';record.cleanup=intent||authorized?'unknown':'pending';
      record.cleanupError='PREVIOUSLY_APPROVED_CLEANUP_RETRY_FAILED: '+String(error.message??error);
      if (!state.deadlineReached&&!['stopped','deadline'].includes(state.phase)) {state.phase='halted';if(state.stopReason!=='journal_failure')state.stopReason='cleanup_unknown';}
      try{runner.abort.abort(state.stopReason??'cleanup_unknown');}catch{}
      try{runner.clearTimers?.();}catch{}
      try{runner.persist('previously_approved_cleanup_retry_failed',{draftId:record.ref.draftId,intentWritten:intent,error:String(error.message??error)});}
      catch{state.phase='halted';state.stopReason='journal_failure';try{runner.abort.abort('journal_failure');}catch{}}
      throw error;
    }
  } finally {runner.busy=false;}
  return runner.status();
}

/** Record a previously authorized, uncertain send using read-only evidence.
 * Callback mailbox operations MUST remain read-only. The original adapter's
 * reconcile may update its local binding ledger; this never sends or deletes.
 */
export async function reconcileSentAndCleanupAndResume(runner,{reconcileSend,reconcileCleanup,signal}={}) {
  if (typeof reconcileSend!=='function'||typeof reconcileCleanup!=='function') throw Error('READ_ONLY_SEND_AND_ABSENCE_CHECKS_REQUIRED');
  if (runner.busy) throw Error('SENT_RECONCILIATION_REQUIRES_IDLE_RUNNER');
  if (signal?.aborted) throw Error('SENT_RECONCILIATION_ABORTED');
  runner.checkDeadline();
  const state=runner.state,adapter=runner.adapter;
  if (state.phase!=='halted'||!['send_unknown','cleanup_unknown'].includes(state.stopReason)) throw Error('SENT_RECONCILIATION_REQUIRES_UNKNOWN_SEND_OR_CLEANUP_HALT');
  if (!state.startedAt||!Number.isFinite(runner.nextDueMono)
    ||(runner.deadlineMono===null?state.config.durationMs!==null||state.deadlineAt!==null:!Number.isFinite(runner.deadlineMono))) throw Error('SENT_RECONCILIATION_ORIGINAL_WINDOW_MISSING');
  const unknown=state.records.filter(record=>record.status==='unknown');
  const candidates=unknown.length?unknown:state.records.filter(record=>record.status==='sent'&&['pending','unknown'].includes(record.cleanup));
  if (candidates.length!==1||state.records.some(record=>['attempting','inspecting','held','not_attempted'].includes(record.status))) throw Error('SENT_RECONCILIATION_REQUIRES_ONE_UNRESOLVED_RECORD');
  const record=candidates[0],item=record.item,knownSent=record.status==='sent',initialCleanup=record.cleanup;
  if ((knownSent&&state.stopReason!=='cleanup_unknown')||(!knownSent&&state.stopReason!=='send_unknown')) throw Error('SENT_RECONCILIATION_HALT_REASON_MISMATCH');
  const hasText=value=>typeof value==='string'&&value.trim().length>0;
  if (!item||!['accountId','draftId','draftVersion','approvedHash','recipient','subject','body'].every(key=>hasText(item[key]))
    ||item.accountId!==record.ref.accountId||item.draftId!==record.ref.draftId||!hasText(record.attemptAt)||!hasText(record.clickAuthorizedAt)
    ||(knownSent?!runner.validReceipt(record.receipt,item):record.cleanup!=='not_eligible'||record.receipt)
    ||!state.events.some(event=>event.type==='send_intent'&&event.draftId===item.draftId&&event.approvedHash===item.approvedHash)
    ||state.events.some(event=>event.type==='cleanup_intent'&&event.draftId===item.draftId)
    ||(!knownSent&&state.events.some(event=>event.type==='sent_confirmed'&&event.draftId===item.draftId))
    ||(knownSent&&!state.events.some(event=>event.type==='sent_confirmed'&&event.draftId===item.draftId&&event.messageId===record.receipt.messageId))
    ||state.records.some(other=>other!==record&&['pending','unknown'].includes(other.cleanup))) throw Error('SENT_RECONCILIATION_ORIGINAL_INTENT_OR_BINDING_INVALID');
  const window=()=>JSON.stringify({runId:state.runId,startedAt:state.startedAt,deadlineAt:state.deadlineAt,
    deadlineMono:runner.deadlineMono,nextDueMono:runner.nextDueMono,config:state.config});
  const originalWindow=window(),others=()=>JSON.stringify(state.records.filter(other=>other!==record)),originalOthers=others();
  let expectedRecord=JSON.stringify(record),sentRecorded=knownSent,absenceRecorded=false;
  const sameOriginal=()=>{
    runner.checkDeadline();
    if (runner.state!==state||runner.adapter!==adapter||window()!==originalWindow||others()!==originalOthers
      ||!state.records.includes(record)||JSON.stringify(record)!==expectedRecord) throw Error('SENT_RECONCILIATION_ORIGINAL_STATE_CHANGED');
  };
  runner.busy=true;
  try {
    const receipt=await reconcileSend({runId:state.runId,accountId:item.accountId,draftId:item.draftId,item:structuredClone(item)});
    sameOriginal();
    if (!runner.validReceipt(receipt,item)||(knownSent&&receipt.messageId!==record.receipt.messageId)||state.records.some(other=>other!==record&&other.receipt?.messageId===receipt?.messageId)) throw Error('SENT_RECONCILIATION_EXACT_NEW_RECEIPT_NOT_CONFIRMED');
    // Commit the confirmed send before attempting any absence lookup. A later
    // UI/read error must never turn this accepted message back into unknown.
    if (!knownSent) {record.status='sent';record.receipt=structuredClone(receipt);record.cleanup='pending';sentRecorded=true;}
    if (!['stopped','deadline'].includes(state.phase)) {state.phase='halted';state.stopReason='cleanup_unknown';}
    runner.persist(knownSent?'sent_receipt_reverified':'sent_confirmed',{draftId:item.draftId,messageId:receipt.messageId,recovery:'read_only_unknown_send_reconciliation'});
    expectedRecord=JSON.stringify(record);
    if (signal?.aborted) throw Error('SENT_RECONCILIATION_ABORTED');
    const evidence=await reconcileCleanup({runId:state.runId,accountId:item.accountId,draftId:item.draftId,
      item:structuredClone(item),receipt:structuredClone(receipt)});
    sameOriginal();
    if (evidence?.status!=='already_absent'||evidence.authoritative!==true||evidence.removalMethod!=='provider_consumed'
      ||evidence.scope!=='all_drafts_stable_id'||evidence.complete!==true||evidence.absent!==true
      ||!runner.validCleanup(evidence,item,receipt)) throw Error('SENT_RECONCILIATION_COMPLETE_ORIGINAL_ABSENCE_NOT_CONFIRMED');
    record.cleanup='already_absent';record.cleanupReceipt=structuredClone(evidence);delete record.cleanupError;absenceRecorded=true;
    runner.persist('cleanup_reconciled',{draftId:item.draftId,sentMessageId:receipt.messageId,status:'already_absent',
      removalMethod:'provider_consumed',scope:'all_drafts_stable_id',recovery:'read_only_unknown_send_reconciliation'});
    runner.checkDeadline();
    const expired=state.deadlineReached||(runner.deadlineMono!==null&&runner.clock.monotonic()>=runner.deadlineMono);
    if (expired||signal?.aborted||state.phase==='stopped') {
      if (expired) {state.phase='deadline';state.stopReason='deadline';}
      else if (state.phase!=='stopped') {state.phase='stopped';state.stopReason='reconciliation_cancelled';}
      try{runner.abort.abort(state.stopReason);}catch{}
      runner.clearTimers?.();
      runner.persist('recovery_not_resumed',{reason:state.stopReason,draftId:item.draftId});
    } else {
      runner.abort=new AbortController();state.phase='running';state.stopReason=null;
      if (state.records.filter(entry=>entry.status==='sent').length>=state.config.target) {state.phase='target_reached';runner.persist('target_reached');}
      else if (!state.records.some(entry=>entry.status==='pending')) {state.phase='exhausted';runner.persist('queue_exhausted');}
      else {runner.armDeadline?.();runner.resetContinuousRuntime?.();runner.persist('recovered',{reason:'read_only_sent_and_original_absence_confirmed',draftId:item.draftId});}
      if (state.phase!=='running')runner.clearTimers?.();
    }
  } catch(error) {
    // No callback is permitted to delete. Without exact absence evidence the
    // confirmed send remains sent, with its original cleanup still pending.
    if (sentRecorded) {
      record.status='sent';
      if (!absenceRecorded) {record.cleanup=knownSent?initialCleanup:'pending';record.cleanupError='READ_ONLY_ABSENCE_RECONCILIATION_FAILED: '+String(error.message??error);}
    } else record.reconcileError=String(error.message??error);
    if (!state.deadlineReached&&!['stopped','deadline'].includes(state.phase)) {state.phase='halted';if(state.stopReason!=='journal_failure')state.stopReason=sentRecorded?'cleanup_unknown':'send_unknown';}
    try{runner.abort.abort(state.stopReason??'read_only_reconciliation_failed');}catch{}
    try{runner.clearTimers?.();}catch{}
    try{runner.persist('read_only_send_reconciliation_failed',{draftId:item.draftId,sentConfirmed:sentRecorded,absenceConfirmed:absenceRecorded,error:String(error.message??error)});}
    catch{state.phase='halted';state.stopReason='journal_failure';try{runner.abort.abort('journal_failure');}catch{}}
    throw error;
  } finally {runner.busy=false;}
  return runner.status();
}
