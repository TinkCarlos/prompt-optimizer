#!/usr/bin/env node
'use strict';
// Antigravity PreInvocation hook for prompt-optimizer.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_ROOT = process.env.AGY_HOOK_STATE_DIR || path.join(os.homedir(), '.gemini', 'config', 'hooks', 'state');
const STATE_DIR = path.join(STATE_ROOT, 'prompt-optimizer');
const SKILL_PATH = process.env.PROMPT_OPTIMIZER_SKILL_PATH || path.join(os.homedir(), '.gemini', 'config', 'skills', 'prompt-optimizer', 'SKILL.md');

const BYPASS_PREFIX_RE = /^(?:raw\s*[:：]|(?:原文|直接|不优化|跳过优化)(?:\s*[:：]|\s|$))/i;
const PURE_ACK_RE = /^(?:同意|确认|好的?|好了|可以|可以了|行|行了|嗯|是的?|对|收到|明白|知道了|了解|懂了|没事了|不用改了|弄好了|搞定了|完成了|做完了|登好了|登录好了|绑好了|谢谢|感谢|继续|没问题|按这个来?|就这样|发吧|执行|按原话|跳过优化|跳过|不用了|取消|算了|停止|ok|okay|yes|no|y|n|go|continue|proceed|lgtm|looks\s+good|选\s*\d+|第\s*\d+\s*[个项条]?|sí|si|vale|gracias|oui|merci|ja|danke|はい|了解です?|ありがとう|네|좋아요|감사합니다|да|спасибо|[a-d1-4])$/i;
const ACK_LEAD_RE = /^(?:同意|确认|好的|好了|弄好了|搞定了|继续|可以|没问题|按这个来?|就这样|发吧|执行|按原话|跳过优化)(?:[，,。.！!\s]|$)/i;
const SHORT_FOLLOWUP_RE = /^(?:(?:下面|接下来|下一步|然后|后面)(?:该|要)?(?:做什么|怎么做|干什么|呢)|下一步(?:呢)?|继续吧|然后呢)[？?！!。.]*$/i;
// Delegation and bare context verbs ("你自己决定", "按你推荐的做", "修复") only make sense against the previous turn.
const CONTEXT_ONLY_RE = /^(?:you decide|up to you|your call|do what you (?:recommend|suggest)|go ahead|do it|(?:fix|deploy|ship|publish|commit|push)(?: it)?|你(?:自己|来)?(?:决定|定吧?|看着办|安排吧?)|听你的|按照?你(?:的)?(?:推荐|建议|说|方案|计划)的?(?:做|来|办|改)?(?:吧)?|(?:那就)?(?:修复|修吧|改吧|部署|部署上线|上线|发布|提交|推送|开始|开始吧|开干|做吧|干吧|去做吧)(?:吧)?)$/i;
const SINGLE_LINE_CMD_RE = /^(?:git|npm|pnpm|yarn|bun|pytest|vitest|jest|ls|pwd|cd|cat|rg|grep)\b/i;
const OPTIMIZER_HEADING_RE = /(?:^|\n)#{2,4}\s*(?:优化后的提问|Optimized Prompt)/i;

