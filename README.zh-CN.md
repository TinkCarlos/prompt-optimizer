# prompt-optimizer

[English](./README.md)

一个在 AI 助手动手之前，把含糊的请求改写成一段精炼、信息密度高的提问的 Skill。改写**沿用你输入的语言**，并且知道**什么时候不该改写**。

- **保真。** 不改变你的意图、范围、数字和约束；缺失的信息只会标出，不会替你编。
- **有选择。** 情绪发泄、“同意”、“你自己决定”、单步微调、本来就清晰的话，都会静默跳过；只有实质性但表述含糊的任务才改写。
- **简短。** 只输出一段话加一句确认，不是模板，也不是长篇说明。
- **接续建议（按需触发）。** 默认静默；仅当完成任务后确实存在明确、高价值的下一步动作，或把明确的线下/外部操作交给你去完成并带结果回来继续时，才结合当前上下文与会话里已载入的历史记忆/规则，在回复末尾附 1 条可直接复制发送的回传或续接提示词（遇到明确分叉时给 2~3 条备选方向），不需要时直接不给。
- **任何语言。** 改写结果、确认语和下一步建议都跟随你使用的语言。
- **多助手通用。** Skill 本身可用于 Claude Code、Codex、Pi、Cursor、Grok、Antigravity；可选的 Hook 或 Extension 能让它在 Antigravity、Claude Code、Codex 和 Pi 里自动触发。

## 效果

你随手写一句，助手先静默判断改写是否有帮助；有帮助才给出一条更清晰的提问并等你确认：

```text
你：   帮我做个PPT介绍新产品

助手： ### 优化后的提问
       > 帮我整理一份新产品介绍 PPT 的结构与每页文案，重点让忙于决策的人在几分钟内看懂
       > 它解决什么问题、凭什么有效、下一步怎么试用；请基于真实的产品资料提炼，缺的数据
       > 留空标注，不要编造，避免空泛口号。
       按这句提问吗？（同意 / 修改 / 按原话）

你：   同意          -> 助手按优化后的提问执行
```

改写借鉴了公开的提问经验（例如 Anthropic 的 Felix Rieseberg 的分享）：追问任务背后的目标；把大白话描述准确翻译为对应的领域专业术语且不过度发挥（例如“像玻璃一样”→ 玻璃态）；指向一手材料和从业者真正使用的方法，而不是“你是某某专家”；写明用外部手段验证结果；按“要让受众达成什么”来描述交付物。

### 哪些会被跳过

| 你输入 | 结果 |
| --- | --- |
| `同意`、`选方案2`、`继续`、`你自己决定`、`修复` | 跳过改写，助手直接继续 |
| `烦死了又崩了` | 跳过，正常回复 |
| `把按钮改成蓝色` | 跳过，本身就是清晰的单步操作 |
| `把总结精简成 3 条要点`（明确的后续微调） | 跳过 |
| `开头几个模块太普通了，改酷一点`（主观/含糊的后续修改） | 改写，并等你确认 |
| 含糊的多步任务，或只贴了报错没有说明 | 改写，并等你确认 |

### 回复末尾的下一步提示词建议

当 `next` 开启，且模型完成实质性任务后存在明确高价值的后续动作，或明确把一项具体的线下/外部操作（如按清单截图、导出文件、完成手动配置）交给你去执行并带结果回来继续既定流程时，助手会在回复末尾用分隔线和纯文本附带 1 条可直接复制发送的下一步或回传续接指令（仅在出现明显分叉时用短列表给 2~3 条备选方向），依据刚刚完成的工作、交接清单、未收尾的检查或风险，以及会话里已经载入的历史记忆与项目规则生成。

当上下文明确时，建议会写出执行环境、从入口到结果的实际流程、待验收的功能与关键回归、需要交回的证据或文件，并保留已有的授权条件。只确认了一项检查时，建议也只写这一项。

Codex 的 `Stop` Hook 检查已注入规则的轮次。回复给出非零的源数据条数，却留下未经逐条解释的空结果且缺少建议时，Hook 只请求补写一次建议。已经解释清楚、已有建议或关闭 `next` 的轮次直接结束。

在长工具链或同一会话多次上下文压缩场景下，Hook 会自动保活该提醒且绝不重复触发改写：Antigravity 会在每次 `CHECKPOINT` 压缩后以及长轮次每 16 步（`PROMPT_OPTIMIZER_NEXT_REFRESH_STEPS`）补发一次 `[PROMPT-OPTIMIZER NEXT-STEP]`；Claude Code 通过 `SessionStart`（`matcher: "compact"`）在压缩后立即恢复；各宿主 Hook 在压缩边界自动清理陈旧的待确认状态，并支持最多 64 MB 分块倒扫长会话日志。

如果当前任务已经完整结束无需再做（宁缺毋滥、绝不为了建议而硬凑），或处于优化确认轮、向你提出开放式澄清追问、因登录/付款受阻、纯闲聊、开关配置回复、极简问答，都会保持完全静默。因为建议本身已经具体可验证，复制发回后会直接执行，不会再次触发改写。

