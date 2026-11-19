import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readdirSync,rmdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(new URL('../codex/package.json',import.meta.url));
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');

const configure = fileURLToPath(new URL('./configure.mjs',import.meta.url));
const home = mkdtempSync(path.join(tmpdir(),'prospectdesk-stdio-'));
const configuredAccount = 'operator@example.test';
const defaultNames = ['sales_browser_mail_compatibility','sales_browser_mail_status'];

function generate(args) {
  const result = spawnSync(process.execPath,[configure,...args],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout).mcpServers['prospectdesk-review'];
}

async function verify(args, expectedNames, verifyTools) {
  const config = generate(args);
  assert.equal(config.type,'stdio');
  assert.ok(path.isAbsolute(config.command));
  assert.ok(path.isAbsolute(config.args[0]));
  const transport = new StdioClientTransport({
    command:config.command,args:config.args,
    env:{...config.env,HOME:home,USERPROFILE:home,PROSPECTDESK_ACCOUNT_ID:'other@example.test'},
    stderr:'inherit'
  });
  const client = new Client({name:'prospectdesk-stdio-self-test',version:'1.0.0'});
  try {
    await client.connect(transport);
    const info = client.getServerVersion();
    assert.equal(info?.name,'prospectdesk-review');
    assert.equal(info?.version,'0.6.3');
    const {tools} = await client.listTools();
    assert.deepEqual(tools.map(tool=>tool.name).sort(),expectedNames);
    assert.ok(tools.every(tool=>tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false));
    const status = await client.callTool({name:'sales_browser_mail_status',arguments:{}});
    assert.equal(status.structuredContent?.profile,'read-only');
    assert.equal(status.structuredContent?.browserConnected,false);

    for (const name of ['sales_browser_mail_step','sales_browser_mail_prepare']) {
      const result = await client.callTool({name,arguments:{}}).catch(error=>({isError:true,content:[{text:error.message}]}));
      assert.equal(result.isError,true);
      assert.match(result.content[0].text,/not found|unknown tool/i);
    }
    await verifyTools(client);
  } finally {
    await client.close();
  }
}

try {
  const invalid = spawnSync(process.execPath,[configure,'--mail-url','http://example.test/'],{encoding:'utf8'});
  assert.notEqual(invalid.status,0);
  assert.match(invalid.stderr,/HTTPS mailbox URL/);

  await verify([],defaultNames,async client=>{
    const result = await client.callTool({name:'sales_browser_mail_compatibility',arguments:{}});
    assert.equal(result.isError,true);
    assert.match(result.content[0].text,/PROSPECTDESK_ACCOUNT_REQUIRED/);
  });
  await verify(['--account',configuredAccount,'--allow-inspect'],[
    defaultNames[0],'sales_browser_mail_inspect_draft',defaultNames[1]
  ],async client=>{
    const result = await client.callTool({
      name:'sales_browser_mail_inspect_draft',
      arguments:{draftId:'123456789012',recipient:'buyer@example.test',subject:'Synthetic verification'}
    });
    assert.equal(result.isError,true);
    assert.match(result.content[0].text,/BROWSER_MAIL_NOT_CONNECTED/);
  });
  assert.deepEqual(readdirSync(home),[],'The browser checks must leave no profile or runtime state.');
  console.log('ProspectDesk read-only STDIO checks passed (2 default tools, 3 with inspect; no state created).');
} finally {
  if (readdirSync(home).length === 0) rmdirSync(home);
}
