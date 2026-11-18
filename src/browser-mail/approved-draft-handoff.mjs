import {randomUUID} from 'node:crypto';
import {hash, email} from '../import.js';

const copy = value => structuredClone(value);
const saveOperations = new WeakMap();
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 40000;
const identifier = value => typeof value === 'string' && value.trim() === value
  && value.length > 0 && value.length <= 512;
const body = value => String(value).replace(/\r\n?/g, '\n').trim();
const noExtraRecipients = item => ['cc','bcc'].every(key => item[key] == null
  || item[key] === '' || Array.isArray(item[key]) && item[key].length === 0);
const stopped = signal => { if (signal?.aborted) throw Error('DRAFT_HANDOFF_CANCELLED'); };
const keyOf = value => value.accountId + '\0' + value.draftId;

function draftHash(draft) {
  return hash({leadId:draft.leadId,recipient:draft.recipient,company:draft.company,
    subject:draft.subject,english:draft.english,chinese:draft.chinese,revision:draft.revision,
    ...(draft.draftingPolicy ? {draftingPolicy:draft.draftingPolicy} : {})});
}

/** Reads approval; never creates it. The trusted host must keep this workflow
 * open and serialize account access around UI operations. */
export function readApprovedDraft({workflow,leadId,expectedCoreHash}) {
  if (!workflow || typeof workflow.ensureOpen !== 'function'
    || typeof workflow.checkEligibility !== 'function'
    || typeof workflow.checkDraftingBasis !== 'function') throw Error('LIVE_CORE_WORKFLOW_REQUIRED');
  workflow.ensureOpen();
  if (!identifier(leadId) || !identifier(expectedCoreHash)) throw Error('EXACT_CORE_DRAFT_HASH_REQUIRED');
  const lead=workflow.lead(leadId),draft=workflow.draft(leadId),approval=draft.approval;
  if (lead.purpose === 'reply') throw Error('REPLY_DRAFT_HANDOFF_NOT_SUPPORTED');
  workflow.checkEligibility(lead);
  workflow.checkDraftingBasis(draft);
  if (lead.purpose === 'reply'
    ? !(lead.threadOwnershipVerified && lead.threadId && lead.replyToMessageId && lead.inboundContext)
    : lead.newness !== 'verified') throw Error('FULL_HISTORY_NEWNESS_NOT_VERIFIED');
  if (draft.leadId !== leadId || draft.hash !== expectedCoreHash || draftHash(draft) !== draft.hash
    || !approval || approval.hash !== draft.hash || approval.revision !== draft.revision
    || !text(approval.reviewer)) throw Error('EXACT_CURRENT_HUMAN_APPROVAL_REQUIRED');
  if (approval.accountId !== workflow.config.accountId) throw Error('APPROVED_MAILBOX_ACCOUNT_CHANGED');
  if (!Number.isFinite(approval.expiresAt) || approval.expiresAt <= workflow.now()) throw Error('CORE_APPROVAL_EXPIRED');
  if (email(draft.recipient) !== lead.email || !text(draft.subject)
    || /[\r\n]/.test(draft.subject) || !text(draft.english) || !text(draft.chinese)) throw Error('CORE_APPROVED_CONTENT_INVALID');
  if (workflow.state.queue.some(q => q.leadId === leadId && ['sending','sent','unknown'].includes(q.status))) {
    throw Error('CORE_SEND_ALREADY_ATTEMPTED');
  }
  return Object.freeze({leadId,accountId:workflow.config.accountId,coreDraftRevision:draft.revision,
    coreApprovalHash:draft.hash,recipient:draft.recipient,subject:draft.subject,body:body(draft.english),
    draftingBasisHash:draft.draftingPolicy?.basisHash ?? null,
    approvalExpiresAt:approval.expiresAt});
}

