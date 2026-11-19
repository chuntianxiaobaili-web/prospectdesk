import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {BrowserMailAdapter} from './browser-adapter.mjs';
import {MailSessionRunner,SessionStoppedError} from './session-runner.mjs';

const clone = value => structuredClone(value);
const browserIds = new Set(['edge','chrome','yandex']);
const bridgeOwners = new WeakMap();
const terminal = new Set(['halted','stopped','deadline','exhausted','target_reached']);
const ids = (value, name) => {
  if (!Array.isArray(value) || value.length > 10000 || value.some(v => typeof v !== 'string' || !v.trim())) throw Error(`INVALID_${name}`);
  return [...new Set(value)];
};

/** Stateful host-facing boundary. This is a separate existing-draft route,
 * never a substitute for the core workflow's research or approval records. */
export class BrowserMailService {
  constructor({tab,connection=null,accountId,journalDirectory,accountLockPath,isCoreBusy=()=>false,
    shouldBlockRecipient=()=>null,adapterFactory,runnerOptions={},mailProfile='chinese-zoho-ui',compatibilityChecker=null,onRuntimeReminder=null,runtimePid=(typeof process!=='undefined'&&Number.isSafeInteger(process.pid)&&process.pid>0?process.pid:null)}={}) {
    // Some CUA hosts omit process; PID is diagnostic, while the owner token owns the lock.
    if(runtimePid!==null&&(!Number.isSafeInteger(runtimePid)||runtimePid<=0))throw Error('RUNTIME_PID_MUST_BE_POSITIVE_INTEGER_OR_NULL');
    this.runtimePid=runtimePid;
    if(typeof mailProfile!=='string'||!mailProfile.trim()||mailProfile.length>100)throw Error('EXPLICIT_MAIL_PROFILE_REQUIRED');
    if(compatibilityChecker!==null&&typeof compatibilityChecker!=='function')throw Error('COMPATIBILITY_CHECKER_MUST_BE_A_FUNCTION');
    if(onRuntimeReminder!==null&&typeof onRuntimeReminder!=='function')throw Error('RUNTIME_REMINDER_MUST_BE_A_FUNCTION');
    if(mailProfile!=='chinese-zoho-ui'&&!compatibilityChecker)throw Error('CUSTOM_MAIL_PROFILE_REQUIRES_COMPATIBILITY_CHECKER');
    this.mailProfile=mailProfile;this.compatibilityChecker=compatibilityChecker;this.onRuntimeReminder=onRuntimeReminder;
    if(connection){
      if(tab&&tab!==connection.tab)throw Error('BROWSER_CONNECTION_TAB_MISMATCH');
      tab=connection.tab;
      const identity=connection.identity;
      if(!identity||!browserIds.has(identity.browserId)||!['cua','playwright'].includes(identity.transport)
        ||typeof identity.targetId!=='string'||!identity.targetId||identity.targetId.length>1024
        ||typeof identity.browserVersion!=='string'||identity.browserVersion.length>200||identity.identityVerified!==true
        ||typeof connection.verifyIdentity!=='function'||typeof connection.close!=='function')throw Error('VERIFIED_BROWSER_CONNECTION_REQUIRED');
      this.connection=connection;
      this.identity=Object.freeze({browserId:identity.browserId,transport:identity.transport,targetId:identity.targetId,browserVersion:identity.browserVersion,identityVerified:true});
      this.identityVerified=true;
    }else{
      this.connection=null;this.identity=Object.freeze({browserId:'legacy',transport:'cua-legacy',targetId:null,browserVersion:null,identityVerified:false});
      this.identityVerified=false;
    }
    if (!tab || typeof tab.getAXState !== 'function') throw Error('EXPLICIT_BROWSER_TAB_REQUIRED');
    if (typeof accountId !== 'string' || !accountId.trim()) throw Error('EXPLICIT_ACCOUNT_REQUIRED');
    if (!journalDirectory || !accountLockPath) throw Error('JOURNAL_DIRECTORY_AND_SHARED_ACCOUNT_LOCK_REQUIRED');
    if (typeof isCoreBusy !== 'function' || typeof shouldBlockRecipient !== 'function') throw Error('HOST_GUARD_FUNCTION_REQUIRED');
    if (Object.keys(runnerOptions).some(k => !['clock','timers','sleep'].includes(k))) throw Error('UNSUPPORTED_RUNNER_OPTION');
    this.tab=tab;this.accountId=accountId;this.journalDirectory=this.connection?path.join(path.resolve(journalDirectory),this.identity.browserId):path.resolve(journalDirectory);
    this.accountLockPath=path.resolve(accountLockPath);this.isCoreBusy=isCoreBusy;
    this.shouldBlockRecipient=shouldBlockRecipient;
    this.usesDefaultAdapter=!adapterFactory;
    this.adapterFactory=adapterFactory??(options=>new BrowserMailAdapter(options));
    this.runnerOptions={...runnerOptions};this.runner=null;this.adapter=null;this.archived=true;
    this.closed=false;this.closing=false;this.operation=null;this.lock=null;this.closePromise=null;this.mutationPermit=null;
    if(typeof this.tab.setMutationGuard==='function'){
      if(bridgeOwners.has(this.tab))throw Error('BROWSER_TAB_ALREADY_OWNED');
      this.tab.setMutationGuard(event=>this.guardBrowserInput(event));bridgeOwners.set(this.tab,this);
    }
  }


