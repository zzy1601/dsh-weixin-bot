# dsh-weixin-bot

微信 **ClawBot** 桥接插件：在手机微信里给机器人发消息，即可驱动本机 DeepSeek Harness（DSH）的**原生 Agent** 完成任务并自动回复结果。

```
手机微信 ⇄ 微信ClawBot(官方插件) ⇄ worker进程(weixin-agent-sdk) ⇄ stdio ⇄ 本插件 ⇄ 原生 DSH Agent
```

## 特性

- **多轮上下文**：同一微信聊天 = 同一 DSH Agent 会话，连续对话有记忆；发 `/new` 重置
- **原生集成**：通过 `ctx.agents.create()` 创建真正的 DSH Agent（工具、沙箱、持久化全量可用）
- **随 DSH 启动加载**：安装器把插件注册进 profile 的 `cordis.patch.yml`，无需手动干预
- **可观察**：worker 全程自写日志（`worker/.wx-worker.log`）

## 前置条件

- Windows + 已运行的 DSH（web profile）
- 手机微信支持 ClawBot 插件（微信「我 → 设置 → 插件」可见「微信ClawBot」，或扫码时自动触发）
- Node.js ≥ 22

## 安装

```cmd
git clone https://github.com/zzy1601/dsh-weixin-bot.git
cd dsh-weixin-bot
node scripts/setup.cjs
```

setup 会：
1. 安装 `weixin-agent-sdk` 依赖到包目录
2. 往 `%DSH_HOME%\profiles\web\cordis.patch.yml` 追加受管的 insert row（幂等，带备份）

## 首次登录（扫码）

双击 `scripts\login.cmd` → 终端出现二维码（48 秒有效）→ 手机微信「扫一扫」。

成功后微信通讯录出现「微信ClawBot」联系人；凭证保存在 `~/.openclaw/`，后续开机免登录。

## 使用

重启 DSH 后，微信里直接发消息：

```
查看当前电脑时间和 C 盘剩余空间
列出桌面上的文件
帮我重启一下 sshd 服务
```

| 指令 | 作用 |
|------|------|
| `/new` | 重置该微信会话的 DSH 上下文 |

单条任务最长处理 5 分钟；回复截断至约 3500 字符。

## 卸载

```cmd
node scripts/setup.cjs --remove
```

重启 DSH 生效。

## 发布到 GitHub

```cmd
node scripts/publish-github.cjs --token <GitHub PAT> [--repo <owner>/dsh-weixin-bot] [--public] [--proxy http://127.0.0.1:7897]
```

## 安全须知

- 微信消息会以用户身份驱动本机 Agent 执行任务——**等同于远程 RCE**。请仅绑定自己的微信号
- 非微信官方项目，存在账号风控风险，自行评估
- 凭证存于 `~/.openclaw/`，泄露等同暴露本机控制权

## License

MIT