function record(store,event) {
  if (!store) return;
  if (typeof store.save !== 'function') throw Error('SYNCHRONOUS_HANDOFF_STORE_REQUIRED');
  const result=store.save(copy(event));
  if (result?.then) throw Error('SYNCHRONOUS_HANDOFF_STORE_REQUIRED');
}
function existingSnapshot(result,accountId) {
  if (result?.complete !== true || result.accountId !== accountId || !Array.isArray(result.drafts)
    || result.drafts.length > 10000) throw Error('COMPLETE_DRAFT_SEARCH_REQUIRED');
  const ids=new Set();
  for (const ref of result.drafts) {
    if (ref.accountId !== accountId || !identifier(ref.draftId) || ids.has(ref.draftId)) throw Error('DRAFT_SEARCH_BINDING_AMBIGUOUS');
    ids.add(ref.draftId);
  }
  return result.drafts;
}
function matchesContent(item,packet) {
  if (!item || item.accountId !== packet.accountId || email(item.recipient) !== packet.recipient
    || item.subject !== packet.subject || !text(item.body) || body(item.body) !== packet.body
    || !noExtraRecipients(item) || item.attachments === true) throw Error('MAILBOX_DRAFT_CONTENT_MISMATCH');
  const contentHash=hash({accountId:packet.accountId,recipient:packet.recipient,subject:packet.subject,body:packet.body});
  if (item.approvedHash !== contentHash || !identifier(item.draftVersion)) throw Error('MAILBOX_CONTENT_HASH_OR_VERSION_MISMATCH');
  return contentHash;
}
// Serializer labels are audit evidence, never a replacement for exact body/hash checks.
function serializationEvidence(item) {
  const bodySerialization=item.bodySerialization??'native-ax-text-v1';
  if(!identifier(bodySerialization))throw Error('BODY_SERIALIZATION_LABEL_INVALID');
  return {bodySerialization,...(item.bodyEvidence?{bodyEvidence:copy(item.bodyEvidence)}:{})};
}
function proofFields(binding) {
  if (binding?.schema !== 1 || binding.status !== 'saved_and_readback_verified'
    || !identifier(binding.leadId) || !identifier(binding.accountId)
    || !identifier(binding.coreApprovalHash) || !Number.isInteger(binding.coreDraftRevision)
    || binding.coreDraftRevision < 1 || !identifier(binding.mailboxDraftId)
    || !identifier(binding.mailboxDraftVersion) || !identifier(binding.mailboxContentHash)
    || !text(binding.body) || !text(binding.subject)) throw Error('VERIFIED_HANDOFF_BINDING_REQUIRED');
  const packet={accountId:binding.accountId,recipient:email(binding.recipient),subject:binding.subject,body:body(binding.body)};
  if (hash(packet) !== binding.mailboxContentHash) throw Error('HANDOFF_CONTENT_HASH_MISMATCH');
  return {...copy(binding),...packet,...serializationEvidence(binding)};
}
function packetForBinding(workflow,binding) {
  const packet=readApprovedDraft({workflow,leadId:binding.leadId,expectedCoreHash:binding.coreApprovalHash});
  if (packet.coreDraftRevision !== binding.coreDraftRevision || packet.accountId !== binding.accountId
    || packet.recipient !== binding.recipient || packet.subject !== binding.subject || packet.body !== binding.body
    || packet.draftingBasisHash !== (binding.draftingBasisHash ?? null)) throw Error('CORE_HANDOFF_BINDING_CHANGED');
  return packet;
}
function itemForBinding(item,binding) {
  if (item?.draftId !== binding.mailboxDraftId || item?.draftVersion !== binding.mailboxDraftVersion) {
    throw Error('MAILBOX_ORIGINAL_DRAFT_BINDING_CHANGED');
  }
  const contentHash=matchesContent(item,binding);
  if (contentHash !== binding.mailboxContentHash) throw Error('HANDOFF_CONTENT_HASH_MISMATCH');
}

/**
 * Adapter contract:
 * - readExisting({accountId,recipient,signal}) -> {accountId,complete:true,drafts:[refs]}
 *   must cover the complete scoped draft search, including stable draft IDs.
 * - save(packet,{beforeSave,signal}) -> {status:'saved',draftId?}. Obtain fresh
 *   controls, fill only packet fields, and await beforeSave immediately before
 *   the save action. Never click send/schedule, use send hotkeys, or retry.
 * - inspect(ref,{signal}) -> full BrowserMailAdapter-style item (full body).
 *
 * A save toast or returned ID alone never establishes a handoff. The next
 * complete search must expose exactly one new matching ID and full readback
 * must match. The caller supplies any required durable store and account lock.
 * A failed/unknown save remains reserved for explicit reconciliation.
 */
