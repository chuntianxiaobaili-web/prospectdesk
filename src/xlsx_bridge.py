"""Optional, explicit prerequisite: Python 3 + openpyxl. Never evaluates formulas."""
import sys,json,zipfile
from openpyxl import load_workbook
p,m=sys.argv[1],json.loads(sys.argv[2])
with zipfile.ZipFile(p) as z:
    if sum(i.file_size for i in z.infolist())>100*1024*1024: raise ValueError('Workbook expanded size exceeds limit')
w=load_workbook(p,read_only=True,data_only=False)
def rows(sheet):
    iterator=w[sheet].iter_rows(values_only=True)
    headers=[str(v or '').strip() for v in next(iterator)]
    if len(set(headers))!=len(headers): raise ValueError('Duplicate headers')
    out=[]
    for line in iterator:
        if any(isinstance(v,str) and v.startswith('=') for v in line): raise ValueError('Formula cells not accepted in import data')
        if not any(v is not None for v in line): continue
        if len(out)>=10000: raise ValueError('Too many rows')
        out.append(dict(zip(headers,[v.isoformat()[:10] if hasattr(v,'isoformat') else v for v in line])))
    return out
leads=rows(m.get('leadSheet','客户清单'))
key=m.get('key','编号'); evidence={}
if m.get('evidenceSheet','证据') in w.sheetnames:
    for r in rows(m.get('evidenceSheet','证据')):
        k=str(r.get(key,'')); evidence.setdefault(k,[]).append(r)
for r in leads:
    matched=evidence.get(str(r.get(key,'')),[])
    # A mapping joins exact same customer IDs; all source rows remain preserved.
    for field,col in m.get('evidenceColumns',{}).items():
        selected=matched
        if m.get('emailEvidenceType') and field in ('evidence','sourceUrl','sourceDate'):
            selected=[e for e in matched if e.get(m.get('evidenceTypeColumn','证据类型'))==m['emailEvidenceType']]
        values=[str(e[col]) for e in selected if e.get(col) is not None]
        if values:
            values=list(dict.fromkeys(values))
            r[field]=values[0] if field in ('sourceUrl','sourceDate') else '\n'.join(values)
            r[field+'All']=values
    for field,col in m.get('columns',{}).items():r[field]=r.get(col,'')
    r['joinedEvidenceRows']=matched
print(json.dumps(leads,ensure_ascii=False,default=str));w.close()