// Language-neutral: a short reply that is a heading plus a blockquote is the optimized prompt, whatever the language.
function looksLikeOptimizedPrompt(text) {
  const t = String(text || '').replace(/```[\s\S]*?```/g, '').trim();
  if (!t) return false;
  if (OPTIMIZER_HEADING_RE.test(t)) return true;
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  return t.length <= 1500 && lines.length <= 8 && /^#{2,4}\s+\S/.test(lines[0]) && lines.some((l) => /^>\s*\S/.test(l));
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function hashId(id) {
  return crypto.createHash('sha256').update(String(id || 'default')).digest('hex').slice(0, 16);
}

function extractUserText(raw) {
  const s = String(raw || '').replace(/<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/g, '');
  const matches = [...s.matchAll(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/g)];
  if (matches.length) {
    return matches.map((m) => m[1].trim()).filter(Boolean).join('\n');
  }
  return s.trim();
}

function isMachinePrompt(raw) {
  const s = String(raw || '');
  return !s.trim() || /^\s*(?:\[plan review(?:\s+due)?\]|<(?:hook_prompt|system-reminder|task-notification)\b)/i.test(s);
}

function isExplicitUserInput(d) {
  return Boolean(d && d.type === 'USER_INPUT' && (d.source === 'USER_EXPLICIT' || d.source == null));
}

function inspectTranscript(payload) {
  const result = { stepKey: null, hasTranscriptTruth: false, lastReplyWasOptimizerPrompt: false };
  const tpath = String(payload.transcriptPath || '');
  if (!tpath) return result;
  try {
    // Long agent turns can exceed any fixed tail window, so widen until the latest
    // user input and the reply before it are both visible.
    const size = fs.statSync(tpath).size;
    for (const maxBytes of [256 * 1024, 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024]) {
      const start = Math.max(0, size - maxBytes);
      const fd = fs.openSync(tpath, 'r');
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split(/\r?\n/);
      if (start > 0 && lines.length) lines.shift();

      const rows = [];
      for (const line of lines) {
        if (!line) continue;
        try {
          const d = JSON.parse(line);
          if (d && typeof d === 'object') rows.push(d);
        } catch (_) {}
      }

      let latestUserIdx = -1;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (isExplicitUserInput(rows[i])) {
          latestUserIdx = i;
          break;
        }
      }

      let decided = false;
      let replyIsPrompt = false;
      if (latestUserIdx >= 0) {
        for (let i = latestUserIdx - 1; i >= 0; i--) {
          const d = rows[i];
          if (isExplicitUserInput(d)) {
            decided = true;
            break;
          }
          if (d.type === 'PLANNER_RESPONSE') {
            const content = String(d.content || '').trim();
            if (!content) continue;
            decided = true;
            replyIsPrompt = looksLikeOptimizedPrompt(content);
            break;
          }
        }
        if (start === 0) decided = true;
      }

      if (latestUserIdx >= 0 && decided) {
        const step = rows[latestUserIdx].step_index;
        result.stepKey = step != null ? 'step:' + step : null;
        result.hasTranscriptTruth = true;
        result.lastReplyWasOptimizerPrompt = replyIsPrompt;
        break;
      }
      if (start === 0) break;
    }
  } catch (_) {}
  return result;
}

function turnKeys(payload, stepKey) {
  const digest = crypto.createHash('sha256').update(String(payload.lastUserInput || '')).digest('hex').slice(0, 16);
  const initKey = payload.initialNumSteps != null ? 'init:' + String(payload.initialNumSteps) + ':' + digest : null;
  const fallbackKey = stepKey || initKey || 'raw:' + digest;
  return { stepKey, initKey, fallbackKey };
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function dedupeTurn(convId, payload, stepKey) {
  const cur = turnKeys(payload, stepKey);
  const file = path.join(STATE_DIR, 'turn-' + hashId(convId) + '.json');
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (prev && typeof prev === 'object') {
      if ((cur.initKey && prev.initKey === cur.initKey) ||
          (cur.stepKey && prev.stepKey === cur.stepKey) ||
          prev.fallbackKey === cur.fallbackKey) {
        return false;
      }
    }
  } catch (_) {}
  try {
    atomicWrite(file, JSON.stringify(cur));
  } catch (_) {}
  return true;
}

function defaultModeFile() {
  return path.join(STATE_DIR, 'default-mode.txt');
}

function readDefaultMode() {
  try {
    const m = fs.readFileSync(defaultModeFile(), 'utf8').trim().toLowerCase();
    if (m === 'on' || m === 'off') return m;
  } catch (_) {}
  return 'on';
}

function writeDefaultMode(mode) {
  try {
    atomicWrite(defaultModeFile(), mode);
  } catch (_) {}
}

function sessionFile(convId) {
  return path.join(STATE_DIR, 'session-' + hashId(convId) + '.json');
}

