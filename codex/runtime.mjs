import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

import {apply} from '../src/plugin.js';
import {connectChrome} from '../src/browser-mail/chrome.mjs';

export const bridgeVersion = '0.6.1';
const frameScope = 'top-document';
const bridgeDirectory = path.dirname(fileURLToPath(import.meta.url));
const allowedTools = new Set([
  'sales_browser_mail_compatibility',
  'sales_browser_mail_prepare',
  'sales_browser_mail_start',
  'sales_browser_mail_step',
  'sales_browser_mail_status',
  'sales_browser_mail_stop',
  'sales_browser_mail_finish'
]);

function configuredPath(value, fallback) {
  return path.resolve(value || fallback);
}

function installedChromePath(environment) {
  if (process.platform !== 'win32') return undefined;
  const env = new Map(Object.entries(environment).map(([key, value]) => [key.toLowerCase(), value]));
  const systemDrive = env.get('systemdrive');
  const systemRoot = systemDrive && /^[a-z]:$/i.test(systemDrive) ? systemDrive + '/': undefined;
  const candidates = [env.get('programfiles'), env.get('programfiles(x86)'), env.get('localappdata'),
    ...(systemRoot ? [path.join(systemRoot, 'Program Files'), path.join(systemRoot, 'Program Files (x86)')] : [])];
  for (const root of candidates) {
    if (!root || !path.isAbsolute(root)) continue;
    const candidate = path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe');
    if (fs.statSync(candidate, {throwIfNoEntry: false})?.isFile()) return candidate;
  }
  return undefined;
}

function settingsFromEnvironment(environment = process.env) {
  const dataDirectory = configuredPath(
    environment.PROSPECTDESK_DATA_DIRECTORY,
    path.join(bridgeDirectory, 'state')
  );
  return {
    accountId: environment.PROSPECTDESK_ACCOUNT_ID,
    dataDirectory,
    profileDirectory: configuredPath(
      environment.PROSPECTDESK_CHROME_DATA_DIRECTORY,
      path.join(bridgeDirectory, 'chrome-data')
    ),
    mailUrl: environment.PROSPECTDESK_MAIL_URL || 'https://mail.zoho.com/zm/#mail/folder/drafts',
    executablePath: environment.PROSPECTDESK_CHROME_EXECUTABLE || installedChromePath(environment)
  };
}

