// dsh-weixin-bot — WeChat ClawBot bridge plugin for DeepSeek Harness (host side).
//
// 微信消息 → worker 进程（weixin-agent-sdk 轮询）→ stdio JSON-RPC → 本插件
// → ctx.agents.create() 创建原生 DSH Agent（同一微信会话复用同一 Agent = 多轮上下文）
// → followup 提交消息 → whenIdle 等待完成 → 提取最后 assistant 文本回传微信。
'use strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, '..', 'worker', 'worker.js');
const WORKER_CWD = path.join(__dirname, '..');

/** Stable Cordis plugin name. */
const name = 'weixin-bot';
/** Core services: native agent creation + subprocess for the worker. */
const inject = ['agents', 'sessions', 'agentDefaultModel', 'subprocess', 'sandboxPolicy'];

function apply(ctx) {
  const agents = ctx.agents;
  const sessions = ctx.sessions;
  const defaultModel = ctx.agentDefaultModel;
  const subprocess = ctx.subprocess;
  const sandboxPolicy = ctx.sandboxPolicy;

  let handle = undefined;
  let stdoutBuf = '';
  const conversations = new Map();
  let sessionCounter = 1;
  let msgCounter = 1;
  let queue = Promise.resolve();

  function log(line) { console.log('[wx-bot] ' + line); }

  function createUserMessage(text) {
    return {
      id: 'u' + Date.now() + '-' + (msgCounter++),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    };
  }

  /** Inline equivalent of @deepseek-ai/dsh-agent installModelSelection(). */
  function installModelSelection(agentCtx, selection) {
    agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const selected = selection.current;
      const assembled = await next();
      selection.assembled = selected;
      if (selected === undefined) return assembled;
      return {
        ...assembled,
        variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
      };
    });
    agentCtx.on('agent/request', async (_payload, next) => {
      const resolved = await next();
      const selected = selection.assembled;
      if (selected === undefined) return resolved;
      const rest = { ...resolved };
      delete rest.reasoningEffort;
      return { ...rest, provider: selected.provider, model: selected.model };
    });
  }

  /** Aggregate last assistant text and turn outcome over one owned interval. */
  function summarize(events, firstSeq) {
    let started = false;
    let text = '';
    let reason;
    for (const event of events) {
      if ((event.seq ?? 0) < firstSeq) continue;
      if (event.type === 'turn/start') { started = true; continue; }
      if (!started) continue;
      if (event.type === 'assistant/message') {
        try {
          const joined = event.data.message.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('');
          if (joined !== '') text = joined;
        } catch {}
      }
      if (event.type === 'turn/end') reason = event.data && event.data.reason;
    }
    return { text, reason };
  }

  /** One persistent native Agent per WeChat conversation (multi-turn context). */
  async function ensureConversation(conversationId) {
    let entry = conversations.get(conversationId);
    if (entry) return entry;
    const selection = defaultModel.currentSelection();
    if (!selection || !selection.provider || !selection.model) throw new Error('no default model selection');
    const cwd = sandboxPolicy.workspaceRoot;
    const sessionId = 'session-wx-' + Date.now() + '-' + sessionCounter++;
    const created = await agents.create({
      sessionId,
      meta: { cwd },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => installModelSelection(agentCtx, { current: selection, assembled: undefined }),
    });
    const agent = created.agent;
    await agent.whenIdle();
    entry = { agent };
    conversations.set(conversationId, entry);
    log('created native agent ' + sessionId + ' for conversation ' + conversationId);
    return entry;
  }

  async function runChatTurn(conversationId, text) {
    if (text.trim() === '/new') {
      conversations.delete(conversationId);
      return '[OK] 已重置当前微信会话的 DSH 上下文。';
    }
    const entry = await ensureConversation(conversationId);
    const seqBefore = entry.agent.session.seq;
    entry.agent.followup(createUserMessage(text));
    await entry.agent.whenIdle();
    try { await sessions.flush(entry.agent.session); } catch {}
    const outcome = summarize(entry.agent.session.events, seqBefore);
    let out = outcome.text || '';
    if (!out && outcome.reason && outcome.reason.kind === 'error') {
      out = '[ERR] Agent 出错: ' + ((outcome.reason.error && outcome.reason.error.message) || '');
    }
    return out || '(无文本回复)';
  }

  function sendToWorker(obj) {
    try { handle.stdin.write(JSON.stringify(obj) + '\n'); } catch (e) { log('stdin write failed: ' + (e && e.message)); }
  }

  function enqueueChat(msg) {
    queue = queue.then(async () => {
      try {
        const reply = await runChatTurn(String(msg.conversationId || 'default'), String(msg.text ?? ''));
        sendToWorker({ type: 'reply', id: msg.id, text: reply.slice(0, 3500) });
        log('replied to ' + msg.id + ' (' + reply.length + ' chars)');
      } catch (e) {
        sendToWorker({ type: 'reply', id: msg.id, text: '[ERR] 执行失败: ' + ((e && e.message) || String(e)) });
      }
    }).catch(() => {});
  }

  function handleLine(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'ready') log('worker ready — WeChat ClawBot bridge online');
    else if (msg.type === 'log') log('worker: ' + msg.line);
    else if (msg.type === 'chat') { log('incoming WeChat message ' + msg.id); enqueueChat(msg); }
    else if (msg.type === 'fatal') log('FATAL from worker: ' + msg.message);
  }

  ctx.effect(() => () => { try { if (handle) handle.terminate(); } catch {} });

  (async () => {
    let nodeExe;
    try { nodeExe = await subprocess.resolveExecutable('node'); }
    catch { nodeExe = 'node'; }

    handle = subprocess.spawn({
      argv: [nodeExe, WORKER_PATH],
      cwd: WORKER_CWD,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 5000,
    });
    log('worker spawned pid=' + handle.pid);

    handle.stderr.setEncoding('utf8');
    handle.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) if (line.trim()) log('worker-err: ' + line);
    });
    handle.stdout.setEncoding('utf8');
    handle.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const raw = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (raw.trim()) handleLine(raw);
      }
    });
    handle.done.then((outcome) => {
      log('worker exited (code=' + outcome.exitCode + ', signal=' + outcome.signal + ')');
    }).catch((e) => log('worker spawn failed: ' + ((e && e.message) || e)));
    log('dsh-weixin-bot plugin applied — waiting for WeChat messages');
  })().catch((e) => {
    console.error('[wx-bot] START FAILED: ' + ((e && e.stack) || e));
  });
}

export { apply, inject, name };
