# prompt-optimizer

[English](./README.md)

一个极简、高保真的 AI 提问优化 Skill（结合 Felix Rieseberg *How to be more ambitious* 中的深度/广度/外部客观验证与现代推理模型最佳实践），并附带可选的 Antigravity `PreInvocation` 自动前置分流 Hook。

## 核心机制

1. **结合上下文极速分流（`改写` / `不改写`）**：
   - 对情绪发泄/抱怨、上下文确认与委托（如“同意”“你自己决定”“继续”）、明确单步微调、对回复的反馈及已足够清晰的提问，静默跳过不调用本技能。
   - 仅对确实能明显提升执行效果的实质任务触发改写。
2. **高保真、极简输出**：
   - 100% 严格保留原意、范围与约束，不脑补、不扩写。
   - 去除过时套话（“你是一个专家”“请一步步思考”）与无关噪点，只输出 1 段自然话正文 + 一句确认，同意后再执行。

## 安装

### 作为 Skill 使用（支持 Claude Code / Codex / Cursor / Grok / Antigravity）

将 `SKILL.md` 放到对应工具的 `skills/prompt-optimizer/` 目录即可，例如 `~/.gemini/config/skills/prompt-optimizer/SKILL.md`。

### 可选：Antigravity 自动前置分流 Hook

1. 将 `hooks/prompt-optimizer-agy.js` 复制到 `~/.gemini/config/hooks/prompt-optimizer-agy.js` 并赋予可执行权限（`chmod +x`）。
2. 将 `hooks/hooks.json.example` 中的配置合并到 `~/.gemini/config/hooks.json`。
3. 常用命令：`/prompt-optimizer on | off | status | default on | default off`；单次跳过可在消息开头加 `原文：` 或 `raw:`。

## 测试

```bash
node tests/test-hook.js
```