### 效果到底怎么样

如实说明：目前**没有基准测试**。已有的是上面的行为，有 Hook 的自动化测试（分流、确认轮次识别、开关、长会话）覆盖，以及日常使用中对真实输出的人工检查。最终答案是否更好取决于你的任务和模型；改写刻意保持很短，读起来成本低，不满意回复 `按原话` 即可。是否改写由模型判断，偶尔会改写你认为已经清晰的话，这时回复 `按原话`，或在消息开头加 `原文：` / `直接：` / `raw:`。

开销：装了 Hook 后，每条非简单的消息会多带一段几百 token 的分流指令；`同意`、`好的` 这类纯确认消息由 Hook 在本地直接过滤，不增加任何内容；`继续`、`你自己决定` 这类可执行的跟进指令会在本地跳过改写分流（`next` 关闭时不增加任何内容，`next` 开启时仅附带简短的可选下一步建议指令）。

## 安装

### 1. Skill（所有助手）

```bash
git clone https://github.com/TinkCarlos/prompt-optimizer.git
cd prompt-optimizer
for d in ~/.claude/skills ~/.codex/skills ~/.cursor/skills ~/.grok/skills \
         ~/.gemini/config/skills ~/.agents/skills; do
  [ -d "$d" ] && mkdir -p "$d/prompt-optimizer" && cp SKILL.md "$d/prompt-optimizer/"
done
```

按你实际使用的助手调整目录列表；Pi 也会自动扫描 `~/.agents/skills/prompt-optimizer/SKILL.md`，或使用下文 `pi install` 一次装好 Skill 与自动扩展。装好后可以在任一助手里手动调用，例如 `/prompt-optimizer 帮我做个PPT介绍新产品`（Pi 里原生 Skill 语法是 `/skill:prompt-optimizer ...`），或者说“帮我优化这段提问：……”。

### 2. 自动分流（可选 Hook / Extension）

Hook 或 Extension 在每条消息之前运行，提示助手应用这个 Skill。需要 Node.js 18+。

| 助手 | 自动触发 | 说明 |
| --- | --- | --- |
| Antigravity | 支持 | `hooks/prompt-optimizer-agy.js`（`next` 默认 `on`） |
| T3 Code | 支持 | Claude Code、Codex、Pi 线程自动复用对应宿主 Hook（均已自动解包 T3 的 `<t3_code_instructions>` / `<user_request>` 外壳）；Antigravity 线程需运行 `node scripts/install-t3.js` 写入隔离目录 |
| Claude Code | 支持 | `hooks/prompt-optimizer-hook.js claude`（`next` 默认 `on`） |
| Codex | 支持 | `hooks/prompt-optimizer-hook.js codex`（`next` 默认 `on`；如想避免与 Codex 原生输入框建议重复，可执行 `/prompt-optimizer next default off`；需要你信任新 Hook） |
| Pi | 支持 | `pi install git:github.com/TinkCarlos/prompt-optimizer` 或 `hooks/prompt-optimizer-pi.js`（`next` 默认 `on`） |
| Cursor | 不支持 | 它的提交前 Hook 不能给模型追加上下文，请手动调用 Skill |
| Grok | 未测试 | 请手动调用 Skill |

**Antigravity**

```bash
mkdir -p ~/.gemini/config/hooks
cp hooks/prompt-optimizer-agy.js ~/.gemini/config/hooks/
```

把下面这段合并进 `~/.gemini/config/hooks.json`（保留已有条目，参考 `hooks/hooks.json.example`；在 macOS GUI 应用中启动时，如默认 PATH 不含 `node` 或不展开 `~`，请把 `node` 和 `~` 替换为绝对路径，例如 `/opt/homebrew/bin/node` 和 `/Users/<你的用户名>`）：

```json
"prompt-optimizer": {
  "PreInvocation": [
    { "type": "command", "command": "/opt/homebrew/bin/node /Users/<你的用户名>/.gemini/config/hooks/prompt-optimizer-agy.js prompt", "timeout": 5 }
  ]
}
```

**Claude Code**

```bash
mkdir -p ~/.agents/hooks
cp hooks/prompt-optimizer-hook.js ~/.agents/hooks/
```

把 `hooks/claude-settings.example.json` 合并进 `~/.claude/settings.json`（同时注册 `UserPromptSubmit` 与 `SessionStart` `matcher: "compact"`，保证上下文压缩后继续给出下一步提示词）。Claude Code 可能会要求你确认新 Hook，可打开 `/hooks` 查看。

**Codex**

```bash
mkdir -p ~/.agents/hooks
cp hooks/prompt-optimizer-hook.js ~/.agents/hooks/
```

把 `hooks/codex-hooks.example.json` 合并进 `~/.codex/hooks.json`，并确认已开启 Hook（`~/.codex/config.toml` 的 `[features]` 下有 `hooks = true`）。**Codex 在你信任之前不会运行新 Hook**：在 Codex 里打开 `/hooks`，批准 `prompt-optimizer-hook.js`，然后新开一个会话。

