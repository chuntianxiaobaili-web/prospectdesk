import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {SalesWorkflow} from '../src/workflow.js';import {MockDraftAdapter,MockMailbox} from '../src/mock.js';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'batch-cadence-'));let now=100000;const mailAdapter=new MockMailbox();
const config={brand:{name:'Synthetic'},draftModel:{provider:'test',model:'draft'},sendModel:{provider:'test',model:'send'},accountId:'batch-qa@example.test',accountLockDirectory:path.join(directory,'locks'),pacing:{minSeconds:1,maxSeconds:1}};
const open=()=>new SalesWorkflow({directory,config,mailAdapter,draftAdapter:new MockDraftAdapter(),now:()=>now});let w=open();
try{
 for(let i=0;i<10;i++){const email=`business@company-${i}.example.test`;const id=w.importRows([{company:`Synthetic ${i}`,website:`https://company-${i}.example.test`,email,need:`flowers for synthetic use ${i}`,sourceUrl:`https://company-${i}.example.test/contact`,sourceDate:'2026-10-23',evidence:email,newness:'verified'}]).accepted[0];const draft=await w.generateDraft(id);w.approve(id,{hash:draft.hash,reviewer:'QA review fixture',acknowledgedRecipient:email});w.enqueue(id);}
 w.setBatchPlan([{count:5,pauseSeconds:120},{count:3,pauseSeconds:360},{count:2,pauseSeconds:0}]);w.resume();
 for(let i=0;i<5;i++){if(i)now+=1000;assert.equal((await w.tick()).status,'sent');}assert.equal(mailAdapter.messages.size,5);assert.equal((await w.tick()).status,'waiting');assert.equal(w.status().nextAllowedAt,224000);
 await w.close();w=open();assert.equal(w.status().paused,true);assert.deepEqual(w.status().batchProgress,{stage:1,sent:0,complete:false});w.resume();now=223999;assert.equal((await w.tick()).status,'waiting');now=224000;
 for(let i=0;i<3;i++){if(i)now+=1000;assert.equal((await w.tick()).status,'sent');}assert.equal(mailAdapter.messages.size,8);assert.equal(w.status().nextAllowedAt,586000);assert.equal((await w.tick()).status,'waiting');
 await w.close();w=open();w.resume();now=586000;for(let i=0;i<2;i++){if(i)now+=1000;assert.equal((await w.tick()).status,'sent');}assert.equal(w.status().paused,true);assert.equal(w.status().batchProgress.complete,true);assert.equal(mailAdapter.messages.size,10);assert.throws(()=>w.resume(),/complete/);
 console.log(JSON.stringify({passed:true,plan:'5 then120s;3 then360s;2 then complete',restartCount:2,mockMessages:10,duplicateMessages:0}));
}finally{await w.close();fs.rmSync(directory,{recursive:true,force:true});}
