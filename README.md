# dsh-ferry

在彼此可达的 DSH 实例之间推送 / 拉取会话（Session），并连同工作区文件一起流转，让同一件工作可以在另一台机器上继续。

- **推送**：把本机会话 + 它需要的工作区文件送到对端，对端可直接继续。
- **拉取**：从对端挑选会话拉回本机。
- **不处理网络**：插件假设实例之间已经可达（目前默认 Tailscale 组网）。它只负责身份验证、打包、校验和落盘。

UI 入口：**左侧栏的 dsh-ferry 图标**（实例配置、连接状态、拉取会话）；**会话 “...” 菜单 → 推送到…** 选择在线实例直接推送。同时提供 5 个 agent 工具：`ferry_peers`、`ferry_sessions`、`ferry_remote_sessions`、`ferry_push`、`ferry_pull`。

## 前提

1. 两端 DSH 版本一致（会话日志格式版本必须相同）。版本不一致时导入会被拒绝并提示。
2. 对端的 DSH Web 监听地址必须从本机可达。默认 `dsh web` 只绑 `127.0.0.1`，跨机时要绑 Tailscale 地址或 `--host` 指定的具体网卡地址，例如：
   ```bash
   dsh --profile web --host 100.64.0.2 --port 3080
   ```
3. 双方各配置一个共享令牌（见下）。插件用 HMAC 签名每个请求，令牌本身不在网络上传输。

## 配置

对端、令牌、传输范围和上限最终都落在 profile 的 `cordis.patch.yml` 里；日常改动用侧栏面板即可，下面的 YAML 仅作为预置/备份参考。**注意：按 id 定位的 patch 会整体替换该行 config，因此同一行只写一份完整配置。**

令牌是**全局共享**的：一个实例一个 `token`，所有对端共用。旧版 `peers[].token` 若各对端取值相同会自动迁移到全局；取值不同则激活失败并提示手工合并。

```yaml
- id: dsh-ferry
  name: dsh-ferry
  config:
    instance:
      id: zenbook          # 本实例身份，默认主机名
      name: 笔记本
    token: 所有实例共用的共享密钥   # 全局唯一，不再按 peer 配置
    peers:
      - id: workstation    # 本机给对端起的标识，保证本机唯一即可
        name: 工作站
        url: http://100.64.0.3:3080
    importRoots:           # 允许对端写入的目录；默认 [~]
      - /home/zapan
    workspace:
      incomingRoot: ~/dsh-ferry/incoming  # 收到的工作区没有本机映射目录时放这里
      git: auto            # auto | include | skip
      respectGitignore: true
      exclude: []          # 额外排除的 glob
      include: []          # 强制包含（不能绕过凭据/大小限制）
      includeSecrets: false
      maxFileBytes: 67108864      # 64 MiB
      maxWorkspaceBytes: 1073741824 # 1 GiB
      maxGitBytes: 67108864       # 64 MiB
      symlinks: inside     # inside | skip
    dataDir: ~/.dsh/ferry  # 备份与暂存根目录
    timeouts:
      requestMs: 1200000   # 单次传输上限 20 分钟
      handshakeMs: 6000
```

两端都需配置对端条目（或至少让接收方持有发送方的令牌，见“安全模型”）。改完配置后重载插件或重启 `dsh web`。

## 使用

### 配置实例（在 UI 里，不用改配置文件）

1. 点左侧栏的 **dsh-ferry** 图标打开面板。
2. 在面板顶部填写**全局共享令牌**（所有实例一致），再点“添加实例”填名称和对端 DSH Web 地址（如 `http://100.64.0.3:3080`），点“保存配置”。
3. 面板会显示每个实例的在线状态和延迟；“刷新状态”重新探测。
   配置会写回 profile 的 `cordis.patch.yml`，令牌不会返回给浏览器；留空即保持原令牌。

### 推送

会话左侧的 “...” 菜单里点 **推送到…**，二级菜单只列出当前在线实例。
- 没有在线实例时该菜单项置灰。
- 推送使用对端的自动映射：对端已存在同一路径的工作区就合并进去，否则放到对端配置的“工作区接收目录”。
- 二级菜单底部的“合并已有目录（自动备份）”默认开启；关闭后遇到非空目录会被拒绝。
- 传输在后台进行，右下角 toast 显示目标目录、文件数、未传输类别。

