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
  // Per-conversation serialization: chats run in parallel across conversations,
  // while turns inside one conversation stay strictly ordered.
  const convQueues = new Map();
  const startedAt = Date.now();
  let stopping = false;
  let restartCount = 0;

  // Mid-turn WeChat status pushes so the user can tell "still working" from
  // "dead". Cadence tuned for short agentic turns: ack ~5s, tool news ≥12s
  // apart, thinking news ≥25s apart, heartbeat ≥90s apart.
  const PROGRESS_ACK_MS = 5000;
  const PROGRESS_POLL_MS = 10000;
  const PROGRESS_TOOL_GAP_MS = 12000;
  const PROGRESS_THINK_GAP_MS = 25000;
  const PROGRESS_HEARTBEAT_MS = 90000;
  // Long tasks are legitimate now that agents execute real tools. The worker
  // waits 15 minutes before given up; the host caps slightly below that.
  const TURN_CAP_MS = 14 * 60 * 1000;
  /** Working directory pinned for bridge agents (System32 is not a home). */
  const BRIDGE_CWD = process.env.DSH_WX_CWD || sandboxPolicy.workspaceRoot || os.homedir();

  // ── durable conversation→session mapping ──────────────────────────────
  // Lives outside the package dir so reinstalls don't wipe it. Atomic write
  // (tmp+rename) because the file is read on every plugin start.
  const STATE_FILE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'wxbot-state.json');
  function loadState() {
    try {
      const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (d && typeof d.chats === 'object' && d.chats !== null) return d;
    } catch {}
    return { chats: {} };
  }
  const wxState = loadState();
  function saveState() {
    try {
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(wxState, null, 2));
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) { log('state save failed: ' + ((e && e.message) || e)); }
  }

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

  /** Per-session polish applied to every bridge agent (best effort). */
  function polishAgent(agent) {
    try { ctx.get('permissionPresets')?.set?.(agent.session, 'workspace-write'); } catch {}
    try { agent.ctx?.get?.('planMode')?.set?.(agent, false); } catch {}
    try { ctx.get('sessionTitle')?.rename?.(agent.session, '微信'); } catch {}
  }

  async function createAgentFresh(selection) {
    const sessionIdStr = 'session-wx-' + Date.now() + '-' + sessionCounter++;
    const created = await agents.create({
      sessionId: sessionIdStr,
      meta: { cwd: BRIDGE_CWD },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => composeAgentWorld(agentCtx, selection),
    });
    return { created, sessionIdStr };
  }

  /**
   * One persistent native Agent per WeChat conversation. Survives host
   * restarts: the conversation→session mapping is persisted, and on startup
   * the session is resumed (falling back to a fresh agent if resume fails).
   * NOTE: never touch agent.session.events here — that getter caches a
   * one-shot snapshot and summarize() needs the post-turn view.
   */
  async function ensureConversation(conversationId) {
    let entry = conversations.get(conversationId);
    if (entry) return entry;
    const selection = defaultModel.currentSelection();
    if (!selection || !selection.provider || !selection.model) throw new Error('no default model selection');
    const persisted = wxState.chats[conversationId];
    let created;
    if (persisted) {
      const live = agents.get(persisted);
      if (live) {
        // Owned by another consumer (e.g., web UI): attach without teardown.
        created = { agent: live, dispose: undefined };
        log('attached to live agent ' + persisted + ' seq=' + live.session.seq);
      } else {
        try {
          created = await agents.resume({
            resumeSessionId: persisted,
            agentOptions: { provider: selection.provider, model: selection.model },
            setup: (agentCtx) => composeAgentWorld(agentCtx, selection),
          });
          log('resumed session ' + persisted + ' seq=' + created.agent.session.seq);
        } catch (e) {
          log('resume failed (' + ((e && e.message) || e) + '), starting fresh');
          delete wxState.chats[conversationId];
          saveState();
          created = await createAgentFresh(selection);
        }
      }
    } else {
      created = await createAgentFresh(selection);
    }
    const agent = created.agent;
    await agent.whenIdle();
    entry = { agent, owner: typeof created.dispose === 'function' ? created : undefined };
    conversations.set(conversationId, entry);
    if (!persisted) {
      wxState.chats[conversationId] = created.sessionIdStr;
      saveState();
    }
    polishAgent(agent);
    log('ready conversation ' + conversationId + ' (session ' + (persisted || created.sessionIdStr) + ')');
    return entry;
  }

  /** Fold one live session event into the turn's progress counters. */
  function firstLine(text, max) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function observeTurnEvent(state, event) {
    const type = event && event.type;
    if (type === 'tool/call') {
      state.toolCount += 1;
      state.lastTool = (event.data && event.data.name) || '';
      let args = (event.data && event.data.arguments) ?? '';
      if (typeof args === 'object') { try { args = JSON.stringify(args); } catch { args = String(args); } }
      state.lastToolArg = firstLine(String(args), 70);
    } else if (type === 'assistant/message') {
      try {
        const blocks = ((event.data && event.data.message) || {}).content || [];
        const textOf = (b) => String(b.text ?? b.thinking ?? '');
        const reasoning = blocks.filter((b) => b && b.type === 'reasoning').map(textOf).join('');
        const plain = blocks.filter((b) => b && b.type === 'text').map(textOf).join('');
        if (reasoning.trim()) { state.thinkSegs += 1; state.lastThinkExcerpt = reasoning; }
        if (plain.trim()) { state.textSegs += 1; state.lastTextExcerpt = plain; }
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
      lastToolArg: '',
      thinkSegs: 0,
      lastThinkExcerpt: '',
      textSegs: 0,
      lastTextExcerpt: '',
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
        const arg = state.lastToolArg ? '：' + state.lastToolArg : '';
        push('🔧 工具调用 ×' + state.toolCount + '（' + state.lastTool + arg + '）执行中…');
        state.reportedTools = state.toolCount;
        return;
      }
      if (state.thinkSegs > state.reportedThinks && now - state.lastSentAt >= PROGRESS_THINK_GAP_MS) {
        const excerpt = firstLine(state.lastThinkExcerpt, 80);
        push('💭 思考中' + (excerpt ? '：' + excerpt : '…'));
        state.reportedThinks = state.thinkSegs;
        return;
      }
      // Interim narration from the model ("我先查看目录结构…") is progress too.
      if (state.textSegs > state.reportedTextSegs && now - state.lastSentAt >= PROGRESS_THINK_GAP_MS) {
        const excerpt = firstLine(state.lastTextExcerpt, 80);
        if (excerpt) { push('💬 ' + excerpt); state.reportedTextSegs = state.textSegs; return; }
      }
      if (now - state.lastSentAt >= PROGRESS_HEARTBEAT_MS) {
        const mins = Math.floor(elapsed / 60000);
        push('⏳ 任务较大，仍在运行（已 ' + (mins >= 1 ? mins + ' 分钟' : Math.round(elapsed / 1000) + ' 秒') + '，完成后再发结果）…');
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
    const cmd = text.trim();
    if (cmd === '/new') {
      const entry = conversations.get(conversationId);
      conversations.delete(conversationId);
      if (wxState.chats[conversationId]) { delete wxState.chats[conversationId]; saveState(); }
      if (entry) {
        try { if (entry.owner && typeof entry.owner.dispose === 'function') await entry.owner.dispose(); } catch {}
        log('disposed agent for conversation ' + conversationId);
      }
      return '[OK] 已重置当前微信会话的 DSH 上下文。';
    }
    if (cmd === '/help' || cmd === '/start') {
      return [
        '🤖 dsh-weixin-bot 指令',
        '/new — 重置本会话的 DSH 上下文',
        '/status — 查看运行状态',
        '/help — 显示本帮助',
        '其他任意文本都会交给 DSH Agent 执行（可多轮对话）。',
      ].join('\n');
    }
    if (cmd === '/status') {
      const mins = Math.floor((Date.now() - startedAt) / 60000);
      const convList = Array.from(conversations.keys());
      return [
        '📊 dsh-weixin-bot 运行中 ' + mins + ' 分钟',
        '活跃 DSH 会话: ' + conversations.size + ' 个' + (convList.length ? '（' + convList.join(', ').slice(0, 120) + '）' : ''),
        'workspace: ' + (sandboxPolicy.workspaceRoot || '(未知)'),
      ].join('\n');
    }
    log('turn start conv=' + conversationId + ' text=' + String(text).slice(0, 60));
    const entry = await ensureConversation(conversationId);
    const seqBefore = entry.agent.session.seq;
    log('agent ready seq=' + seqBefore + ', submitting followup');
    startProgress(entry, conversationId);
    try {
      entry.agent.followup(createUserMessage(text));
      // Hard cap so one stuck turn cannot hold its conversation forever; the
      // worker waits even longer, and heartbeats keep the user informed.
      await Promise.race([
        entry.agent.whenIdle(),
        new Promise((resolve) => {
          const t = setTimeout(resolve, TURN_CAP_MS);
          if (t.unref) t.unref();
        }),
      ]);
      log('whenIdle settled (or ' + Math.round(TURN_CAP_MS / 60000) + 'min cap hit)');
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
    const convId = String(msg.conversationId || 'default');
    const prev = convQueues.get(convId) || Promise.resolve();
    const next = prev.then(async () => {
      try {
        const reply = await runChatTurn(convId, String(msg.text ?? ''));
        // Full text: the worker splits long replies into sequential chunks.
        sendToWorker({ type: 'reply', id: msg.id, text: reply.slice(0, 60000) });
        log('replied to ' + msg.id + ' (' + reply.length + ' chars)');
      } catch (e) {
        sendToWorker({ type: 'reply', id: msg.id, text: '[ERR] 执行失败: ' + ((e && e.message) || String(e)) });
      }
    }).catch(() => {});
    convQueues.set(convId, next);
    next.then(() => { if (convQueues.get(convId) === next) convQueues.delete(convId); });
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

  ctx.effect(() => () => { stopping = true; try { if (handle) handle.terminate(); } catch {} });

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

  function attachWorkerPipe(h) {
    h.stderr.setEncoding('utf8');
    h.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) if (line.trim()) log('worker-err: ' + line);
    });
    h.stdout.setEncoding('utf8');
    h.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const raw = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (raw.trim()) handleLine(raw);
      }
    });
    h.done.then((outcome) => {
      log('worker exited (code=' + outcome.exitCode + ', signal=' + outcome.signal + ')');
      if (stopping) return;
      // Auto-heal: crash-restart with capped exponential backoff. Even a clean
      // exit restarts — the WeChat monitor must never stay down.
      if (restartCount < 5) {
        const delay = Math.min(30000, 2000 * Math.pow(2, restartCount++));
        log('auto-restarting worker in ' + delay + 'ms (attempt ' + restartCount + '/5)');
        const t = setTimeout(() => { spawnWorker().catch((e) => log('restart failed: ' + ((e && e.message) || e))); }, delay);
        if (t.unref) t.unref();
      } else {
        log('worker keeps dying; giving up until plugin restart');
      }
    }).catch((e) => log('worker spawn failed: ' + ((e && e.message) || e)));
  }

  function spawnWorker() {
    return (async () => {
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
      attachWorkerPipe(handle);
    })();
  }

  (async () => {
    await spawnWorker();
    log('dsh-weixin-bot plugin applied — waiting for WeChat messages');
    const st = setTimeout(() => { runSelfTest().catch(() => {}); }, 20000);
    if (st.unref) st.unref();
  })().catch((e) => {
    console.error('[wx-bot] START FAILED: ' + ((e && e.stack) || e));
  });
}

export { apply, inject, name };
