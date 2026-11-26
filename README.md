# prompt-optimizer

[Chinese (Simplified)](./README.zh-CN.md)

A skill that rewrites a vague request into one short, high-signal prompt before your AI agent acts on it, in **your own language**, and that knows when **not** to rewrite.

- **Faithful.** It never changes your intent, scope, numbers or constraints. Missing facts are flagged, not invented.
- **Selective.** Venting, "yes", "you decide", single-step tweaks and already-clear messages are skipped silently. Only substantive but vague tasks are rewritten.
- **Short.** The output is one paragraph plus one confirmation line, not a template or a lecture.
- **Next-step ready (optional).** Omitted by default; only when a concrete, high-value follow-up genuinely exists after completing a task—or after handing you a concrete offline/external step whose return prompt is predictable—it can append one ready-to-copy next prompt (or 2–3 short options at a real fork) grounded in the current context and loaded memory or rules.
- **Any language.** The rewrite and the confirmation line follow the language you wrote in.
- **Works across agents.** The skill itself runs in Claude Code, Codex, Pi, Cursor, Grok and Antigravity. Optional hooks or extensions make it trigger automatically in Antigravity, Claude Code, Codex and Pi.

## What it does

You type a rough request. The agent first decides, silently, whether a rewrite would help. If so it shows one sharper prompt and waits:

```text
You:    make a deck introducing the new product

Agent:  ### Optimized Prompt
        > Draft the structure and slide-by-slide copy for a new-product deck that lets busy
        > decision makers grasp in a few minutes what problem it solves, why it works and how
        > to try it next; build it from the real product materials, mark missing numbers as
        > blanks instead of inventing them, and avoid empty slogans.
        Use this prompt? (approve / edit / use original)

You:    approve          -> the agent runs the optimized prompt
```

The rewrite applies a few ideas drawn from public advice on prompting current models (for example from Felix Rieseberg of Anthropic): ask for the goal behind the task, translate everyday layperson descriptions into accurate domain terminology without over-specifying (for example, "looks like glass" -> glassmorphism), point at first-hand material and the methods practitioners actually use instead of "act as an expert", name an external way to verify the result, and describe the deliverable by what it must achieve for its audience.

### What gets skipped

| You type | Result |
| --- | --- |
| `yes`, `option 2`, `continue`, `you decide`, `fix it` | skipped for rewriting, the agent just proceeds |
| `ugh, it broke again` | skipped, normal reply |
| `make the button blue` | skipped, already a clear single step |
| `cut the summary to 3 bullet points` (clear follow-up edit) | skipped |
| `these sections look too plain, make them cooler` (subjective follow-up revision) | rewritten, then confirmed |
| a vague multi-step task, or a pasted error with no instruction | rewritten, then confirmed |

### Post-turn next-step suggestions

When `next` is enabled and a concrete, high-value follow-up genuinely exists—either after completing a substantive task or after handing you a concrete offline/external action to complete and return with results (such as taking listed screenshots or gathering files)—the agent appends one ready-to-copy prompt at the end of the reply in plain text (or a `- ` bullet list with 2–3 short options when there is a real fork), grounded in what was just done, the handed-off action, remaining checks/risks, and any history or project rules already loaded in the session.

When the context supports them, the prompt names the environment, the workflow from entry to outcome, the integrations and regressions to check, and the evidence or files to return. It carries forward existing approval conditions and stays as narrow as the confirmed next action.

Across long tool runs and repeated context compactions, the hooks keep the reminder active without re-running prompt rewriting: Antigravity refreshes `[PROMPT-OPTIMIZER NEXT-STEP]` once after each `CHECKPOINT` compaction and every 16 steps (`PROMPT_OPTIMIZER_NEXT_REFRESH_STEPS`), Claude Code restores it on `SessionStart` (`matcher: "compact"`), and all host hooks clear stale pending-confirmation state at compaction boundaries while scanning up to 64 MB of transcript tail in bounded chunks.

It stays completely silent whenever a task is self-contained or done (never forcing filler suggestions), as well as during confirmation turns, open-ended clarifying questions whose answer cannot be predicted, login/payment gates, chit-chat, config replies, and trivial Q&A. Because the suggested prompt is already concrete, pasting it back executes immediately without triggering another rewrite.

### How well does it work

