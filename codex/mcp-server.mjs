import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

import {bridgeVersion,createProspectDeskRuntime} from './runtime.mjs';

const runtime = createProspectDeskRuntime();
const server = new McpServer({name: 'prospectdesk-codex', version: bridgeVersion});

function response(value) {
  const structuredContent = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {value};
  return {
    content: [{type: 'text', text: JSON.stringify(value)}],
    structuredContent
  };
}

function register(name, description, inputSchema, handler) {
  server.registerTool(name, {description, inputSchema}, async (args, extra) => {
    try {
      return response(await handler(args, extra?.signal));
    } catch (error) {
      return {
        isError: true,
        content: [{type: 'text', text: error instanceof Error ? error.message : String(error)}]
      };
    }
  });
}

register(
  'sales_browser_mail_compatibility',
  'Read-only compatibility and account check for the connected mailbox. Does not send or clean drafts.',
  {},
  (_args, signal) => runtime.call('sales_browser_mail_compatibility', {}, signal)
);

register(
  'sales_browser_mail_prepare',
  'Freeze a verified existing-draft batch without sending. Permanent cleanup IDs must be explicitly approved for this batch.',
  {
    target: z.number().int().min(1).max(10000).optional(),
    durationMs: z.union([z.number().int().min(1), z.null()]).optional(),
    workDuration: z.string().max(100).optional(),
    intervalMs: z.number().int().min(1).max(86400000).optional(),
    prepareAheadMs: z.number().int().min(0).max(60000).optional(),
    preparedRefsJson: z.string().max(1000000).optional(),
    excludeDraftIdsJson: z.string().max(1000000).optional(),
    approvedPermanentDraftIdsJson: z.string().max(1000000).optional()
  },
  (args, signal) => runtime.call('sales_browser_mail_prepare', args, signal)
);

for (const [name, description] of [
  ['sales_browser_mail_start', 'Start a prepared batch and its optional deadline. This call does not submit mail.'],
  ['sales_browser_mail_step', 'Process at most one due draft, including send receipt verification and only explicitly approved cleanup.'],
  ['sales_browser_mail_status', 'Read the current batch state and timing without changing mailbox content.'],
  ['sales_browser_mail_stop', 'Stop further sends and cleanup; in-flight verification may settle.'],
  ['sales_browser_mail_finish', 'Stop if needed, read final draft count, archive the run, and release the account lock. Does not send.']
]) {
  register(name, description, {}, (_args, signal) => runtime.call(name, {}, signal));
}

let closing = false;
async function closeAndExit(code = 0) {
  if (closing) return;
  closing = true;
  try {
    await runtime.close();
  } finally {
    process.exitCode = code;
  }
}

process.once('SIGINT', () => void closeAndExit(0));
process.once('SIGTERM', () => void closeAndExit(0));
process.stdin.once('end', () => void closeAndExit(0));
process.once('beforeExit', () => void closeAndExit(process.exitCode ?? 0));

await server.connect(new StdioServerTransport());
