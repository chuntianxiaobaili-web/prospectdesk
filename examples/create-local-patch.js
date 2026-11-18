import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {validateDataDirectory} from '../src/local-browser.js';
const [output,dataDir,configPath,browser='chromium']=process.argv.slice(2);
if(!output||!dataDir||!configPath)throw Error('Usage: node examples/create-local-patch.js OUTPUT_YML DATA_DIR CONFIG_JSON [chromium|chrome|msedge]');
if(!['chromium','chrome','msedge'].includes(browser))throw Error('Unsupported browser');const root=validateDataDirectory(dataDir),config=JSON.parse(fs.readFileSync(configPath,'utf8'));
fs.writeFileSync(output,JSON.stringify([{insert:[{id:'b2b-sales-workflow',name:fileURLToPath(new URL('../src/plugin.js',import.meta.url)),config:{directory:path.join(root,'workflow'),importDirectory:path.join(root,'imports'),exportDirectory:path.join(root,'exports'),localBrowser:{dataDirectory:root,browser},config}}]}],null,2));console.log(path.resolve(output));
