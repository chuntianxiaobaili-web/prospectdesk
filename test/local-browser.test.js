import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';
import {runInNewContext} from 'node:vm';
import {DedicatedBrowser,assertDedicatedRoot,validateDataDirectory} from '../src/local-browser.js';import {validateLocalRequest} from '../src/local-app.js';import {BrowserMockMailbox,MockWebmailStore} from '../src/mock-webmail.js';
class Context extends EventEmitter {setDefaultTimeout(){} async close(){this.emit('close');}}
const temp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'b2b-browser-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
test('default Chrome/Edge trees and case/separator variants rejected',()=>{for(const p of ['C:\\Users\\X\\AppData\\Local\\Google\\Chrome\\User Data','c:/users/x/appdata/local/MICROSOFT/EDGE/User Data/Profile 1','C:/Google/Chrome SxS/User Data','C:/Microsoft/Edge Beta/User Data','/home/u/.config/google-chrome/Default','/home/u/.config/google-chrome-beta/Default','/Users/u/Library/Application Support/Google/Chrome Canary','/Users/u/Library/Application Support/Google/Chrome'])assert.throws(()=>assertDedicatedRoot(p),/Default/);});
test('symlink directory ancestry refused before creation',t=>{const d=temp(t);fs.mkdirSync(path.join(d,'real'));fs.symlinkSync(path.join(d,'real'),path.join(d,'link'),'dir');assert.throws(()=>validateDataDirectory(path.join(d,'link','new')),/Symlink/);assert.equal(fs.existsSync(path.join(d,'real','new')),false);});
test('isolated persistent launch has sandbox, no CDP, starts paused; exclusive lock retained by owner',async t=>{const d=temp(t);let captured;const c=new Context();const driver={launchPersistentContext:async(p,o)=>(captured={p,o},c)};const b=new DedicatedBrowser({dataDirectory:d,driver});await b.launch();assert.equal(b.state,'paused');assert.equal(captured.o.chromiumSandbox,true);assert.equal(captured.o.args,undefined);assert.equal(captured.p,path.join(d,'browser-profiles','chromium'));const other=new DedicatedBrowser({dataDirectory:d,driver});await assert.rejects(()=>other.launch(),/EEXIST/);assert.equal(fs.existsSync(b.lockPath),true);await b.close();assert.equal(fs.existsSync(b.lockPath),false);});
test('launch failure releases only own lock, never silently retries',async t=>{const d=temp(t);let calls=0;const b=new DedicatedBrowser({dataDirectory:d,driver:{launchPersistentContext:async()=>{calls++;throw Error('socket denied');}}});await assert.rejects(()=>b.launch(),/socket denied/);assert.equal(calls,1);assert.equal(b.state,'closed');assert.equal(fs.existsSync(b.lockPath),false);});
test('pause and manual takeover abort and wait for in-flight action; restart never auto resumes',async t=>{const d=temp(t);const b=new DedicatedBrowser({dataDirectory:d,driver:{launchPersistentContext:async()=>new Context()}});await b.launch();await assert.rejects(()=>b.runAutomation(()=>{}),/paused/);b.resumeAutomation();let release;const action=b.runAutomation(({signal})=>new Promise(r=>{release=()=>r(signal.aborted);}));await new Promise(r=>setImmediate(r));const takeover=b.takeover();assert.equal(b.state,'paused');release();assert.equal(await action,true);await takeover;assert.equal(b.state,'manual');await assert.rejects(()=>b.runAutomation(()=>{}),/manual/);await b.close();await b.launch();assert.equal(b.state,'paused');await b.close();});
test('unexpected context close pauses owner callback and releases after action settles',async t=>{const d=temp(t);let pauses=0;const c=new Context();const b=new DedicatedBrowser({dataDirectory:d,driver:{launchPersistentContext:async()=>c},onPause:()=>pauses++});await b.launch();b.resumeAutomation();await c.close();assert.equal(b.state,'closed');assert.equal(pauses,1);assert.equal(fs.existsSync(b.lockPath),false);});
test('local control rejects cross-origin, DNS rebinding and missing CSRF',()=>{const cfg={origin:'http://127.0.0.1:12345',token:'a'.repeat(64)};const req={headers:{host:'127.0.0.1:12345',origin:cfg.origin,'content-type':'application/json','x-local-token':cfg.token}};assert.doesNotThrow(()=>validateLocalRequest(req,cfg,true));for(const patch of [{host:'evil.example:12345'},{origin:'https://evil.example'},{'x-local-token':''},{'sec-fetch-site':'cross-site'}])assert.throws(()=>validateLocalRequest({headers:{...req.headers,...patch}},cfg,true));});
test('browser mock store persists exact idempotent packet and rejects live addresses',t=>{const d=temp(t),s=new MockWebmailStore(d),m={recipient:'buy@fixture.test',subject:'Exact',body:'Exact text',idempotencyKey:'1',approvedHash:'abc'};assert.equal(s.accept(m).mode,'mock');assert.equal(s.accept(m).messageId,s.receipts()[0].messageId);assert.equal(new MockWebmailStore(d).receipts().length,1);assert.throws(()=>s.accept({...m,body:'changed'}),/mismatch/);assert.throws(()=>s.accept({...m,recipient:'live@example.com'}),/Synthetic/);});
function mailboxFixture(t, {fieldsForRead, newURL} = {}) {
  const directory = temp(t);
  const store = new MockWebmailStore(directory);
  const calls = [];
  const requests = [];
  const context = new Context();
  context.newPage = async () => {
    let url = '';
    let formValues = {};
    let receipt;
    let routeHandler;
    let readCount = 0;
    async function request(method, requestURL) {
      return routeHandler({
        request: () => ({method: () => method, url: () => requestURL}),
        continue: () => {
          requests.push({method, url: requestURL, allowed: true});
          return true;
        },
        abort: () => {
          requests.push({method, url: requestURL, allowed: false});
          return false;
        },
      });
    }
    return {
      route: async (pattern, handler) => { routeHandler = handler; },
      goto: async target => {
        await request('GET', target);
        url = newURL ?? target;
      },
      url: () => url,
      close: async () => {},
      evaluate: async (inspect, args) => {
        const form = {};
        const nodes = {
          account: {localName: 'p', textContent: 'mock@local.test'},
          recipient: {localName: 'input', name: 'recipient', form},
          subject: {localName: 'input', name: 'subject', form},
          body: {localName: 'textarea', name: 'body', form},
          'send-id': {localName: 'input', name: 'idempotencyKey', form},
          'approved-hash': {localName: 'input', name: 'approvedHash', form},
          send: {localName: 'button', type: 'submit', form},
          receipt: {localName: 'pre'},
          'sent-list': {localName: 'pre'},
        };
        const fields = Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, [{
          type: 'text',
          getClientRects: () => [1],
          matches: () => false,
          getAttribute: () => null,
          hasAttribute: () => false,
          ...node,
        }]]));
        fieldsForRead?.(fields, ++readCount);
        const document = {
          querySelectorAll: selector => selector === 'form#compose'
            ? [form]
            : fields[selector.match(/^\[data-testid="(.*)"\]$/)?.[1]] ?? [],
        };
        const getComputedStyle = node => node.style ?? {visibility: 'visible', display: 'block'};
        return JSON.parse(JSON.stringify(runInNewContext('(' + inspect.toString() + ')(args)', {
          document, getComputedStyle, args,
        })));
      },
      getByTestId: id => ({
        fill: async value => {
          calls.push(id);
          formValues[id] = value;
        },
        textContent: async () => id === 'receipt' ? JSON.stringify(receipt) : JSON.stringify(store.receipts()),
        filter() { return this; },
        waitFor: async () => {},
        click: async () => {
          calls.push('send');
          if (!await request('POST', new URL('/api/mock-send', url).href)) throw Error('Mock POST denied');
          receipt = store.accept({
            recipient: formValues.recipient,
            subject: formValues.subject,
            body: formValues.body,
            idempotencyKey: formValues['send-id'],
            approvedHash: formValues['approved-hash'],
          });
        },
      }),
    };
  };
  const browser = new DedicatedBrowser({
    dataDirectory: directory,
    driver: {launchPersistentContext: async () => context},
  });
  t.after(() => browser.close());
  const mail = new BrowserMockMailbox({browser, baseURL: 'http://127.0.0.1:12345'});
  return {mail, browser, calls, requests, store};
}

