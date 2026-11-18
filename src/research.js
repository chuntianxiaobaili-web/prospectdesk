import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
const text = x => String(x ?? '').trim();
const copy = x => JSON.parse(JSON.stringify(x));
const key = x => text(x).toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
const list = x => Array.isArray(x) ? x.map(text).filter(Boolean) : text(x) ? [text(x)] : [];
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function canonicalURL(value) {
  const u = new URL(text(value));
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error('Public HTTP(S) URL required');
  u.hash = ''; u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  if (u.pathname !== '/') u.pathname = u.pathname.replace(/\/+$/, '');
  return u.href;
}
const host = x => new URL(canonicalURL(/^https?:\/\//i.test(text(x)) ? x : `https://${x}`)).hostname.replace(/^www\./, '');
const day = x => /^\d{4}-\d{2}-\d{2}$/.test(text(x)) && !Number.isNaN(Date.parse(x)) && new Date(x).toISOString().slice(0,10) === x;
export function completeBusinessEmail(value) {
  const s = text(value);
  if (s.length > 254 || /[\s<>\[\](){}*,;:\\]/.test(s) || !/^[A-Za-z0-9!#$%&'+/=?^_`|~.-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(s)) return false;
  const [local, domain] = s.split('@');
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !s.includes('..') && domain.split('.').every(p => p && !p.startsWith('-') && !p.endsWith('-'));
}
function identity(record) {
  const company = text(record.company); const domains = [...list(record.domains), ...list(record.website)].flatMap(d=>{try{return [host(d)];}catch{return [];}});
  const names = [company, ...list(record.aliases)].filter(Boolean).map(key);
  const groups = [...list(record.group), ...list(record.groups)].map(key);
  return {company, aliases:list(record.aliases), domains:[...new Set(domains.map(host))], groups:[...new Set(groups)], keys:[...new Set([...names.map(n=>'name:'+n), ...domains.map(d=>'domain:'+host(d)), ...groups.map(g=>'group:'+g)])]};
}
function sourceCheck(s, kind) {
  try { canonicalURL(s.url); } catch { return false; }
  return s.kind === kind && s.official === true && day(s.date) && !!text(s.ownershipEvidence) && !!text(s.readEvidence) && !!text(s.text);
}
/** Structured evidence ingester, not a browser or independent email-delivery verifier. */
export class ResearchLedger {
  constructor(config = {}, state = {}) {
    this.config = copy(config);
    this.history = copy(state.history ?? []);
    this.records = copy(state.records ?? []);
    this.coverage = copy(state.coverage ?? {complete:false, missing:['Complete historical screened-company index not supplied']});
    for (const exclusion of config.exclusions ?? []) this.addHistory(typeof exclusion === 'string' ? {company:exclusion, reason:'configured exclusion'} : {...exclusion,reason:exclusion.reason || 'configured exclusion'});
  }
  addHistory(record) {
    const id = identity(record);
    if (!id.keys.length) throw Error('History requires company, domain, alias or group identity');
    const item = {...id, reason:text(record.reason) || 'previously screened', batch:text(record.batch), status:text(record.status) || 'screened'};
    this.history.push(item); return copy(item);
  }
  setHistoryCoverage({complete,missing = []}) {
    this.coverage = {complete:complete === true && list(missing).length === 0, missing:list(missing)};
    if (!this.coverage.complete && !this.coverage.missing.length) this.coverage.missing.push('Full history not attested complete');
    return copy(this.coverage);
  }
  brief() {
    return {industry:text(this.config.industry), products:list(this.config.products), buyerTypes:list(this.config.buyerTypes ?? this.config.targetBuyerTypes), regions:list(this.config.regions), exclusions:copy(this.config.exclusions ?? []), historyCoverage:copy(this.coverage), requirements:['Public official attributable complete business email','Evidence of actual relevant business/product use','Company/domain/group/alias comparison against all screened history','Observed facts separated from inference and unknowns'], collection:'Use configured authorized web/browser tools; this module does not browse or verify delivery.'};
  }
  screen(record) {
    const r = copy(record); const id = identity(r); const reasons = [];
    const previous = this.history.filter(h=>h.keys.some(k=>id.keys.includes(k)));
    if (!id.company || !id.domains.length) reasons.push('missing_company_or_website');
    if (previous.length) reasons.push('historical_company_domain_group_or_alias');
    const sources = Array.isArray(r.officialSources) ? r.officialSources : [];
    const mail = text(r.email).toLowerCase();
    const published = sources.filter(s=>sourceCheck(s,'email')).find(s=>{
      const tokens = text(s.text).match(/[A-Za-z0-9!#$%&'+/=?^_`|~.-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
      return tokens.some(t=>t.toLowerCase()===mail);
    });
    if (!completeBusinessEmail(mail)) reasons.push('missing_or_incomplete_business_email');
    if (r.emailVerification !== 'published' || !published) reasons.push('email_not_officially_evidenced');
    if (r.emailConflict === true || r.emailGuessed === true) reasons.push('email_guessed_or_unresolved_conflict');
    const needSources = sources.filter(s=>sourceCheck(s,'need'));
    if (!text(r.need) || !needSources.length || r.relevant !== true) reasons.push('relevant_business_not_evidenced');
    const status = reasons.length ? 'rejected' : this.coverage.complete ? 'qualified' : 'provisional';
    const item = {...r, ...id, id:'research_'+digest([id.keys,this.records.length]).slice(0,20), email:mail, officialSources:sources, status, reasons, newness:status==='qualified'?'verified':'provisional', historyCoverage:copy(this.coverage), duplicateMatches:previous.map(h=>({company:h.company,batch:h.batch,reason:h.reason})), inference:text(r.inference), unknowns:list(r.unknowns), contactStatus:text(r.contactStatus)||'not_contacted', draftStatus:text(r.draftStatus)||'not_generated', handoffStatus:'not_sent', sourceUrl:published?.url ?? '', sourceDate:published?.date ?? '', evidence:published?.text ?? ''};
    this.records.push(item);
    // Every screened identity is retained, including rejected and uncontacted candidates.
    if (id.keys.length) this.addHistory({...r, reason:'screened:'+status, status, batch:r.batch});
    return copy(item);
  }
  rows({status} = {}) { return copy(this.records.filter(r=>!status || r.status===status)); }
  snapshot() { return copy({version:1, history:this.history, records:this.records, coverage:this.coverage}); }
  exportJSON() { return JSON.stringify({brief:this.brief(),...this.snapshot()}, null, 2); }
  exportCSV() { return researchCSV(this.records); }
  async exportWorkbook(path) {
    path = resolve(path); if (!path.toLowerCase().endsWith('.xlsx')) throw Error('Output must be .xlsx');
    await mkdir(dirname(path),{recursive:true});
    const data = {records:this.rows(),history:this.history,brief:this.brief()};
    const py = `import json,sys\nfrom openpyxl import Workbook,load_workbook\nd=json.load(sys.stdin); w=Workbook(); w.remove(w.active)\ndef safe(v):\n s=json.dumps(v,ensure_ascii=False) if isinstance(v,(dict,list)) else str(v if v is not None else '')\n return "'"+s if s.lstrip().lstrip('\\ufeff').lstrip().startswith(('=','+','-','@','\\t','\\r','\\n')) else s\ndef tab(name,rows,cols):\n s=w.create_sheet(name); s.append(cols); s.freeze_panes='A2'\n for r in rows: s.append([safe(r.get(c,'')) for c in cols])\n s.auto_filter.ref=s.dimensions\n for c in s.columns: s.column_dimensions[c[0].column_letter].width=min(65,max(15,len(str(c[0].value))+3))\ncols=['id','company','country','website','email','need','sourceUrl','sourceDate','evidence','inference','unknowns','status','reasons','newness','contactStatus','draftStatus','handoffStatus','group','aliases']\nfor status in ['qualified','provisional','rejected']: tab(status,[r for r in d['records'] if r['status']==status],cols)\ne=[dict(s,company=r['company']) for r in d['records'] for s in r.get('officialSources',[])]\ntab('official_evidence',e,['company','kind','url','date','official','ownershipEvidence','readEvidence','text'])\ntab('screened_history',d['history'],['company','aliases','domains','groups','reason','batch','status'])\ntab('brief',[d['brief']],list(d['brief']))\nw.save(sys.argv[1]); v=load_workbook(sys.argv[1],read_only=True); assert len(v.sheetnames)==6; v.close()\n`;
    await new Promise((ok,fail)=>{const executable = text(this.config.pythonExecutable) || (process.platform==='win32'?'python':'python3'); const p=spawn(executable,['-c',py,path],{stdio:['pipe','pipe','pipe'],timeout:60000,killSignal:'SIGKILL'}); let err='';p.stderr.on('data',b=>{err=(err+b).slice(-8192);});p.on('error',fail);p.on('close',(c,signal)=>c===0?ok():fail(Error('Excel export requires Python/openpyxl and must finish within 60s: '+(signal||'')+' '+err)));p.stdin.on('error',()=>{});p.stdin.end(JSON.stringify(data));});
    return {path, qualified:this.records.filter(r=>r.status==='qualified').length, provisional:this.records.filter(r=>r.status==='provisional').length, rejected:this.records.filter(r=>r.status==='rejected').length};
  }
}
export function spreadsheetSafe(value) { const s = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? ''); return /^[\s\uFEFF]*[=+@-]/u.test(s) || /^[\t\r\n]/.test(s) ? "'"+s : s; }
export function researchCSV(rows) {
  const columns=['company','country','website','email','need','sourceUrl','sourceDate','evidence','inference','unknowns','group','aliases','status','newness','contactStatus','draftStatus','handoffStatus','reasons','officialSources'];
  const cell=x=>'"'+spreadsheetSafe(x).replace(/"/g,'""')+'"';
  return '\uFEFF'+[columns.map(cell).join(','),...rows.map(r=>columns.map(c=>cell(r[c])).join(','))].join('\r\n');
}
export class LearningLedger {
  constructor(state = {}, target = 100) {
    this.target = Math.max(100, Number.isInteger(state.target)?state.target:Number.isInteger(target)?target:100);
    this.sources = copy(state.sources ?? []);
  }
  record(source) {
    const s=copy(source); const url=canonicalURL(s.url);
    if (!['article','video'].includes(s.type)) throw Error('Learning source type must be article or video');
    if (!text(s.title)) throw Error('Source title required');
    if (this.sources.some(p=>p.url===url)) throw Error('Duplicate canonical source URL; use update to review existing source');
    return this.#store({...s,url});
  }
  update(url,review) {
    url=canonicalURL(url); const i=this.sources.findIndex(s=>s.url===url);
    if(i<0) throw Error('Unknown learning source');
    const s={...this.sources[i],...copy(review),url};
    if(!['article','video'].includes(s.type)||!text(s.title)) throw Error('Invalid learning source');
    this.#validate(s); this.sources[i]=s; return copy(s);
  }
  #validate(s) {
    if (!['article','video'].includes(s.type) || !text(s.title)) throw Error('Valid article/video type and title required');
    s.status=s.status==='verified-read'?'verified-read':'unreviewed';
    s.principles=list(s.principles);
    if(s.status==='verified-read' && (!day(s.readDate)||!text(s.readEvidence)||!text(s.summary)||!s.principles.length)) throw Error('Actually-read evidence, date, original summary and principles required');
    if(s.type==='video' && s.status==='verified-read' && !text(s.transcriptOrViewingEvidence)) throw Error('Video requires transcript segment or viewing evidence');
  }
  #store(s) { this.#validate(s); this.sources.push(s); return copy(s); }
  compile() {
    const seen=new Set();
    const sources=this.sources.filter(s=>{try{this.#validate(s);const url=canonicalURL(s.url);if(s.status!=='verified-read'||seen.has(url))return false;seen.add(url);return true;}catch{return false;}});
    return {target:this.target, discoveredSources:this.sources.length, reviewedSources:sources.length, ready:sources.length>=this.target, missing:Math.max(0,this.target-sources.length), principles:sources.flatMap(s=>s.principles.map(principle=>({sourceUrl:s.url,principle}))), sources:copy(sources), notice:'Structured reading attestations, not model training or independently verified browsing; host approval required before production drafting.'};
  }
  snapshot() { return copy({version:1,target:this.target,sources:this.sources}); }
}