export function createProspectDeskRuntime(options = {}) {
  const settings = {...settingsFromEnvironment(options.environment), ...options};
  let activeRuntime = null;
  let opening = null;

  async function open() {
    if (opening) return await opening;
    if (activeRuntime?.summary().connected) return activeRuntime.summary();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.accountId ?? '')) {
      throw new Error('PROSPECTDESK_ACCOUNT_REQUIRED: set PROSPECTDESK_ACCOUNT_ID to the mailbox address');
    }
    const mailUrl = new URL(settings.mailUrl);
    if (mailUrl.protocol !== 'https:' || mailUrl.username || mailUrl.password) {
      throw new Error('PROSPECTDESK_MAIL_URL_INVALID: supply an HTTPS mailbox URL without credentials');
    }

    opening = (async () => {
      if (activeRuntime) await activeRuntime.close();
      fs.mkdirSync(settings.dataDirectory, {recursive: true});
      fs.mkdirSync(settings.profileDirectory, {recursive: true});

      const connection = await connectChrome({
        mode: 'launch',
        dataDirectory: settings.profileDirectory,
        headless: false,
        frameScope,
        ...(settings.executablePath ? {executablePath: settings.executablePath} : {})
      });

      const registered = new Map();
      const disposers = [];
      const context = {
        tools: {
          register(tool) {
            registered.set(tool.name, tool);
            return () => registered.delete(tool.name);
          },
          guard() {
            return () => {};
          }
        },
        effect(factory) {
          const dispose = factory();
          if (typeof dispose === 'function') disposers.push(dispose);
        }
      };

      try {
        await connection.page.goto(settings.mailUrl, {waitUntil: 'domcontentloaded'});
        let readyServices = null;
        apply(context, {
          directory: settings.dataDirectory,
          config: {
            brand: {name: 'ProspectDesk Codex'},
            accountId: settings.accountId,
            accountLockDirectory: path.join(settings.dataDirectory, 'account-locks'),
            draftModel: {provider: 'codex', model: 'unused-for-existing-drafts'}
          },
          browserMail: {
            connection,
            journalDirectory: path.join(settings.dataDirectory, 'browser-mail-runs')
          },
          onReady(_workflow, services) {
            readyServices = services;
          }
        });

        for (const toolName of allowedTools) {
          if (!registered.has(toolName)) throw new Error(`PROSPECTDESK_TOOL_NOT_REGISTERED:${toolName}`);
        }

        let closed = false;
        activeRuntime = {
          async call(name, args = {}, signal = new AbortController().signal) {
            if (closed) throw new Error('PROSPECTDESK_RUNTIME_CLOSED');
            if (!allowedTools.has(name)) throw new Error(`PROSPECTDESK_TOOL_NOT_ALLOWED:${name}`);
            const tool = registered.get(name);
            if (!tool) throw new Error(`PROSPECTDESK_TOOL_UNAVAILABLE:${name}`);
            return await tool.execute(args, {signal});
          },
          summary() {
            return {
              connected: !closed && !connection.page.isClosed(),
              bridgeVersion,
              frameScope,
              accountId: settings.accountId,
              browser: connection.identity,
              mailUrl: connection.page.url(),
              session: readyServices?.browserMail?.status?.() ?? null
            };
          },
          async close() {
            if (closed) return {closed: true};
            closed = true;
            try {
              for (const dispose of disposers.reverse()) await dispose();
            } finally {
              try { await connection.close(); } finally { activeRuntime = null; }
            }
            return {closed: true};
          }
        };
        return activeRuntime.summary();
      } catch (error) {
        try {
          for (const dispose of disposers.reverse()) await dispose();
          await connection.close();
        } catch {}
        throw error;
      }
    })();

    try {
      return await opening;
    } finally {
      opening = null;
    }
  }

  return {
    open,
    connectionStatus() {
      return activeRuntime
        ? activeRuntime.summary()
        : {connected: false, accountId: settings.accountId, mailUrl: settings.mailUrl, bridgeVersion, frameScope};
    },
    async call(name, args = {}, signal) {
      if (!allowedTools.has(name)) throw new Error(`PROSPECTDESK_TOOL_NOT_ALLOWED:${name}`);
      if (name === 'sales_browser_mail_status') {
        const status = activeRuntime?.summary();
        return {...(status?.session ?? {phase: 'idle', planned: 0, sent: 0, cleaned: 0}),
          bridgeVersion, frameScope, browserConnected: status?.connected ?? false};
      }
      // Opening a browser is meaningful only for a compatibility check or preparation.
      if (!['sales_browser_mail_compatibility', 'sales_browser_mail_prepare'].includes(name)
          && !activeRuntime?.summary().connected) throw new Error('BROWSER_MAIL_NOT_CONNECTED');
      await open();
      if (name !== 'sales_browser_mail_compatibility') return await activeRuntime.call(name, args, signal);
      const started = Date.now();
      let result;
      do {
        result = await activeRuntime.call(name, args, signal);
        const live = activeRuntime.summary();
        // The mailbox title and folders can become visible on different renders.
        // Re-read only on the configured mailbox origin; login or identity checks retain their result.
        if (result.compatible || !live.connected || result.connectionChecks?.some(check => !check.ok)
            || new URL(live.mailUrl).origin !== new URL(settings.mailUrl).origin
            || Date.now() - started >= 12000) break;
        await delay(400, undefined, {signal});
      } while (!signal?.aborted);
      return {...result, bridgeVersion, frameScope};
    },
    async close() {
      if (opening) await opening.catch(() => {});
      if (!activeRuntime) return {closed: true, wasConnected: false};
      return await activeRuntime.close();
    }
  };
}

export default createProspectDeskRuntime;
