import {validateDataDirectory} from './local-browser.js';
try{console.log(validateDataDirectory(process.argv[2]));}catch(e){console.error(e.message);process.exitCode=1;}
