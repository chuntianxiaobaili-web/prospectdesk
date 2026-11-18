import test from 'node:test';import assert from 'node:assert/strict';import {QueueRunner} from '../src/runner.js';
test('runner schedules due timestamps and stops after bounded queue empty',async()=>{let now=0,scheduled;let n=0;const w={state:{paused:true,queue:[{status:'queued'}]},resume(){this.state.paused=false;},pause(){this.state.paused=true;},save(){},async tick(){n++;if(n===1){this.state.nextAllowedAt=120000;return {status:'sent'};}this.state.queue=[];return {status:'empty'};}};const r=new QueueRunner(w,{now:()=>now,setTimer:(fn,ms)=>(scheduled={fn,ms}),clearTimer:()=>scheduled=null});r.start();assert.equal(scheduled.ms,0);await scheduled.fn();assert.equal(scheduled.ms,120000);now=120000;await scheduled.fn();assert.equal(r.status().active,false);assert.equal(n,2);});
test('pause clears timer and errors stop without retry',async()=>{let scheduled;const w={state:{paused:true,queue:[{status:'queued'}]},resume(){this.state.paused=false;},pause(){this.state.paused=true;},save(){},async tick(){throw Error('Unknown result');}};const r=new QueueRunner(w,{setTimer:fn=>(scheduled=fn),clearTimer:()=>scheduled=null});r.start();r.stop();assert.equal(scheduled,null);r.start();await scheduled();assert.equal(r.status().active,false);assert.match(r.status().lastError,/Unknown/);assert.equal(w.state.paused,true);});
test('runner snapshots approved IDs and ignores packets added after start',async()=>{let callback,seen;const w={state:{paused:true,queue:[{id:'old',status:'queued'}]},resume(){this.state.paused=false;},pause(){this.state.paused=true;},save(){},async tick(ids){seen=ids;this.state.queue[0].status='sent';return {status:'sent'};}};const r=new QueueRunner(w,{setTimer:fn=>(callback=fn),clearTimer:()=>{}});r.start();w.state.queue.push({id:'new',status:'queued'});await callback();assert.deepEqual(seen,['old']);assert.equal(r.status().active,false);assert.equal(w.state.queue[1].status,'queued');});


const useFakeClock = (workflow = undefined) => {
  let time = Date.UTC(2026, 10, 17);
  const timers = [];
  const w = workflow ?? {
    state: {paused: true, queue: [{id: 'approved', status: 'queued'}]},
    resume({notBefore, allowedIds}) {
      this.state.paused = false;
      for (const q of this.state.queue) if (allowedIds.has(q.id)) q.notBefore = notBefore;
    },
    pause() {
      this.state.paused = true;
    },
    async tick() {
      this.calls = (this.calls ?? 0) + 1;
      this.state.queue = [];
      return {status: 'sent'};
    }
  };
  const runner = new QueueRunner(w, {
    now: () => time,
    setTimer(fn, ms) {
      const timer = {fn, ms};
      timers.push(timer);
      return timer;
    },
    clearTimer() {}
  });
  return {w, runner, timers, advance: ms => { time += ms; }};
};

test('planned start preserves the explicit zone and rejects ambiguous or invalid dates', async () => {
  const {w, runner, timers, advance} = useFakeClock();
  for (const notBefore of ['2026-11-17T08:01:00', '2026-02-30T08:01:00+08:00', '2026-11-17T24:00:00Z']) {
    assert.throws(() => runner.start({notBefore}), /ISO timestamp/);
  }
  assert.equal(w.state.paused, true);
  const notBefore = '2026-11-17T08:01:00+08:00';
  assert.equal(runner.start({notBefore}).nextAt, Date.parse(notBefore));
  assert.equal(w.state.queue[0].notBefore, Date.parse(notBefore));
  assert.equal(timers[0].ms, 60000);
  await timers[0].fn();
  assert.equal(w.calls, undefined);
  advance(60000);
  await timers.at(-1).fn();
  assert.equal(w.calls, 1);
});

test('a stale timer cannot send or replace a newly started queue', async () => {
  const {w, runner, timers} = useFakeClock();
  runner.start();
  const oldTimer = timers.at(-1);
  runner.stop();
  runner.start();
  const current = runner.status();
  await oldTimer.fn();
  assert.deepEqual(runner.status(), current);
  assert.equal(w.calls, undefined);
  await timers.at(-1).fn();
  assert.equal(w.calls, 1);
});

test('a long wait is chunked without processing the packet early', async () => {
  const {w, runner, timers, advance} = useFakeClock();
  const notBefore = '2027-01-01T00:00:00Z';
  runner.start({notBefore});
  assert.equal(timers[0].ms, 2_147_483_647);
  advance(timers[0].ms);
  await timers[0].fn();
  assert.equal(w.calls, undefined);
  assert.equal(runner.status().nextAt, Date.parse(notBefore));
  advance(timers.at(-1).ms);
  await timers.at(-1).fn();
  assert.equal(w.calls, 1);
});
