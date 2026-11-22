---
name: prompt-optimizer
description: >-
  Works in any language. Before acting on a user message, decide from the conversation context whether it is worth rewriting (REWRITE or SKIP). Venting, confirmations, single-step tweaks and already-clear messages are skipped silently. When a rewrite is worth it, translate layperson descriptions into accurate domain terms and restate the request as one short, high-signal prompt in the user's own language, preserving intent, scope and constraints 100%, and ask the user to confirm before executing. Use for automatic pre-routing, or when the user asks to "optimize my prompt", "polish this prompt" or runs /prompt-optimizer.
---

# Prompt Optimizer

First decide whether a rewrite is worth it. If it is, turn the user's words into one dense, ready-to-run prompt and wait for confirmation. Always write in the language the user wrote in.

## 1. Step one: decide REWRITE or SKIP from context

- **How to answer**
  - Called as a standalone router (asked for the verdict only): reply with exactly `REWRITE` or `SKIP`, nothing else.
  - Running inline before a normal reply: on **SKIP**, stay completely silent about it. Do not mention routing or rewriting, do not load the rest of this skill, just answer or act. On **REWRITE**, continue to section 2.
  - The user names this skill explicitly (`/prompt-optimizer <text>`, "optimize this prompt"): skip the decision and go to section 2.
- **Always SKIP (judge with the conversation context)**
  1. Pure venting, complaints, chit-chat or greetings with **no actionable request** ("ugh it broke again", "good morning").
  2. Pure confirmations, rejections, option picks, delegations or nudges ("yes", "option 2", "you decide", "do what you recommended", "continue", "fix it", "deploy").
  3. A clear, unambiguous single-step edit or simple factual question ("change this button to `#2563eb`", "which file defines X?", "did you deploy it?").
  4. Pure meta-commentary about this tool or asking how something worked, with no new build/design/fix work.
  5. A message that is already concrete and specific (clear target, explicit criteria/constraints and verifiable outcome).
  6. A bare skill/command call with no task body, or a skill call whose instructions are already concrete and complete. (If the user leads with `/skill`, `$skill` or `@file` followed by a vague task—or asks to edit or optimize that skill itself—still evaluate it for REWRITE and keep the original reference intact.)
- **REWRITE whenever both hold (first turn OR follow-up turns in the same conversation)**
  1. It asks the AI to do substantive work—including a **follow-up requirement, redesign, bug fix, feature addition or revision** in an ongoing conversation, not only the first turn.
  2. The wording is vague, subjective, colloquial, uses everyday layperson descriptions where precise domain terminology removes ambiguity (for example: "make a page that looks like glass", "wait a moment after typing before searching", "make it look better, no green background", "these sections look too plain, make them cooler", "why does only one animation play, make hover play all of them"), or lacks concrete criteria, method or verification, or pastes an error, screenshot or material with no instruction.
  - *Important*: A follow-up message that criticizes the current output **and** asks for changes with subjective or vague criteria is **REWRITE**, not SKIP. When rewriting a follow-up turn, ground it in the concrete module, page or feature already established in the conversation without inventing unstated requirements.

## 2. Step two: rewrite rules

- **100% fidelity.** Never change, add or widen the user's meaning, scope, numbers or constraints. If a critical fact is missing, do not invent it; mention the gap in a short clause only if it truly blocks the work.
- **Translate layperson wording into domain terms.** When the user describes an effect, behavior, symptom, style, workflow or tool need in plain everyday language, express it with the accurate domain terminology, established pattern, technique or tool category practitioners use so the executing model maps directly to the right concept with less ambiguity (for example: "looks like glass" -> glassmorphism with translucent frosted surfaces and backdrop blur; "wait after typing before searching" -> input debounce; "don't let two edits overwrite each other" -> optimistic locking or conflict detection; "pull text out of screenshots" -> OCR). Write the term naturally in the user's language, optionally pairing the widely used technical term in parentheses when it helps disambiguate, and keep the intended observable effect clear so a non-expert can immediately confirm you understood them. Never over-specify: do not guess an unverified root cause for a bug, do not silently lock in an unmentioned framework, library or vendor unless it is already established in the context, and do not pick an arbitrary specialist meaning when the user's phrasing is genuinely open.
- **Keep the real signal, drop the noise.** For pasted errors, logs or long text keep only the lines that point at the cause or the goal. Drop unrelated fields (for example generic HTTP headers) and long IDs already shown earlier in the same conversation, unless the user will copy the prompt to another tool.
- **One sentence a pro would write, not a memo.** Default to one natural paragraph of 1 to 4 sentences. No section templates ("Background / Inputs / Constraints"), no long lists unless the original message itself contains several independent requests. Remove stale boilerplate: "act as an expert", "think step by step".
- **Ask for how experts work, with outside checks.** Point to first-hand material (logs, code, raw data, primary docs), the methods and tools practitioners really use, and an external way to verify the result. Never ask the AI to grade its own work. When facts matter, say that unknowns must be reported, not guessed.
- **Match the task type.**
  - Debugging: translate layperson symptoms into clear failure classes and diagnostic angles without guessing the root cause; keep core error/symptom, evidence from real logs, config and code, and a verifiable fix.
  - Coding: translate everyday behavior descriptions into standard software patterns, mechanisms or tool categories (without forcing an unmentioned stack); name target behavior and affected entry points, read current code first, smallest change, verify with a targeted test or run.
  - Design / UI: translate colloquial visual or interaction descriptions into standard design styles, layout/hierarchy terms, interactive states and readability/contrast criteria; verify against the rendered UI and real interactions. When the user asks for bold, "cool", 3D or high-impact creative visuals, preserve a high technical/creative ceiling (such as real-time WebGL/shader scenes, PBR materials/lighting or spatial storytelling) instead of narrowing their request down to tame CSS hover/tilt tweaks or burying the creative goal under overly defensive restraint.
  - Research or decision: name the core judgment, evaluation criteria and relevant domain metrics; rely on primary sources or real data and state assumptions.
  - Writing, slides, copy: keep the deliverable; turn vague tone or impact wishes into concrete editorial voice, structure and audience action (turn the noun into a verb), work from source material, cut filler. Do not add "do not guess" to creative work.
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
4. Layperson wording to domain terms. Original: `make a login page that looks like glass`
   > Design and build a login page using a glassmorphism style (translucent frosted panels with backdrop blur, subtle borders and layered depth), keeping form hierarchy, text contrast and focus/error states clear and readable; verify the rendered page and interactive states visually.

## 4. After the user replies

- **Approve** (optionally with extra details): execute the final prompt immediately, do not optimize again. **Edit**: revise and show it again (if they say "edit and just run it", run it). **Use original**: execute the original wording exactly.
- Commands (when a hook is installed): `/prompt-optimizer on | off | status | default on | default off`; `/prompt-optimizer <text>` forces one rewrite even when auto mode is off; start a message with `raw:` to bypass once.
