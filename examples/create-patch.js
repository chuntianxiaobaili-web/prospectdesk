// Generate portable YAML from explicit user paths; JSON-quoted scalars are valid YAML.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const [output,directory,importDirectory,configPath]=process.argv.slice(2);
if(!output||!directory||!importDirectory||!configPath)throw Error('Usage: node examples/create-patch.js OUTPUT_YML STATE_DIR IMPORT_DIR CONFIG_JSON');
const entry=fileURLToPath(new URL('../src/plugin.js',import.meta.url));const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
const workbookMapping=JSON.parse(fs.readFileSync(new URL('./workbook-mapping.fsarcan.json',import.meta.url),'utf8'));
const patch=[{insert:[{id:'b2b-sales-workflow',name:entry,config:{directory:path.resolve(directory),importDirectory:path.resolve(importDirectory),exportDirectory:path.resolve(directory,'..','exports'),workbookMapping,config}}]}];
// JSON is a YAML 1.2 subset and preserves Windows slashes/quoting without guessing.
fs.writeFileSync(output,JSON.stringify(patch,null,2));console.log(path.resolve(output));