已安装的 Codex 环境可追加示例中的 `Stop` 条目，再用 `/hooks` 审核启用收尾检查。

**Pi**

作为 Pi 包一键安装（同时安装 Skill 与自动扩展）：

```bash
pi install git:github.com/TinkCarlos/prompt-optimizer
```

如果你已经把 `SKILL.md` 复制到了 `~/.agents/skills/prompt-optimizer/` 或 `~/.pi/agent/skills/prompt-optimizer/`，只需复制单个扩展文件，避免重名 Skill 警告：

```bash
mkdir -p ~/.pi/agent/extensions
cp hooks/prompt-optimizer-pi.js ~/.pi/agent/extensions/prompt-optimizer.js
```

在运行中的 Pi 会话输入 `/reload`，或新开会话即可生效。

**T3 Code**

T3 Code 按线程所选的 Provider 加载对应配置：

- **Claude Code / Codex / Pi** 线程自动继承本机宿主 Hook 与 Skill；三端 Hook 已自动解包 T3 Code 的 `<t3_code_instructions>` / `<user_request>` / `<runtime_info>` 外壳，`/prompt-optimizer off|status`、`raw:` 和本地过滤均可正常工作。
- **Antigravity** 线程使用独立的 `~/.t3/userdata/providers/antigravity/<id>/config/` 目录（默认只软链 `skills`，不挂载 `hooks.json`）。运行内置安装脚本即可一键把 `prompt-optimizer` 合并写入 T3 Antigravity 的 `hooks.json`（保留 `lmemory` 等其他已有条目）：

```bash
node scripts/install-t3.js --dry-run
node scripts/install-t3.js
```

如需仅移除 T3 Antigravity 里的 `prompt-optimizer` 条目，运行 `node scripts/install-t3.js --uninstall`。

怎样确认已生效：发一句含糊的任务，比如 `帮我做个PPT介绍新产品`。Hook 第一次运行时会创建 `~/.agents/hooks-state/prompt-optimizer/`（Antigravity 是 `~/.gemini/config/hooks/state/prompt-optimizer/`；Pi 的会话开关记在当前会话树中，`default-mode.txt` 记在 `~/.agents/hooks-state/prompt-optimizer/`）。注意：像“审查某某功能有没有问题”这种本来就清晰的请求，Hook/扩展虽然在运行，模型也会静默跳过，所以不要用它来验证。

## 控制命令

- `/prompt-optimizer on | off | status`：开关当前会话的自动模式（`off` 会同时关闭改写和下一步建议）并查看当前状态。
- `/prompt-optimizer default on | off`：新会话的改写默认值（默认 `on`）。
- `/prompt-optimizer next on | off`：单独开关当前会话的回复后下一步建议（即使在 `/prompt-optimizer off` 后执行 `/prompt-optimizer next on`，也可只保留下一步建议）。
- `/prompt-optimizer next default on | off`：新会话的下一步建议默认值（Antigravity、Claude Code、Codex、Pi 均默认 `on`）。
- `/prompt-optimizer <内容>`：即使自动模式关闭，也强制改写一次。
- 消息开头加 `原文：`、`直接：` 或 `raw:`，本次跳过改写。

## 语言支持

Skill 和改写支持任何语言。Hook 会在本地跳过改写分流而不额外调用模型判断：纯确认类短语识别英语、中文、西班牙语、法语、德语、日语、韩语、俄语（不增加任何内容）；“继续”“你自己决定”“go ahead”这类简短续接与授权短语识别英语和中文（跳过改写分流，`next` 开启时仅附带简短的下一步建议指令）。其他语言或其他说法会交给模型自己判断改写还是跳过，跳过时同样是静默的，区别只是多带一点上下文。确认轮次的识别与语言无关：由一个标题紧接一段引用提问再跟一句确认语构成的短回复就算作优化后的提问。

## 配置

| 变量 | 含义 |
| --- | --- |
| `PROMPT_OPTIMIZER_SKILL_PATH` | Hook 告诉助手去读的 `SKILL.md` 路径 |
| `PROMPT_OPTIMIZER_STATE_DIR` | Claude Code 和 Codex Hook 的状态目录 |
| `AGY_HOOK_STATE_DIR` | Antigravity Hook 的状态目录 |
| `PROMPT_OPTIMIZER_NEXT_REFRESH_STEPS` | Antigravity 长轮次刷新 `[PROMPT-OPTIMIZER NEXT-STEP]` 的步距阈值（默认 `16`） |

## 测试

```bash
npm test                             # 全部 Hook 与 Extension 测试
node tests/test-hook.js              # Antigravity Hook
node tests/test-cross-host-hook.js   # Claude Code 和 Codex Hook
node tests/test-pi-extension.js      # Pi Extension
```

`SKILL.md` 的行为级回归评测样例见 `tests/eval-cases.json`。

## 局限

- 是否改写是模型的判断，不是保证。
- 没有 Hook 时，Skill 只在你主动要求时才运行。
- Hook 看不到助手最终答案的质量，只负责分流和跟踪确认轮次。
