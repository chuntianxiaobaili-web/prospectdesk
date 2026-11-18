#!/usr/bin/env node
// Human-operated review console; stop Harness plugin before opening state.
import fs from 'node:fs';
import {createInterface} from 'node:readline/promises';
import {SalesWorkflow} from './workflow.js';
import {ResearchLedger,LearningLedger} from './research.js';
import {hash} from './import.js';
const [directory,configPath,id]=process.argv.slice(2);
if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Human interactive terminal required; no piped approvals');
if(!directory||!configPath||!id)throw Error('Usage: node src/review.js STATE_DIR CONFIG_JSON LEAD_ID|PLAYBOOK|HISTORY');
const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
const workflow=new SalesWorkflow({directory,config});
const rl=createInterface({input:process.stdin,output:process.stdout});
try {
  if(id==='PLAYBOOK'){
    const content=new LearningLedger(workflow.state.learning??{}).compile(),digest=hash(content);
    console.log(JSON.stringify(content,null,2));
    const reviewer=await rl.question('已核对100个真实阅读来源和提炼原则的审核人：');
    const confirmation=await rl.question(`输入 APPROVE ${digest} 批准此写作手册，否则取消：`);
    if(confirmation!==`APPROVE ${digest}`)throw Error('Review cancelled');
    console.log(workflow.approvePlaybook({content,hash:digest,reviewer}));
  }else if(id==='HISTORY'){
    const research=new ResearchLedger(config.research??{},workflow.state.research??{});
    console.log(JSON.stringify(research.snapshot(),null,2));
    console.log('必须包含全部已筛查/未入选/未发送/已交付/已联系公司、域名、别名和集团，不只最终客户表。缺项请取消。此前 provisional 不会追溯改成 qualified。');
    const reviewer=await rl.question('历史索引核对人：');
    const confirmation=await rl.question('仅全部历史确实齐全时输入 HISTORY COMPLETE，否则取消：');
    if(!reviewer.trim()||confirmation!=='HISTORY COMPLETE')throw Error('History review cancelled');
    research.setHistoryCoverage({complete:true,missing:[]});workflow.state.research=research.snapshot();workflow.audit('history_coverage_human_attested',{reviewer});workflow.save();console.log({complete:true});
  }else{
    const d=workflow.draft(id),l=workflow.lead(id);
    console.log(JSON.stringify({lead:l,draft:d},null,2));
    console.log('请核对收件人归属、来源、英文、中文稿和历史排重；批准不会立即发信。');
    const reviewer=await rl.question('审核人：');
    const acknowledgedRecipient=await rl.question('输入已核对的完整收件邮箱：');
    const confirmation=await rl.question(`输入 APPROVE ${d.hash} 批准，否则取消：`);
    if(confirmation!==`APPROVE ${d.hash}`)throw Error('Review cancelled');
    console.log(workflow.approve(id,{hash:d.hash,reviewer,acknowledgedRecipient}));
  }
} finally{rl.close();await workflow.close();}