export async function saveApprovedDraft({workflow,leadId,expectedCoreHash,adapter,store,signal}={}) {
  if (!adapter || ['readExisting','save','inspect'].some(name => typeof adapter[name] !== 'function')) {
    throw Error('DRAFT_SAVE_ADAPTER_REQUIRED');
  }
  if (store && typeof store.save !== 'function') throw Error('SYNCHRONOUS_HANDOFF_STORE_REQUIRED');
  stopped(signal);
  let operations=saveOperations.get(workflow);
  if (!operations) { operations=new Map();saveOperations.set(workflow,operations); }
  if (operations.has(leadId)) throw Error('DRAFT_SAVE_ALREADY_ATTEMPTED_RECONCILE');
  const operation={attemptId:randomUUID(),phase:'reading',attempted:false};
  operations.set(leadId,operation);
  try {
    const packet=readApprovedDraft({workflow,leadId,expectedCoreHash});
    const before=existingSnapshot(await adapter.readExisting({accountId:packet.accountId,recipient:packet.recipient,signal}),packet.accountId);
    stopped(signal);
    readApprovedDraft({workflow,leadId,expectedCoreHash});
    if (before.some(ref => ref.recipient === packet.recipient && ref.subject === packet.subject)) throw Error('MATCHING_EXISTING_DRAFT_REQUIRES_REVIEW');
    const oldIds=new Set(before.map(ref => ref.draftId));
    const meta={attemptId:operation.attemptId,leadId,accountId:packet.accountId,coreApprovalHash:expectedCoreHash};
    let saveHookCalled=false;
    operation.attempted=true;operation.phase='saving';
    record(store,{...meta,event:'draft_save_started',persistence:store?'host-store':'volatile'});
    const result=await adapter.save(packet,{signal,beforeSave:()=>{
      if (saveHookCalled) throw Error('DRAFT_SAVE_HOOK_ALREADY_USED');
      saveHookCalled=true;stopped(signal);
      readApprovedDraft({workflow,leadId,expectedCoreHash});
      record(store,{...meta,event:'draft_save_intent'});
      stopped(signal);readApprovedDraft({workflow,leadId,expectedCoreHash});
      return {allowed:true};
    }});
    if (!saveHookCalled) throw Error('DRAFT_SAVE_AUTHORIZATION_HOOK_REQUIRED');
    if (result?.status !== 'saved') throw Error('DRAFT_SAVE_OUTCOME_UNCONFIRMED');
    stopped(signal);readApprovedDraft({workflow,leadId,expectedCoreHash});
    const after=existingSnapshot(await adapter.readExisting({accountId:packet.accountId,recipient:packet.recipient,signal}),packet.accountId);
    stopped(signal);readApprovedDraft({workflow,leadId,expectedCoreHash});
    const candidates=after.filter(ref => !oldIds.has(ref.draftId)
      && ref.recipient === packet.recipient && ref.subject === packet.subject);
    if (candidates.length !== 1) throw Error('NEW_SAVED_DRAFT_ID_MISSING_OR_AMBIGUOUS');
    const ref=candidates[0];
    if (result.draftId !== undefined && result.draftId !== ref.draftId) throw Error('SAVED_DRAFT_ID_MISMATCH');
    const inspected=await adapter.inspect(copy(ref),{signal});
    stopped(signal);readApprovedDraft({workflow,leadId,expectedCoreHash});
    if (inspected?.draftId !== ref.draftId) throw Error('SAVED_DRAFT_ID_MISMATCH');
    const mailboxContentHash=matchesContent(inspected,packet);
    const proof=Object.freeze({schema:1,status:'saved_and_readback_verified',leadId,
      accountId:packet.accountId,coreDraftRevision:packet.coreDraftRevision,
      coreApprovalHash:packet.coreApprovalHash,draftingBasisHash:packet.draftingBasisHash,
      mailboxDraftId:ref.draftId,mailboxDraftVersion:inspected.draftVersion,mailboxContentHash,
      recipient:packet.recipient,subject:packet.subject,body:packet.body,
      ...serializationEvidence(inspected),
      browserId:adapter.identity?.browserId ?? null,targetId:adapter.identity?.targetId ?? null,
      verifiedAt:new Date(workflow.now()).toISOString()});
    operation.phase='verified';operation.proof=proof;
    record(store,{...meta,event:'draft_handoff_verified',proof});
    return copy(proof);
  } catch (error) {
    operation.phase=operation.attempted?'needs_review':'not_attempted';
    if (operation.attempted) {
      error.handoffSaveAttempted=true;
      try { record(store,{attemptId:operation.attemptId,leadId,event:'draft_handoff_needs_review',error:String(error.message??error)}); } catch {}
    } else operations.delete(leadId);
    throw error;
  }
}

/** Wraps the mailbox adapter without changing its content hash or receipts.
 * Bindings are trusted-host records from saveApprovedDraft, not new approvals.
 * Read-only reconciliation remains available after approval expiry/change.
 * This wrapper never retries a save, send, or cleanup action. */