Honest status: there is **no benchmark** yet. What exists is the behavior above, covered by an automated test suite for the hooks (routing, confirmation tracking, switches, long sessions), plus manual checks of real outputs in daily use. Whether the final answer is better depends on your task and model; the rewrite is deliberately small so it is cheap to read and easy to reject with `use original`. Routing is decided by the model, so it can occasionally rewrite something you consider clear; reply `use original` or start the message with `raw:`.

Cost: with a hook installed, every non-trivial message carries a short routing instruction (a few hundred tokens). Pure acknowledgements such as `yes` or `ok` are filtered by the hook locally and add nothing. Actionable follow-ups such as `continue` or `you decide` skip rewrite routing locally (adding nothing when `next` is off, or only the short optional next-step instruction when `next` is on).

## Install

### 1. The skill (all agents)

```bash
git clone https://github.com/TinkCarlos/prompt-optimizer.git
cd prompt-optimizer
for d in ~/.claude/skills ~/.codex/skills ~/.cursor/skills ~/.grok/skills \
         ~/.gemini/config/skills ~/.agents/skills; do
  [ -d "$d" ] && mkdir -p "$d/prompt-optimizer" && cp SKILL.md "$d/prompt-optimizer/"
done
```

Adjust the list to the agents you use. Pi also discovers `~/.agents/skills/prompt-optimizer/SKILL.md`, or you can install it together with the automatic extension via `pi install` below. After this you can call it manually in any agent, for example `/prompt-optimizer make a deck introducing the new product` (`/skill:prompt-optimizer ...` in Pi) or "optimize this prompt: ...".

### 2. Automatic routing (optional hooks & extensions)

A hook or extension runs before every message and tells the agent to apply the skill. Hooks and the Pi extension need Node.js 18+.

