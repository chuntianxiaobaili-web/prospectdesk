import {setTimeout as delay} from 'node:timers/promises';

/** Keep the injected CUA host alive for the full run. The fixed runner, rather
 * than the supervising agent, selects each item and authorizes every click. */
export async function runSession(runner,{sleep=delay,onProgress=()=>{}}={}) {
  while(true){
    const current=runner.status();
    if(current.phase!=='running')return current;
    if(current.waitMs>0){await sleep(Math.min(30000,current.waitMs,current.remainingMs??Infinity));continue;}
    const next=await runner.step();
    onProgress(next);
    if(next.phase!=='running')return next;
  }
}
