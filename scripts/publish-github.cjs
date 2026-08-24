#!/usr/bin/env node
/**
 * dsh-weixin-bot GitHub 一键发布脚本
 *
 * 网络自适应：
 *   - api.github.com 可达 → 自动创建仓库 + Release
 *   - api.github.com 被墙 → 提示手动在网页建仓，然后纯 git push（git 协议通常不被封）
 *   - git push 默认直连 github.com；若被墙可加 --proxy http://127.0.0.1:7897
 *
 * 用法：
 *   node scripts/publish-github.cjs --token <gh_pat> [--repo zzy1601/dsh-weixin-bot] [--public] [--proxy http://127.0.0.1:7897]
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
function argVal(n) { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; }
const token = argVal('--token') || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
let repo = argVal('--repo');
const proxy = argVal('--proxy');
const isPublic = args.includes('--public');
const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
const tag = 'v' + version;
if (!token) fail('缺少 --token <GitHub PAT>，或设置环境变量 GH_TOKEN');
const ROOT = path.resolve(__dirname, '..');

function api(method, urlPath, body) {
  return execSync(
    `curl -sS -X ${method} --max-time 25 --noproxy "*" -H "User-Agent: dsh-weixin-bot-publisher" -H "Authorization: Bearer ${token}" -H "Accept: application/vnd.github+json" ${body ? `-d @- ` : ''}"https://api.github.com${urlPath}"`,
    { input: body, encoding: 'utf8', windowsHide: true, timeout: 40000 },
  );
}
function git(cmd) {
  const proxyArg = proxy ? `-c http.proxy=${proxy} ` : '';
  return execSync(`git ${proxyArg}${cmd}`, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 300000 });
}
function fail(m) { console.error('ERROR:', m); process.exit(1); }

async function main() {
  // 1. 账号（API 可达时自动获取；不可达要求 --repo）
  let userLogin = null;
  try {
    const u = JSON.parse(api('GET', '/user'));
    userLogin = u.login || null;
  } catch {}
  if (!userLogin && !repo) {
    fail('api.github.com 不可达且未提供 --repo。请在手机/其他网络创建空仓库后传入 --repo <owner>/dsh-weixin-bot');
  }
  if (!repo) repo = `${userLogin}/dsh-weixin-bot`;
  console.log('仓库:', repo);

  // 2. 创建仓库（API 可达时；已存在/不可达则跳过）
  let apiOk = false;
  try {
    const created = JSON.parse(api('POST', '/user/repos', JSON.stringify({
      name: repo.split('/')[1],
      description: 'WeChat ClawBot bridge plugin for DeepSeek Harness (DSH) — chat with a native DSH agent from WeChat',
      private: !isPublic,
    })));
    if (created.full_name) { console.log('已创建:', created.html_url); apiOk = true; }
    else if (JSON.stringify(created.errors || '').includes('already_exists')) { console.log('仓库已存在'); apiOk = true; }
  } catch (e) {
    console.log('API 不可达（' + String(e).slice(0, 80) + '），跳过自动建仓——请确认仓库已在网页上创建');
  }

  // 3. 推送
  const full = repo;
  try { git('remote remove origin'); } catch {}
  git(`remote add origin https://${token}@github.com/${full}.git`);
  try { git(`add -A`); git(`commit -m "release ${tag}"`); } catch {}
  git(`push -u origin HEAD`);
  try { git(`tag ${tag}`); } catch {}
  try { git(`push origin ${tag}`); } catch {}
  git(`remote set-url origin https://github.com/${full}.git`);

  // 4. Release（API 可达时）
  if (apiOk) {
    try {
      const rel = JSON.parse(api('POST', `/repos/${full}/releases`, JSON.stringify({
        tag_name: tag,
        name: `dsh-weixin-bot ${tag}`,
        body: 'WeChat ClawBot bridge plugin for DSH.\n\nInstall:\n```\ngit clone https://github.com/' + full + '.git\ncd dsh-weixin-bot\nnode scripts/setup.cjs\n```\nThen scan the QR code via scripts\\login.cmd and restart DSH.',
        draft: false, prerelease: false,
      })));
      if (rel.html_url) console.log('Release:', rel.html_url);
    } catch {}
  }

  console.log('\n====== 发布完成 ======');
  console.log(`仓库: https://github.com/${full}`);
  console.log(`他机安装:\n  git clone https://github.com/${full}.git\n  cd dsh-weixin-bot\n  npm install --prefix . weixin-agent-sdk@0.5.0\n  node scripts/setup.cjs\n  scripts\\login.cmd 扫码 → 重启 DSH`);
}

main().catch((e) => fail(e.message));
