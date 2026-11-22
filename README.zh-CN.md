# prompt-optimizer

[English](./README.md)

一个在 AI 助手动手之前，把含糊的请求改写成一段精炼、信息密度高的提问的 Skill。改写**沿用你输入的语言**，并且知道**什么时候不该改写**。

- **保真。** 不改变你的意图、范围、数字和约束；缺失的信息只会标出，不会替你编。
- **有选择。** 情绪发泄、“同意”、“你自己决定”、单步微调、本来就清晰的话，都会静默跳过；只有实质性但表述含糊的任务才改写。
- **简短。** 只输出一段话加一句确认，不是模板，也不是长篇说明。
- **任何语言。** 改写结果和确认语都跟随你使用的语言。
- **多助手通用。** Skill 本身可用于 Claude Code、Codex、Cursor、Grok、Antigravity；可选的 Hook 能让它在 Antigravity、Claude Code、Codex 里自动触发。

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

改写借鉴了公开的提问经验（例如 Anthropic 的 Felix Rieseberg 的分享）：追问任务背后的目标；指向一手材料和从业者真正使用的方法，而不是“你是某某专家”；写明用外部手段验证结果；按“要让受众达成什么”来描述交付物。

### 哪些会被跳过

| 你输入 | 结果 |
| --- | --- |
| `同意`、`选方案2`、`继续`、`你自己决定`、`修复` | 跳过，助手直接继续 |
| `烦死了又崩了` | 跳过，正常回复 |
| `把按钮改成蓝色` | 跳过，本身就是清晰的单步操作 |
| `太长了，精简点`（对上一条回复的反馈） | 跳过 |
| 含糊的多步任务，或只贴了报错没有说明 | 改写，并等你确认 |

### 效果到底怎么样

如实说明：目前**没有基准测试**。已有的是上面的行为，有 Hook 的自动化测试（分流、确认轮次识别、开关、长会话）覆盖，以及日常使用中对真实输出的人工检查。最终答案是否更好取决于你的任务和模型；改写刻意保持很短，读起来成本低，不满意回复 `按原话` 即可。是否改写由模型判断，偶尔会改写你认为已经清晰的话，这时回复 `按原话`，或在消息开头加 `原文：` / `raw:`。

开销：装了 Hook 后，每条非简单的消息会多带一段几百 token 的分流指令；`同意`、`继续` 这类消息由 Hook 在本地直接过滤，不增加任何内容。

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

按你实际使用的助手调整目录列表。装好后可以在任一助手里手动调用，例如 `/prompt-optimizer 帮我做个PPT介绍新产品`，或者说“帮我优化这段提问：……”。

### 2. 自动分流（可选 Hook）

Hook 在每条消息之前运行，提示助手应用这个 Skill。需要 Node.js 18+。

| 助手 | 自动 Hook | 说明 |
| --- | --- | --- |
| Antigravity | 支持 | `hooks/prompt-optimizer-agy.js` |
| Claude Code | 支持 | `hooks/prompt-optimizer-hook.js claude` |
| Codex | 支持 | `hooks/prompt-optimizer-hook.js codex`；需要你信任新 Hook |
| Cursor | 不支持 | 它的提交前 Hook 不能给模型追加上下文，请手动调用 Skill |
| Grok | 未测试 | 请手动调用 Skill |

**Antigravity**

```bash
mkdir -p ~/.gemini/config/hooks
cp hooks/prompt-optimizer-agy.js ~/.gemini/config/hooks/
```

把下面这段合并进 `~/.gemini/config/hooks.json`（保留已有条目，参考 `hooks/hooks.json.example`）：

```json
"prompt-optimizer": {
  "PreInvocation": [
    { "type": "command", "command": "node ~/.gemini/config/hooks/prompt-optimizer-agy.js prompt", "timeout": 5 }
  ]
}
```

**Claude Code**

```bash
mkdir -p ~/.agents/hooks
cp hooks/prompt-optimizer-hook.js ~/.agents/hooks/
```

把 `hooks/claude-settings.example.json` 合并进 `~/.claude/settings.json`。Claude Code 可能会要求你确认新 Hook，可打开 `/hooks` 查看。

**Codex**

```bash
mkdir -p ~/.agents/hooks
cp hooks/prompt-optimizer-hook.js ~/.agents/hooks/
```

把 `hooks/codex-hooks.example.json` 合并进 `~/.codex/hooks.json`，并确认已开启 Hook（`~/.codex/config.toml` 的 `[features]` 下有 `hooks = true`）。**Codex 在你信任之前不会运行新 Hook**：在 Codex 里打开 `/hooks`，批准 `prompt-optimizer-hook.js`，然后新开一个会话。

怎样确认已生效：发一句含糊的任务，比如 `帮我做个PPT介绍新产品`。Hook 第一次运行时会创建 `~/.agents/hooks-state/prompt-optimizer/`（Antigravity 是 `~/.gemini/config/hooks/state/prompt-optimizer/`）。注意：像“审查某某功能有没有问题”这种本来就清晰的请求，Hook 虽然在运行，模型也会静默跳过，所以不要用它来验证。

## 控制命令

- `/prompt-optimizer on | off | status`：开关当前会话的自动模式。
- `/prompt-optimizer default on | off`：新会话的默认值（默认 `on`）。
- `/prompt-optimizer <内容>`：即使自动模式关闭，也强制改写一次。
- 消息开头加 `原文：` 或 `raw:`，本次跳过改写。

## 语言支持

Skill 和改写支持任何语言。Hook 会在不调用模型的情况下跳过明显的回复：确认类短语识别英语、中文、西班牙语、法语、德语、日语、韩语、俄语，“你自己决定”“go ahead”这类授权短语识别英语和中文。其他语言或其他说法会交给模型自己判断改写还是跳过，跳过时同样是静默的，区别只是多带一点上下文。确认轮次的识别与语言无关：由一个标题加一段引用提问构成的短回复就算作优化后的提问。

## 配置

| 变量 | 含义 |
| --- | --- |
| `PROMPT_OPTIMIZER_SKILL_PATH` | Hook 告诉助手去读的 `SKILL.md` 路径 |
| `PROMPT_OPTIMIZER_STATE_DIR` | Claude Code 和 Codex Hook 的状态目录 |
| `AGY_HOOK_STATE_DIR` | Antigravity Hook 的状态目录 |

## 测试

```bash
node tests/test-hook.js              # Antigravity Hook
node tests/test-cross-host-hook.js   # Claude Code 和 Codex Hook
```

## 局限

- 是否改写是模型的判断，不是保证。
- 没有 Hook 时，Skill 只在你主动要求时才运行。
- Hook 看不到助手最终答案的质量，只负责分流和跟踪确认轮次。
