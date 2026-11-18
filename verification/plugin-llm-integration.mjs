import {Context,SystemPrompt,Tools,LlmRuntime,LlmAdapter,Llm} from './runtime.mjs';
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';




import {hash} from '../src/import.js';
import {LearningLedger} from '../src/research.js';
import plugin from '../src/plugin.js';
import {MockDraftAdapter,MockMailbox} from '../src/mock.js';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'official-plugin-qa-'));let workflow;
const ctx=new Context();await ctx.plugin(SystemPrompt);await ctx.plugin(Tools);
await ctx.plugin(LlmRuntime);let llmCalls=0;class SyntheticLlm extends LlmAdapter {async *stream(options){llmCalls++;assert.equal(options.provider,'synthetic');assert.equal(options.model,'draft');const output=JSON.stringify(await new MockDraftAdapter().generate({prompt:options.messages[0].content[0].text}));yield {type:'text-delta',index:0,text:output};yield {type:'block-end',index:0,block:{type:'text',text:output}};yield {type:'finish',reason:'stop'};}}ctx.llm.registerAdapter(['synthetic'],new SyntheticLlm());
const mailbox=new MockMailbox();const config={brand:{name:'Synthetic QA'},draftModel:{provider:'synthetic',model:'draft'},sendModel:{provider:'synthetic',model:'execution'},accountId:'qa@example.test',pacing:{minSeconds:1,maxSeconds:1}};
const pluginFiber=ctx.plugin(plugin,{directory,config,mailAdapter:mailbox,onReady:w=>workflow=w});await pluginFiber;
let n=0;async function call(name,args={},error=false){const r=await ctx.tools.execute({callId:'qa-'+(++n),name,arguments:args,signal:new AbortController().signal});assert.equal(r.isError,error,JSON.stringify(r));return r.value??r;}
try{
 const names=ctx.tools.schemas().map(x=>x.name);for(const name of ['sales_status','sales_import_csv','sales_generate_draft','sales_enqueue','sales_tick','sales_set_batch_plan'])assert.ok(names.includes(name));assert.ok(!names.some(x=>x.includes('approve')));
 const headers=['company','website','email','need','sourceUrl','sourceDate','evidence','newness'];
 const row=['Synthetic A','https://a.example.test','b2b@a.example.test','artificial flowers','https://a.example.test/contact','2026-10-23','b2b@a.example.test','verified'];
 const imported=await call('sales_import_csv',{csv:headers.join(',')+'\n'+row.join(',')});const leadId=imported.accepted[0];assert.ok(leadId);
 await call('sales_generate_draft',{leadId},true);assert.equal(llmCalls,0);const learning=new LearningLedger();for(let i=0;i<100;i++)learning.record({url:`https://synthetic.example.test/source-${i}`,type:'article',title:`SYNTHETIC fixture ${i}`,status:'verified-read',readDate:'2026-10-23',readEvidence:'SYNTHETIC test fixture, not web reading',summary:`SYNTHETIC summary ${i}`,principles:[`SYNTHETIC principle ${i}`]});const content=learning.compile();workflow.approvePlaybook({content,hash:hash(content),reviewer:'QA synthetic fixture reviewer'});const draft=await call('sales_generate_draft',{leadId});await call('sales_enqueue',{leadId},true);
 workflow.approve(leadId,{hash:draft.hash,reviewer:'QA human fixture',acknowledgedRecipient:row[2]});const queued=await call('sales_enqueue',{leadId});
 await call('sales_set_draft',{leadId,subject:'changed',english:'changed',chinese:'修改'},true);
 await call('sales_resume');const sent=await call('sales_tick');assert.equal(llmCalls,1);assert.equal(sent.status,'sent');assert.equal(mailbox.messages.size,1);
 await call('sales_enqueue',{leadId},true);assert.equal((await call('sales_tick')).status,'empty');
 console.log(JSON.stringify({passed:true,registeredTools:names,dispatchCalls:n,receipt:sent.receipt,llmCalls,scope:'real Cordis + official tools; official LlmRuntime with synthetic provider adapter + synthetic mailbox; no paid models/live email'}));
}finally{await ctx.fiber.dispose();assert.ok(!fs.existsSync(path.join(directory,'state.lock')));fs.rmSync(directory,{recursive:true,force:true});}
