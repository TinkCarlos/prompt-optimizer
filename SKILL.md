---
name: prompt-optimizer
description: >-
  Works in any language. Before acting on a user message, decide from the conversation context whether it is worth rewriting (REWRITE or SKIP). Venting, confirmations, single-step tweaks and already-clear messages are skipped silently. When a rewrite is worth it, restate the request as one short, high-signal prompt in the user's own language, preserving intent, scope and constraints 100%, and ask the user to confirm before executing. Use for automatic pre-routing, or when the user asks to "optimize my prompt", "polish this prompt" or runs /prompt-optimizer.
---

# Prompt Optimizer

First decide whether a rewrite is worth it. If it is, turn the user's words into one dense, ready-to-run prompt and wait for confirmation. Always write in the language the user wrote in.

## 1. Step one: decide REWRITE or SKIP from context

- **How to answer**
  - Called as a standalone router (asked for the verdict only): reply with exactly `REWRITE` or `SKIP`, nothing else.
  - Running inline before a normal reply: on **SKIP**, stay completely silent about it. Do not mention routing or rewriting, do not load the rest of this skill, just answer or act. On **REWRITE**, continue to section 2.
  - The user names this skill explicitly (`/prompt-optimizer <text>`, "optimize this prompt"): skip the decision and go to section 2.
- **Always SKIP (judge with the conversation context)**
  1. Venting, complaints, chit-chat, greetings.
  2. Confirmations, rejections, option picks, delegation or nudges that only make sense against the previous turn ("yes", "option 2", "you decide", "do what you recommended", "continue", "fix it", "deploy").
  3. A clear single-step tweak or a simple factual question ("make the button blue", "which file is this in?").
  4. Feedback about your previous reply or about this tool ("too long", "is this conflicting with something?").
  5. A message that is already structured, with a clear goal and constraints.
  6. A message that already names a specific skill or workflow.
- **REWRITE only when both hold**
  1. It is a substantive task that needs analysis, debugging, creation, design, planning or coding.
  2. The wording is vague or colloquial, lacks a method or a way to verify the result, or pastes an error, screenshot or material with no instruction, so a rewrite will clearly improve what the AI does.

## 2. Step two: rewrite rules

- **100% fidelity.** Never change, add or widen the user's meaning, scope, numbers or constraints. If a critical fact is missing, do not invent it; mention the gap in a short clause only if it truly blocks the work.
- **Keep the real signal, drop the noise.** For pasted errors, logs or long text keep only the lines that point at the cause or the goal. Drop unrelated fields (for example generic HTTP headers) and long IDs already shown earlier in the same conversation, unless the user will copy the prompt to another tool.
- **One sentence a pro would write, not a memo.** Default to one natural paragraph of 1 to 4 sentences. No section templates ("Background / Inputs / Constraints"), no long lists unless the original message itself contains several independent requests. Remove stale boilerplate: "act as an expert", "think step by step".
- **Ask for how experts work, with outside checks.** Point to first-hand material (logs, code, raw data, primary docs), the methods and tools practitioners really use, and an external way to verify the result. Never ask the AI to grade its own work. When facts matter, say that unknowns must be reported, not guessed.
- **Match the task type.**
  - Debugging: core error and symptom, evidence from real logs, config and code, a verifiable fix.
  - Coding: target behavior and affected entry points, read current code first, smallest change, verify with a targeted test or run.
  - Research or decision: the core judgment and the criteria, primary sources or real data, state the assumptions.
  - Writing, slides, copy: keep the deliverable; add the audience and what they must understand or decide (turn the noun into a verb), work from source material, cut filler. Do not add "do not guess" to creative work.
  - Broad goals: do not invent requirements; ask for the current state, the main bottleneck, the options and a concrete first step.

## 3. Output format (rewritten prompt plus one confirmation line, nothing else)

Write the heading, the confirmation line and the prompt in the user's language.

```markdown
### Optimized Prompt

> <one short natural paragraph, no sub-headings>

Use this prompt? (approve / edit / use original)
```

- Never output change notes, explanations, optional "stretch" ideas, before/after comparisons or any mention of the routing decision.
- Keep the structure exactly: a `###` heading, one blockquote, one confirmation line. Hooks recognize the confirmation turn by this shape in any language.
- If the user asks to optimize without executing, output only the optimized text.

### Examples

1. Creative task. Original: `make a deck introducing the new product`
   > Draft the structure and slide-by-slide copy for a new-product deck that lets busy decision makers grasp in a few minutes what problem it solves, why it works and how to try it next; build it from the real product materials, mark missing numbers as blanks instead of inventing them, and avoid empty slogans.
2. Pasted error, noise removed. Original: `<a pasted 400 error with generic response headers, a trace ID and "User location is not supported for the API use.">`
   > For the `HTTP 400 FAILED_PRECONDITION` ("User location is not supported for the API use.") in the error above, check the machine's real network path, proxy settings and egress region to find what triggers the location restriction and give verified steps to fix it; if the network facts are missing, say what is unknown instead of guessing.
3. Language is preserved. Original: `hazme una presentación del producto nuevo`
   > Prepara la estructura y el texto de cada diapositiva de una presentación del producto nuevo, pensada para que quienes deciden entiendan en pocos minutos qué problema resuelve y cuál es el siguiente paso; usa los materiales reales del producto y deja en blanco los datos que falten en lugar de inventarlos.

## 4. After the user replies

- **Approve** (optionally with extra details): execute the final prompt immediately, do not optimize again. **Edit**: revise and show it again (if they say "edit and just run it", run it). **Use original**: execute the original wording exactly.
- Commands (when a hook is installed): `/prompt-optimizer on | off | status | default on | default off`; `/prompt-optimizer <text>` forces one rewrite even when auto mode is off; start a message with `raw:` to bypass once.
