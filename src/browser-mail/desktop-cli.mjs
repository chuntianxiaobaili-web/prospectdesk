import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {connectBrowser} from './connection.mjs';
import {BrowserMailService} from './service.mjs';
import {hash} from '../import.js';

export function parseArguments(argv) {
  const [command='help',...args]=argv;
  if(!['open','probe','help'].includes(command))throw Error('Choose open or probe');
  const options={command};
  const flags=new Map([['--browser','browserId'],['--data-directory','dataDirectory'],['--executable-path','executablePath'],['--url','url'],['--account','accountId'],['--config','configPath']]);
  for(let i=0;i<args.length;i++){
    const key=args[i];
    if(key==='--headless'){options.headless=true;continue;}
    const name=flags.get(key);if(!name||!args[i+1]||args[i+1].startsWith('--'))throw Error('Unknown or incomplete argument: '+key);
    if(options[name]!==undefined)throw Error('Duplicate argument: '+key);
    options[name]=args[++i];
  }
  return options;
}
export async function main(argv=process.argv.slice(2)) {
  const input=parseArguments(argv);
  if(input.command==='help'){
    console.log('Browser connection only; this command does not send or delete mail.\nopen|probe --browser edge|chrome|yandex --data-directory ABSOLUTE_PATH [--executable-path YANDEX_EXE] [--url HTTPS_URL] [--account MAILBOX] [--headless]\nA JSON launch configuration can be supplied with --config.');
    return;
  }
  let config={};
  if(input.configPath)config=JSON.parse(await fs.readFile(path.resolve(input.configPath),'utf8'));
  if(config.mode!==undefined&&config.mode!=='launch')throw Error('Desktop CLI uses an owned launch connection');
  if(config.browserId&&input.browserId&&config.browserId!==input.browserId)throw Error('Browser entry and configuration do not match');
  const settings={...config,...Object.fromEntries(Object.entries(input).filter(([,v])=>v!==undefined))};
  if(!path.isAbsolute(settings.dataDirectory??''))throw Error('An absolute dedicated data directory is required');
  const url=settings.url??'about:blank';
  if(url!=='about:blank'&&!/^https?:\/\//i.test(url))throw Error('Choose about:blank or an explicit HTTP(S) page');
  const connection=await connectBrowser({browserId:settings.browserId,mode:'launch',
    dataDirectory:settings.dataDirectory,executablePath:settings.executablePath,headless:settings.headless??false});
  let service;
  try{
    if(url!=='about:blank')await connection.page.goto(url,{waitUntil:'domcontentloaded'});
    if(input.command==='probe'){
      let mailboxCompatibility=null,pageReadable=false;
      if(settings.accountId){
        service=new BrowserMailService({connection,accountId:settings.accountId,
          journalDirectory:path.join(settings.dataDirectory,'browser-mail-runs'),
          accountLockPath:path.join(os.tmpdir(),'harness-sales-account-locks',hash(settings.accountId)+'.lock')});
        mailboxCompatibility=await service.compatibility();
        pageReadable=Array.isArray(mailboxCompatibility.mailboxChecks)&&mailboxCompatibility.mailboxChecks.some(check=>check.id==='account_matches');
      }else {await connection.tab.getAXState({emit:false,disableDiffing:true});pageReadable=true;}
      console.log(JSON.stringify({connection:connection.identity,pageReadable,mailboxCompatibility,mailSent:0,draftsDeleted:0},null,2));
      if(!pageReadable||(mailboxCompatibility&&!mailboxCompatibility.compatible))process.exitCode=2;
      return;
    }
    console.log(JSON.stringify({connection:connection.identity,status:'open_for_manual_login',mailSent:0,draftsDeleted:0},null,2));
    console.log('Connection window is open. Complete login in this dedicated browser if needed. Close this page or press Ctrl+C to finish. No mail is sent by this command.');
    await new Promise(resolve=>{
      const stop=()=>{process.off('SIGINT',stop);process.off('SIGTERM',stop);resolve();};
      process.once('SIGINT',stop);process.once('SIGTERM',stop);connection.page.once('close',stop);
    });
  }finally{
    if(service)await service.close();else await connection.close();
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
