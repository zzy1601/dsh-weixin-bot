// dsh-weixin-bot — WeChat ClawBot bridge plugin for DeepSeek Harness (host side).
//
// 微信消息 → worker 进程（weixin-agent-sdk 轮询）→ stdio JSON-RPC → 本插件
// → ctx.agents.create() 创建原生 DSH Agent（同一微信会话复用同一 Agent = 多轮上下文）
// → followup 提交消息 → whenIdle 等待完成 → 提取最后 assistant 文本回传微信。
'use strict';
import fs from 'node:fs';
import os from 'node:os';
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

  // Mid-turn WeChat status pushes so the user can tell "still working" from
  // "dead". Cadence tuned for short agentic turns: ack ~5s, tool news ≥12s
  // apart, thinking news ≥25s apart, heartbeat ≥90s apart.
  const PROGRESS_ACK_MS = 5000;
  const PROGRESS_POLL_MS = 10000;
  const PROGRESS_TOOL_GAP_MS = 12000;
  const PROGRESS_THINK_GAP_MS = 25000;
  const PROGRESS_HEARTBEAT_MS = 90000;

  function log(line) {
    const text = '[wx-bot] ' + line;
    console.log(text);
    try {
      const dir = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      fs.appendFileSync(path.join(dir, 'wxbot-plugin.log'), new Date().toISOString() + ' ' + text + '\n');
    } catch {}
  }

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

  /**
   * Compose one created agent's world in factory setup: model selection plus
   * joining the default agent preset. Without the preset, web-profile agents
   * resolve against the empty global layer — no tools, prompt sections, or
   * skills (the UI mounts its sessions through this same machinery).
   */
  async function composeAgentWorld(agentCtx, selection) {
    installModelSelection(agentCtx, { current: selection, assembled: undefined });
    try {
      const presets = agentCtx.get('agentPresets');
      if (!presets || typeof presets.mount !== 'function') {
        log('preset join skipped: agentPresets service not visible from agent context');
        return;
      }
      const preset = await presets.mount(agentCtx);
      log('joined agent preset ' + ((preset && preset.id) || '(default)'));
    } catch (e) {
      log('preset join FAILED: ' + ((e && e.message) || e));
    }
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
      setup: (agentCtx) => composeAgentWorld(agentCtx, selection),
    });
    const agent = created.agent;
    await agent.whenIdle();
    entry = { agent };
    conversations.set(conversationId, entry);
    log('created native agent ' + sessionId + ' for conversation ' + conversationId);
    return entry;
  }

  /** Fold one live session event into the turn's progress counters. */
  function observeTurnEvent(state, event) {
    const type = event && event.type;
    if (type === 'tool/call') {
      state.toolCount += 1;
      state.lastTool = (event.data && event.data.name) || '';
    } else if (type === 'assistant/message') {
      try {
        const blocks = ((event.data && event.data.message) || {}).content || [];
        const hasText = blocks.some((b) => b && b.type === 'text' && String(b.text || '').trim() !== '');
        if (!hasText && blocks.length > 0) state.thinkSegs += 1;
      } catch {}
    }
  }

  function sendStatus(conversationId, text) {
    sendToWorker({ type: 'status', conversationId, text });
  }

  /** Periodic status pushes for one in-flight turn until stopProgress(). */
  function startProgress(entry, conversationId) {
    const state = {
      startedAt: Date.now(),
      done: false,
      toolCount: 0,
      lastTool: '',
      thinkSegs: 0,
      ackSent: false,
      reportedTools: 0,
      reportedThinks: 0,
      lastSentAt: Date.now(),
    };
    entry.progress = state;
    const push = (text) => { sendStatus(conversationId, text); state.lastSentAt = Date.now(); };
    const timer = setInterval(() => {
      if (state.done) return;
      const now = Date.now();
      const elapsed = now - state.startedAt;
      if (!state.ackSent) {
        if (elapsed >= PROGRESS_ACK_MS) { push('🤔 收到，正在思考中…'); state.ackSent = true; }
        return;
      }
      if (state.toolCount > state.reportedTools && now - state.lastSentAt >= PROGRESS_TOOL_GAP_MS) {
        push('🔧 工具调用 ×' + state.toolCount + (state.lastTool ? '（' + state.lastTool + '）' : '') + '，执行中…');
        state.reportedTools = state.toolCount;
        return;
      }
      if (state.thinkSegs > state.reportedThinks && now - state.lastSentAt >= PROGRESS_THINK_GAP_MS) {
        push('💭 已输出 ' + state.thinkSegs + ' 段思考，继续推理中…');
        state.reportedThinks = state.thinkSegs;
        return;
      }
      if (now - state.lastSentAt >= PROGRESS_HEARTBEAT_MS) {
        const mins = Math.floor(elapsed / 60000);
        push('⏳ 任务较大，仍在运行（已 ' + (mins >= 1 ? mins + ' 分钟' : Math.round(elapsed / 1000) + ' 秒') + '）…');
      }
    }, PROGRESS_POLL_MS);
    state.timer = timer;
    return state;
  }

  function stopProgress(entry) {
    const state = entry.progress;
    if (!state) return;
    state.done = true;
    clearInterval(state.timer);
    entry.progress = undefined;
  }

  async function runChatTurn(conversationId, text) {
    if (text.trim() === '/new') {
      conversations.delete(conversationId);
      return '[OK] 已重置当前微信会话的 DSH 上下文。';
    }
    log('turn start conv=' + conversationId + ' text=' + String(text).slice(0, 60));
    const entry = await ensureConversation(conversationId);
    const seqBefore = entry.agent.session.seq;
    log('agent ready seq=' + seqBefore + ', submitting followup');
    startProgress(entry, conversationId);
    try {
      entry.agent.followup(createUserMessage(text));
      // Hard cap so one stuck turn cannot block the whole message queue
      // (worker gives up on a chat id after 5 minutes).
      await Promise.race([
        entry.agent.whenIdle(),
        new Promise((resolve) => {
          const t = setTimeout(resolve, 270000);
          if (t.unref) t.unref();
        }),
      ]);
      log('whenIdle settled (or 270s cap hit)');
    } finally {
      stopProgress(entry);
    }
    try { await sessions.flush(entry.agent.session); } catch {}
    log('flush done');
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

  /** Boot-time probe: does a registry-created agent on THIS instance get tools? */
  async function runSelfTest() {
    const started = Date.now();
    try {
      const selection = defaultModel.currentSelection();
      if (!selection || !selection.provider || !selection.model) return log('SELFTEST skipped: no model selection');
      const sessionId = 'session-wx-selftest-' + Date.now();
      const created = await agents.create({
        sessionId,
        meta: { cwd: sandboxPolicy.workspaceRoot },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => composeAgentWorld(agentCtx, selection),
      });
      const agent = created.agent;
      await agent.whenIdle();
      const seqBefore = agent.session.seq;
      agent.followup(createUserMessage('调用工具执行命令 echo BOOTTEST-123 并原样报告输出，完成后立即结束本轮。'));
      await Promise.race([
        agent.whenIdle(),
        new Promise((r) => { const t = setTimeout(r, 120000); if (t.unref) t.unref(); }),
      ]);
      let toolUsed = false;
      try {
        for (const e of agent.session.events) if ((e.seq ?? 0) >= seqBefore && e.type === 'tool/call') toolUsed = true;
      } catch {}
      const text = summarize(agent.session.events, seqBefore);
      log('SELFTEST done in ' + Math.round((Date.now() - started) / 1000) + 's: toolUsed=' + toolUsed +
        ' reason=' + ((text.reason && text.reason.kind) || '?') +
        ' reply="' + String(text.text || '').slice(0, 100) + '"');
      try { if (typeof created.dispose === 'function') await created.dispose(); } catch {}
    } catch (e) {
      log('SELFTEST FAILED: ' + ((e && e.message) || e));
    }
  }

  function handleLine(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'ready') log('worker ready — WeChat ClawBot bridge online');
    else if (msg.type === 'log') log('worker: ' + msg.line);
    else if (msg.type === 'chat') { log('incoming WeChat message ' + msg.id); enqueueChat(msg); }
    else if (msg.type === 'fatal') log('FATAL from worker: ' + msg.message);
  }

  ctx.effect(() => () => { try { if (handle) handle.terminate(); } catch {} });

  // Live feed: route each in-flight turn's session events into its progress
  // counters (session.events is a frozen one-shot snapshot, so observing is
  // the only way to see events mid-turn).
  try {
    ctx.on('session/event', (session, event) => {
      for (const entry of conversations.values()) {
        if (entry.progress && entry.agent && entry.agent.session === session) {
          observeTurnEvent(entry.progress, event);
        }
      }
    });
  } catch (e) {
    log('session/event observer unavailable, progress pushes disabled: ' + ((e && e.message) || e));
  }

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
    const st = setTimeout(() => { runSelfTest().catch(() => {}); }, 20000);
    if (st.unref) st.unref();
  })().catch((e) => {
    console.error('[wx-bot] START FAILED: ' + ((e && e.stack) || e));
  });
}

export { apply, inject, name };
