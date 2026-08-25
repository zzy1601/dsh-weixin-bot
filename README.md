# dsh-weixin-bot

微信 **ClawBot** 桥接插件：在手机微信里给机器人发消息，即可驱动本机 DeepSeek Harness（DSH）的**原生 Agent** 完成任务并自动回复结果。

```
手机微信 ⇄ 微信ClawBot(官方插件) ⇄ worker进程(weixin-agent-sdk) ⇄ stdio ⇄ 本插件 ⇄ 原生 DSH Agent
```

## 特性

- **多轮上下文**：同一微信聊天 = 同一 DSH Agent 会话，连续对话有记忆；发 `/new` 重置
- **过程可见**：任务执行中主动推送思考/工具进度（首次确认 ~8 秒，工具动态 ≥15 秒一条、思考进展 ≥30 秒一条、超 90 秒无动静发心跳），不再"发了就没音讯"
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

## 版本记录

- **0.6.1**（2026-08-25）：修复 `ask_user_question` 在桥接会话中**永久阻塞**的问题（微信里没有网页版的问题表单，Agent 会一直等待直到撞上超时上限）——现在 Agent 的提问实时转发到微信显示为编号选项，你的下一条回复自动作为答案回注（支持 `1.2` 编号、选项关键词或自由文本），3 分钟未回复自动选第一项继续；提示词同步引导模型非必要不提问
- **0.6.0**（2026-08-25）：**文件双向能力**——微信发来的图片/文件自动转存并告知 Agent 绝对路径（Agent 用文件工具读取处理）；Agent 回复中的 `[[send-file:路径]]` 指令会把文件经 CDN 传回微信（每条回复限 3 个）；新增 `/stop` 立即取消正在执行的任务；支持 cordis patch 配置覆盖 cwd/provider/model/超时/附件上限
- **0.5.0**（2026-08-25）：**重启不失忆**——会话映射持久化到 `~/.dsh/wxbot-state.json`，DSH 重启后自动 resume 原生会话（失败自动回退新会话）；**长回复分块发送**——超过 2000 字符的回复按段落/句子边界切成带序号的连续消息（不再截断丢内容）；每个桥接 Agent 自动应用 workspace-write 权限、关闭 plan mode、会话命名"微信"；`/new` 同步清除磁盘映射并释放旧 Agent
- **0.4.0**（2026-08-25）：不同微信会话**并行执行**（同会话内仍严格排队）；长任务上限提升到 15 分钟（worker 与 host 对齐），超时后完成的真实结果会主动补发；进度推送带内容摘录——💭 思考摘录、💬 模型中途叙述、🔧 工具参数预览；`/new` 正确释放旧 Agent；桥接 Agent 工作目录可经 `DSH_WX_CWD` 固定
- **0.3.0**：owner 白名单（首个发送者自动配对）、15 秒重放去重、回复 markdown 清理、/help /status 指令、worker 崩溃自动重启（指数退避）
- **0.2.0**（2026-08-24）：任务执行过程实时推送到微信；Agent 创建时加入默认 agent preset，完整工具集可用；270 秒兜底超时防单轮卡死堵队列；文件日志
- **0.1.0**：首个版本——微信 ClawBot ↔ 原生 DSH Agent 多轮桥接

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
