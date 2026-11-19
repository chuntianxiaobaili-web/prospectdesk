import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const {values} = parseArgs({
  options: {
    account: {type: 'string'},
    project: {type: 'string', default: process.cwd()},
    help: {type: 'boolean'}
  }
});

const usage = 'Usage: node codex/configure.mjs --account <mailbox-address> [--project <project-directory>]';
if (values.help) {
  console.log(usage);
} else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.account ?? '')) {
  console.error(usage);
  process.exitCode = 1;
} else {
  const server = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));
  const workspace = path.resolve(values.project, '.prospectdesk', 'codex');
  const quote = value => JSON.stringify(value);
  console.log(`[mcp_servers.prospectdesk]
command = ${quote(process.execPath)}
args = [${quote(server)}]
cwd = ${quote(path.dirname(server))}
enabled = true
required = false
startup_timeout_sec = 30.0
tool_timeout_sec = 900.0
supports_parallel_tool_calls = false
env = { PROSPECTDESK_ACCOUNT_ID = ${quote(values.account)}, PROSPECTDESK_DATA_DIRECTORY = ${quote(path.join(workspace, 'state'))}, PROSPECTDESK_CHROME_DATA_DIRECTORY = ${quote(path.join(workspace, 'chrome-data'))} }

[mcp_servers.prospectdesk.tools.sales_browser_mail_step]
approval_mode = "prompt"`);
}