const accountId = 'mock@local.test';
const packet = {
  recipient: 'buy@fixture.test',
  subject: 'Approved subject',
  body: 'Approved unchanged body',
  idempotencyKey: 'packet-1',
  approvedHash: 'hash-1',
};

test('browser mock adapter checks the UI without filling or submitting and preserves approved fields', async t => {
  const {mail, browser, calls, requests, store} = mailboxFixture(t);
  await browser.launch();
  assert.equal((await mail.checkCompatibility({accountId})).compatible, false);
  assert.equal(browser.state, 'paused');
  browser.resumeAutomation();

  const status = await mail.checkCompatibility({accountId});
  assert.equal(status.compatible, true);
  assert.equal(status.mode, 'mock');
  assert.ok(status.checks.every(check => check.ok));
  assert.ok(!JSON.stringify(status).includes(accountId));
  assert.equal((await mail.preflight({recipient: packet.recipient, accountId})).accountVerified, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(store.receipts(), []);
  assert.ok(requests.every(request => request.allowed && request.method === 'GET'));

  const result = await mail.send(packet);
  assert.equal(result.body, packet.body);
  assert.equal(result.mode, 'mock');
  assert.deepEqual(calls, ['recipient', 'subject', 'body', 'send-id', 'approved-hash', 'send']);
  assert.equal((await mail.reconcile(packet)).messageId, result.messageId);
});

test('missing, ambiguous, or disabled mock controls fail closed before composition', async t => {
  for (const [label, id, change] of [
    ['missing', 'send', fields => { fields.send = []; }],
    ['duplicate', 'subject', fields => { fields.subject.push(fields.subject[0]); }],
    ['disabled', 'send', fields => { fields.send[0].matches = () => true; }],
    ['hidden', 'body', fields => { fields.body[0].getClientRects = () => []; }],
  ]) {
    await t.test(label, async subtest => {
      const {mail, browser, calls, store} = mailboxFixture(subtest, {fieldsForRead: change});
      await browser.launch();
      browser.resumeAutomation();
      const result = await mail.checkCompatibility({accountId});
      assert.equal(result.compatible, false);
      assert.deepEqual(result.checks.filter(check => !check.ok), [{id, ok: false}]);
      assert.equal((await mail.preflight({recipient: packet.recipient, accountId})).fresh, false);
      await assert.rejects(() => mail.send(packet), /UI compatibility check failed/);
      assert.deepEqual(calls, []);
      assert.deepEqual(store.receipts(), []);
    });
  }
});

test('same-origin page replacement is rejected and changed controls are rechecked before clicking', async t => {
  const redirected = mailboxFixture(t, {newURL: 'http://127.0.0.1:12345/other'});
  await redirected.browser.launch();
  redirected.browser.resumeAutomation();
  assert.equal((await redirected.mail.checkCompatibility({accountId})).compatible, false);
  await assert.rejects(() => redirected.mail.send(packet), /Unexpected mock mailbox URL/);
  assert.deepEqual(redirected.calls, []);

  const changed = mailboxFixture(t, {fieldsForRead: (fields, readCount) => {
    if (readCount === 2) fields.send = [];
  }});
  await changed.browser.launch();
  changed.browser.resumeAutomation();
  assert.equal((await changed.mail.checkCompatibility({accountId})).compatible, true);
  await assert.rejects(() => changed.mail.send(packet), /UI compatibility check failed/);
  assert.ok(!changed.calls.includes('send'));
  assert.deepEqual(changed.store.receipts(), []);
});
test('relaunch during disconnected in-flight action cannot release old profile lock',async t=>{const d=temp(t),c=new Context(),b=new DedicatedBrowser({dataDirectory:d,driver:{launchPersistentContext:async()=>c}});await b.launch();b.resumeAutomation();let release;const action=b.runAutomation(()=>new Promise(r=>release=r));await new Promise(r=>setImmediate(r));c.emit('close');assert.equal(fs.existsSync(b.lockPath),true);await assert.rejects(()=>b.launch(),/settle/);assert.equal(fs.existsSync(b.lockPath),true);release();await action;assert.equal(fs.existsSync(b.lockPath),false);});
test('close requested while launching waits then closes context and lock',async t=>{const d=temp(t);let resolve,closed=false;const c=new Context(),original=c.close.bind(c);c.close=async()=>{closed=true;await original();};const b=new DedicatedBrowser({dataDirectory:d,driver:{launchPersistentContext:()=>new Promise(r=>resolve=r)}});const launch=b.launch();const close=b.close();await assert.rejects(()=>b.launch(),/closing/);resolve(c);await launch;await close;assert.equal(closed,true);assert.equal(b.state,'closed');assert.equal(fs.existsSync(b.lockPath),false);});