export function bindApprovedDrafts({workflow,bindings,adapter}={}) {
  if (!adapter || !Array.isArray(bindings) || !bindings.length || bindings.length > 50) throw Error('VERIFIED_HANDOFF_BINDINGS_REQUIRED');
  const selected=bindings.map(proofFields),byDraft=new Map(),leadIds=new Set();
  for (const binding of selected) {
    const key=keyOf({accountId:binding.accountId,draftId:binding.mailboxDraftId});
    if (byDraft.has(key) || leadIds.has(binding.leadId)) throw Error('DUPLICATE_APPROVED_HANDOFF');
    packetForBinding(workflow,binding);
    byDraft.set(key,binding);leadIds.add(binding.leadId);
  }
  const lookup=item=>{
    const binding=byDraft.get(keyOf(item??{}));
    if (!binding) throw Error('UNBOUND_MAILBOX_DRAFT');
    return binding;
  };
  const validate=(item,{full=true,current=true}={})=>{
    const binding=lookup(item);
    if (current) packetForBinding(workflow,binding);
    if (full) itemForBinding(item,binding);
    return binding;
  };
  return new Proxy(adapter,{get(target,property){
    if (property === 'scanDrafts') return async({limit=50}={})=>selected.slice(0,limit).map(binding=>({
      accountId:binding.accountId,draftId:binding.mailboxDraftId,draftVersion:binding.mailboxDraftVersion,
      recipient:binding.recipient,subject:binding.subject,approvedHash:binding.mailboxContentHash,
      ...serializationEvidence(binding)
    }));
    if (property === 'inspectDraft') return async(ref,...args)=>{
      const binding=validate(ref,{full:false});
      const item=await target.inspectDraft(ref,...args);
      packetForBinding(workflow,binding);itemForBinding(item,binding);
      return item;
    };
    if (property === 'preflight') return async(item,...args)=>{
      const binding=validate(item);
      const result=await target.preflight(item,...args);
      packetForBinding(workflow,binding);return result;
    };
    if (property === 'send') return async(item,{beforeClick,signal,...options}={})=>{
      const binding=validate(item);
      if (typeof beforeClick !== 'function') throw Error('GUARDED_SEND_HOOK_REQUIRED');
      let used=false;
      return await target.send(item,{...options,signal,beforeClick:async(hook={})=>{
        if (used || typeof hook.revalidate !== 'function') throw Error('FRESH_SEND_REVALIDATION_REQUIRED');
        used=true;stopped(signal);packetForBinding(workflow,binding);itemForBinding(item,binding);
        await beforeClick({...hook,revalidate:async()=>{
          stopped(signal);packetForBinding(workflow,binding);
          await hook.revalidate();
          stopped(signal);packetForBinding(workflow,binding);itemForBinding(item,binding);
        }});
        // Synchronous approval recheck after the pacing and live-content reads.
        stopped(signal);packetForBinding(workflow,binding);itemForBinding(item,binding);
      }});
    };
    if (property === 'reconcile') return async(item,...args)=>{
      validate(item,{current:false});return await target.reconcile(item,...args);
    };
    if (property === 'cleanup') return async(item,receipt,{beforeClick,signal,...options}={})=>{
      const binding=validate(item);
      if (typeof beforeClick !== 'function') throw Error('GUARDED_CLEANUP_HOOK_REQUIRED');
      return await target.cleanup(item,receipt,{...options,signal,beforeClick:async()=>{
        stopped(signal);packetForBinding(workflow,binding);itemForBinding(item,binding);
        await beforeClick();
        stopped(signal);packetForBinding(workflow,binding);itemForBinding(item,binding);
      }});
    };
    const value=Reflect.get(target,property,target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}

/** Converts verified proof records to selected refs; approval is rechecked by the binder. */
export function preparedRefsForBindings(bindings) {
  if(!Array.isArray(bindings)||!bindings.length||bindings.length>50)throw Error('VERIFIED_HANDOFF_BINDINGS_REQUIRED');
  const seen=new Set();
  return bindings.map(input=>{
    const binding=proofFields(input),key=keyOf({accountId:binding.accountId,draftId:binding.mailboxDraftId});
    if(seen.has(key))throw Error('DUPLICATE_APPROVED_HANDOFF');seen.add(key);
    return {accountId:binding.accountId,draftId:binding.mailboxDraftId,draftVersion:binding.mailboxDraftVersion,recipient:binding.recipient,subject:binding.subject,approvedHash:binding.mailboxContentHash,...serializationEvidence(binding)};
  });
}

/**
 * Trusted-host, explicit read-only recovery after an uncertain save/autosave.
 * expectedMailboxDraftId must come from inspected UI evidence for that attempt.
 * Unlike saveApprovedDraft this does not claim a newly created ID, create a
 * draft, call adapter.save, send, delete, or release a prior save reservation.
 * The caller retains account exclusivity and the original uncertain-save log.
 */
export async function reconcileApprovedDraftSave({
  workflow,leadId,expectedCoreHash,expectedMailboxDraftId,adapter,store,signal
}={}) {
  if (!identifier(expectedMailboxDraftId)) throw Error('EXPLICIT_MAILBOX_DRAFT_ID_REQUIRED');
  if (!adapter || ['readExisting','inspect'].some(name=>typeof adapter[name] !== 'function')) {
    throw Error('READ_ONLY_DRAFT_RECONCILIATION_ADAPTER_REQUIRED');
  }
  if (store && typeof store.save !== 'function') throw Error('SYNCHRONOUS_HANDOFF_STORE_REQUIRED');
  stopped(signal);
  const operation=saveOperations.get(workflow)?.get(leadId);
  if (operation && ['reading','saving'].includes(operation.phase)) throw Error('DRAFT_SAVE_STILL_IN_PROGRESS');
  const packet=readApprovedDraft({workflow,leadId,expectedCoreHash});
  if (workflow.state.mailboxDraftBindings?.[leadId]?.usage) throw Error('HANDOFF_SEND_ALREADY_ATTEMPTED_RECONCILE');
  const originalAttempt=workflow.state.mailboxDraftSaveAttempts?.[leadId];
  if (originalAttempt && ((originalAttempt.coreApprovalHash && originalAttempt.coreApprovalHash !== expectedCoreHash)
    || (originalAttempt.accountId && originalAttempt.accountId !== packet.accountId))) throw Error('ORIGINAL_SAVE_ATTEMPT_BINDING_CHANGED');
  const searched=await adapter.readExisting({accountId:packet.accountId,recipient:packet.recipient,signal});
  stopped(signal);readApprovedDraft({workflow,leadId,expectedCoreHash});
  const refs=existingSnapshot(searched,packet.accountId);
  const matches=refs.filter(ref=>ref.draftId===expectedMailboxDraftId);
  if (matches.length !== 1) throw Error('EXPLICIT_ORIGINAL_DRAFT_NOT_FOUND');
  const ref=matches[0];
  if (ref.recipient !== packet.recipient || ref.subject !== packet.subject) throw Error('EXPLICIT_ORIGINAL_DRAFT_CONTENT_MISMATCH');
  const inspected=await adapter.inspect(copy(ref),{signal});
  stopped(signal);readApprovedDraft({workflow,leadId,expectedCoreHash});
  if (inspected?.draftId !== expectedMailboxDraftId) throw Error('EXPLICIT_ORIGINAL_DRAFT_ID_MISMATCH');
  const mailboxContentHash=matchesContent(inspected,packet);
  const priorAttempt=workflow.state.mailboxDraftSaveAttempts?.[leadId];
  const originalSaveAttemptId=priorAttempt?.attemptId ?? operation?.attemptId ?? null;
  const proof=Object.freeze({schema:1,status:'saved_and_readback_verified',leadId,
    accountId:packet.accountId,coreDraftRevision:packet.coreDraftRevision,
    coreApprovalHash:packet.coreApprovalHash,draftingBasisHash:packet.draftingBasisHash,
    mailboxDraftId:expectedMailboxDraftId,mailboxDraftVersion:inspected.draftVersion,mailboxContentHash,
    recipient:packet.recipient,subject:packet.subject,body:packet.body,
    ...serializationEvidence(inspected),
    browserId:adapter.identity?.browserId ?? null,targetId:adapter.identity?.targetId ?? null,
    verifiedAt:new Date(workflow.now()).toISOString(),
    recoveryMethod:'explicit_existing_draft_reconciliation',originalSaveAttemptId});
  record(store,{attemptId:originalSaveAttemptId ?? randomUUID(),leadId,accountId:packet.accountId,
    coreApprovalHash:expectedCoreHash,event:'draft_handoff_verified',
    recoveryMethod:proof.recoveryMethod,proof});
  return copy(proof);
}
