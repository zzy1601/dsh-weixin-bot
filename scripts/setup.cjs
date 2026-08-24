#!/usr/bin/env node
/**
 * dsh-weixin-bot 插件安装器（setup.cjs）
 *
 * 把「微信 ClawBot → DSH 原生 Agent」桥接部署到本机 DSH：
 *   1. 安装 weixin-agent-sdk 依赖到包目录（--no-deps 跳过）
 *   2. 往 ~/.dsh/profiles/web/cordis.patch.yml 追加 insert row（幂等，
 *      file:// URL 指向本包 lib/index.mjs；DSH 启动即自动加载）
 *   3. 提示微信扫码登录（scripts/login.cmd，凭证存 ~/.openclaw）
 *
 * 用法：
 *   node setup.cjs                # 安装 / 重装（幂等）
 *   node setup.cjs --check        # 只校验不修改
 *   node setup.cjs --remove       # 卸载（移除 patch row）
 *   node setup.cjs --profile web  # 指定 profile（默认 web）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { execSync } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const MARK = 'dsh-weixin-bot-plugin';
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const doRemove = args.includes('--remove');
const noDeps = args.includes('--no-deps');
const pIdx = args.indexOf('--profile');
const profileName = pIdx >= 0 ? args[pIdx + 1] : 'web';
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', profileName);
const PATCH_FILE = path.join(PROFILE_DIR, 'cordis.patch.yml');

function log(m) { console.log(m); }
function fail(m) { console.error('ERROR:', m); process.exit(1); }

function buildRow() {
  const entryUrl = pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'index.mjs')).href;
  return [
    '# [' + MARK + '] auto-managed — do not edit between markers',
    '# [dsh-weixin-bot-plugin:begin]',
    '- insert:',
    '    - id: weixin-bot',
    '      name: ' + JSON.stringify(entryUrl),
    '# [dsh-weixin-bot-plugin:end]',
  ].join('\n');
}

/** Idempotently ensure the managed block inside the profile patch file. */
function upsertPatch() {
  if (!fs.existsSync(PATCH_FILE)) {
    fs.writeFileSync(PATCH_FILE, '# dsh profile root\n' + buildRow() + '\n');
    log('已创建并写入: ' + PATCH_FILE);
    return;
  }
  const s = fs.readFileSync(PATCH_FILE, 'utf8');
  if (s.includes(MARK)) { log('patch row 已存在，跳过'); return; }
  let out = s.replace(/\s*$/, '');
  // 文件若为空数组占位 "[]" 则清空后再追加
  if (out.trim() === '[]') out = '';
  out += '\n\n' + buildRow() + '\n';
  fs.copyFileSync(PATCH_FILE, PATCH_FILE + '.bak_wxbot_' + Date.now());
  fs.writeFileSync(PATCH_FILE, out);
  log('已追加 patch row（备份 .bak_wxbot_*）: ' + PATCH_FILE);
}

function removePatch() {
  if (!fs.existsSync(PATCH_FILE)) { log('patch 文件不存在'); return; }
  const s = fs.readFileSync(PATCH_FILE, 'utf8');
  if (!s.includes(MARK)) { log('无托管块，无需删除'); return; }
  const out = s.replace(/\n?# \[dsh-weixin-bot-plugin:begin\][\s\S]*?# \[dsh-weixin-bot-plugin:end\]/, '');
  fs.writeFileSync(PATCH_FILE, out);
  log('已移除 patch row: ' + PATCH_FILE);
}

function checkDeps() {
  const sdkPath = path.join(PLUGIN_ROOT, 'node_modules', 'weixin-agent-sdk', 'dist', 'index.mjs');
  const ok = fs.existsSync(sdkPath);
  log('weixin-agent-sdk: ' + (ok ? 'OK' : '未安装'));
  return ok;
}

function installDeps() {
  if (checkDeps()) return;
  log('安装 weixin-agent-sdk 到包目录...');
  execSync('npm install --omit=dev --no-audit --no-fund weixin-agent-sdk@0.5.0', {
    cwd: PLUGIN_ROOT, stdio: 'inherit', windowsHide: true, timeout: 300000,
  });
  if (!checkDeps()) fail('依赖安装失败，请手动执行: npm install --prefix "' + PLUGIN_ROOT + '" weixin-agent-sdk');
}

/* ─────────────── 主流程 ─────────────── */
log(`── dsh-weixin-bot ${checkOnly ? '检查' : doRemove ? '卸载' : '安装'} ──`);

if (!fs.existsSync(path.join(PLUGIN_ROOT, 'lib', 'index.mjs'))) fail('插件文件缺失：' + PLUGIN_ROOT);
if (!fs.existsSync(PATCH_FILE) && !doRemove) {
  log('提示: profile cordis.patch.yml 不存在，将自动创建 (' + PATCH_FILE + ')');
}

if (doRemove) {
  removePatch();
  log('卸载完成。重启 DSH 生效。');
  process.exit(0);
}

if (checkOnly) {
  const s = fs.existsSync(PATCH_FILE) ? fs.readFileSync(PATCH_FILE, 'utf8') : '';
  log('patch row: ' + (s.includes(MARK) ? 'OK' : '未安装'));
  checkDeps();
  log('微信登录凭证: ' + (fs.existsSync(path.join(os.homedir(), '.openclaw', 'openclaw-weixin', 'accounts.json')) ? 'OK' : '未登录（运行 scripts/login.cmd）'));
} else {
  if (!noDeps) installDeps();
  upsertPatch();
  log('');
  log('安装完成。接下来：');
  log('  1. 首次使用先扫码登录：双击 scripts\\login.cmd（手机微信扫码，48 秒有效）');
  log('  2. 重启 DSH（插件随启动加载）');
  log('  3. 微信里给「微信ClawBot」发消息即可驱动 DSH；发送 /new 重置会话上下文');
}
