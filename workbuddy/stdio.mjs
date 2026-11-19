import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {bridgeVersion,createProspectDeskRuntime} from '../codex/runtime.mjs';

const require = createRequire(new URL('../codex/package.json',import.meta.url));
const {McpServer} = require('@modelcontextprotocol/sdk/server/mcp.js');
const {StdioServerTransport} = require('@modelcontextprotocol/sdk/server/stdio.js');
const {z} = require('zod');

const {values} = parseArgs({options:{'allow-inspect':{type:'boolean'}}});
const workspace = path.join(homedir(),'.prospectdesk','workbuddy');
const environment = Object.fromEntries(Object.entries(process.env)
  .filter(([name])=>!name.toUpperCase().startsWith('PROSPECTDESK_')));
const runtime = createProspectDeskRuntime({
  environment,
  accountId:process.env.PROSPECTDESK_WORKBUDDY_ACCOUNT_ID,
  dataDirectory:path.join(workspace,'state'),
  profileDirectory:path.join(workspace,'chrome-data'),
  ...(process.env.PROSPECTDESK_WORKBUDDY_MAIL_URL
    ? {mailUrl:process.env.PROSPECTDESK_WORKBUDDY_MAIL_URL} : {}),
  ...(process.env.PROSPECTDESK_WORKBUDDY_CHROME_EXECUTABLE
    ? {executablePath:process.env.PROSPECTDESK_WORKBUDDY_CHROME_EXECUTABLE} : {})
});
const server = new McpServer({name:'prospectdesk-review',version:bridgeVersion});

function register(name, description, inputSchema, handler) {
  server.registerTool(name,{
    description,inputSchema,annotations:{readOnlyHint:true,destructiveHint:false}
  },async (args, extra)=>{
    try {
      const result = await handler(args, extra?.signal);
      return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
    } catch (error) {
      return {isError:true,content:[{type:'text',text:error instanceof Error ? error.message : String(error)}]};
    }
  });
}

register('sales_browser_mail_status',
  'Report the local ProspectDesk review bridge version and connection state without opening the browser.',
  {}, async (_args,signal)=>{
    const {browserConnected,frameScope} = await runtime.call('sales_browser_mail_status',{},signal);
    return {bridgeVersion,browserConnected,frameScope,profile:'read-only'};
  });

register('sales_browser_mail_compatibility',
  'Check the configured mailbox and browser controls. May open the dedicated browser; never changes messages.',
  {}, async (_args,signal)=>{
    const {compatible,status,checkedAt,checks} = await runtime.call('sales_browser_mail_compatibility',{},signal);
    return {bridgeVersion,compatible,status,checkedAt,checks};
  });

if (values['allow-inspect']) {
  register('sales_browser_mail_inspect_draft',
    'Verify one exact existing draft without changing it. Returns verification metadata, never body text.',
    {draftId:z.string().regex(/^\d{10,30}$/),recipient:z.string().email().max(320),subject:z.string().min(1).max(1000)},
    async (args,signal)=>{
      const {draftId,bodyLength,approvedHash} = await runtime.inspectDraft(args,signal);
      return {bridgeVersion,readOnly:true,draftId,bodyLength,approvedHash};
    });
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await runtime.close();
  } catch {
    process.exitCode = 1;
  } finally {
    await server.close();
  }
}
process.once('SIGINT',()=>void shutdown());
process.once('SIGTERM',()=>void shutdown());
process.stdin.once('end',()=>void shutdown());

await server.connect(new StdioServerTransport());
