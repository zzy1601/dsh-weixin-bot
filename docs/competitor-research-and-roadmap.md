# dsh-weixin-bot 竞品调研与优化方案

> 调研日期：2026-08-25。对象为 GitHub 上同领域（微信 ↔ DeepSeek Harness 桥接）的三个竞品插件，
> 以及通用微信机器人生态的代表性设计。结论按「差距 → 借鉴 → 路线图」组织。

## 一、竞品矩阵

| 能力 | 本插件 zzy1601<br>v0.4.0 | wendayuan<br>dsh-weixin | xiaoshihou514<br>dsh-weixin | xmanrui<br>dsh-weixin |
|---|---|---|---|---|
| 底层通道 | weixin-agent-sdk（子进程隔离） | 同 SDK（进程内直跑） | 自研 TS iLink 客户端（编译分发） | 自研 iLink 客户端 v2.4.6 + Web 配置页 |
| 思考/工具进度实时推送 | ✅ 摘录式（独有） | ❌ | ❌（仅分块回复） | ❌ |
| 会话级并行队列 | ✅ | ❌（串行天然） | ✅ | ？ |
| 长任务上限 + 迟到结果补发 | ✅ 14/15min | ❌ | ✅ outbox 至少一次投递 | ？ |
| 文件/图片收发 | ❌ | ❌ | ✅ 双向（自研 CDN 加解密、AES、MIME 表） | ？ |
| 群聊支持 | ❌ 仅单 owner | ❌ | ✅ allowedGroups × allowedUsers 双维校验 | ？ |
| 会话映射重启持久化 | ❌ 重启即失忆 | ❌ 重启即失忆 | ✅ chats 映射 + iLink cursor + contextTokens 全持久化 | 部分（原子写配置存储） |
| 长回复处理 | 截断到 3500 字符（丢内容） | 不处理 | ✅ 可重试分块发送 + outbox 断点续传 | ？ |
| 配置机制 | 环境变量 + 隐式 | ✅ cordis Schema（cwd/provider/model 可覆盖） | cordis patch + CLI + 登录长轮询修复 | npx 安装器 + Web UI 页面 |
| 安全 | owner 白名单 + 15s 重放去重 | 无白名单（边界=微信号本身） | 群×用户双维白名单、90s 请求期限、2MiB 响应上限、拒绝重定向 | 配置哈希原子写 |
| 取消正在运行的任务 | ❌ | ❌ | ✅ /stop | ？ |
| 测试 | 无 | 无 | vitest 套件 + 设计文档库（12 篇） | 无 |

## 二、关键洞察

1. **"进度可见"是我们的差异化壁垒**：四家竞品中只有我们做执行过程实时推送，且已验证可用。
   后续迭代不应削弱这一点，而应让它覆盖更多事件类型。
2. **最大的落后项是「持久化」**：两家竞品把 conversation→session 映射、iLink 游标、context token
   持久化到磁盘。我们 DSH 一重启，微信侧全部会话"失忆"（session 文件还在但映射丢失），
   且 worker 重启后 sendMessage 因缺少 context token 而不可用，直到用户再次来消息。
3. **第二落后项是「媒体能力」**：xiaoshihou514 实现了完整的微信 CDN 加解密收发（图片/语音/文件/视频，
   AES 密钥 + padding 规则 + MIME 表）。我们的 SDK 类型定义显示 `ChatResponse.media` 与
   `ChatRequest.media` 都是现成接口——至少 outbound 文件回传是低垂果实。
4. **截断 ≠ 分块**：我们 3500 字符硬截断会静默丢失内容；正确做法是分块顺序发送 + 发送状态落盘
   （outbox 模式），崩溃后从断点续传，宁可重复不可丢失。
5. **配置应当走 cordis Schema**：wendayuan 的做法（cwd/provider/model 可在 profile patch 里覆盖）
   是 dsh 插件的正规姿势；环境变量方式无法被其他用户的部署复用。
6. **架构选择（子进程隔离）保留**：wendayuan 进程内直跑更简单，但 SDK 崩溃会波及宿主；
   我们的 worker 子进程 + 自动重启 + stdio 协议在长期运行稳定性上更优，维持现状。

## 三、优化路线图

### v0.5.0 —— 可靠性补课（优先级最高，工作量小）

1. **会话映射持久化**：conversation→sessionId 写入包根 `state.json`（原子写：tmp+rename），
   启动时恢复；`/new` 时同时清除映射与磁盘记录。
2. **长回复分块**：超过 3500 字符的回复按 ≤2000 字符切块顺序发送（块间 300ms 防风控），
   结尾标注 `(2/3)`；彻底移除截断逻辑。
3. **context token 持久化**：worker 把最近 context token 存入 state，重启后无需等新消息即可主动推送。

### v0.6.0 —— 能力扩展

4. **outbound 文件回传**：Agent 产出文件（交付物/生成物）时经 `ChatResponse.media` 回传微信；
   先支持单文件，路径取自 turn 内 tool 结果里的绝对路径启发式识别。
5. **inbound 图片透传**：`ChatRequest.media`（图片）转存后以附件形式注入 Agent 消息。
6. **cordis Schema 配置化**：cwd / provider / model / 各节流参数 / owner 列表迁移到 Config schema，
   兼容现有 config.json 自动迁移。
7. **/stop 取消**：接入 Agent 的中止信号，终止当前轮次并回复"已停止"。

### v0.7.0 —— 群聊与工程质量

8. **群聊白名单**（allowedGroups × allowedUsers 双维校验，参考 xiaoshihou514 的越权语义：
   群 ID 授权不等于群成员全授权）。
9. **wire 防御**：请求 90s 期限、响应体上限、重定向拒绝（若自研协议则直接实现；SDK 模式下
   在 worker 层做等效限制）。
10. **vitest 测试**：mdToPlain、去重窗口、分块器、state 原子写的单元测试先行。
11. **安装方式正规化**：发布 npm 包或支持 `dsh plugin --profile web add github:zzy1601/dsh-weixin-bot`
    （weixin-agent-sdk 进 dependencies），setup.cjs 降级为兼容入口。

### 远期备选（不承诺）

- Web 配置页（xmanrui 模式：ModuleLoader 往 dsh web 注入登录/配置页）。
- 语音输入（media kind=voice，ASR 转文字进 Agent）。
- 多账号（config.owners 已是列表，天然可扩）。

## 四、风险与取舍

- **微信风控**：分块发送的块间延迟、消息频率上限要保守；所有主动推送必须跟随一条真实来消息
  （context token 机制天然约束了这一点）。
- **SDK 协议变动**：weixin-agent-sdk 是社区包，iLink 协议版本升级可能破坏兼容；锁定版本 +
  SELFTEST 自检能在启动时尽早暴露。
- **持久化的安全边界**：state.json 含 context token（等同会话劫持能力），文件权限收紧到 0600，
  并纳入 .gitignore（教训来自 config.json 曾被误提交）。
