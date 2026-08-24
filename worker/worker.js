// dsh-weixin-bot worker: WeChat ClawBot <-> DSH plugin bridge over stdio.
// Protocol (newline-delimited JSON):
//   worker -> plugin: {"type":"ready"} | {"type":"log","line":..} | {"type":"chat","id":..,"conversationId":..,"text":..}
//   plugin -> worker: {"type":"reply","id":..,"text":..} | {"type":"quit"}
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PKG_ROOT = path.join(__dirname, '..');
const LOG_FILE = path.join(__dirname, '.wx-worker.log');
function flog(line) {
  try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + String(line).slice(0, 800) + '\n'); } catch {}
}
function send(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
    flog('>> ' + JSON.stringify(obj).slice(0, 400));
  } catch (e) { flog('send failed: ' + e.message); }
}
function log(line) { flog(line); send({ type: 'log', line: String(line).slice(0, 500) }); }

/** Load weixin-agent-sdk from well-known locations. */
function loadSdk() {
  const candidates = [
    process.env.DSH_WEIXIN_SDK_PATH,
    path.join(PKG_ROOT, 'node_modules', 'weixin-agent-sdk', 'dist', 'index.mjs'),
    path.join(PKG_ROOT, '..', 'dsh-weixin-bridge', 'node_modules', 'weixin-agent-sdk', 'dist', 'index.mjs'),
    'C:/Users/cnooc/dsh-weixin-bridge/node_modules/weixin-agent-sdk/dist/index.mjs',
  ].filter(Boolean);
  for (const p of candidates) {
    try { const m = require(p); flog('sdk loaded from ' + p); return m; }
    catch (e) { flog('sdk load failed at ' + p + ': ' + e.message); }
  }
  throw new Error('weixin-agent-sdk not found. Install with: npm install --prefix "' + PKG_ROOT + '" weixin-agent-sdk');
}

let pendingReplies = new Map();
let nextId = 1;

/** Ask the plugin (native DSH Agent) to handle one chat turn. */
function requestChat(conversationId, text) {
  const id = `m${nextId++}`;
  return new Promise((resolve) => {
    pendingReplies.set(id, resolve);
    send({ type: 'chat', id, conversationId, text });
    setTimeout(() => {
      if (pendingReplies.has(id)) {
        pendingReplies.delete(id);
        resolve({ text: '[timeout] DSH 5 minutes no response' });
      }
    }, 5 * 60 * 1000).unref?.();
  });
}

(async () => {
  flog('=== worker start pid=' + process.pid + ' ===');
  const sdk = loadSdk();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'reply') {
      const r = pendingReplies.get(msg.id);
      if (r) { pendingReplies.delete(msg.id); flog('<< reply for ' + msg.id + ': ' + String(msg.text || '').slice(0, 200)); r({ text: msg.text ?? '' }); }
    } else if (msg.type === 'quit') {
      process.exit(0);
    }
  });

  const loggedIn = sdk.isLoggedIn();
  flog('isLoggedIn=' + loggedIn);
  if (!loggedIn) {
    send({ type: 'fatal', message: 'WeChat not logged in. Run scripts/login.cmd first.' });
    process.exit(2);
  }

  const agentAdapter = {
    async chat(request) {
      const text = request?.text ?? '';
      flog('chat() from conversation=' + request.conversationId + ' text=' + String(text).slice(0, 200));
      if (!text.trim()) return { text: '' };
      const reply = await requestChat(request.conversationId || 'default', text);
      flog('chat done, reply len=' + (reply.text || '').length);
      return { text: reply.text };
    },
    async clearSession() {},
  };

  sdk.start(agentAdapter, { log });
  send({ type: 'ready' });
  flog('ready sent — monitor polling');
})().catch((e) => {
  flog('FATAL: ' + ((e && e.stack) || e));
  send({ type: 'fatal', message: String(e && e.message || e) });
  process.exit(1);
});
