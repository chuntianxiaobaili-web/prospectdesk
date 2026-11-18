import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildDraftPrompt, clean, domain, email, hash, normalizeLead, parseCSV } from './import.js';
const terminal = new Set(['sent','cancelled','suppressed']);
const clone = x => structuredClone(x);
const identifier = value => typeof value === 'string' && value.trim() === value
  && value.length > 0 && value.length <= 512;
const sameBinding = (expected, candidate) => ['accountId', 'draftId', 'draftVersion', 'approvedHash']
  .every(field => expected[field] === candidate?.[field]);
export class SalesWorkflow {
  constructor({ directory, config, draftAdapter, mailAdapter, now = () => Date.now(),
    runtimePid = typeof process !== 'undefined' && Number.isSafeInteger(process.pid) && process.pid > 0 ? process.pid : null }) {
    if (!directory || !config?.brand || !config?.draftModel?.provider || !config?.draftModel?.model) throw Error('Directory, brand and explicit drafting route required');
    if(runtimePid!==null&&(!Number.isSafeInteger(runtimePid)||runtimePid<=0))throw Error('RUNTIME_PID_MUST_BE_POSITIVE_INTEGER_OR_NULL');
    this.runtimePid=runtimePid;
    this.config = clone(config); this.directory = path.resolve(directory); this.draftAdapter = draftAdapter; this.mailAdapter = mailAdapter; this.now = now; this.running = false;
    const interval = config.minimumIntervalSeconds ?? config.pacing?.maxSeconds ?? config.pacing?.minSeconds ?? 180;
    const between = config.batchInterMessageSeconds ?? 0;
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 86400) throw Error('Minimum interval must be an integer from 1 to 86400 seconds');
    if (!Number.isSafeInteger(between) || between < 0 || between > 86400) throw Error('Batch spacing must be an integer from 0 to 86400 seconds');
    this.minimumInterval = interval * 1000;
    this.batchSpacing = between * 1000;
    if(!clean(config.accountId))throw Error('Explicit accountId required even for mock');
    const lockRoot=path.resolve(config.accountLockDirectory??path.join(os.tmpdir(),'harness-sales-account-locks'));fs.mkdirSync(lockRoot,{recursive:true});this.accountLock=path.join(lockRoot,hash(config.accountId)+'.lock');
    fs.mkdirSync(this.directory,{recursive:true}); this.file = path.join(this.directory,'state.json'); this.lock = path.join(this.directory,'state.lock');
    try {this.lockFd = fs.openSync(this.lock,'wx',0o600);fs.writeFileSync(this.lockFd,JSON.stringify({pid:this.runtimePid}));}
    catch(err) {if(err.code==='EEXIST') throw Error('Workflow already open or stale lock exists; inspect owner before recovery');throw err;}
    try {
      this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file,'utf8')) : {schema:1,leads:{},drafts:{},queue:[],suppressed:[],history:[],audit:[],paused:true,lastAttemptAt:null};
      if(this.state.schema!==1) throw Error('Unsupported state schema');
      this.state.paused = true;
      if(!this.state.batchPlan&&config.batchPlan){this.validatePlan(config.batchPlan);this.state.batchPlan=clone(config.batchPlan);this.state.batchProgress={stage:0,sent:0,complete:false};}
      for(const q of this.state.queue) if(q.status==='sending'){q.status='unknown';q.error='Restart after send began: reconcile, never auto-retry';}
      this.save();
    } catch(err){this.close();throw err;}
  }
  ensureOpen(){if(this.closed)throw Error('Workflow closed');}
  save(){this.ensureOpen();const tmp=this.file+'.tmp';const fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(this.state,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,this.file);}
  audit(action,data){this.state.audit.push({at:new Date(this.now()).toISOString(),action,...clone(data)});}
  close(){if(this.closed)return;if(this.running){this.state.paused=true;this.abort?.abort();this.save();this.closePromise??=new Promise(resolve=>{this.finishClose=resolve;});return this.closePromise;}this.abort?.abort();if(this.lockFd!=null){fs.closeSync(this.lockFd);try{fs.unlinkSync(this.lock);}catch{}}this.closed=true;}
  importCSV(text){return this.importRows(parseCSV(text));}
  importRows(rows){
    this.ensureOpen();if(!Array.isArray(rows)||rows.length>10000)throw Error('Expected bounded rows');
    const result={accepted:[],rejected:[]};
    for(let i=0;i<rows.length;i++)try{
      const l=normalizeLead(rows[i]); const old=[...Object.values(this.state.leads),...this.state.history];
      if(this.state.leads[l.id])throw Error('Duplicate lead ID');
      if(old.some(x=>x.email===l.email||x.domain===l.domain||x.companyKey===l.companyKey||(l.groupKey&&x.groupKey===l.groupKey)))throw Error('Previously screened company/domain/email/group');
      this.state.leads[l.id]=l; result.accepted.push(l.id);
    }catch(err){result.rejected.push({row:i+1,reason:err.message});const r=rows[i];let d='';try{const v=r.website??r['官网'];if(v)d=domain(v);}catch{}const companyKey=clean(r.company??r['公司']).toLowerCase().replace(/[\p{P}\p{Z}\s]/gu,'');const groupKey=clean(r.group??r['集团']??r['别名及集团']).toLowerCase();if((d||companyKey||groupKey)&&!Object.values(this.state.leads).some(x=>x.domain===d||x.companyKey===companyKey||(groupKey&&x.groupKey===groupKey)))this.state.history.push({domain:d,companyKey,groupKey,email:'',screenedRejected:true,reason:err.message});}
    this.audit('import',{accepted:result.accepted.length,rejected:result.rejected.length});this.save();return result;
  }
  importHistory(rows){this.ensureOpen();for(const r of rows){const e=r.email?email(r.email):'';const d=r.domain?domain(r.domain):r.website?domain(r.website):'';const companyKey=clean(r.company).toLowerCase().replace(/[\p{P}\p{Z}\s]/gu,'');const groupKey=clean(r.group).toLowerCase();if(!e&&!d&&!companyKey&&!groupKey)throw Error('Empty historical identity');this.state.history.push({email:e,domain:d,companyKey,groupKey});}this.audit('history_import',{count:rows.length});this.save();}
  lead(id){const l=this.state.leads[id];if(!l)throw Error('Unknown lead');return l;}
  draft(id){const d=this.state.drafts[id];if(!d)throw Error('No draft');return d;}
  isSuppressed(l){return this.state.suppressed.some(x=>x.email===l.email||x.domain===l.domain);}
  checkEligibility(l){if(l.purpose!=='reply'&&this.state.history.some(x=>x.email===l.email||x.domain===l.domain||x.companyKey===l.companyKey||(l.groupKey&&x.groupKey===l.groupKey)))throw Error('Lead conflicts with historical index');if(this.isSuppressed(l))throw Error('Recipient suppressed');if(/拒绝|退订|do.?not.?contact|opt.?out|rejected|unsubscribe/i.test(l.contactStatus))throw Error('Contact status prohibits outreach');}
  prepareDraft(id){
    const l=this.lead(id);this.checkEligibility(l);
    const policy=this.draftingMode()==='product-evidence-review'?this.productEvidenceContext():null;
    const prompt=buildDraftPrompt(l,{...this.config,playbook:policy?null:this.state.approvedPlaybook?.content??null});
    return {route:clone(this.config.draftModel),prompt:policy?'DRAFTING_POLICY='+JSON.stringify({mode:policy.mode,basisHash:policy.basisHash,review:'Exact per-message human approval required; no 100-source learning completion claimed'})+'\n'+prompt:prompt,...(policy?{draftingPolicy:clone(policy)}:{})};
  }
  async generateDraft(id,signal){
    this.ensureOpen();const policy=this.checkLearningReady();if(!this.draftAdapter?.generate)throw Error('Draft model adapter not configured');
    const input=this.prepareDraft(id),out=await this.draftAdapter.generate({...input,signal});
    if(policy?.mode==='product-evidence-review'&&this.productEvidenceContext().basisHash!==policy.basisHash)throw Error('Product evidence changed during draft generation; generate and review again');
    return this.setDraft(id,out);
  }
  setDraft(id,out){
    this.ensureOpen();const draftingPolicy=this.checkLearningReady();const l=this.lead(id);this.checkEligibility(l);
    if(this.state.queue.some(q=>q.leadId===id&&!terminal.has(q.status)))throw Error('Cancel or reconcile queued item before editing');
    const subject=clean(out.subject),english=clean(out.english),chinese=clean(out.chinese);
    if(!subject||/[\r\n]/.test(subject)||subject.length>300||!english||!chinese||english.length>40000||chinese.length>40000)throw Error('Valid subject and both draft languages required');
    for(const [otherId,d] of Object.entries(this.state.drafts))if(otherId!==id&&(d.english===english||d.chinese===chinese))throw Error('Duplicate cross-customer draft; individualize before review');
    const previous=this.state.drafts[id];const d={leadId:id,recipient:l.email,company:l.company,subject,english,chinese,revision:(previous?.revision??0)+1,draftModel:clone(this.config.draftModel),createdAt:new Date(this.now()).toISOString(),approval:null,...(draftingPolicy?{draftingPolicy:clone(draftingPolicy)}:{})};
    d.hash=hash({leadId:id,recipient:d.recipient,company:d.company,subject,english,chinese,revision:d.revision,...(draftingPolicy?{draftingPolicy}: {})});this.state.drafts[id]=d;this.audit('draft_saved',{leadId:id,revision:d.revision,hash:d.hash});this.save();return clone(d);
  }
  draftingMode(){
    const mode=this.config.draftingPolicy?.mode??'hundred-source-playbook';
    if(!['hundred-source-playbook','product-evidence-review'].includes(mode))throw Error('Unknown drafting policy mode');
    return mode;
  }
  productEvidenceContext(){
    const brand=this.config.brand;
    const boundedText=value=>typeof value==='string'&&value.trim().length>0&&value.length<=10000&&!value.includes('\0');
    if(!Array.isArray(brand.verifiedFacts)||!brand.verifiedFacts.length||brand.verifiedFacts.length>1000||!brand.verifiedFacts.every(boundedText))throw Error('Product evidence review requires non-empty verified product facts');
    if(!Array.isArray(brand.evidenceSources)||!brand.evidenceSources.length||brand.evidenceSources.length>1000)throw Error('Product evidence review requires auditable evidence sources');
    const evidenceSources=brand.evidenceSources.map(source=>{
      if(!source||typeof source!=='object'||!boundedText(source.readEvidence)||!boundedText(source.checkedAt))throw Error('Product evidence source requires readEvidence and checkedAt');
      const checkedAt=source.checkedAt.trim(),when=Date.parse(checkedAt),calendar=checkedAt.match(/^\d{4}-\d{2}-\d{2}(?:$|T)/)?.[0].slice(0,10);
      if(!calendar||!Number.isFinite(when)||new Date(calendar+'T00:00:00Z').toISOString().slice(0,10)!==calendar)throw Error('Product evidence checkedAt must be a valid ISO date');
      const locator={};
      if(source.path!==undefined){if(!boundedText(source.path)||!(path.win32.isAbsolute(source.path)||path.posix.isAbsolute(source.path)))throw Error('Product evidence path must be absolute');locator.path=source.path.trim();}
      if(source.url!==undefined){let u;try{u=new URL(source.url);}catch{throw Error('Product evidence URL must be public HTTP(S)');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('Product evidence URL must be public HTTP(S)');locator.url=u.href;}
      if(!locator.path&&!locator.url)throw Error('Product evidence source requires a path or URL');
      if(source.locator!==undefined&&!boundedText(source.locator))throw Error('Product evidence locator must be non-empty');
      return {...locator,readEvidence:source.readEvidence.trim(),checkedAt,...(source.locator?{locator:source.locator.trim()}:{})};
    });
    const basis={brandName:clean(brand.name),products:clone(brand.products??[]),verifiedFacts:brand.verifiedFacts.map(s=>s.trim()),evidenceSources,unknowns:clone(brand.unknowns??[])};
    return {schema:1,mode:'product-evidence-review',basisHash:hash(basis),basis};
  }
  checkLearningReady(){
    if(this.draftingMode()==='product-evidence-review')return this.productEvidenceContext();
    if(this.draftAdapter?.mode==='mock')return;
    if(!this.state.approvedPlaybook?.content?.ready||this.state.approvedPlaybook.content.reviewedSources<100)throw Error('First review 100 distinct learning sources and approve their synthesized playbook');
  }
  checkDraftingBasis(draft){
    const mode=this.draftingMode(),saved=draft.draftingPolicy;
    if(mode==='product-evidence-review'){
      const current=this.productEvidenceContext();
      if(saved?.mode!==mode||!saved.basis||saved.basisHash!==hash(saved.basis)||saved.basisHash!==current.basisHash)throw Error('Product evidence or drafting policy changed; save and review a new draft');
    }else if(saved?.mode==='product-evidence-review')throw Error('Drafting policy changed; save and review a new draft');
  }
  approvePlaybook({content,hash:expected,reviewer}){this.ensureOpen();if(!content?.ready||content.reviewedSources<100||hash(content)!==expected||!clean(reviewer))throw Error('Complete 100-source playbook and exact human approval required');this.state.approvedPlaybook={content:clone(content),hash:expected,reviewer:clean(reviewer),at:new Date(this.now()).toISOString()};this.audit('playbook_approved',{hash:expected,reviewer});this.save();return clone(this.state.approvedPlaybook);}
  // Host-only review method: deliberately NOT registered as an agent tool.
  approve(id,{hash:expectedHash,reviewer,acknowledgedRecipient}){
    this.ensureOpen();const l=this.lead(id),d=this.draft(id);this.checkEligibility(l);this.checkDraftingBasis(d);
    if(l.purpose==='reply' ? !(l.threadOwnershipVerified&&l.threadId&&l.replyToMessageId&&l.inboundContext) : l.newness!=='verified')throw Error('Full-history newness not verified; draft-only candidate');
    if(!clean(reviewer)||expectedHash!==d.hash||email(acknowledgedRecipient)!==d.recipient)throw Error('Approval must match exact current draft and recipient');
    d.approval={accountId:this.config.accountId,hash:d.hash,revision:d.revision,reviewer:clean(reviewer),at:new Date(this.now()).toISOString(),expiresAt:this.now()+(this.config.approvalMaxAgeSeconds??86400)*1000};this.audit('human_review_approved',{leadId:id,hash:d.hash,reviewer:clean(reviewer)});this.save();return clone(d.approval);
  }
  enqueue(id){
    this.ensureOpen();const l=this.lead(id),d=this.draft(id);this.checkEligibility(l);this.checkDraftingBasis(d);
    if(!d.approval||d.approval.hash!==d.hash||d.approval.revision!==d.revision)throw Error('Exact current human-approved draft required');
    if(this.state.queue.some(q=>q.leadId===id&&!['cancelled','suppressed'].includes(q.status)))throw Error('Already queued, sent or uncertain; do not duplicate');
    if(d.approval.accountId!==this.config.accountId)throw Error('Approved mailbox account changed');
    if(d.approval.expiresAt<=this.now())throw Error('Approval expired');
    const previous=this.state.queue.find(q=>q.snapshot.hash===d.hash);if(previous){if(previous.status!=='cancelled')throw Error('Existing send packet');previous.status='queued';previous.snapshot=clone(d);delete previous.draftBinding;previous.notBefore=Math.max(this.now(),this.state.nextAllowedAt??0);this.save();return clone(previous);}
    const snapshot=clone(d),q={id:'send_'+hash(d.hash).slice(0,20),leadId:id,snapshot,status:'queued',notBefore:Math.max(this.now(),this.state.nextAllowedAt??0),attempts:0,receipt:null};
    this.state.queue.push(q);this.audit('enqueued',{id:q.id,leadId:id,hash:d.hash});this.save();return clone(q);
  }
  pause(){this.ensureOpen();this.state.paused=true;this.abort?.abort();this.audit('paused',{});this.save();}
  resume({notBefore, allowedIds} = {}) {
    this.ensureOpen();
    if (this.state.batchProgress?.complete) throw Error('Batch plan complete; set next explicit plan');
    if (this.state.queue.some(q => q.status === 'unknown')) throw Error('Reconcile uncertain send before resuming');
    if (notBefore !== undefined && (!Number.isFinite(notBefore) || notBefore < 0)) throw Error('Invalid planned start');
    if (notBefore > 0) {
      for (const q of this.state.queue) {
        if (q.status === 'queued' && (!allowedIds || allowedIds.has(q.id))) q.notBefore = Math.max(q.notBefore, notBefore);
      }
    }
    this.state.paused = false;
    this.audit('resumed', notBefore > 0 ? {notBefore} : {});
    this.save();
  }
  async mailboxCompatibility({signal, busy} = {}) {
    this.ensureOpen();
    const report = {compatible: false, mode: this.mailAdapter?.mode === 'mock' ? 'mock' : this.mailAdapter ? 'configured' : 'none', checkedAt: new Date(this.now()).toISOString()};
    if (busy || this.running || this.checkingCompatibility) return {...report, status: 'busy'};
    if (!this.mailAdapter?.checkCompatibility) return {...report, status: 'unavailable'};
    this.checkingCompatibility = true;
    try {
      const result = await this.mailAdapter.checkCompatibility({accountId: this.config.accountId, signal});
      const checks = Array.isArray(result?.checks) ? result.checks.slice(0, 32)
        .filter(check => typeof check?.id === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(check.id) && typeof check.ok === 'boolean')
        .map(({id, ok}) => ({id, ok})) : [];
      return {...report, compatible: result?.compatible === true && checks.every(check => check.ok), status: 'checked', checks};
    } catch {
      return {...report, status: 'probe_failed'};
    } finally {
      this.checkingCompatibility = false;
    }
  }
  cancel(id){this.ensureOpen();const q=this.state.queue.find(q=>q.id===id);if(!q)throw Error('Unknown queue item');if(q.status==='sending'||q.status==='unknown'||q.status==='sent')throw Error('Cannot cancel sent/in-flight/uncertain outcome; reconcile first');q.status='cancelled';this.audit('cancelled',{id});this.save();}
  suppress({recipient,companyDomain,reason}){this.ensureOpen();if(!reason)throw Error('Suppression reason required');const e=recipient?email(recipient):'',d=companyDomain?domain(companyDomain):'';if(!e&&!d)throw Error('Suppression target required');this.state.suppressed.push({email:e,domain:d,reason,at:new Date(this.now()).toISOString()});for(const q of this.state.queue)if(this.isSuppressed(this.lead(q.leadId))){if(q.status==='queued')q.status='suppressed';if(q.status==='sending'){this.abort?.abort();this.state.paused=true;}}this.audit('suppressed',{email:e,domain:d,reason});this.save();}
  beginMailboxAction() {
    if (this.running || this.checkingCompatibility) throw Error('Wait for previous mailbox operation to settle');
    try {
      this.accountLockFd = fs.openSync(this.accountLock, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') throw Error('Mailbox account already executing or requires stale-lock inspection');
      throw error;
    }
    try {
      fs.writeFileSync(this.accountLockFd, JSON.stringify({pid: this.runtimePid, accountId: this.config.accountId}));
    } catch (error) {
      this.releaseAccount();
      throw error;
    }
    this.running = true;
    this.abort = new AbortController();
  }

  finishMailboxAction() {
    try {
      this.releaseAccount();
    } finally {
      this.running = false;
      this.abort = null;
      this.completeDeferredClose();
    }
  }

  mailboxPacket(q) {
    const lead = this.lead(q.leadId);
    return {
      idempotencyKey: q.id,
      recipient: q.snapshot.recipient,
      company: q.snapshot.company,
      subject: q.snapshot.subject,
      body: q.snapshot.english,
      approvedHash: q.snapshot.hash,
      accountId: this.config.accountId,
      threadId: lead.threadId,
      replyToMessageId: lead.replyToMessageId,
      ...(q.draftBinding ? {draftBinding: clone(q.draftBinding)} : {}),
      signal: this.abort.signal
    };
  }

  verifySent(q, receipt) {
    return receipt?.status === 'sent'
      && identifier(receipt.messageId)
      && receipt.recipient === q.snapshot.recipient
      && receipt.approvedHash === q.snapshot.hash;
  }

  recordSent(q, receipt, action) {
    q.status = 'sent';
    delete q.error;
    q.receipt = clone(receipt);
    q.mode = this.mailAdapter.mode ?? 'unverified';
    if (q.draftBinding) q.draftCleanup = {status: 'pending'};
    this.audit(action, {id: q.id, messageId: receipt.messageId});
  }

  async cleanupSentDraft(q) {
    const finish = (status, reason) => {
      q.draftCleanup = {status, ...(reason ? {reason} : {})};
      this.audit('draft_cleanup', {id: q.id, ...q.draftCleanup});
      this.save();
    };
    const binding = q.draftBinding;
    const receipt = q.receipt;
    if (q.status !== 'sent' || !binding || !['pending', 'needs_review'].includes(q.draftCleanup?.status)) return;
    if (binding.accountId !== this.config.accountId
      || binding.approvedHash !== q.snapshot.hash || !this.verifySent(q, receipt)
      || receipt.authoritative !== true || !sameBinding(binding, receipt.draftBinding)) {
      return finish('needs_review', 'unverified_draft_binding');
    }
    if (!this.mailAdapter?.trashSentDraft) return finish('needs_review', 'adapter_unavailable');
    if (this.abort.signal.aborted) return finish('needs_review', 'paused_before_cleanup');
    let result;
    try {
      result = await this.mailAdapter.trashSentDraft({
        ...this.mailboxPacket(q), sentMessageId: receipt.messageId
      });
    } catch {
      return finish('needs_review', 'cleanup_outcome_unverified');
    }
    if (result?.authoritative !== true || result.sentMessageId !== receipt.messageId
      || !sameBinding(binding, result.draftBinding) || !['trashed', 'already_absent'].includes(result.status)) {
      return finish('needs_review', 'cleanup_outcome_unverified');
    }
    finish(result.status);
  }

  async tick(allowedIds) {
    this.ensureOpen();
    if (this.running || this.checkingCompatibility || this.state.paused) return {status: 'paused_or_busy'};
    if (this.state.queue.some(q => q.status === 'unknown')) {
      this.pause();
      throw Error('Uncertain send blocks queue');
    }
    const q = this.state.queue.find(q => q.status === 'queued' && (!allowedIds || allowedIds.includes(q.id)));
    if (!q) return {status: 'empty'};
    const nextAt = Math.max(q.notBefore, this.state.nextAllowedAt ?? 0);
    if (nextAt > this.now()) return {status: 'waiting', notBefore: nextAt};

    const lead = this.lead(q.leadId);
    this.checkEligibility(lead);
    const draft = this.draft(q.leadId);
    this.checkDraftingBasis(draft);this.checkDraftingBasis(q.snapshot);
    if (draft.hash !== q.snapshot.hash || !draft.approval || draft.approval.hash !== q.snapshot.hash) throw Error('Draft approval changed');
    if (draft.approval.accountId !== this.config.accountId) throw Error('Approved mailbox account changed');
    if (draft.approval.expiresAt <= this.now()) throw Error('Approval expired');
    if (!this.mailAdapter?.preflight) throw Error('Mail preflight adapter required');
    if (!this.mailAdapter?.send) throw Error('Mail adapter not configured');

    this.beginMailboxAction();
    try {
      try {
        const preflight = await this.mailAdapter.preflight(this.mailboxPacket(q));
        if (!preflight?.accountVerified || preflight.accountId !== this.config.accountId
          || !preflight.recipientVerified || !preflight.fresh || preflight.stop || preflight.hardBounce
          || preflight.latestReply || preflight.ambiguousRefusal || preflight.alreadySent) {
          if (preflight?.stop || preflight?.hardBounce) this.suppress({recipient: lead.email, reason: 'Fresh mailbox stop/bounce'});
          throw Error('Mailbox preflight hold: account/recipient/reply/stop/sent check');
        }
        if (this.abort.signal.aborted || this.state.paused || q.status !== 'queued') throw Error('Paused/cancelled before send');
        this.checkEligibility(lead);
        const current = this.draft(q.leadId);
        this.checkDraftingBasis(current);this.checkDraftingBasis(q.snapshot);
        if (current.hash !== q.snapshot.hash || !current.approval || current.approval.hash !== q.snapshot.hash
          || current.approval.expiresAt <= this.now()) throw Error('Draft changed or approval expired during preflight');
        if (preflight.draftBinding != null) {
          const binding = preflight.draftBinding;
          if (binding.accountId !== this.config.accountId || binding.approvedHash !== q.snapshot.hash
            || !identifier(binding.draftId) || !identifier(binding.draftVersion)) throw Error('Mailbox draft binding mismatch');
          const {accountId, draftId, draftVersion, approvedHash} = binding;
          q.draftBinding = {accountId, draftId, draftVersion, approvedHash};
        }
      } catch (error) {
        this.state.paused = true;
        this.save();
        throw error;
      }

      q.status = 'sending';
      q.attempts++;
      this.state.lastAttemptAt = this.now();
      this.audit('send_started', {id: q.id, hash: q.snapshot.hash});
      this.save();
      try {
        const receipt = await this.mailAdapter.send(this.mailboxPacket(q));
        if (!this.verifySent(q, receipt)) throw Error('Unverified send outcome');
        this.recordSent(q, receipt, 'sent_verified');
      } catch (error) {
        q.status = 'unknown';
        q.error = error.message;
        this.state.paused = true;
        this.audit('send_unknown', {id: q.id, reason: error.message});
      }
      const delay = this.advanceCadence(q.status === 'sent');
      if (q.status === 'sent') q.cadenceCounted = true;
      this.state.nextAllowedAt = this.now() + delay;
      const next = this.state.queue.find(item => item.status === 'queued');
      if (next) next.notBefore = Math.max(next.notBefore, this.state.nextAllowedAt);
      this.save();
      await this.cleanupSentDraft(q);
      return clone(q);
    } finally {
      this.finishMailboxAction();
    }
  }

  async reconcile(id) {
    this.ensureOpen();
    const q = this.state.queue.find(item => item.id === id);
    const retryCleanup = q?.status === 'sent' && ['pending', 'needs_review'].includes(q.draftCleanup?.status);
    if (q?.status !== 'unknown' && !retryCleanup) throw Error('Only an unknown send or pending draft cleanup may be reconciled');
    if (q.snapshot.approval?.accountId !== this.config.accountId) throw Error('Approved mailbox account changed');
    if (!retryCleanup && !this.mailAdapter?.reconcile) throw Error('No reconciliation adapter');
    this.beginMailboxAction();
    try {
      if (!retryCleanup) {
        const packet = this.mailboxPacket(q);
        const {idempotencyKey, recipient, approvedHash, accountId, draftBinding, signal} = packet;
        const result = await this.mailAdapter.reconcile({idempotencyKey, recipient, approvedHash, accountId, draftBinding, signal});
        if (this.verifySent(q, result)) {
          this.recordSent(q, result, 'reconciled_sent');
          if (!q.cadenceCounted) {
            this.state.nextAllowedAt = Math.max(this.state.nextAllowedAt ?? 0, this.now() + this.advanceCadence(true));
            q.cadenceCounted = true;
          }
        } else if (result?.status === 'not_sent' && result.authoritative === true) {
          q.status = 'cancelled';
          q.error = 'Confirmed not sent; explicit new enqueue required';
          this.audit('reconciled_not_sent', {id});
        } else {
          this.audit('reconciliation_inconclusive', {id});
        }
        this.save();
      }
      await this.cleanupSentDraft(q);
      return clone(q);
    } finally {
      this.finishMailboxAction();
    }
  }
  validatePlan(plan){if(!Array.isArray(plan)||!plan.length||plan.length>1000||plan.some(x=>!Number.isSafeInteger(x.count)||x.count<1||x.count>10000||!Number.isSafeInteger(x.pauseSeconds)||x.pauseSeconds<0||x.pauseSeconds>86400))throw Error('Plan requires 1–1000 bounded count/pauseSeconds stages');}
  setBatchPlan(plan){this.ensureOpen();if(this.running||this.state.queue.some(q=>q.status==='unknown'))throw Error('Resolve active or unknown operation before changing plan');this.validatePlan(plan);this.state.batchPlan=clone(plan);this.state.batchProgress={stage:0,sent:0,complete:false};this.state.paused=true;this.audit('batch_plan_changed',{plan});this.save();return clone({plan,progress:this.state.batchProgress});}
  advanceCadence(sent) {
    if (!this.state.batchPlan || !sent) return this.minimumInterval;
    const progress = this.state.batchProgress;
    const stage = this.state.batchPlan[progress.stage];
    progress.sent++;
    if (progress.sent < stage.count) return Math.max(this.minimumInterval, this.batchSpacing);
    progress.sent = 0;
    progress.stage++;
    if (progress.stage === this.state.batchPlan.length) {
      progress.complete = true;
      this.state.paused = true;
    }
    return Math.max(this.minimumInterval, stage.pauseSeconds * 1000);
  }
  completeDeferredClose(){if(this.finishClose){const resolve=this.finishClose;this.finishClose=null;this.close();resolve();}}
  releaseAccount(){if(this.accountLockFd!=null){fs.closeSync(this.accountLockFd);this.accountLockFd=null;fs.unlinkSync(this.accountLock);}}
  status(){this.ensureOpen();return clone({paused:this.state.paused,leads:Object.values(this.state.leads),drafts:Object.values(this.state.drafts),queue:this.state.queue,suppressed:this.state.suppressed,historyCount:this.state.history.length,batchPlan:this.state.batchPlan??null,batchProgress:this.state.batchProgress??null,nextAllowedAt:this.state.nextAllowedAt??null});}
}
