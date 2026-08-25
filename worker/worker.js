// dsh-weixin-bot worker: WeChat ClawBot <-> DSH plugin bridge over stdio.
// Protocol (newline-delimited JSON):
//   worker -> plugin: {"type":"ready"} | {"type":"log","line":..} | {"type":"chat","id":..,"conversationId":..,"text":..}
//   plugin -> worker: {"type":"reply","id":..,"text":..} | {"type":"status","conversationId":..,"text":..} | {"type":"quit"}
//
// Safety & UX (learned from Tencent/openclaw-weixin and wechat-acp):
//   - owner allowlist: first sender auto-pairs; unpaired senders are rejected
//     without reaching DSH (the bridge is remote-RCE equivalent)
//   - inbound replay dedupe: same conversation + same body within the window
//     is dropped (at-least-once delivery can replay messages)
//   - markdown stripped to WeChat-friendly plain text on replies
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PKG_ROOT = path.join(__dirname, '..');
const LOG_FILE = path.join(__dirname, '.wx-worker.log');
const CONFIG_FILE = path.join(PKG_ROOT, 'config.json');

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

/* ─────────────── owner allowlist config ─────────────── */
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch {}
}

/**
 * Strip markdown WeChat renders as raw symbols, keep code fences intact.
 * Simplified whole-text variant of openclaw-weixin's streaming filter.
 */
function mdToPlain(md) {
  if (!md) return md;
  const fences = [];
  let s = String(md).replace(/```[\s\S]*?```/g, (m) => { fences.push(m); return '\u0000F' + (fences.length - 1) + '\u0000'; });
  s = s
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '[image] $2')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s*> ?/gm, '');
  s = s.replace(/\u0000F(\d+)\u0000/g, (_, i) => fences[Number(i)] ?? '');
  return s;
}

/** Near-dedupe: same conversation + same body inside the window is a replay. */
const RECENT_WINDOW_MS = 15 * 1000;
const recent = [];

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
/** Bot instance from sdk.start() — undefined until the monitor is up. */
let bot;

/** Ask the plugin (native DSH Agent) to handle one chat turn. */
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
function requestChat(conversationId, text) {
  const id = `m${nextId++}`;
  return new Promise((resolve) => {
    pendingReplies.set(id, resolve);
    send({ type: 'chat', id, conversationId, text });
    setTimeout(() => {
      if (pendingReplies.has(id)) {
        pendingReplies.delete(id);
        resolve({ text: '[timeout] 任务超过 15 分钟仍未完成，已停止等待；稍后若完成会单独补发结果。' });
      }
    }, REQUEST_TIMEOUT_MS).unref?.();
  });
}

(async () => {
  flog('=== worker start pid=' + process.pid + ' ===');
  const sdk = loadSdk();
  const cfg = loadConfig();
  if (!Array.isArray(cfg.owners)) cfg.owners = [];
  flog('config owners=' + JSON.stringify(cfg.owners));

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'reply') {
      const r = pendingReplies.get(msg.id);
      if (r) { pendingReplies.delete(msg.id); flog('<< reply for ' + msg.id + ': ' + String(msg.text || '').slice(0, 200)); r({ text: msg.text ?? '' }); return; }
      // Late result: the requester already timed out, but the work finished —
      // deliver it proactively instead of dropping hours of agent effort.
      const text = String(msg.text ?? '').slice(0, 3500);
      if (!text || !bot) return;
      flog('<< late reply for ' + msg.id + ', pushing via sendMessage');
      Promise.race([
        bot.sendMessage(mdToPlain(text)),
        new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('sendMessage timeout 15s')), 15000); t.unref?.(); }),
      ]).then(
        () => flog('late reply delivered ok'),
        (e) => flog('late reply send FAILED: ' + ((e && e.message) || e))
      );
      return;
    } else if (msg.type === 'status') {
      // Proactive mid-task progress push; sendMessage needs a cached context
      // token, which exists because a status only follows an inbound message.
      const text = String(msg.text ?? '').slice(0, 2000);
      if (!text) return;
      if (!bot) { flog('status before ready, dropped: ' + text.slice(0, 100)); return; }
      flog('<< status: ' + text.slice(0, 120));
      Promise.race([
        bot.sendMessage(text),
        new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('sendMessage timeout 15s')), 15000); t.unref?.(); }),
      ]).then(
        () => flog('status delivered ok'),
        (e) => flog('status send FAILED: ' + ((e && e.message) || e))
      );
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
      const conv = String((request && request.conversationId) || 'default');
      const text = String((request && request.text) ?? '');
      flog(`chat() conv=${conv} text=${text.slice(0, 160)}`);

      // Owner allowlist: first sender auto-pairs as owner; others rejected.
      if (!cfg.owners.includes(conv)) {
        if (cfg.owners.length === 0 && !cfg.noAutoPair) {
          cfg.owners.push(conv);
          saveConfig(cfg);
          flog('auto-paired first sender as owner: ' + conv);
          log('owner paired: ' + conv);
        } else {
          flog('REJECTED unpaired sender: ' + conv);
          return { text: '[rejected] 私人机器人，未授权的会话无法使用。' };
        }
      }

      // Replay dedupe (same conv + same body inside window).
      const now = Date.now();
      while (recent.length && now - recent[0].t > RECENT_WINDOW_MS) recent.shift();
      if (text.trim() && recent.some((r) => r.conv === conv && r.text === text)) {
        flog('dropped replay duplicate from ' + conv);
        return { text: '' };
      }
      recent.push({ t: now, conv, text });

      if (!text.trim()) return { text: '' };
      const reply = await requestChat(conv, text);
      return { text: mdToPlain(reply.text || '') };
    },
    async clearSession() {},
  };

  bot = sdk.start(agentAdapter, { log });
  send({ type: 'ready' });
  flog('ready sent — monitor polling; owners=' + JSON.stringify(cfg.owners));
})().catch((e) => {
  flog('FATAL: ' + ((e && e.stack) || e));
  send({ type: 'fatal', message: String(e && e.message || e) });
  process.exit(1);
});
