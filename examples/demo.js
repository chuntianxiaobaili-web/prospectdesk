import {SalesWorkflow} from '../src/workflow.js';import {MockDraftAdapter,MockMailbox} from '../src/mock.js';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const config=JSON.parse(fs.readFileSync(new URL('./config.mock.json',import.meta.url)));const directory=fs.mkdtempSync(path.join(os.tmpdir(),'harness-sales-demo-'));
const mailAdapter=new MockMailbox();const w=new SalesWorkflow({directory,config,draftAdapter:new MockDraftAdapter(),mailAdapter});
try{
 const id=w.importRows([{company:'Synthetic Events',website:'https://synthetic.test',email:'buy@synthetic.test',need:'artificial flower installations',sourceUrl:'https://synthetic.test/contact',sourceDate:'2026-10-23',evidence:'Published buy@synthetic.test',newness:'verified'}]).accepted[0];
 const draft=await w.generateDraft(id);console.log({mode:'mock',draft});
 // Test harness approval only, never reused for real recipients.
 w.approve(id,{hash:draft.hash,reviewer:'Synthetic QA fixture',acknowledgedRecipient:draft.recipient});w.enqueue(id);w.resume();const result=await w.tick();console.log({mode:'mock',realCustomerContacts:0,result});
}finally{w.close();fs.rmSync(directory,{recursive:true,force:true});}
