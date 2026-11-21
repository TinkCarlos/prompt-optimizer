# prompt-optimizer

[中文说明](./README.zh-CN.md)

A minimal, high-fidelity AI prompt optimizer skill (inspired by Felix Rieseberg's *How to be more ambitious* — Depth, Range, Outside Judge, and modern reasoning model best practices) with an optional Antigravity `PreInvocation` router hook.

## How It Works

1. **Fast Context-Aware Routing (`改写` / `不改写`)**:
   - Skips venting/complaints, contextual confirmations/delegations (`同意`, `你自己决定`, `继续`), single-step edits, feedback, and already-clear prompts silently without invoking the skill.
   - Only rewrites substantive tasks where restructuring materially improves execution.
2. **High-Fidelity, Concise Rewrite**:
   - Preserves 100% of the user's original intent, scope, and constraints.
   - Strips noise (irrelevant headers, redundant IDs in the same conversation) and outdated boilerplate ("act as an expert", "think step by step").
   - Outputs one concise paragraph plus a single confirmation line before execution.

## Install

### As a Skill (Claude Code, Codex, Cursor, Grok, Antigravity)

Copy `SKILL.md` into your agent's skill directory, e.g.:

- `~/.gemini/config/skills/prompt-optimizer/SKILL.md` (Antigravity)
- `~/.claude/skills/prompt-optimizer/SKILL.md` (Claude Code)
- `~/.codex/skills/prompt-optimizer/SKILL.md` (Codex)
- `~/.cursor/skills/prompt-optimizer/SKILL.md` (Cursor)

### Optional Automatic Hook (Antigravity)

1. Copy `hooks/prompt-optimizer-agy.js` to `~/.gemini/config/hooks/prompt-optimizer-agy.js` and `chmod +x` it.
2. Merge `hooks/hooks.json.example` into `~/.gemini/config/hooks.json`.
3. Controls: `/prompt-optimizer on | off | status | default on | default off`, or prefix a message with `原文：` / `raw:` to bypass once.

## Test

```bash
node tests/test-hook.js
```
