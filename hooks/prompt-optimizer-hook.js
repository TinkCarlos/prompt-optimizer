#!/usr/bin/env node
'use strict';
// Cross-host UserPromptSubmit hook for prompt-optimizer (Claude Code / Codex).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOST = (process.argv[2] || 'claude').toLowerCase();
const STATE_ROOT = process.env.PROMPT_OPTIMIZER_STATE_DIR || path.join(os.homedir(), '.agents', 'hooks-state', 'prompt-optimizer');
const DEFAULT_NEXT_MODE = HOST === 'codex' ? 'off' : 'on';
const DEFAULT_SKILL = HOST === 'codex'
  ? path.join(os.homedir(), '.codex', 'skills', 'prompt-optimizer', 'SKILL.md')
  : path.join(os.homedir(), '.claude', 'skills', 'prompt-optimizer', 'SKILL.md');
const SKILL_PATH = process.env.PROMPT_OPTIMIZER_SKILL_PATH || DEFAULT_SKILL;

const BYPASS_PREFIX_RE = /^(?:(?:raw|原文|直接)\s*[:：]|(?:不优化|跳过优化)(?:\s*[:：]|\s|$))/i;
const PURE_ACK_RE = /^(?:同意|确认|好的?|好了|可以|可以了|行|行了|嗯|是的?|对|收到|明白|知道了|了解|懂了|没事了|不用改了|弄好了|搞定了|完成了|做完了|登好了|登录好了|绑好了|谢谢|感谢|没问题|按这个来?|就这样|发吧|执行|按原话|跳过优化|跳过|不用了|取消|算了|停止|ok|okay|yes|no|y|n|lgtm|looks\s+good|选\s*\d+|第\s*\d+\s*[个项条]?|sí|si|vale|gracias|oui|merci|ja|danke|はい|了解です?|ありがとう|네|좋아요|감사합니다|да|спасибо|[a-d1-4])$/i;
const ACTION_ACK_RE = /^(?:继续|go|continue|proceed)$/i;
const ACK_LEAD_RE = /^(?:同意|确认|好的|好了|弄好了|搞定了|继续|可以|没问题|按这个来?|就这样|发吧|执行|按原话|跳过优化)(?:[，,。.！!\s]+|$)/i;
const SHORT_DELEGATION_TAIL_RE = /^(?:(?:那就|那|请)?(?:你来帮我|你来|你帮我|帮我|直接|先)?(?:继续|弄|绑|搞|跑|试|查|看|修|改|发|推|提|建|装|配|同步|部署|上线|验证|测试|处理)(?:一下|吧|呗)?)$/;
const SHORT_FOLLOWUP_RE = /^(?:(?:下面|接下来|下一步|然后|后面)(?:该|要)?(?:做什么|怎么做|干什么|呢)|下一步(?:呢)?|继续吧|然后呢)[？?！!。.]*$/i;
const CONTEXT_ONLY_RE = /^(?:you decide|up to you|your call|do what you (?:recommend|suggest)|go ahead|do it|(?:fix|deploy|ship|publish|commit|push)(?: it)?|你(?:自己|来)?(?:决定|定吧?|看着办|安排吧?)|听你的|按照?你(?:的)?(?:推荐|建议|说|方案|计划)的?(?:做|来|办|改)?(?:吧)?|(?:那就)?(?:修复|修吧|改吧|部署|部署上线|上线|发布|提交|推送|开始|开始吧|开干|做吧|干吧|去做吧)(?:吧)?)$/i;
const PROSE_WORDS_RE = /\b(?:is|are|was|were|has|have|had|does|do|did|can|could|should|would|will|keeps?|makes?|please|help|fix|optimize|redesign|investigate|explain|why|how|what|when|where|our|my|the|this|that|website|page|app|module|workflow)\b/i;
const SINGLE_LINE_CMD_RE = /^(?:pwd|git\s+(?:status|diff|log|branch|checkout|switch|pull|push|fetch|add|commit|stash|rebase|merge|reset|restore|show|tag|remote|clone|init|rev-parse|cherry-pick|worktree)(?:\s+.*)?|(?:npm|pnpm|yarn|bun)\s+(?:run|test|install|i|add|remove|rm|build|dev|start|lint|exec|dlx|ci|update|outdated|audit|ls|list|pack|publish|-v|--version)(?:\s+.*)?|(?:pytest|vitest|jest)(?:\s+(?:-[\w-]+|[\w./:=*?-]+))*|(?:ls|cd|cat|rg|grep)(?:\s+(?:-[\w-]+|['"][^'"]+['"]|[^\s,;?!]+)){0,4})$/;
// Skip bare single-token /skill, @mention, $skill calls and built-in host control commands,
// but let `/skill <task body>` or `@file <task body>` pass through to the router.
const CONTROL_CMD_RE = /^\/(?:compact|clear|plan|goal|schedule|browser|grill-me|teamwork|learn|boost|hooks?|help|status|model|models|config|permissions|mcp|memory|plugins?|login|logout|resume|rewind|rename|cost|doctor|init|exit|quit|ponytail(?:[:：][\w-]+)?)(?:\s|$)/i;
const MACHINE_RE = /^\s*(?:<\\?~?(?:hook_prompt|system-reminder|task-notification|cross-session-message|side-sessions-event|ci-monitor-event|send_user_message_question_reply)\b|\[(?:KROUTER_PROACTIVE|LMEMORY_PROACTIVE|PROMPT-OPTIMIZER)\b)/i;
const OPTIMIZER_HEADING_RE = /^#{2,4}\s*(?:优化后的提问|优化后的提示词|Optimized Prompt)(?:$|[\s:：\-—(（])/i;
const SKILL_META_RE = /(?:(?:这个|该|当前|本|此)\s*(?:skill|技能|hook|钩子|扩展|插件|脚本|提示词优化器)|SKILL\.md|\b(?:this|the)\s+(?:skill|hook|extension|plugin|script|repo|readme|prompt-optimizer)\b|^(?:(?:还有|有|存在|哪里有)(?:什么|啥)?问题|为什么(?:没触发|不触发|会触发|没生效|不生效|老是|总是)|(?:怎么|如何)(?:用|安装|配置|工作|触发|关闭|开启|修复|优化)|(?:审查|检查|修复|优化|改进|重构|调试)(?:一下)?(?:这个|该|当前|本)?\s*(?:skill|技能|hook|钩子|扩展|插件|脚本)|what(?:'s| is) wrong|any (?:issues?|bugs?|problems?)|how does (?:this|it) work|why (?:didn't|did|doesn't|isn't) (?:this|it)|(?:review|audit|inspect|debug|fix|edit|update|refactor|improve)\s+(?:this|the|your|its)?\s*(?:skill|hook|extension|plugin|script|prompt-optimizer)\b))/i;
const STATE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_TRANSCRIPT_SCAN_BYTES = 64 * 1024 * 1024;
const TRANSCRIPT_CHUNK_BYTES = 4 * 1024 * 1024;

function isControlCommand(text) {
  return /^[/@$][^\s]+$/.test(text) || CONTROL_CMD_RE.test(text);
}

function isConfigArg(argText) {
  const lower = String(argText || '').trim().toLowerCase();
  return !lower || lower === 'on' || lower === 'off' || lower === 'status' ||
    lower === 'default on' || lower === 'default off' ||
    lower === 'next on' || lower === 'next off' ||
    lower === 'next default on' || lower === 'next default off';
}

function isSkillMetaRequest(argText) {
  return SKILL_META_RE.test(String(argText || '').trim());
}

function isSingleLineCliCommand(text) {
  if (!text || text.includes('\n')) return false;
  if (/[,?!。，？！\u4e00-\u9fff]/.test(text)) return false;
  if (PROSE_WORDS_RE.test(text.replace(/(['"]).*?\1/g, ''))) return false;
  return SINGLE_LINE_CMD_RE.test(text);
}

function stripCodeFences(text) {
  const lines = String(text || '').split(/\r?\n/);
  const kept = [];
  let fenceChar = '';
  let fenceLen = 0;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!fenceChar) {
      const open = trimmed.match(/^(`{3,}|~{3,})/);
      if (open) {
        fenceChar = open[1][0];
        fenceLen = open[1].length;
        continue;
      }
      kept.push(line);
    } else {
      const close = trimmed.match(/^(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        fenceChar = '';
        fenceLen = 0;
      }
    }
  }
  return kept.join('\n').trim();
}

// Language-neutral: a short reply made of a heading immediately followed by a blockquote (and confirmation line) is the optimized prompt.
function looksLikeOptimizedPrompt(text) {
  const t = stripCodeFences(text);
  if (!t || t.length > 3000) return false;
  if (/(?:^|\n)---+\s*(?:\n|$)/.test(t)) return false;
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  if (!/^#{2,4}\s+\S/.test(lines[0])) return false;
  if (lines.slice(1).some((l) => /^#{1,6}\s+\S/.test(l))) return false;
  if (!/^>\s*\S/.test(lines[1])) return false;
  let idx = 1;
  while (idx < lines.length && /^>/.test(lines[idx])) idx++;
  const trailing = lines.slice(idx);
  if (trailing.length > 2) return false;
  if (OPTIMIZER_HEADING_RE.test(lines[0])) return true;
  if (t.length > 2000 || lines.length > 12 || trailing.length === 0) return false;
  if (/^>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(lines[1])) return false;
  return true;
}

function unwrapHarnessPrompt(text) {
  const s = String(text || '').trim();
  if (!s || !s.includes('<user_request>')) return s;
  const m = s.match(/^(?:<(?:t3_code_instructions|runtime_info)\b[^>]*>[\s\S]*?<\/(?:t3_code_instructions|runtime_info)>\s*)*<user_request>([\s\S]*)<\/user_request>(?:\s*<(?:t3_code_instructions|runtime_info)\b[^>]*>[\s\S]*?<\/(?:t3_code_instructions|runtime_info)>)*\s*$/);
  return m ? m[1].trim() : s;
}

function out(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj) + '\n');
}

function hashId(id) {
  return crypto.createHash('sha256').update(String(id || 'default')).digest('hex').slice(0, 16);
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function maybePruneStateDir(dir) {
  try {
    const marker = path.join(dir, '.last-prune');
    const now = Date.now();
    try {
      const st = fs.statSync(marker);
      if (now - st.mtimeMs < PRUNE_INTERVAL_MS) return;
    } catch (_) {}
    atomicWrite(marker, String(now));
    for (const name of fs.readdirSync(dir)) {
      if (!/^(?:(?:[a-z]+-)?session-|turn-)[0-9a-f]+\.json(?:\.tmp-\d+)?$/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > STATE_TTL_MS) fs.unlinkSync(full);
      } catch (_) {}
    }
  } catch (_) {}
}

function defaultModeFile() {
  return path.join(STATE_ROOT, 'default-mode.txt');
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

function nextDefaultModeFile() {
  return path.join(STATE_ROOT, HOST + '-next-default-mode.txt');
}

function readNextDefaultMode() {
  try {
    const m = fs.readFileSync(nextDefaultModeFile(), 'utf8').trim().toLowerCase();
    if (m === 'on' || m === 'off') return m;
  } catch (_) {}
  return DEFAULT_NEXT_MODE;
}

function writeNextDefaultMode(mode) {
  try {
    atomicWrite(nextDefaultModeFile(), mode);
  } catch (_) {}
}

function sessionFile(sessionId) {
  return path.join(STATE_ROOT, HOST + '-session-' + hashId(sessionId) + '.json');
}

function readSession(sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFile(sessionId), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      const mode = parsed.mode === 'on' || parsed.mode === 'off' ? parsed.mode : null;
      const nextMode = parsed.nextMode === 'on' || parsed.nextMode === 'off' ? parsed.nextMode : null;
      return { mode, nextMode, awaitingConfirm: Boolean(parsed.awaitingConfirm) };
    }
  } catch (_) {}
  return { mode: null, nextMode: null, awaitingConfirm: false };
}

function writeSession(sessionId, state) {
  try {
    atomicWrite(sessionFile(sessionId), JSON.stringify({
      mode: state.mode === 'on' || state.mode === 'off' ? state.mode : null,
      nextMode: state.nextMode === 'on' || state.nextMode === 'off' ? state.nextMode : null,
      awaitingConfirm: Boolean(state.awaitingConfirm),
    }));
    maybePruneStateDir(STATE_ROOT);
  } catch (_) {}
}

function resolveModes(session) {
  const rewriteEnabled = (session.mode || readDefaultMode()) === 'on';
  let nextEnabled;
  if (session.nextMode === 'on' || session.nextMode === 'off') {
    nextEnabled = session.nextMode === 'on';
  } else if (!rewriteEnabled) {
    nextEnabled = false;
  } else {
    nextEnabled = readNextDefaultMode() === 'on';
  }
  return { rewriteEnabled, nextEnabled };
}

function extractClaudeCodexText(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (typeof entry.content === 'string') return entry.content;
  const msg = entry.message;
  if (msg && typeof msg.content === 'string') return msg.content;
  const parts = Array.isArray(msg && msg.content) ? msg.content : (Array.isArray(entry.content) ? entry.content : null);
  if (parts) {
    return parts.map((p) => (p && typeof p === 'object' && p.type === 'text' ? String(p.text || '') : '')).filter(Boolean).join('\n');
  }
  const payload = entry.payload;
  if (payload && payload.type === 'message' && Array.isArray(payload.content)) {
    return payload.content.map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
  }
  return '';
}

function getEntryRole(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.type === 'user' || entry.role === 'user') return 'user';
  if (entry.type === 'assistant' || entry.role === 'assistant') return 'assistant';
  if (entry.message && (entry.message.role === 'user' || entry.message.role === 'assistant')) return entry.message.role;
  if (entry.type === 'response_item' && entry.payload && entry.payload.type === 'message') {
    if (entry.payload.role === 'user' || entry.payload.role === 'assistant') return entry.payload.role;
  }
  return null;
}

function isCompactionEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.type === 'compacted' || entry.isCompactSummary) return true;
  if (entry.type === 'system' && entry.subtype === 'compact_boundary') return true;
  if (entry.payload && typeof entry.payload === 'object' &&
      (entry.payload.type === 'compacted' || entry.payload.type === 'context_compacted')) {
    return true;
  }
  return false;
}

function readHostTranscriptSlice(fd, start, end) {
  const len = end - start;
  if (len <= 0) return { rows: [], firstCompleteOffset: start };
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, start);
  let firstCompleteOffset = start;
  let contentBuf = buf;
  if (start > 0) {
    const nlIdx = buf.indexOf(0x0a);
    if (nlIdx === -1) {
      return { rows: [], firstCompleteOffset: end };
    }
    firstCompleteOffset = start + nlIdx + 1;
    contentBuf = buf.subarray(nlIdx + 1);
  }
  const lines = contentBuf.toString('utf8').split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const d = JSON.parse(line);
      if (d && typeof d === 'object') rows.push(d);
    } catch (_) {}
  }
  return { rows, firstCompleteOffset };
}

function scanHostRows(rows, normalizedCur, state) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const entry = rows[i];
    if (isCompactionEntry(entry)) {
      return { hasTranscriptTruth: true, lastReplyWasOptimizerPrompt: false };
    }
    const role = getEntryRole(entry);
    if (role === 'assistant') {
      const text = extractClaudeCodexText(entry).trim();
      if (!text) {
        state.sawPostUserActivity = true;
        continue;
      }
      return { hasTranscriptTruth: true, lastReplyWasOptimizerPrompt: looksLikeOptimizedPrompt(text) };
    }
    if (role === 'user') {
      const uText = unwrapHarnessPrompt(extractClaudeCodexText(entry));
      // Tool results in Claude Code appear as role='user' with empty text; do not treat as a human turn boundary.
      if (!uText) {
        state.sawPostUserActivity = true;
        continue;
      }
      if (!state.skippedCurrentUser && !state.sawPostUserActivity && normalizedCur && uText === normalizedCur) {
        state.skippedCurrentUser = true;
        continue;
      }
      // Hit an earlier user turn before any assistant text reply (e.g., tool-only or interrupted turn).
      return { hasTranscriptTruth: true, lastReplyWasOptimizerPrompt: false };
    }
  }
  return null;
}

function inspectHostTranscript(tpath, curPrompt) {
  const result = { hasTranscriptTruth: false, lastReplyWasOptimizerPrompt: false };
  if (!tpath) return result;
  const normalizedCur = unwrapHarnessPrompt(curPrompt);
  let fd = null;
  try {
    const size = fs.statSync(tpath).size;
    fd = fs.openSync(tpath, 'r');
    let tailFirstComplete = size;
    let tailState = { skippedCurrentUser: false, sawPostUserActivity: false };
    for (const maxBytes of [256 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
      const start = Math.max(0, size - maxBytes);
      const slice = readHostTranscriptSlice(fd, start, size);
      tailFirstComplete = slice.firstCompleteOffset;
      tailState = { skippedCurrentUser: false, sawPostUserActivity: false };
      const found = scanHostRows(slice.rows, normalizedCur, tailState);
      if (found) return found;
      if (start === 0) {
        return { hasTranscriptTruth: true, lastReplyWasOptimizerPrompt: false };
      }
    }
    if (size > 4 * 1024 * 1024) {
      const floor = Math.max(0, size - MAX_TRANSCRIPT_SCAN_BYTES);
      let cursor = size - 4 * 1024 * 1024;
      let chunkEnd = tailFirstComplete;
      while (cursor > floor) {
        const nextStart = Math.max(floor, cursor - TRANSCRIPT_CHUNK_BYTES);
        const slice = readHostTranscriptSlice(fd, nextStart, chunkEnd);
        const found = scanHostRows(slice.rows, normalizedCur, tailState);
        if (found) return found;
        chunkEnd = slice.firstCompleteOffset;
        cursor = nextStart;
      }
      if (floor === 0) {
        return { hasTranscriptTruth: true, lastReplyWasOptimizerPrompt: false };
      }
    }
  } catch (_) {
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
  return result;
}

function wrapContext(text, eventName) {
  return {
    hookSpecificOutput: {
      hookEventName: eventName || 'UserPromptSubmit',
      additionalContext: text,
    },
  };
}

function gateInstruction(isExplicit) {
  if (isExplicit) {
    return [
      '[PROMPT-OPTIMIZER EXPLICIT]',
      `The user explicitly invoked /prompt-optimizer. Skip the REWRITE/SKIP routing and follow ${SKILL_PATH} (sections 2 and 3) directly.`,
      '- Preserve 100% of the original intent, scope, constraints and exact identifiers/paths; drop irrelevant noise (keep IDs if the user will copy to another tool); write one short natural paragraph (no section templates, no long lists).',
      "- Reply in the user's language. Output only the optimized-prompt heading, the prompt in a blockquote, and one confirmation line (approve / edit / use original)—unless the user explicitly asked to optimize without executing, in which case output only the optimized prompt text. Do not execute the task or modify files.",
    ].join('\n');
  }
  return [
    '[PROMPT-OPTIMIZER ROUTER]',
    "Silently decide from context whether the user's latest message is worth rewriting: REWRITE or SKIP (for both Turn 1 and follow-up turns).",
    `- REWRITE when the message asks for substantive work (new or follow-up redesign, bug fix, feature, revision) AND is vague, subjective, colloquial, lacks criteria/verification, or pastes an error/screenshot with no instruction (criticizing current output with vague revision wishes is REWRITE). On REWRITE: read ${SKILL_PATH} and follow it; ground follow-ups in established context; reply in the user's language with only the heading, one short blockquote paragraph, and one confirmation line (approve / edit / use original). Do not execute or modify files this turn.`,
    '- SKIP when: venting/chit-chat with no actionable request; confirmations, option picks, delegations ("you decide") or nudges ("continue", "deploy"); a clear single-step edit or simple factual question; meta-commentary about this tool with no new work; an already-concrete prompt (including one copied from a prior next-step suggestion); or a bare/already-concrete skill or command call (vague tasks after `/skill`, `$skill`, or `@file`—or editing that skill—still evaluate for REWRITE with the reference kept intact). On SKIP: do not read SKILL.md or mention routing; act normally.',
  ].join('\n');
}

function nextStepInstruction() {
  return [
    '[PROMPT-OPTIMIZER NEXT-STEP]',
    'Before ending your final reply (even after long tool runs or context compaction), check whether an obvious, high-value next prompt grounded in context and loaded session memory/rules exists: (a) after substantive work with concrete remaining verification, risks, or next steps, or (b) after handing the user a concrete offline/external action to complete and return with results (draft the exact return prompt naming items, counts, and next action). When it exists, ALWAYS append this block at the very end—do not bury it in prose.',
    '- Omit completely (stay silent, never suggest just for the sake of suggesting) when the task is done/self-contained, during optimized-prompt confirmation turns, when asking open-ended clarifying questions, when blocked on login/payment, or for chit-chat/config/trivial Q&A.',
    "- Format: `---` and one short bold localized label, then 1 concrete 1–2 sentence prompt in the user's language and voice (or 2–3 `- ` bullets only at a real fork). Plain text only—no `###`, `>`, or code fences.",
  ].join('\n');
}

function nextStepRefreshInstruction(afterCompaction) {
  const lead = afterCompaction
    ? 'Context was compacted—restoring the active end-of-turn next-step reminder (do not re-run prompt rewriting for this turn):'
    : 'Long-turn reminder (keep this active when you write your final reply; do not re-run prompt rewriting for this turn):';
  return `${lead}\n${nextStepInstruction()}`;
}

function composeInstruction(primary, includeNext) {
  return [primary, includeNext ? nextStepInstruction() : ''].filter(Boolean).join('\n\n');
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

function classifyNonTask(text) {
  if (BYPASS_PREFIX_RE.test(text)) return 'silent';
  if (isSingleLineCliCommand(text)) return 'silent';
  const stripped = text.replace(/^[\s"'`“”‘’（(【\[]+|[\s"'`“”‘’）)】\]。，,！!？?；;：:.]+$/g, '');
  if (!stripped || PURE_ACK_RE.test(stripped)) return 'silent';
  if (ACTION_ACK_RE.test(stripped) || SHORT_FOLLOWUP_RE.test(stripped) || CONTEXT_ONLY_RE.test(stripped)) return 'actionable';
  if (ACK_LEAD_RE.test(stripped)) {
    const tail = stripped.replace(ACK_LEAD_RE, '').trim();
    if (!tail) return 'silent';
    if (
      PURE_ACK_RE.test(tail) ||
      ACTION_ACK_RE.test(tail) ||
      SHORT_FOLLOWUP_RE.test(tail) ||
      CONTEXT_ONLY_RE.test(tail) ||
      SHORT_DELEGATION_TAIL_RE.test(tail)
    ) {
      return 'actionable';
    }
  }
  return 'task';
}

function handleCommand(sessionId, session, argText) {
  const trimmed = argText.trim();
  const lower = trimmed.toLowerCase();

  if (lower === 'off') {
    const preservedNextMode = session.nextMode === 'off' ? 'off' : null;
    writeSession(sessionId, { mode: 'off', nextMode: preservedNextMode, awaitingConfirm: false });
    return out(wrapContext('[PROMPT-OPTIMIZER CONFIG] Automatic prompt optimization (rewrite and next-step suggestions) is now OFF for this session. Tell the user briefly (they can re-enable it with `/prompt-optimizer on`, or enable only next-step suggestions with `/prompt-optimizer next on`) and do nothing else.'));
  }
  if (lower === 'on') {
    writeSession(sessionId, { ...session, mode: 'on', awaitingConfirm: false });
    return out(wrapContext('[PROMPT-OPTIMIZER CONFIG] Automatic prompt optimization is now ON for this session. Tell the user briefly and do nothing else.'));
  }
  if (lower === 'default off' || lower === 'default on') {
    const nextDefault = lower.endsWith('on') ? 'on' : 'off';
    writeDefaultMode(nextDefault);
    return out(wrapContext(`[PROMPT-OPTIMIZER CONFIG] New sessions will now default to \`${nextDefault}\`. Tell the user briefly and do nothing else.`));
  }
  if (lower === 'next off' || lower === 'next on') {
    const nextMode = lower.endsWith('on') ? 'on' : 'off';
    writeSession(sessionId, { ...session, nextMode, awaitingConfirm: false });
    return out(wrapContext(`[PROMPT-OPTIMIZER CONFIG] Post-turn next-step suggestions are now ${nextMode.toUpperCase()} for this session. Tell the user briefly and do nothing else.`));
  }
  if (lower === 'next default off' || lower === 'next default on') {
    const nextDefault = lower.endsWith('on') ? 'on' : 'off';
    writeNextDefaultMode(nextDefault);
    return out(wrapContext(`[PROMPT-OPTIMIZER CONFIG] Post-turn next-step suggestions for new ${HOST} sessions will now default to \`${nextDefault}\`. Tell the user briefly and do nothing else.`));
  }
  if (lower === 'status' || trimmed === '') {
    const defMode = readDefaultMode();
    const defNext = readNextDefaultMode();
    const curMode = session.mode || `${defMode} (inherited default)`;
    const effective = resolveModes(session);
    const curNext = session.nextMode
      ? session.nextMode
      : (!effective.rewriteEnabled ? 'off (follows rewrite off)' : `${defNext} (inherited default)`);
    return out(wrapContext(
      `[PROMPT-OPTIMIZER CONFIG] Rewrite: ${curMode} (default: ${defMode}); Next-step suggestions: ${curNext} (default: ${defNext}). ` +
      'Commands: `/prompt-optimizer on|off|status|default on|default off|next on|next off|next default on|next default off`, or `/prompt-optimizer <prompt to optimize>`; prefix a message with `raw:` to bypass once. Reply to the user with a brief summary.'
    ));
  }

  // Explicit invocation with a payload works even when auto mode is off.
  writeSession(sessionId, { ...session, awaitingConfirm: true });
  return out(wrapContext(gateInstruction(true)));
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
  } catch (_) {
    return;
  }
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch (_) {
    return;
  }
  if (!payload || typeof payload !== 'object') return;

  const sessionId = String(payload.session_id || 'default');
  const session = readSession(sessionId);

  const hookEvent = String(payload.hook_event_name || '');
  const source = String(payload.source || '').toLowerCase();
  if (hookEvent === 'SessionStart' || (!payload.prompt && source === 'compact')) {
    if (session.awaitingConfirm) {
      writeSession(sessionId, { ...session, awaitingConfirm: false });
    }
    if (source === 'compact') {
      const { nextEnabled } = resolveModes(session);
      if (nextEnabled) {
        return out(wrapContext(nextStepRefreshInstruction(true), 'SessionStart'));
      }
    }
    return;
  }

  const rawPrompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!rawPrompt || MACHINE_RE.test(rawPrompt)) return;
  const prompt = unwrapHarnessPrompt(rawPrompt);
  if (!prompt || MACHINE_RE.test(prompt)) return;

  const cmdMatch = prompt.match(/^[/@$]prompt-optimizer(?:[:：]prompt-optimizer)?(?:\s+([\s\S]*))?$/i);
  const cmdArg = cmdMatch ? (cmdMatch[1] || '').trim() : '';
  const isMetaCmd = Boolean(cmdMatch && cmdArg && !isConfigArg(cmdArg) && isSkillMetaRequest(cmdArg));
  if (cmdMatch && !isMetaCmd) {
    return handleCommand(sessionId, session, cmdMatch[1] || '');
  }

  if (isControlCommand(prompt)) {
    if (session.awaitingConfirm) {
      writeSession(sessionId, { ...session, awaitingConfirm: false });
    }
    return;
  }

  const { rewriteEnabled, nextEnabled } = resolveModes(session);
  if (!rewriteEnabled && !nextEnabled && !session.awaitingConfirm) return;

  const tx = inspectHostTranscript(String(payload.transcript_path || ''), prompt);
  const isAwaiting = rewriteEnabled
    ? (tx.hasTranscriptTruth ? tx.lastReplyWasOptimizerPrompt : session.awaitingConfirm)
    : (session.awaitingConfirm && (tx.hasTranscriptTruth ? tx.lastReplyWasOptimizerPrompt : true));
  if (!isAwaiting && session.awaitingConfirm) {
    writeSession(sessionId, { ...session, awaitingConfirm: false });
  }

  if (isAwaiting) {
    if (BYPASS_PREFIX_RE.test(prompt)) {
      writeSession(sessionId, { ...session, awaitingConfirm: false });
      return;
    }
    const keepExplicitConfirm = !rewriteEnabled && tx.hasTranscriptTruth;
    writeSession(sessionId, { ...session, awaitingConfirm: keepExplicitConfirm });
    return out(wrapContext(composeInstruction(pendingReplyInstruction(), nextEnabled)));
  }

  if (!rewriteEnabled && !nextEnabled) return;

  const kind = classifyNonTask(prompt);
  if (kind === 'silent') return;

  if (kind === 'actionable' || !rewriteEnabled) {
    if (!nextEnabled) return;
    return out(wrapContext(nextStepInstruction()));
  }

  writeSession(sessionId, { ...session, awaitingConfirm: true });
  return out(wrapContext(composeInstruction(gateInstruction(false), nextEnabled)));
}

try {
  main();
} catch (_) {}
