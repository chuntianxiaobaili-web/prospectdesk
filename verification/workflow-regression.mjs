import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {SalesWorkflow} from '../src/workflow.js';import {MockDraftAdapter,MockMailbox} from '../src/mock.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-regression-'));const config={brand:{name:'Synthetic'},draftModel:{provider:'test',model:'draft'},sendModel:{provider:'test',model:'send'},pacing:{minSeconds:1,maxSeconds:1},accountId:'qa-regression@example.test'};
const mailbox=new MockMailbox();const open=name=>new SalesWorkflow({directory:path.join(dir,name),config,draftAdapter:new MockDraftAdapter(),mailAdapter:mailbox});
const lead={company:'Synthetic A',website:'https://a.example.test',email:'business@a.example.test',need:'synthetic flowers',sourceUrl:'https://a.example.test/contact',sourceDate:'2026-10-23',evidence:'business@a.example.test',newness:'verified'};
let w=open('a');try{const id=w.importRows([lead]).accepted[0];await w.generateDraft(id);const d=w.draft(id);w.approve(id,{hash:d.hash,reviewer:'QA human fixture',acknowledgedRecipient:lead.email});const q=w.enqueue(id);w.cancel(q.id);w.enqueue(id);w.cancel(q.id);assert.deepEqual(w.status().queue.map(q=>q.status),['cancelled']);
const w2=open('b');w2.close();
w.enqueue(id);w.state.queue[0].status='sending';w.save();w.close();w=open('a');assert.equal(w.status().paused,true);assert.equal(w.status().queue[0].status,'unknown');assert.throws(()=>w.resume(),/Reconcile/);
const reconciled=await w.reconcile(q.id);assert.equal(reconciled.status,'cancelled');w.enqueue(id);assert.equal(w.status().queue.length,1);
console.log(JSON.stringify({passed:true,checks:['cancel-reenqueue IDs reused safely','restart inflight unknown paused','unknown blocks resume','authoritative not-sent requeue retains single packet']}));
}finally{w.close();fs.rmSync(dir,{recursive:true,force:true});}
