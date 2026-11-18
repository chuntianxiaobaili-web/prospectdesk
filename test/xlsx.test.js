import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {importWorkbook} from '../src/xlsx.js';
test('XLSX Chinese lead sheet joins evidence by exact ID and applies mapping',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-xlsx-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 execFileSync('python3',['-c',`from openpyxl import Workbook
import sys
w=Workbook();s=w.active;s.title='客户清单';s.append(['编号','公司','官网','公开商务邮箱','需求事实']);s.append([1,'Synthetic','https://synthetic.test','sales@synthetic.test','Artificial flower décor']);e=w.create_sheet('证据');e.append(['编号','摘录','链接','日期']);e.append([1,'Published sales@synthetic.test','https://synthetic.test/contact','2026-10-23']);w.save(sys.argv[1])`,path.join(dir,'leads.xlsx')]);
 const rows=await importWorkbook(dir,'leads.xlsx',{evidenceColumns:{evidence:'摘录',sourceUrl:'链接',sourceDate:'日期'}});assert.equal(rows[0].evidence,'Published sales@synthetic.test');assert.equal(rows[0].joinedEvidenceRows.length,1);await assert.rejects(()=>importWorkbook(dir,'../bad.xlsx'));
});
