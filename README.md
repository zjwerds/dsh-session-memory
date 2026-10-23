# dsh-session-memory

DeepSeek Harness（DSH）的 **会话记忆插件**：每个用户回合结束后在后台静默整理一次记忆，把「用户身份 / 用户习惯 / 本对话项目记忆」自动注入下一次请求，并把「用户身份 / 习惯 / 账号密码」长期保存在 `$DSH_HOME` 下、账号密码只通过 skill + 工具按需读取。零运行时依赖、host-only。

> 一句话：**对话内自动记重点（≤600 字），跨对话记住你、你的习惯和你的凭据；身份/习惯/项目记忆自动注入，账号密码绝不自动注入。**

## 功能

- **项目记忆（每对话独立）**：`turn/end` 后约 1 秒后台完成，一次模型调用同时产出项目记忆、身份、习惯、账号密码与话题标签；每条 ≤40 字符、同一对话累计 ≤600 字符，自动注入**当前会话**的 system prompt；别的会话可通过 `session_memory_read(all:true)` 只读查看。
- **长期记忆 v3（结构化）**：`$DSH_HOME/memory/vault.json`，`identity`（职业/角色、语言、专业领域等，≤60；**从对话判断/推断**，如「我现在在开发插件」→「职业：开发人员」）、`habits`（长期稳定习惯/偏好，每条 ≤20、总 ≤120、去重）、`credentials`（账号密码类，≤60），带历史版本。
- **自动注入（顺序固定）**：用户身份（order 156）→ 用户习惯（157）→ 本对话项目记忆（160）→ 固定规则（161）；vault 的 **credentials 永不注入**。
- **按需读取**：注册 `user-profile` skill + `vault_read(scope=all|identity|habits|credentials)`；只有用户明确索要时才读取，返回值用 `<vault_secret>` 包裹。
- **divergence 三次标签机制（程序强制）**：用户问题与项目记忆差距很大时，模型先打一个 ≤6 码点的「小标签」并**冻结项目记忆**；同话题第 2 次继续冻结；第 3 次才判定「可以安心存储」，清掉标签并允许写入本轮项目记忆。标签只落盘 `session-memory.json`，不注入提示词。
- **分级防泄漏（不卡死）**：`guardMode: balanced`（默认）下本地工具（`pwsh`/`write`/`edit`/`read`…）放行；只有向外的工具（`web_fetch`/`web_search`/`subagent`/`workflow`/`a2a_send`/`mcp*`）带长期记忆内容时才拦截，`web_fetch` 仅允许 `trustedDomains` 白名单；URL/percent-encoding 绕过会被归一后识别。也可切 `strict`/`off`。
- **程序化过滤**：项目记忆写入/注入两侧都会过滤身份与凭据片段、通用凭据形态（密码/高熵 token），避免凭据进入自动注入的上下文。

## 安装

```sh
# 安装到默认 web profile（按需替换 profile 名）
dsh plugin --profile web add dsh-session-memory

# 或固定版本
dsh plugin --profile web add dsh-session-memory@0.3.0
```

桌面端 DSH：设置 → 插件 → 安装（从市场/本地包），装完重启窗口。

## 快速验证

1. 说 `记住：这个项目先做 MVP` → 下一轮问 `我们刚才定了什么？`，回答应来自自动注入的项目记忆。
2. 说 `我现在在开发插件，喜欢快一点、不要弹窗，以后叫我小王` → 下一轮 system prompt 自动注入「用户身份（职业：开发人员）」与「用户习惯（要求快、不弹窗）」。
3. 说 `我的测试账号是 testuser，密码是 TestPass123` → 再说 `我的账号密码是什么？`，应通过 `user-profile` skill + `vault_read` 告知；而普通对话的注入段里**不应**出现密码。
4. 换一个完全不同的话题聊三轮 → 项目记忆应在前两轮保持旧内容（divergence 冻结），第三轮延续后才写入新话题条目。

数据位置：`$DSH_HOME/memory/session-memory.json`（项目记忆 + divergence 标签）、`$DSH_HOME/memory/vault.json`（长期记忆，0600 best-effort）。

## 配置

在 profile 的 `cordis.patch.yml` 里给 `session-memory` 行加 `config`（全部可选）：

```yaml
- id: session-memory
  config:
    projectMaxChars: 600
    entryMaxChars: 40
    identityMaxChars: 60
    habitsMaxChars: 120
    habitEntryMaxChars: 20
    credentialsMaxChars: 60
    guardMode: balanced          # balanced | strict | off
    trustedDomains: ['example.com']
    analysisReasoningEffort: 'off'  # 后台分析关 thinking，保证快
    debug: false
```

完整字段见 `cordis.patch.yml` 头部注释与 `lib/config.js`。

## 安全边界（请阅读）

- 长期记忆按要求**明文**存放在本机 `$DSH_HOME/memory/vault.json`（0600 best-effort）；会进入后台分析请求、用户索要时的会话记录与磁盘。不要把它同步到公开仓库。
- 自动注入只含 identity / habits / 项目记忆；credentials 绝不注入，只经 `vault_read` 按需返回。
- 护栏挡的是**外发**（外部网站/子代理/工作流/a2a）；本地工具放行，用户明确索要时模型可告知本人。
- `balanced` 的网络工具识别按工具名；未知的自定义网络工具可能不在名单内，需要严格时用 `strict`。
- 已知误伤：两个字符的通用称呼/职业词出现在项目记忆条目中时可能被过滤（安全优先）。

## 兼容性

- 开发与真机验证：DSH `0.2.1-rc.2`。
- Node.js `>=22.19`。
- `engines.dsh`: `>=0.2.0-rc.1 <0.3.0-0`。
- 当前单测：`node --test --test-isolation=none "test/*.test.mjs"` 112/112 绿。

## 开发

```sh
node --check lib/*.js
node --test --test-isolation=none "test/*.test.mjs"
```

> 测试目录不随 npm 包发布（`files` 只含 `lib/`、`cordis.patch.yml`、`README.md`、`LICENSE`）；源码仓库包含 `test/`。

## License

MIT
