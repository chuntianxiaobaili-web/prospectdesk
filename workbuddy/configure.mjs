import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const options = {
  account:{type:'string'},
  'allow-inspect':{type:'boolean'},
  'mail-url':{type:'string'},
  'chrome-executable':{type:'string'},
  help:{type:'boolean'}
};

const usage = 'Usage: node workbuddy/configure.mjs [--account address] [--allow-inspect] [--mail-url https://…] [--chrome-executable path]';

function buildConfig(values) {
  if (values.account !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.account)) {
    throw new Error('Supply an email address with --account.');
  }
  if (values['allow-inspect'] && !values.account) throw new Error('Pass --account to enable --allow-inspect.');

  const env = {};
  if (values.account) env.PROSPECTDESK_WORKBUDDY_ACCOUNT_ID = values.account;
  if (values['mail-url'] !== undefined) {
    let url;
    try { url = new URL(values['mail-url']); } catch {}
    if (!url || url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('Supply an HTTPS mailbox URL without credentials.');
    }
    env.PROSPECTDESK_WORKBUDDY_MAIL_URL = url.href;
  }
  if (values['chrome-executable'] !== undefined) {
    if (!values['chrome-executable'].trim()) throw new Error('Supply a browser executable path.');
    env.PROSPECTDESK_WORKBUDDY_CHROME_EXECUTABLE = path.resolve(values['chrome-executable']);
  }

  const args = [fileURLToPath(new URL('./stdio.mjs',import.meta.url))];
  if (values['allow-inspect']) args.push('--allow-inspect');
  return {mcpServers:{'prospectdesk-review':{
    type:'stdio',command:process.execPath,args,timeout:120000,env
  }}};
}

try {
  const {values} = parseArgs({options});
  console.log(values.help ? usage : JSON.stringify(buildConfig(values),null,2));
} catch (error) {
  console.error(error.message);
  console.error(usage);
  process.exitCode = 1;
}
