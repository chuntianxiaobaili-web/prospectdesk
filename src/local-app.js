import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import {randomBytes,timingSafeEqual} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {DedicatedBrowser} from './local-browser.js';import {BrowserMockMailbox,MockWebmailStore,mockWebmailHTML} from './mock-webmail.js';import {SalesWorkflow} from './workflow.js';import {MockDraftAdapter} from './mock.js';import {QueueRunner} from './runner.js';
export function validateLocalRequest(req,{origin,token},mutating=false){
 const target=new URL(origin);if(req.headers.host!==target.host)throw Error('Unexpected local host');
 if(req.headers.origin&&req.headers.origin!==origin)throw Error('Cross-origin local request denied');
 if(req.headers['sec-fetch-site']==='cross-site')throw Error('Cross-site local request denied');
 if(mutating){if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')throw Error('Local JSON origin required');const given=String(req.headers['x-local-token']??'');if(given.length!==token.length||!timingSafeEqual(Buffer.from(given),Buffer.from(token)))throw Error('Local action token required');}
}
async function readJSON(req){let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>100000)throw Error('Request too large');}return JSON.parse(data);}
const html=token=>`<!doctype html><html lang="zh"><meta charset="utf-8"><title>B2B 本地专用浏览器 · 开发版</title><style>body{font:16px system-ui;max-width:1100px;margin:30px auto;padding:15px}button,input{padding:10px;margin:5px}pre{white-space:pre-wrap;background:#f4f5f7;padding:15px;max-height:450px;overflow:auto}.warning{background:#fff1ca;padding:15px}</style><h1>B2B 本地专用浏览器</h1><p class="warning">v0.2 开发验证版：当前只连模拟邮箱；不连接任何真实邮箱，不发送互联网邮件。通用研究与学习功能仍由 Harness 原生插件提供。</p><section><button data-action="seed">准备一条合成客户与草稿</button><button data-action="resumeBrowser">允许模拟浏览器自动化</button><button id="checkCompatibility">只读检查邮箱界面</button><label>计划开始时间 <input id="notBefore" placeholder="2026-11-17T14:00:00+08:00"></label><button id="startQueue">启动已批准模拟队列</button><button data-action="pause">暂停</button><button data-action="takeover">暂停并人工接管</button><button data-action="closeBrowser">关闭专用浏览器</button></section><h2>人工审核并入队</h2><p>先阅读下方完整草稿。填写当前 leadId、hash、收件邮箱和审核人；不会自动同意或代填批准。</p><input id="lead" placeholder="leadId"><input id="hash" placeholder="完整 draft hash"><input id="recipient" placeholder="完整 .test 收件邮箱"><input id="reviewer" placeholder="审核人"><label><input type="checkbox" id="approved">我已核对当前主题、英文正文、中文稿与收件人</label><button id="approve">批准精确草稿并入队</button><h2>状态与完整草稿</h2><p id="notice"></p><pre id="state"></pre><script>
const token=${JSON.stringify(token)};async function refresh(){const r=await fetch('/api/status');document.querySelector('#state').textContent=JSON.stringify(await r.json(),null,2);}async function act(action,extra={}){try{const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':token},body:JSON.stringify({action,...extra})});const data=await r.json();document.querySelector('#notice').textContent=JSON.stringify(data);await refresh();}catch(e){document.querySelector('#notice').textContent=e.message;}}
document.querySelector('#checkCompatibility').onclick=async()=>{try{const r=await fetch('/api/compatibility');document.querySelector('#notice').textContent=JSON.stringify(await r.json());}catch(e){document.querySelector('#notice').textContent=e.message;}};document.querySelector('#startQueue').onclick=()=>{const notBefore=document.querySelector('#notBefore').value.trim();return act('start',notBefore?{notBefore}:{});};
document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>act(b.dataset.action));document.querySelector('#approve').onclick=()=>{if(!document.querySelector('#approved').checked){alert('请先核对并勾选');return;}act('approve',{leadId:document.querySelector('#lead').value,hash:document.querySelector('#hash').value,acknowledgedRecipient:document.querySelector('#recipient').value,reviewer:document.querySelector('#reviewer').value});};refresh();setInterval(refresh,2000);</script></html>`;
export async function startLocalApp({dataDirectory,browserName='chromium',driver,headless=false}={}){
 const token=randomBytes(32).toString('hex');let origin,workflow,runner,shuttingDown=false;
 const browser=new DedicatedBrowser({dataDirectory,browser:browserName,driver,headless,onPause:()=>{runner?.stop();}});
 const store=new MockWebmailStore(path.join(dataDirectory,'mock-mailbox'));
 const server=http.createServer(async(req,res)=>{res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'");try{
   validateLocalRequest(req,{origin,token},req.method!=='GET');const url=new URL(req.url,origin);
   const json=value=>{res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));};
   if(req.method==='GET'&&url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html(token));}
   if(req.method==='GET'&&url.pathname==='/mock-webmail'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(mockWebmailHTML(token));}
   if(req.method==='GET'&&url.pathname==='/api/mock-sent')return json(store.receipts());
   if(req.method==='GET'&&url.pathname==='/api/compatibility')return json(await workflow.mailboxCompatibility({busy:runner.status().active}));
   if(req.method==='GET'&&url.pathname==='/api/status')return json({mode:'mock',realCustomerContacts:0,browser:browser.status(),runner:runner.status(),workflow:workflow.status(),mockReceipts:store.receipts()});
   if(req.method==='POST'&&url.pathname==='/api/mock-send')return json(store.accept(await readJSON(req)));
   if(req.method==='POST'&&url.pathname==='/api/action'){
    const a=await readJSON(req);if(shuttingDown)throw Error('Closing');
    if(a.action==='pause')return json(browser.pause());if(a.action==='takeover')return json(await browser.takeover());if(a.action==='closeBrowser')return json(await browser.close());
    if(a.action==='resumeBrowser')return json(browser.resumeAutomation());if(a.action==='start'){if(browser.state!=='ready')throw Error('Explicitly enable browser automation first');return json(runner.start({notBefore:a.notBefore}));}
    if(a.action==='seed'){const n=Date.now();const id=workflow.importRows([{company:'Synthetic Buyer '+n,website:`https://buyer${n}.test`,email:`buy@buyer${n}.test`,need:'synthetic commercial furniture procurement',sourceUrl:`https://buyer${n}.test/contact`,sourceDate:new Date().toISOString().slice(0,10),evidence:`Published buy@buyer${n}.test`,newness:'verified'}]).accepted[0];return json(await workflow.generateDraft(id));}
    if(a.action==='approve'){workflow.approve(a.leadId,a);return json(workflow.enqueue(a.leadId));}throw Error('Unknown action');
   }res.statusCode=404;return json({error:'Not found'});
  }catch(e){res.statusCode=400;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:e.message}));}});
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;
  const mailAdapter=new BrowserMockMailbox({browser,baseURL:origin});workflow=new SalesWorkflow({directory:path.join(dataDirectory,'demo-workflow'),config:{brand:{name:'Synthetic local demo',products:['commercial furniture']},accountId:'mock@local.test',draftModel:{provider:'mock',model:'synthetic'},minimumIntervalSeconds:3},draftAdapter:new MockDraftAdapter(),mailAdapter});runner=new QueueRunner(workflow);
  await browser.launch();const page=await browser.context.newPage();await page.goto(origin);
  const close=async()=>{if(shuttingDown)return;shuttingDown=true;runner.stop();await browser.close();await workflow.close();await new Promise(resolve=>server.close(resolve));};return {origin,browser,workflow,runner,store,close};
 }catch(e){runner?.stop();await browser.close().catch(()=>{});await workflow?.close();await new Promise(resolve=>server.close(resolve));throw e;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),get=k=>{const i=args.indexOf(k);return i<0?undefined:args[i+1];};
 const dataDirectory=get('--data-dir');if(!dataDirectory)throw Error('--data-dir is required');
 try{const app=await startLocalApp({dataDirectory,browserName:get('--browser')??'chromium'});console.log(`Local mock-only controller: ${app.origin}\nDedicated profile: ${app.browser.profile}\nCtrl+C stops queue and closes browser.`);for(const event of ['SIGINT','SIGTERM'])process.once(event,async()=>{await app.close();process.exitCode=0;});}catch(e){console.error('Local browser startup failed; no automatic security downgrade:',e.message);process.exitCode=1;}
}
