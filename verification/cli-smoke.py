"""Synthetic official CLI smoke. No credentials, paid calls, or email sends."""
import subprocess, os, pathlib, time, re, urllib.request, http.cookiejar, json, tempfile, socket
plugin=pathlib.Path(__file__).resolve().parents[1]
nm=os.environ.get('HARNESS_NODE_MODULES')
binary=os.environ.get('DSH_BIN') or (str(pathlib.Path(nm)/'.bin'/'dsh') if nm else 'dsh')
with tempfile.TemporaryDirectory(prefix='harness-cli-qa-') as td:
 root=pathlib.Path(td)
 with socket.socket() as sock:
  sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 patch=root/'plugin.patch.yml'
 patch.write_text(json.dumps([{'insert':[{'id':'sales-qa','name':str(plugin/'src/plugin.js'),'config':{'directory':str(root/'state'),'config':{'brand':{'name':'Synthetic QA'},'accountId':'synthetic@example.test','draftModel':{'provider':'unconfigured','model':'unconfigured'},'sendModel':{'provider':'unconfigured','model':'unconfigured'}}}}]}]))
 env={'HOME':str(root/'home'),'PATH':os.environ.get('PATH',''),'LANG':'C.UTF-8'}
 with tempfile.TemporaryFile(mode='w+') as log:
  p=subprocess.Popen([binary,'web','--patch',str(patch),'--host','127.0.0.1','--port',str(port),'--no-open'],env=env,stdout=log,stderr=subprocess.STDOUT)
  try:
   deadline=time.time()+90;url=None
   while time.time()<deadline:
    log.seek(0);s=log.read();m=re.search(r'http://127\.0\.0\.1:'+str(port)+r'/[^\s\x1b]*',s)
    if m:url=m.group(0);break
    if p.poll() is not None:raise RuntimeError('Harness startup failed; exit '+str(p.returncode))
    time.sleep(.2)
   if not url:raise RuntimeError('No startup URL within90s')
   opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
   first=opener.open(url,timeout=10);html=first.read().decode();second=opener.open(f'http://127.0.0.1:{port}/',timeout=10)
   assert first.status==second.status==200
   assert 'DeepSeek Harness' in html
   assert (root/'state/state.json').exists(), 'Plugin did not apply'
   print(json.dumps({'passed':True,'http':[first.status,second.status],'pluginApplied':True,'scope':'same-exec official CLI loader and HTTP frontend; no GUI/live mailbox acceptance'}))
  finally:
   p.terminate()
   try:p.wait(timeout=10)
   except subprocess.TimeoutExpired:p.kill();p.wait()