function readSession(convId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFile(convId), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      const mode = parsed.mode === 'on' || parsed.mode === 'off' ? parsed.mode : null;
      return { mode, awaitingConfirm: Boolean(parsed.awaitingConfirm) };
    }
  } catch (_) {}
  return { mode: null, awaitingConfirm: false };
}

function writeSession(convId, state) {
  try {
    const clean = {
      mode: state.mode === 'on' || state.mode === 'off' ? state.mode : null,
      awaitingConfirm: Boolean(state.awaitingConfirm),
    };
    atomicWrite(sessionFile(convId), JSON.stringify(clean));
  } catch (_) {}
}

function injectOutput(text) {
  return { injectSteps: [{ systemMessage: { systemMessage: text } }] };
}

function gateInstruction(isExplicit) {
  if (isExplicit) {
    return [
      '[PROMPT-OPTIMIZER EXPLICIT]',
      `The user explicitly invoked /prompt-optimizer. Skip the REWRITE/SKIP routing and follow ${SKILL_PATH} (sections 2 and 3) directly.`,
      '- Preserve 100% of the original intent, scope and constraints; drop irrelevant fields and redundant IDs; write one short natural paragraph (no section templates, no long lists).',
      "- Reply in the same language as the user's message. Output only the optimized-prompt heading, the prompt in a blockquote, and one confirmation line (approve / edit / use original), localized to the user's language. No change notes, no extra suggestions. Do not execute the original task or modify files.",
    ].join('\n');
  }
  return [
    '[PROMPT-OPTIMIZER ROUTER]',
    "Silently decide, using the conversation context, whether the user's latest message is worth rewriting: REWRITE or SKIP.",
    '- SKIP when: venting, complaints or chit-chat; a confirmation, rejection, option pick, delegation ("you decide") or nudge that only makes sense against the previous turn; a clear single-step tweak or simple factual question; feedback about your previous reply or about this tool; a message that is already clear and complete; or one that already names a specific skill or workflow. On SKIP: do not read SKILL.md, do not mention routing or rewriting in any way, and just answer or act normally.',
    `- REWRITE only when the message is a substantive new task AND its wording is vague, colloquial or lacks a method or verification handle (or it pastes an error or material with no instruction), so that a rewrite clearly improves the result. On REWRITE: read ${SKILL_PATH} and follow it; reply in the user's language with only the optimized-prompt heading, one short blockquote paragraph and one confirmation line (approve / edit / use original). No change notes or extra suggestions. Do not execute the original task or modify files this turn.`,
  ].join('\n');
}

function pendingReplyInstruction() {
  return [
    '[PROMPT-OPTIMIZER PENDING-REPLY]',
    'The user is replying to the optimized prompt you showed in the previous turn. Handle it as follows:',
    '1. If they approve (optionally adding details): execute the original task with the final optimized prompt right away; do not optimize again.',
    '2. If they ask for the original wording ("use original", "raw", "skip"): execute the task exactly as originally written.',
    '3. If they request edits and want to review again: output the revised optimized prompt in the same format and wait (if they say "edit and just run it", run it directly).',
    `4. If they clearly start an unrelated new task: apply [PROMPT-OPTIMIZER ROUTER] to it silently; read ${SKILL_PATH} only if it is worth rewriting, otherwise just handle it.`,
  ].join('\n');
}