  connectionStatus(){
    return {browserId:this.identity.browserId,transport:this.identity.transport,
      targetKey:this.identity.targetId?createHash('sha256').update(this.identity.targetId).digest('hex').slice(0,16):null,
      browserVersion:this.identity.browserVersion,identityVerified:this.identityVerified,
      verification:this.connection?(this.identityVerified?'verified':'failed'):'legacy_unverified',
      checkedAt:this.connectionCheckedAt??null};
  }
  async verifyConnection(){
    if(!this.connection)return this.connectionStatus();
    try{
      const proof=await this.connection.verifyIdentity();
      if(proof?.identityVerified!==true||proof?.ok===false
        ||['browserId','transport','targetId','browserVersion'].some(key=>proof[key]!==this.identity[key]))
        throw Error('BROWSER_CONNECTION_IDENTITY_CHANGED');
      this.identityVerified=true;this.connectionCheckedAt=new Date().toISOString();
      return this.connectionStatus();
    }catch{
      this.identityVerified=false;this.mutationPermit=null;this.stopRunner('browser_identity_changed');
      throw new SessionStoppedError('BROWSER_CONNECTION_IDENTITY_CHANGED');
    }
  }
  guardBrowserInput(event={}){
    if(!this.operation)throw Error('BROWSER_MAIL_OPERATION_REQUIRED');
    this.assertOperation();this.assertLock();
    const label=[event.name,event.description].filter(Boolean).join(' ');
    const send=/^(?:发送|Send)(?:\s|$)/i.test(label);
    const remove=/(?:删除|舍弃草稿|Delete|Remove|Trash|Discard)/i.test(label);
    const action=send?'send':remove?'cleanup':null;
    const permit=this.mutationPermit;
    if(permit){
      this.mutationPermit=null;
      if(event.kind!=='click'||action!==permit.action)throw Error('BROWSER_MUTATION_TARGET_MISMATCH');
      this.assertRecipientForPermit(permit);this.runner.guard();
      return;
    }
    if(action)throw Error('BROWSER_MUTATION_NOT_AUTHORIZED');
    // Folder/search navigation remains available for read-only reconciliation after stop.
  }
  assertRecipientForPermit(permit){if(permit.action==='send')this.assertRecipient(permit.recipient);}

