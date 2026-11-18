import path from 'node:path';
import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
export async function importWorkbook(directory,filename,mapping={},pythonExecutable=process.platform==='win32'?'python':'python3') {
  if(!directory)throw Error('Configure importDirectory before XLSX import');
  const root=fs.realpathSync(directory),file=fs.realpathSync(path.resolve(root,filename));
  if(!file.startsWith(root+path.sep)||path.extname(file).toLowerCase()!=='.xlsx')throw Error('XLSX must be inside configured importDirectory');
  if(fs.statSync(file).size>10*1024*1024)throw Error('XLSX exceeds 10 MiB');
  const {stdout}=await promisify(execFile)(pythonExecutable,[fileURLToPath(new URL('./xlsx_bridge.py',import.meta.url)),file,JSON.stringify(mapping)],{maxBuffer:20*1024*1024,timeout:30000});
  return JSON.parse(stdout);
}
