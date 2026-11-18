import fs from 'node:fs';import path from 'node:path';import {hash} from './import.js';
export class MockWebmailStore {
 constructor(directory){fs.mkdirSync(directory,{recursive:true});this.file=path.join(directory,'mock-sent.json');this.messages=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{};}
 accept(m){if(!m.recipient?.endsWith('.test')||!m.idempotencyKey||!m.approvedHash||!m.subject||!m.body)throw Error('Synthetic .test recipient and complete packet required');
 const existing=this.messages[m.idempotencyKey];if(existing){if(existing.approvedHash!==m.approvedHash||existing.recipient!==m.recipient||existing.subject!==m.subject||existing.body!==m.body)throw Error('Idempotency packet mismatch');return existing;}
 const r={...m,status:'sent',mode:'mock',messageId:'mock-browser_'+hash(m.idempotencyKey).slice(0,16)};this.messages[m.idempotencyKey]=r;const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.messages),{mode:0o600});fs.renameSync(temp,this.file);return r;
 }
 receipts(){return Object.values(this.messages);}
}
export function mockWebmailHTML(token){return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>模拟邮箱 · 不发送真实邮件</title><h1>仅模拟邮箱</h1><p data-testid="account">mock@local.test</p><p>只接受 .test 合成地址；本页面不会发送互联网邮件。</p><form id="compose"><label>Recipient<input data-testid="recipient" name="recipient"></label><label>Subject<input data-testid="subject" name="subject"></label><label>Body<textarea data-testid="body" name="body"></textarea></label><input data-testid="send-id" name="idempotencyKey"><input data-testid="approved-hash" name="approvedHash"><button data-testid="send" type="submit">模拟发送</button></form><pre data-testid="receipt"></pre><pre data-testid="sent-list"></pre><script>
const token=${JSON.stringify(token)};async function refresh(){const r=await fetch('/api/mock-sent');document.querySelector('[data-testid=sent-list]').textContent=JSON.stringify(await r.json());}refresh();document.querySelector('form').onsubmit=async e=>{e.preventDefault();const result=await fetch('/api/mock-send',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':token},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});document.querySelector('[data-testid=receipt]').textContent=JSON.stringify(await result.json());refresh();};</script></html>`;}
const MOCK_ACCOUNT = 'mock@local.test';

const controls = [
  {id: 'recipient', tag: 'input', name: 'recipient'},
  {id: 'subject', tag: 'input', name: 'subject'},
  {id: 'body', tag: 'textarea', name: 'body'},
  {id: 'send-id', tag: 'input', name: 'idempotencyKey'},
  {id: 'approved-hash', tag: 'input', name: 'approvedHash'},
  {id: 'send', tag: 'button'},
  {id: 'receipt', tag: 'pre'},
  {id: 'sent-list', tag: 'pre'},
];

async function inspectMailbox(page, accountId) {
  return page.evaluate(({expectedAccount, controls}) => {
    function uniqueVisible(id, tag) {
      const matches = document.querySelectorAll(`[data-testid="${id}"]`);
      if (matches.length !== 1) return null;
      const [element] = matches;
      const style = getComputedStyle(element);
      return element.localName === tag && element.getClientRects().length
        && style.visibility === 'visible' && style.display !== 'none' ? element : null;
    }

    const account = uniqueVisible('account', 'p');
    const composeForms = document.querySelectorAll('form#compose');
    const compose = composeForms.length === 1 ? composeForms[0] : null;
    const checks = [
      {id: 'account', ok: account?.textContent.trim() === expectedAccount},
      {id: 'compose', ok: Boolean(compose)},
    ];
    for (const {id, tag, name} of controls) {
      const element = uniqueVisible(id, tag);
      let ok = Boolean(element);
      if (id === 'send') {
        ok = Boolean(element && compose && element.form === compose
          && element.type === 'submit' && !element.matches(':disabled')
          && element.getAttribute('aria-disabled') !== 'true'
          && !element.hasAttribute('formaction') && !element.hasAttribute('formmethod'));
      } else if (name) {
        ok = Boolean(element && compose && element.form === compose && element.name === name
          && (tag !== 'input' || element.type === 'text')
          && !element.readOnly && !element.matches(':disabled'));
      }
      checks.push({id, ok});
    }
    return {compatible: checks.every(check => check.ok), mode: 'mock', checks};
  }, {expectedAccount: accountId, controls});
}

export class BrowserMockMailbox {
  mode = 'mock';

  constructor({browser, baseURL}) {
    const url = new URL(baseURL);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.username || url.password) {
      throw Error('Mock browser mail requires exact loopback HTTP origin');
    }
    this.browser = browser;
    this.baseURL = url.origin;
  }

  async withPage(fn, externalSignal, {allowSubmit = false} = {}) {
    return this.browser.runAutomation(async ({context, signal}) => {
      const page = await context.newPage();
      const abort = () => { void page.close().catch(() => {}); };
      signal.addEventListener('abort', abort, {once: true});
      externalSignal?.addEventListener('abort', abort, {once: true});
      const mailboxURL = this.baseURL + '/mock-webmail';
      const check = () => {
        if (signal.aborted || externalSignal?.aborted) throw Error('Paused');
        if (page.url() !== mailboxURL) throw Error('Unexpected mock mailbox URL');
      };
      try {
        if (signal.aborted || externalSignal?.aborted) throw Error('Paused');
        await page.route('**/*', route => {
          const request = route.request();
          const url = request.url();
          const method = request.method();
          if (method === 'GET' && (url === mailboxURL || url === this.baseURL + '/api/mock-sent')) {
            return route.continue();
          }
          if (allowSubmit && method === 'POST' && url === this.baseURL + '/api/mock-send') {
            return route.continue();
          }
          return route.abort();
        });
        await page.goto(mailboxURL);
        check();
        return await fn(page, check);
      } finally {
        signal.removeEventListener('abort', abort);
        externalSignal?.removeEventListener('abort', abort);
        await page.close().catch(() => {});
      }
    });
  }

  async checkCompatibility({accountId = MOCK_ACCOUNT, signal} = {}) {
    if (accountId !== MOCK_ACCOUNT) {
      return {compatible: false, mode: this.mode, checks: [{id: 'account', ok: false}]};
    }
    try {
      return await this.withPage(async (page, check) => {
        const result = await inspectMailbox(page, accountId);
        check();
        return result;
      }, signal);
    } catch {
      return {compatible: false, mode: this.mode, checks: [{id: 'mock-page-available', ok: false}]};
    }
  }

  async preflight({accountId, recipient, signal}) {
    const result = await this.checkCompatibility({accountId, signal});
    return {
      accountId: MOCK_ACCOUNT,
      accountVerified: result.compatible && accountId === MOCK_ACCOUNT,
      recipientVerified: typeof recipient === 'string' && recipient.endsWith('.test'),
      fresh: result.compatible,
    };
  }

  async send(m) {
    const accountId = m.accountId ?? MOCK_ACCOUNT;
    if (accountId !== MOCK_ACCOUNT || typeof m.recipient !== 'string' || !m.recipient.endsWith('.test')) {
      throw Error('Mock mailbox and synthetic .test recipient required');
    }
    return this.withPage(async (page, check) => {
      const fields = {
        recipient: m.recipient,
        subject: m.subject,
        body: m.body,
        'send-id': m.idempotencyKey,
        'approved-hash': m.approvedHash,
      };
      const requireCompatible = async () => {
        check();
        const result = await inspectMailbox(page, accountId);
        if (!result.compatible) throw Error('Mock mailbox UI compatibility check failed');
        check();
      };
      await requireCompatible();
      for (const [field, value] of Object.entries(fields)) {
        check();
        await page.getByTestId(field).fill(value);
      }
      await requireCompatible();
      await page.getByTestId('send').click();
      await page.getByTestId('receipt').filter({hasText: 'messageId'}).waitFor();
      const receipt = JSON.parse(await page.getByTestId('receipt').textContent());
      check();
      return receipt;
    }, m.signal, {allowSubmit: true});
  }

  async reconcile({idempotencyKey, recipient, approvedHash}) {
    return this.withPage(async (page, check) => {
      await page.getByTestId('sent-list').filter({hasText: '['}).waitFor();
      const rows = JSON.parse(await page.getByTestId('sent-list').textContent());
      check();
      const found = rows.find(row => row.idempotencyKey === idempotencyKey
        && row.recipient === recipient && row.approvedHash === approvedHash);
      return found ?? {status: 'not_sent', authoritative: true, mode: 'mock'};
    });
  }
}