  hasSession(){return !!this.runner&&!this.archived;}
  isBusy(){return !!this.operation||this.hasSession()||this.closing;}
  describe(){return {configured:true,profile:this.mailProfile,mailProfile:this.mailProfile,connection:this.connectionStatus(),requiresExplicitTab:true,
    accountKey:createHash('sha256').update(this.accountId).digest('hex').slice(0,12),...this.status()};}
  ensureOpen(){if(this.closed||this.closing)throw Error('BROWSER_MAIL_SERVICE_CLOSED');}
  coreIdle(){const value=this.isCoreBusy();if(value?.then)throw Error('CORE_BUSY_CHECK_MUST_BE_SYNCHRONOUS');if(value)throw Error('CORE_MAILBOX_BUSY');}
  blockReason(recipient){const result=this.shouldBlockRecipient(recipient);if(result?.then)throw Error('RECIPIENT_GUARD_MUST_BE_SYNCHRONOUS');return result?String(result).slice(0,200):null;}
  assertRecipient(recipient){if(this.blockReason(recipient))throw Error('RECIPIENT_SUPPRESSED');}
  assertOperation(){if(this.closed||this.closing||this.operation?.controller.signal.aborted)throw new SessionStoppedError('BROWSER_MAIL_OPERATION_ABORTED');}