function shouldSkipNonTask(text) {
  if (BYPASS_PREFIX_RE.test(text)) return true;
  if (!text.includes('\n') && SINGLE_LINE_CMD_RE.test(text)) return true;
  const stripped = text.replace(/^[\s"'`“”‘’（(【\[]+|[\s"'`“”‘’）)】\]。，,！!？?；;：:.]+$/g, '');
  if (!stripped || PURE_ACK_RE.test(stripped) || SHORT_FOLLOWUP_RE.test(stripped) || CONTEXT_ONLY_RE.test(stripped)) return true;
  if (ACK_LEAD_RE.test(text) && text.length <= 40) return true;
  return false;
}

function handleCommand(convId, session, argText) {
  const trimmed = argText.trim();
  const lower = trimmed.toLowerCase();

  if (lower === 'off') {
    writeSession(convId, { mode: 'off', awaitingConfirm: false });
    return out(injectOutput('[PROMPT-OPTIMIZER CONFIG] Automatic prompt optimization is now OFF for this session. Tell the user briefly (they can re-enable it with `/prompt-optimizer on`) and do nothing else.'));
  }
  if (lower === 'on') {
    writeSession(convId, { mode: 'on', awaitingConfirm: false });
    return out(injectOutput('[PROMPT-OPTIMIZER CONFIG] Automatic prompt optimization is now ON for this session. Tell the user briefly and do nothing else.'));
  }
  if (lower === 'default off' || lower === 'default on') {
    const nextDefault = lower.endsWith('on') ? 'on' : 'off';
    writeDefaultMode(nextDefault);
    return out(injectOutput(`[PROMPT-OPTIMIZER CONFIG] New sessions will now default to \`${nextDefault}\`. Tell the user briefly and do nothing else.`));
  }
  if (lower === 'status' || trimmed === '') {
    const defMode = readDefaultMode();
    const curMode = session.mode || `${defMode} (inherited default)`;
    return out(injectOutput(
      `[PROMPT-OPTIMIZER CONFIG] This session: ${curMode}; default for new sessions: ${defMode}. ` +
      'Commands: `/prompt-optimizer on|off|status|default on|default off`, or `/prompt-optimizer <prompt to optimize>`; prefix a message with `raw:` to bypass once. Reply to the user with a brief summary.'
    ));
  }

  // Explicit invocation with a payload works even when auto mode is off.
  writeSession(convId, { ...session, awaitingConfirm: true });
  return out(injectOutput(gateInstruction(true)));
}

function cmdPrompt(payload) {
  const raw = String(payload.lastUserInput || '');
  if (isMachinePrompt(raw)) return out({});

  const convId = String(payload.conversationId || '');
  const tx = inspectTranscript(payload);
  if (!dedupeTurn(convId, payload, tx.stepKey)) return out({});

  const text = extractUserText(raw).trim();
  if (!text) return out({});

  const session = readSession(convId);
  const cmdMatch = text.match(/^[/@$]prompt-optimizer(?:[:：]prompt-optimizer)?(?:\s+([\s\S]*))?$/i);
  if (cmdMatch) {
    return handleCommand(convId, session, cmdMatch[1] || '');
  }

  if (/^[/@$]/.test(text)) {
    if (session.awaitingConfirm) {
      writeSession(convId, { ...session, awaitingConfirm: false });
    }
    return out({});
  }

  // ask_question structured answers (e.g., "A1: ...") should never disrupt pending state.
  if (/^A1:\s/m.test(text)) {
    return out({});
  }

  const isAwaiting = tx.hasTranscriptTruth ? tx.lastReplyWasOptimizerPrompt : session.awaitingConfirm;
  if (!isAwaiting && session.awaitingConfirm) {
    writeSession(convId, { ...session, awaitingConfirm: false });
  }

  if (isAwaiting) {
    if (BYPASS_PREFIX_RE.test(text)) {
      writeSession(convId, { ...session, awaitingConfirm: false });
      return out({});
    }
    writeSession(convId, { ...session, awaitingConfirm: false });
    return out(injectOutput(pendingReplyInstruction()));
  }

  const enabled = (session.mode || readDefaultMode()) === 'on';
  if (!enabled) return out({});

  if (shouldSkipNonTask(text)) return out({});

  writeSession(convId, { ...session, awaitingConfirm: true });
  return out(injectOutput(gateInstruction()));
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {}
  let payload = {};
  try {
    const parsed = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object') payload = parsed;
  } catch (_) {
    return out({});
  }

  try {
    const cmd = process.argv[2] || 'prompt';
    if (cmd === 'prompt') return cmdPrompt(payload);
  } catch (_) {}
  return out({});
}

main();