### 拉取

在 dsh-ferry 面板的“拉取会话”区选择实例 → “加载会话” → 对目标会话点“拉取”。
- 目标目录留空时使用同一套自动映射规则；也可以显式填写本机目录。
- 需要写入非空目录时勾选“合并到已有目录”。
- 本机已有同 ID 会话且内容不同时，请改用 agent 工具的 `ferry_pull` 并传 `forkId`。

### 自动映射规则

接收工作区时依次判断：

1. 请求里带显式目标目录 → 用它；
2. 源工作区路径**在本机已存在**且位于 `importRoots` 内 → 直接复用它（自然映射）；
3. 否则 → 放到 `workspace.incomingRoot` 下，子目录名为 `<源目录名>-<会话 ID 前 8 位>`。

不会为了避免“没有映射”而凭空创建源机上的绝对路径。

命令行 / agent 侧：

```text
ferry_peers()
ferry_push(peer="workstation", session="session-…", targetDir="/home/zapan/proj", merge=true)
ferry_pull(peer="workstation", session="session-…", targetDir="/home/zapan/proj")
```

### 合并、备份与幂等

- 目标目录不存在：直接创建。
- 目标目录已存在且非空：必须显式 `merge`（UI 勾选 / 工具参数），否则拒绝。
- `merge` 覆盖同名文件前，会先把旧文件备份到 `<dataDir>/backups/<时间戳>-<会话>/`，结果里返回备份路径。
- 同 id 且同内容的会话重复推送：返回 `exists`，不覆盖任何内容。
- 同 id 但内容不同：拒绝，要求改用新会话 ID（`forkId`）。拉取时同样规则。
- 任何校验和失败都会在写入工作区之前终止（先落暂存目录），已写入的文件会回滚。

## 单向可达：A 能访问 B，B 访问不了 A

这是 Tailscale/NAT/防火墙下很常见的情况。插件按“谁发起连接”工作，因此不需要反向连通：

| 想做的事 | 从哪边操作 | 是否可行 |
| --- | --- | --- |
| A 的会话 → B | 在 A 上推送 | ✅ |
| B 的会话 → A | 在 A 上拉取 | ✅ |
| B 的会话 → A | 在 B 上推送 | ❌ B 连不到 A |
| A 的会话 → B | 在 B 上拉取 | ❌ 同上 |

要点：

- **只有能主动访问对方的一侧需要配置 peer**。B 侧不需要添加 A，只需在面板里设置相同的全局令牌、`importRoots` 和接收目录，就能接收 A 的推送。
- B 的面板里 A 会显示“离线”，推送菜单里也没有 A——这是**单向连通下的正常表现**，不代表 A 不可达 B。真正的“在线”判定只对“本机 → 对端”这个方向有意义。
- 因此工作流是：**始终在 A 上操作**——A 推送自己的会话给 B，A 拉取 B 上的会话。B 负责接收和继续工作；需要把 B 的成果带回 A 时，回到 A 执行拉取。
- 网络层要反过来，需要自己加反向隧道（SSH `-R`、Tailscale subnet router 等）；插件不处理网络，只负责在已可达的方向上搬运。
- 同一个会话在两个实例上各自被继续编辑后，**没有自动合并**：推送/拉取是快照搬运。回传前建议只在一侧继续编辑；`archiveSource`（推送后归档源会话）可以减少“两边都在改”的错觉。已有同 ID 不同内容时会拒绝，必须用 `forkId` 导入为新会话（谱系会分叉）。

## 传输范围

只传“换一台机器继续干活所需的输入”，不传“本机环境的产物和秘密”。完整分析见 [docs/transfer-scope.md](docs/transfer-scope.md)。

**会传**：源码、文档、配置模板、lockfile、`AGENTS.md`、未提交改动、`.git`（有大小上限）、会话日志、会话引用的图片/附件、工作区内的相对符号链接。

**默认不传**：`node_modules` / `.venv` 等依赖树、`dist` / `build` / `target` 等构建产物、各类缓存、日志、`.idea` / `.vscode`、`.env` 与密钥文件（`.env.example` 例外）、超大文件、指向工作区外的符号链接、socket/FIFO 等特殊文件。

