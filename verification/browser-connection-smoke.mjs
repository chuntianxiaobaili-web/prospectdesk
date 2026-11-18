import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {connectBrowser} from '../src/browser-mail/connection.mjs';

const [browserId,dataDirectory,executablePath]=process.argv.slice(2);
if(!['edge','chrome','yandex'].includes(browserId)||!dataDirectory||!path.isAbsolute(dataDirectory))
  throw Error('Use: node verification/browser-connection-smoke.mjs edge|chrome|yandex ABSOLUTE_TEST_DIRECTORY [YANDEX_EXE]');
await fs.mkdir(dataDirectory,{recursive:true});
const fixture=path.join(dataDirectory,'browser-connection-fixture.html');
await fs.writeFile(fixture,`<!doctype html><meta charset="utf-8"><title>Browser connection fixture</title>
<label>测试输入 <input id="input" aria-label="测试输入"></label>
<button id="button">测试点击</button><output id="result" role="status">idle</output>
<div contenteditable="true" role="textbox" aria-label="富文本编辑区域">完整富文本测试内容</div>
<script>
const result=document.getElementById('result'),input=document.getElementById('input'),button=document.getElementById('button');
button.addEventListener('click',()=>result.textContent='clicked');
button.addEventListener('contextmenu',e=>{e.preventDefault();result.textContent='right';});
input.addEventListener('keydown',e=>{if(e.key==='Enter')result.textContent='enter';});
</script>`);
const checks={};let connection;
const result={browserId,startedAt:new Date().toISOString(),checks,mailSent:0,draftsDeleted:0};
try{
  connection=await connectBrowser({browserId,mode:'launch',dataDirectory,executablePath,headless:true});
  result.connection=connection.identity;assert.equal(connection.identity.browserId,browserId);
  assert.equal(connection.identity.identityVerified,true);checks.identity=true;
  const {page,tab}=connection;
  await page.goto(pathToFileURL(fixture).href);
  let state=await tab.getAXState();checks.snapshot=state.includes('测试输入')&&state.includes('测试点击');
  assert.ok(checks.snapshot);
  const find=(text,label)=>{const matches=[...text.matchAll(new RegExp('^\\s*(\\d+) '+label+'.*$','gm'))];assert.equal(matches.length,1,label);return Number(matches[0][1]);};
  const button=()=>find(state,'button 测试点击');
  const field=()=>find(state,'text field.*测试输入');
  await assert.rejects(()=>tab.click(button()),/MUTATION_GUARD_REQUIRED/);checks.defaultInputBlocked=true;
  tab.setMutationGuard(()=>{assert.equal(page.url(),pathToFileURL(fixture).href);});
  await tab.typeText(field(),browserId+'-input');
  assert.equal(await page.locator('#input').inputValue(),browserId+'-input');checks.typing=true;
  state=await tab.getAXState();await tab.pressKey(field(),'Return');
  assert.equal(await page.locator('#result').innerText(),'enter');checks.keyInput=true;
  state=await tab.getAXState();await tab.click(button());
  assert.equal(await page.locator('#result').innerText(),'clicked');checks.click=true;
  state=await tab.getAXState();await tab.click(button(),{mouseButton:'right'});
  assert.equal(await page.locator('#result').innerText(),'right');checks.rightClick=true;
  state=await tab.getAXState();const stale=button();state=await tab.getAXState();
  await assert.rejects(()=>tab.click(stale),/STALE_SNAPSHOT_REFERENCE/);checks.staleReference=true;
  tab.setMutationGuard(()=>false);
  await assert.rejects(()=>tab.click(button()),/BROWSER_MUTATION_NOT_AUTHORIZED/);
  assert.equal(await page.locator('#result').innerText(),'right');checks.finalInputGuard=true;
  tab.setMutationGuard(()=>{assert.equal(page.url(),pathToFileURL(fixture).href);});
  await tab.reload();state=await tab.getAXState();
  assert.equal(await page.locator('#input').inputValue(),'');checks.reload=true;
  assert.equal((await connection.verifyIdentity()).identityVerified,true);checks.identityAfterActions=true;
  result.ok=true;
}catch(error){result.ok=false;result.error=error.message;process.exitCode=1;
  if(connection?.tab)try{await fs.writeFile(path.join(dataDirectory,'failed-synthetic-snapshot.txt'),await connection.tab.getAXState());}catch{}
}finally{
  if(connection)try{await connection.close();checks.closed=true;}catch(error){result.ok=false;result.closeError=error.message;process.exitCode=1;}
  result.finishedAt=new Date().toISOString();
  await fs.writeFile(path.join(dataDirectory,'connection-smoke-result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}
