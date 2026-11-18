import test from 'node:test';
import assert from 'node:assert/strict';
import {runSession} from './session-host.mjs';

test('host never starts a ready runner automatically',async()=>{
  let starts=0,steps=0,sleeps=0;
  const runner={
    start(){starts++;},
    status(){return {phase:'ready',waitMs:0,remainingMs:null};},
    async step(){steps++;},
  };
  const result=await runSession(runner,{sleep:async()=>{sleeps++;}});
  assert.equal(result.phase,'ready');assert.equal(starts,0);assert.equal(steps,0);assert.equal(sleeps,0);
});

test('host awaits each step and never runs two steps at once',async()=>{
  let phase='running',active=0,maximum=0,steps=0;
  const progress=[];
  const runner={
    status(){return {phase,waitMs:0,remainingMs:1000};},
    async step(){
      active++;maximum=Math.max(maximum,active);
      assert.equal(active,1);
      await Promise.resolve();
      steps++;active--;
      if(steps===3)phase='target_reached';
      return {phase,sent:steps,waitMs:0,remainingMs:1000};
    },
  };
  const result=await runSession(runner,{onProgress:s=>progress.push(s.sent)});
  assert.equal(maximum,1);assert.equal(steps,3);assert.equal(active,0);
  assert.deepEqual(progress,[1,2,3]);assert.equal(result.phase,'target_reached');
});

test('host divides long waits into no more than 30 seconds per sleep',async()=>{
  let waitMs=75000,remainingMs=90000,steps=0;
  const sleeps=[];
  const runner={
    status(){return {phase:'running',waitMs,remainingMs};},
    async step(){steps++;return {phase:'exhausted',waitMs:0,remainingMs};},
  };
  const result=await runSession(runner,{sleep:async ms=>{sleeps.push(ms);waitMs-=ms;remainingMs-=ms;}});
  assert.deepEqual(sleeps,[30000,30000,15000]);
  assert.equal(steps,1);assert.equal(result.phase,'exhausted');
});

test('host sleeps only until the deadline when less than the pacing wait remains',async()=>{
  let remainingMs=5000,phase='running',steps=0;
  const sleeps=[];
  const runner={
    status(){return {phase,waitMs:72000,remainingMs};},
    async step(){steps++;throw Error('must not step after cutoff');},
  };
  const result=await runSession(runner,{sleep:async ms=>{sleeps.push(ms);remainingMs-=ms;if(remainingMs<=0)phase='deadline';}});
  assert.deepEqual(sleeps,[5000]);assert.equal(steps,0);assert.equal(result.phase,'deadline');
});

test('host stops immediately on a terminal phase without sleeping or stepping',async()=>{
  for(const phase of ['halted','stopped','deadline','exhausted','target_reached']){
    let steps=0,sleeps=0;
    const runner={status:()=>({phase,waitMs:60000,remainingMs:1000}),step:async()=>{steps++;}};
    const result=await runSession(runner,{sleep:async()=>{sleeps++;}});
    assert.equal(result.phase,phase);assert.equal(steps,0);assert.equal(sleeps,0);
  }
});

test('host returns a newly halted step without another status poll or retry',async()=>{
  let statuses=0,steps=0,progress=0;
  const runner={
    status(){statuses++;return {phase:'running',waitMs:0,remainingMs:1000};},
    async step(){steps++;return {phase:'halted',stopReason:'send_unknown'};},
  };
  const result=await runSession(runner,{onProgress:()=>{progress++;}});
  assert.equal(result.stopReason,'send_unknown');assert.equal(statuses,1);assert.equal(steps,1);assert.equal(progress,1);
});

test('unexpected step failure is surfaced once without hidden retry',async()=>{
  let steps=0;
  const runner={
    status:()=>({phase:'running',waitMs:0,remainingMs:1000}),
    async step(){steps++;throw Error('execution failed');},
  };
  await assert.rejects(()=>runSession(runner),/execution failed/);
  assert.equal(steps,1);
});

test('sleep failure is surfaced before starting another step',async()=>{
  let steps=0;
  const runner={
    status:()=>({phase:'running',waitMs:10,remainingMs:1000}),
    async step(){steps++;},
  };
  await assert.rejects(()=>runSession(runner,{sleep:async()=>{throw Error('host interrupted');}}),/host interrupted/);
  assert.equal(steps,0);
});

 test('unlimited host pacing retains bounded sleeps instead of treating a null deadline as zero',async()=>{
  let waitMs=75000;const sleeps=[];let steps=0;
  const runner={status:()=>({phase:'running',waitMs,remainingMs:null}),async step(){steps++;return {phase:'target_reached'};}};
  const result=await runSession(runner,{sleep:async ms=>{assert.ok(ms>0);sleeps.push(ms);waitMs-=ms;}});
  assert.deepEqual(sleeps,[30000,30000,15000]);assert.equal(steps,1);assert.equal(result.phase,'target_reached');
});