**不会迁移的运行时状态**：终端 PTY、后台 job、日程提醒、子会话、审批/提问、LSP/浏览器会话、被 spill 的大工具输出。它们不属于会话日志或工作区文件，目标机需要重新建立。

## 安全模型

- 每个请求用全局共享令牌做 HMAC-SHA256 签名，覆盖发送方 id、方法、完整路径、时间戳和随机数；接收方校验时间窗（默认 ±5 分钟）和重放。
- 令牌不出现在请求头或 URL 中。传输加密交给组网（Tailscale/WireGuard）或 HTTPS。
- 令牌是**fleet 级**凭据：持有它的任何实例都可以向本机推送，且签名里的“发送方 id”只是自称，并未被单独认证。令牌泄露等同整组实例失守；轮换时需要更新所有实例。对端可信度由 Tailscale ACL / 防火墙控制，不要把这个端口暴露到公网。
- 接收方只允许写入 `importRoots` 内的绝对路径；会解析符号链接的最长存在前缀，拒绝越界。
- 写入时逐个检查父目录不是符号链接，防止通过已存在的软链把文件写到工作区外。
- 凭据文件默认不传；`includeSecrets: true` 才会放开（不建议）。
- 发送方默认在 `handshake` 暴露实例名与 id，不暴露会话与文件。

## 协议

`/dsh-ferry/v1/*`（node:http，HMAC 认证）：

| 端点 | 作用 |
| --- | --- |
| `GET /handshake` | 协议与实例身份（公开） |
| `POST /ping` | 签名校验 + 延迟 |
| `POST /sessions` | 对端可迁移会话列表 |
| `POST /describe` | 会话头部、工作区计划、附件统计、警告 |
| `POST /export` | 返回 gzip 打包流（manifest + 分帧载荷） |
| `POST /import/preflight` | 只做决策：create / merge / exists / 冲突 |
| `POST /import` | 接收打包流并落盘（`?targetDir=&merge=&forkId=`） |

浏览器侧走 `/api/dsh-ferry/rpc`（Connection 自身认证，仅 owner），供设置页调用。

打包格式：`DSH-FERRY-BUNDLE/1`，gzip 流；首帧是 JSON manifest，之后按 manifest 顺序逐个“长度帧 + 内容”，每个文件带 SHA-256。零字节文件同样占一帧，保证顺序对齐。

## 开发与验证

```bash
node --test 'test/*.test.js'
```

测试覆盖：忽略规则与凭据识别、工作区计划、大小/符号链接策略、分帧与校验和（含零字节文件）、签名与重放、路径越界与符号链接父目录。

本次改动已在两个独立 DSH 实例（独立 `DSH_HOME`、不同端口）之间完成：
推送 1454 事件 + 158 个文件 + `.git`（约 2.2 MB 工作区）、拉取（含 `forkId`）、重复推送返回 `exists`、非空目录拒绝与 `merge` 导入、附件按内容寻址保留、导入后用 `describe` 完成日志重放校验。
配置链路也在独立 profile 中验证：UI 保存全局令牌/实例/接收目录 → 写入 `cordis.patch.yml` → 插件重载后配置生效；令牌留空保持不变、非法 URL 被拒绝且不落盘；旧的单值 per-peer 令牌迁移为全局令牌。

## 已知限制

- 只迁移会话日志与工作区目录；不迁移终端、后台任务、日程、子会话、spill 输出。
- 历史事件里的绝对路径不会重写。目标路径变化后，旧工具调用里的路径仍然指向源机路径，模型需要重新确认目录。
- `.git` 超过 `maxGitBytes` 时留在源机；目标已有 `.git` 时保留目标历史。
- 附件总字节超过 `maxAttachmentBytes` 时，超出部分不传，会话里会留下悬空引用并在结果中警告。
- 会话格式版本不一致时拒绝导入；两端需保持 DSH 版本一致。
- 单次上传是一整条 HTTP 请求。对端 Node 服务的 `requestTimeout` 默认 5 分钟，因此超大工作区在慢链路上可能超时；默认已排除依赖/构建产物，常规仓库不受影响。链路较慢时建议先缩小传输范围（`exclude` / `include`）。