| Agent | Automatic trigger | Notes |
| --- | --- | --- |
| Antigravity | yes | `hooks/prompt-optimizer-agy.js` (`next` defaults to `on`) |
| T3 Code | yes | inherits Claude Code, Codex and Pi hooks automatically (hooks unwrap `<t3_code_instructions>` / `<user_request>`); for T3 Code's isolated Antigravity provider, run `node scripts/install-t3.js` |
| Claude Code | yes | `hooks/prompt-optimizer-hook.js claude` (`next` defaults to `on`) |
| Codex | yes | `hooks/prompt-optimizer-hook.js codex` (`next` defaults to `on`; run `/prompt-optimizer next default off` if you prefer only Codex's native input suggestion; you must trust the new hook) |
| Pi | yes | `pi install git:github.com/TinkCarlos/prompt-optimizer` or `hooks/prompt-optimizer-pi.js` (`next` defaults to `on`) |
| Cursor | no | its prompt hook cannot add context to the model; use the skill manually |
| Grok | not tested | use the skill manually |

**Antigravity**

```bash
mkdir -p ~/.gemini/config/hooks
cp hooks/prompt-optimizer-agy.js ~/.gemini/config/hooks/
```

Add this to `~/.gemini/config/hooks.json` (merge with your existing entries, see `hooks/hooks.json.example`; in GUI-launched hosts on macOS, replace `node` and `~` with absolute paths such as `/opt/homebrew/bin/node` and `/Users/<you>` if `node` is not in the default PATH):

```json
"prompt-optimizer": {
  "PreInvocation": [
    { "type": "command", "command": "/opt/homebrew/bin/node /Users/<you>/.gemini/config/hooks/prompt-optimizer-agy.js prompt", "timeout": 5 }
  ]
}
```

**Claude Code**

```bash
mkdir -p ~/.agents/hooks
cp hooks/prompt-optimizer-hook.js ~/.agents/hooks/
```

Merge `hooks/claude-settings.example.json` into `~/.claude/settings.json` (registers both `UserPromptSubmit` and `SessionStart` with `matcher: "compact"` so post-compaction sessions keep next-step suggestions active). Claude Code may ask you to approve the new hook; open `/hooks` to review it.

**Codex**

```bash
mkdir -p ~/.agents/hooks
cp hooks/prompt-optimizer-hook.js ~/.agents/hooks/
```

Merge `hooks/codex-hooks.example.json` into `~/.codex/hooks.json` and make sure hooks are enabled (`hooks = true` under `[features]` in `~/.codex/config.toml`). **Codex does not run a new hook until you trust it**: open `/hooks` in Codex and approve `prompt-optimizer-hook.js`. After that, start a new session.

**Pi**

Install as a Pi package (installs both the skill and the automatic extension):

```bash
pi install git:github.com/TinkCarlos/prompt-optimizer
```

Or, if you already copied `SKILL.md` to `~/.agents/skills/prompt-optimizer/` or `~/.pi/agent/skills/prompt-optimizer/`, copy only the extension file so Pi does not warn about duplicate skills:

```bash
mkdir -p ~/.pi/agent/extensions
cp hooks/prompt-optimizer-pi.js ~/.pi/agent/extensions/prompt-optimizer.js
```

Run `/reload` in an active Pi session or start a new session.

**T3 Code**

T3 Code routes each thread through its selected provider:

- **Claude Code / Codex / Pi** threads inherit your existing host hooks and skills automatically; all three hooks unwrap T3 Code's `<t3_code_instructions>` / `<user_request>` / `<runtime_info>` envelope so commands (`/prompt-optimizer off|status`), `raw:` bypasses, and local filters work cleanly.
- **Antigravity** threads use an isolated config folder under `~/.t3/userdata/providers/antigravity/<id>/config/` (which symlinks `skills` but does not mount `hooks.json` by default). Run the helper script to install/update the hook and merge `"prompt-optimizer"` into each T3 Antigravity `hooks.json` without touching other entries:

```bash
node scripts/install-t3.js --dry-run
node scripts/install-t3.js
```

To remove only `prompt-optimizer` from T3 Code's Antigravity configs, run `node scripts/install-t3.js --uninstall`.

To check that it is active, send a vague task such as `make a deck introducing the new product`. The hook creates `~/.agents/hooks-state/prompt-optimizer/` the first time it runs (Antigravity: `~/.gemini/config/hooks/state/prompt-optimizer/`). In Pi, session mode is stored in the active session branch and `default-mode.txt` is stored under `~/.agents/hooks-state/prompt-optimizer/`.

## Controls

- `/prompt-optimizer on | off | status`: switch auto mode (`off` silences both rewrite and next-step suggestions) and inspect current settings.
- `/prompt-optimizer default on | off`: default rewrite mode for new sessions (default is `on`).
- `/prompt-optimizer next on | off`: toggle post-turn next-step suggestions for the current session (even when rewrite is `off`, `/prompt-optimizer next on` keeps suggestions active).
- `/prompt-optimizer next default on | off`: default post-turn suggestion mode for new sessions (`on` for Antigravity, Claude Code, Codex, and Pi).
- `/prompt-optimizer <text>`: force one rewrite even when auto mode is off.
- Start a message with `raw:` to skip the rewrite once.

## Language support

The skill and the rewrite work in any language. The hook skips rewrite routing locally without asking the model to route: pure acknowledgements are recognized in English, Chinese, Spanish, French, German, Japanese, Korean and Russian (adding zero context), and short continuations or delegation phrases ("continue", "you decide", "go ahead") in English and Chinese (skipping rewrite routing, and carrying only the optional next-step instruction when `next` is on). Any other language, or any other phrasing, simply goes through the model's own REWRITE or SKIP decision, which is silent for skipped messages, so the only difference is a small amount of extra context. Recognizing the confirmation reply does not depend on language: a short reply made of a heading immediately followed by a blockquote and a confirmation line counts as the optimized prompt.

## Configuration

| Variable | Meaning |
| --- | --- |
| `PROMPT_OPTIMIZER_SKILL_PATH` | path to `SKILL.md` that the hook tells the agent to read |
| `PROMPT_OPTIMIZER_STATE_DIR` | state folder of the Claude Code and Codex hook |
| `AGY_HOOK_STATE_DIR` | state folder of the Antigravity hook |
| `PROMPT_OPTIMIZER_NEXT_REFRESH_STEPS` | step interval for refreshing `[PROMPT-OPTIMIZER NEXT-STEP]` during long Antigravity turns (default `16`) |

## Test

```bash
npm test                             # all hook & extension suites
node tests/test-hook.js              # Antigravity hook
node tests/test-cross-host-hook.js   # Claude Code and Codex hook
node tests/test-pi-extension.js      # Pi extension
```

Behavioral evaluation cases for `SKILL.md` live in `tests/eval-cases.json`.

## Limitations

- Whether to rewrite is a model judgment, not a guarantee.
- Without a hook the skill only runs when you ask for it.
- Hooks cannot see the agent's final answer quality; they only decide routing and track the confirmation turn.