  acquireLock(){
    this.coreIdle();if(this.lock)throw Error('BROWSER_MAIL_ACCOUNT_LOCK_ALREADY_HELD');
    fs.mkdirSync(path.dirname(this.accountLockPath),{recursive:true});
    let fd;
    try{fd=fs.openSync(this.accountLockPath,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw Error('ACCOUNT_MAILBOX_LOCKED');throw error;}
    const ownerToken=randomUUID(),stat=fs.fstatSync(fd);
    this.lock={fd,ownerToken,dev:stat.dev,ino:stat.ino,written:false};
    try{
      fs.writeFileSync(fd,JSON.stringify({kind:'browser-mail-session',pid:this.runtimePid,accountId:this.accountId,ownerToken}));
      fs.fsyncSync(fd);this.lock.written=true;this.coreIdle();
    }catch(error){this.releaseLock();throw error;}
  }

  ownsLock(){
    if(!this.lock)return false;
    try{
      const current=fs.statSync(this.accountLockPath);
      if(current.dev!==this.lock.dev||current.ino!==this.lock.ino)return false;
      return !this.lock.written||JSON.parse(fs.readFileSync(this.accountLockPath,'utf8')).ownerToken===this.lock.ownerToken;
    }catch{return false;}
  }
  assertLock(){if(!this.ownsLock())throw Error('BROWSER_MAIL_ACCOUNT_LOCK_OWNERSHIP_LOST');}
  releaseLock(){
    if(!this.lock)return;
    const owned=this.ownsLock(),lock=this.lock;this.lock=null;
    try{fs.closeSync(lock.fd);}finally{
      if(owned){
        try{
          const current=fs.statSync(this.accountLockPath);
          const token=lock.written?JSON.parse(fs.readFileSync(this.accountLockPath,'utf8')).ownerToken:lock.ownerToken;
          if(current.dev===lock.dev&&current.ino===lock.ino&&token===lock.ownerToken)fs.unlinkSync(this.accountLockPath);
        }catch(error){if(error.code!=='ENOENT')this.lastLockReleaseError='ACCOUNT_LOCK_NOT_RELEASED';}
      }else this.lastLockReleaseError='ACCOUNT_LOCK_OWNERSHIP_LOST';
    }
  }

  clearTimer(){
    if(this.runner?.clearTimers){this.runner.clearTimers();return;}
    if(this.runner?.timer!=null){this.runner.timers.clearTimeout(this.runner.timer);this.runner.timer=null;}
  }
  stopRunner(reason){
    if(!this.runner||this.archived)return;
    if(terminal.has(this.runner.state.phase)){this.runner.abort.abort(reason);this.clearTimer();return;}
    if(this.runner.state.startedAt)this.runner.stop(reason);
    else{
      this.runner.state.phase='stopped';this.runner.state.stopReason=reason;this.runner.abort.abort(reason);
      this.runner.persist('stopped_before_start',{reason});
    }
    this.clearTimer();
  }
  stop(reason='manual_stop'){
    if(this.closed)return this.status();
    this.mutationPermit=null;this.operation?.controller.abort(reason);this.stopRunner(reason);
    return this.status();
  }

  withOperation(name,signal,fn){
    this.ensureOpen();if(this.operation)throw Error('BROWSER_MAIL_OPERATION_IN_PROGRESS');
    if(signal?.aborted)throw Error('BROWSER_MAIL_OPERATION_ABORTED');
    const operation={name,controller:new AbortController(),promise:null};this.operation=operation;
    const aborted=()=>{operation.controller.abort(signal.reason??'host_cancelled');this.stopRunner('host_cancelled');};
    signal?.addEventListener('abort',aborted,{once:true});
    operation.promise=Promise.resolve().then(()=>{this.assertOperation();return fn(operation.controller.signal);}).finally(()=>{
      signal?.removeEventListener('abort',aborted);if(this.operation===operation){this.operation=null;this.mutationPermit=null;}
    });
    return operation.promise;
  }

  async compatibility({signal}={}){
    const result=await this.withOperation('compatibility',signal,async()=>{
      this.coreIdle();
      if(this.hasSession()&&this.runner.state.phase==='running')throw Error('BROWSER_MAIL_SESSION_RUNNING');
      const transient=!this.lock;
      if(transient)this.acquireLock();else this.assertLock();
      try{
        const connectionChecks=[];
        let connectionOk=!this.connection;
        try{await this.verifyConnection();connectionOk=!!this.connection&&this.identityVerified;}catch{}
        connectionChecks.push({id:'browser_identity',ok:connectionOk,status:this.connection?(connectionOk?'verified':'failed'):'legacy_unverified'});
        if(this.connection&&!connectionOk)return {ok:false,compatible:false,status:'needs_review',checkedAt:new Date().toISOString(),
          mode:'browser-ui',connection:this.connectionStatus(),connectionChecks,mailboxChecks:[],checks:connectionChecks,mailProfile:this.mailProfile,requiresComposePreflight:true};
        const checks=['getAXState','click','reload','typeText','pressKey'].map(method=>({id:`tab_${method}`,ok:typeof this.tab[method]==='function'}));
        let profileCompatible=true;
        if(this.compatibilityChecker){
          const result=await this.compatibilityChecker({tab:this.tab,accountId:this.accountId,
            connection:this.connectionStatus(),signal:this.operation.controller.signal});
          this.assertOperation();this.assertLock();await this.verifyConnection();this.assertOperation();
          const custom=Array.isArray(result)?result:result?.checks;
          if(!Array.isArray(custom)||!custom.length||custom.some(check=>!check||typeof check.id!=='string'
            ||!/^[a-zA-Z0-9_-]{1,100}$/.test(check.id)||typeof check.ok!=='boolean'))throw Error('INVALID_COMPATIBILITY_CHECK_RESULT');
          checks.push(...custom.map(check=>({id:check.id,ok:check.ok,
            ...(Number.isSafeInteger(check.count)&&check.count>=0?{count:check.count}:{})})));
          profileCompatible=Array.isArray(result)||result?.compatible===true;
        }else{
          const state=await this.tab.getAXState({emit:false,disableDiffing:true});this.assertOperation();
          const add=(id,regex)=>{const count=[...state.matchAll(regex)].length;checks.push({id,ok:count===1,count});};
          checks.push({id:'account_matches',ok:state.includes(`Zoho Mail (${this.accountId})`)});
          add('draft_folder',/^\s*\d+ row \([^\n]+\) Description: 草稿, ID: \d+/gm);
          add('sent_folder',/^\s*\d+ row \([^\n]+\) Description: 已发送, ID: \d+/gm);
          add('search_control',/^\s*\d+ text field \(settable\) 搜索 \( \/ \)\s*$/gm);
        }
        const ok=profileCompatible&&checks.every(check=>check.ok);
        return {ok,compatible:ok,status:ok?'compatible':'needs_review',checkedAt:new Date().toISOString(),
          mode:this.connection?.identity.transport==='playwright'?'playwright-cdp-browser-ui':'cua-browser-ui',checks,
          connection:this.connectionStatus(),connectionChecks,mailboxChecks:checks,mailProfile:this.mailProfile,requiresComposePreflight:true,
          accountKey:createHash('sha256').update(this.accountId).digest('hex').slice(0,12)};
      }finally{if(transient)this.releaseLock();}
    });
    return result;
  }

  guardedAdapter(raw){
    const service=this;
    const methods=new Set(['scanDrafts','inspectDraft','preflight','send','reconcile','cleanup','countDrafts']);
    return new Proxy(raw,{get(target,property){
      const value=Reflect.get(target,property,target);
      if(!methods.has(property)||typeof value!=='function')return value;
      return async(...args)=>{
        service.assertOperation();service.assertLock();await service.verifyConnection();service.assertOperation();
        if(property==='preflight'){
          const reason=service.blockReason(args[0]?.recipient);if(reason)return {ok:false,skip:true,reason};
        }
        if(property==='send'||property==='cleanup'){
          const optionsIndex=property==='send'?1:2,options=args[optionsIndex]??{},upstream=options.beforeClick;
          if(typeof upstream!=='function')throw Error('MUTATION_HOOK_REQUIRED');
          if(property==='send')service.assertRecipient(args[0]?.recipient);
          args[optionsIndex]={...options,beforeClick:async(hookOptions={})=>{
            service.assertOperation();service.assertLock();
            if(property==='send')service.assertRecipient(args[0]?.recipient);
            if(property==='cleanup'){await service.verifyConnection();service.assertOperation();}
            const revalidate=hookOptions?.revalidate;
            await upstream({...hookOptions,revalidate:async()=>{
              service.assertOperation();service.assertLock();if(property==='send')service.assertRecipient(args[0]?.recipient);
              await service.verifyConnection();service.assertOperation();
              if(typeof revalidate==='function')await revalidate();
              service.assertOperation();if(property==='send')service.assertRecipient(args[0]?.recipient);
            }});
            service.assertOperation();service.assertLock();if(property==='send')service.assertRecipient(args[0]?.recipient);
            service.runner.guard();
            service.mutationPermit={action:property,recipient:args[0]?.recipient};
          }};
        }
        try{
          const result=await value.apply(target,args);
          // Preserve a confirmed receipt even if cancellation arrived after acceptance.
          if(property!=='send'&&property!=='reconcile'&&property!=='cleanup')service.assertOperation();
          return result;
        }finally{if(property==='send'||property==='cleanup')service.mutationPermit=null;}
      };
    }});
  }

  async prepare({target=50,durationMs=null,intervalMs=72000,prepareAheadMs=60000,retainSentDrafts=false,
    preparedRefs,excludeDraftIds=[],approvedPermanentDraftIds=[]}={}, {signal}={}){
    const value=await this.withOperation('prepare',signal,async()=>{
      if(this.hasSession())throw Error('FINISH_OR_CLOSE_EXISTING_BROWSER_SESSION');
      if(!Number.isSafeInteger(target)||target<1||target>10000)throw Error('TARGET_MUST_BE_FROM_1_TO_10000');
      if(durationMs!==null&&(!Number.isSafeInteger(durationMs)||durationMs<=0))throw Error('DURATION_MUST_BE_POSITIVE_INTEGER_OR_NULL');
      if(!Number.isFinite(intervalMs)||intervalMs<=0)throw Error('INTERVAL_MUST_BE_POSITIVE');
      if(!Number.isFinite(prepareAheadMs)||prepareAheadMs<0||prepareAheadMs>60000)throw Error('INVALID_PREPARE_AHEAD');
      if(typeof retainSentDrafts!=='boolean')throw Error('RETAIN_SENT_DRAFTS_MUST_BE_BOOLEAN');
      const permanent=ids(approvedPermanentDraftIds,'PERMANENT_DRAFT_IDS'),excluded=ids(excludeDraftIds,'EXCLUDED_DRAFT_IDS');
      if(retainSentDrafts&&permanent.length)throw Error('RETAIN_SENT_DRAFTS_CONFLICTS_WITH_PERMANENT_DELETE');
      if(preparedRefs!==undefined&&(!Array.isArray(preparedRefs)||preparedRefs.length>10000
        ||preparedRefs.some(ref=>ref?.accountId!==this.accountId||typeof ref.draftId!=='string'||!ref.draftId)))throw Error('PREPARED_REFS_ACCOUNT_MISMATCH');
      this.acquireLock();
      try{
        this.assertOperation();await this.verifyConnection();this.assertOperation();
        const raw=await this.adapterFactory({tab:this.tab,accountId:this.accountId,
          preparedRefs:preparedRefs===undefined?null:clone(preparedRefs),approvedPermanentDraftIds:[...permanent]});
        this.assertOperation();
        if(this.usesDefaultAdapter&&this.identity.transport==='playwright')raw.mode='playwright-cdp-browser-ui';
        if(raw&&'approvedPermanentDraftIds'in raw)raw.approvedPermanentDraftIds=new Set(permanent);
        this.adapter=this.guardedAdapter(raw);
        fs.mkdirSync(this.journalDirectory,{recursive:true});
        const journalPath=path.join(this.journalDirectory,`browser-mail-${Date.now()}-${randomUUID()}.json`);
        this.runner=new MailSessionRunner({...this.runnerOptions,adapter:this.adapter,journalPath,
          target,durationMs,intervalMs,prepareAheadMs,retainSentDrafts,onRuntimeReminder:this.onRuntimeReminder});this.archived=false;
        this.runner.state.connection=this.connectionStatus();this.runner.state.mailProfile=this.mailProfile;
        await this.runner.initialize({excludeDraftIds:excluded});this.assertOperation();
        const selected=this.runner.state.records.map(r=>r.ref);
        if(selected.some(ref=>ref.accountId!==this.accountId))throw Error('SELECTED_DRAFT_ACCOUNT_MISMATCH');
        const selectedIds=new Set(selected.map(ref=>ref.draftId));
        if(permanent.some(id=>!selectedIds.has(id)))throw Error('PERMANENT_APPROVAL_OUTSIDE_SELECTED_DRAFTS');
        return this.status();
      }catch(error){
        this.clearTimer();
        if(this.runner&&!this.archived){try{this.stopRunner('prepare_failed');}catch{}}
        this.archived=true;this.releaseLock();throw error;
      }
    });
    return {...value,busy:this.isBusy()};
  }

  start(){
    this.ensureOpen();if(this.operation)throw Error('BROWSER_MAIL_OPERATION_IN_PROGRESS');
    if(!this.hasSession())throw Error('PREPARE_BROWSER_SESSION_FIRST');
    this.assertLock();this.coreIdle();this.runner.start();if(terminal.has(this.runner.state.phase))this.clearTimer();return this.status();
  }

  async step({signal}={}){
    await this.withOperation('step',signal,async()=>{
      if(!this.hasSession())throw Error('PREPARE_BROWSER_SESSION_FIRST');
      this.assertLock();this.coreIdle();await this.runner.step();if(terminal.has(this.runner.state.phase))this.clearTimer();
    });
    return this.status();
  }

  async finish({signal}={}){
    await this.withOperation('finish',signal,async()=>{
      if(!this.hasSession())throw Error('NO_UNARCHIVED_BROWSER_SESSION');
      this.assertLock();
      if(!terminal.has(this.runner.state.phase))this.stopRunner('finish_requested');
      this.clearTimer();
      await this.runner.finish();this.assertOperation();
      this.archived=true;this.releaseLock();
    });
    return this.status();
  }

  status(){
    let result={phase:'idle',sent:0,cleaned:0,planned:0};
    if(this.runner){
      const s=this.runner.state,records=s.records,now=this.runner.clock.monotonic();
      const deadline=s.deadlineReached||(!this.archived&&s.phase==='running'&&this.runner.deadlineMono!==null&&now>=this.runner.deadlineMono);
      const sent=records.filter(r=>r.status==='sent').length,trashed=records.filter(r=>r.cleanup==='trashed').length;
      const alreadyAbsent=records.filter(r=>r.cleanup==='already_absent').length;
      const phase=deadline&&s.phase==='running'?'deadline':s.phase;
      result={runId:s.runId,phase,startedAt:s.startedAt,deadlineAt:s.deadlineAt,deadlineReached:deadline,
        durationMs:s.config.durationMs,timeLimited:s.config.durationMs!==null,retainSentDrafts:s.config.retainSentDrafts,runtimeReminder:clone(s.runtimeReminder),
        stopReason:s.stopReason,target:s.config.target,planned:records.length,sent,trashed,alreadyAbsent,cleaned:trashed+alreadyAbsent,
        skipped:records.filter(r=>r.status==='skipped').length,unknown:records.filter(r=>r.status==='unknown').length,
        pending:records.filter(r=>r.status==='pending').length,remainingPlanned:records.length-sent,
        cleanupPending:records.filter(r=>r.status==='sent'&&!['trashed','already_absent'].includes(r.cleanup)).length,
        retainedOriginalDrafts:records.filter(r=>r.status==='sent'&&r.cleanupReason==='retained_by_send_only_policy').length,
        scanCoverage:clone(s.scanCoverage??null),
        initialMailboxCount:clone(s.initialMailboxCount),finalMailboxCount:clone(s.finalMailboxCount),
        waitMs:phase==='running'?Math.max(0,this.runner.nextDueMono-now-s.config.prepareAheadMs):0,
        sendWaitMs:phase==='running'?Math.max(0,this.runner.nextDueMono-now):0,
        remainingMs:this.runner.deadlineMono===null?null:Math.max(0,this.runner.deadlineMono-now)};
    }
    return {...result,configured:true,connection:this.connectionStatus(),mailProfile:this.mailProfile,closed:this.closed,phase:this.closed?'closed':result.phase,
      archived:this.archived,hasSession:this.hasSession(),busy:this.isBusy(),inFlight:this.operation?.name??null,
      accountLocked:!!this.lock,...(this.lastLockReleaseError?{lockWarning:this.lastLockReleaseError}:{})};
  }

  acknowledgeRuntimeReminder(notificationId){
    this.ensureOpen();
    if(!this.runner)throw Error('PREPARE_BROWSER_SESSION_FIRST');
    this.runner.acknowledgeRuntimeReminder(notificationId);
    return this.status();
  }

  close(){
    if(this.closePromise)return this.closePromise;if(this.closed)return Promise.resolve(this.status());
    this.closing=true;
    try{this.stop('service_closed');}catch(error){this.closeStopError=String(error.message??error);}
    const pending=this.operation?.promise;
    this.closePromise=(async()=>{
      if(pending)try{await pending;}catch{}
      if(this.runner?.reminderDelivery)try{await this.runner.reminderDelivery;}catch{}
      try{await this.connection?.close();}
      finally{if(bridgeOwners.get(this.tab)===this){this.tab.setMutationGuard(null);bridgeOwners.delete(this.tab);}this.mutationPermit=null;this.clearTimer();this.releaseLock();this.archived=true;this.closed=true;this.closing=false;}
      return this.status();
    })();
    return this.closePromise;
  }
}
