'use strict';
// Pi coding agent extension for prompt-optimizer.
// Works both as a standalone file in ~/.pi/agent/extensions/prompt-optimizer.js
// and as a Pi package entry via package.json (`"extensions": ["./hooks/prompt-optimizer-pi.js"]`).

const fs = require('fs');
const os = require('os');
const path = require('path');

const BYPASS_PREFIX_RE = /^(?:raw\s*[:：]|(?:原文|直接|不优化|跳过优化)(?:\s*[:：]|\s|$))/i;
const PURE_ACK_RE = /^(?:同意|确认|好的?|好了|可以|可以了|行|行了|嗯|是的?|对|收到|明白|知道了|了解|懂了|没事了|不用改了|弄好了|搞定了|完成了|做完了|登好了|登录好了|绑好了|谢谢|感谢|继续|没问题|按这个来?|就这样|发吧|执行|按原话|跳过优化|跳过|不用了|取消|算了|停止|ok|okay|yes|no|y|n|go|continue|proceed|lgtm|looks\s+good|选\s*\d+|第\s*\d+\s*[个项条]?|sí|si|vale|gracias|oui|merci|ja|danke|はい|了解です?|ありがとう|네|좋아요|감사합니다|да|спасибо|[a-d1-4])$/i;
const ACK_LEAD_RE = /^(?:同意|确认|好的|好了|弄好了|搞定了|继续|可以|没问题|按这个来?|就这样|发吧|执行|按原话|跳过优化)(?:[，,。.！!\s]|$)/i;
const SHORT_FOLLOWUP_RE = /^(?:(?:下面|接下来|下一步|然后|后面)(?:该|要)?(?:做什么|怎么做|干什么|呢)|下一步(?:呢)?|继续吧|然后呢)[？?！!。.]*$/i;
const CONTEXT_ONLY_RE = /^(?:you decide|up to you|your call|do what you (?:recommend|suggest)|go ahead|do it|(?:fix|deploy|ship|publish|commit|push)(?: it)?|你(?:自己|来)?(?:决定|定吧?|看着办|安排吧?)|听你的|按照?你(?:的)?(?:推荐|建议|说|方案|计划)的?(?:做|来|办|改)?(?:吧)?|(?:那就)?(?:修复|修吧|改吧|部署|部署上线|上线|发布|提交|推送|开始|开始吧|开干|做吧|干吧|去做吧)(?:吧)?)$/i;
const SINGLE_LINE_CMD_RE = /^(?:git|npm|pnpm|yarn|bun|pytest|vitest|jest|ls|pwd|cd|cat|rg|grep)\b/i;
// Skip bare single-token /skill, @mention, $skill calls and built-in host/Pi control commands,
// but let `/skill:name <task body>`, `/skill <task body>` or `@file <task body>` pass through.
const CONTROL_CMD_RE = /^\/(?:compact|clear|plan|goal|schedule|browser|grill-me|teamwork|learn|boost|hooks?|help|status|model|models|config|permissions|mcp|memory|plugins?|login|logout|resume|rewind|rename|cost|doctor|init|exit|quit|ponytail(?:[:：][\w-]+)?|reload|settings|tree|fork|clone|new|name|export|share|session|hotkeys|changelog|copy|thinking|theme|scoped-models|debug)(?:\s|$)/i;
const MACHINE_RE = /^\s*(?:<\\?~?(?:hook_prompt|system-reminder|task-notification|cross-session-message|side-sessions-event|ci-monitor-event|send_user_message_question_reply)\b|\[(?:KROUTER_PROACTIVE|LMEMORY_PROACTIVE|PROMPT-OPTIMIZER)\b)/i;
const BARE_SKILL_BLOCK_RE = /^<skill\b[^>]*>[\s\S]*?<\/skill>\s*$/i;
const OPTIMIZER_HEADING_RE = /(?:^|\n)#{2,4}\s*(?:优化后的提问|优化后的提示词|Optimized Prompt)/i;
const RAW_INPUT_TTL_MS = 30000;
const SECTION_KEY = 'prompt_optimizer';
const ENTRY_TYPE = 'prompt-optimizer-mode';

function getStateRoot() {
  return process.env.PROMPT_OPTIMIZER_STATE_DIR || path.join(os.homedir(), '.agents', 'hooks-state', 'prompt-optimizer');
}

function defaultModeFile() {
  return path.join(getStateRoot(), 'default-mode.txt');
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function readDefaultMode() {
  try {
    const mode = fs.readFileSync(defaultModeFile(), 'utf8').trim().toLowerCase();
    if (mode === 'on' || mode === 'off') return mode;
  } catch (_) {}
  return 'on';
}

function writeDefaultMode(mode) {
  const normalized = mode === 'off' ? 'off' : 'on';
  try {
    atomicWrite(defaultModeFile(), normalized);
  } catch (_) {}
  return normalized;
}

function isControlCommand(text) {
  return /^[/@$][^\s]+$/.test(text) || CONTROL_CMD_RE.test(text);
}

// Language-neutral: a short reply that is a heading plus a blockquote is the optimized prompt, whatever the language.
function looksLikeOptimizedPrompt(text) {
  const t = String(text || '').replace(/```[\s\S]*?```/g, '').trim();
  if (!t) return false;
  if (OPTIMIZER_HEADING_RE.test(t)) return true;
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  return t.length <= 1500 && lines.length <= 8 && /^#{2,4}\s+\S/.test(lines[0]) && lines.some((l) => /^>\s*\S/.test(l));
}

function shouldSkipNonTask(text) {
  if (BYPASS_PREFIX_RE.test(text)) return true;
  if (!text.includes('\n') && SINGLE_LINE_CMD_RE.test(text)) return true;
  const stripped = text.replace(/^[\s"'`“”‘’（(【\[]+|[\s"'`“”‘’）)】\]。，,！!？?；;：:.]+$/g, '');
  if (!stripped || PURE_ACK_RE.test(stripped) || SHORT_FOLLOWUP_RE.test(stripped) || CONTEXT_ONLY_RE.test(stripped)) return true;
  if (ACK_LEAD_RE.test(text) && text.length <= 40) return true;
  return false;
}

function resolveSkillPath(event) {
  const envPath = String(process.env.PROMPT_OPTIMIZER_SKILL_PATH || '').trim();
  if (envPath) return envPath;

  const skills = event && event.systemPromptOptions && Array.isArray(event.systemPromptOptions.skills)
    ? event.systemPromptOptions.skills
    : null;
  if (skills) {
    const found = skills.find((s) => s && s.name === 'prompt-optimizer' && typeof s.filePath === 'string' && s.filePath.trim());
    if (found) return found.filePath.trim();
  }

  const candidates = [
    path.join(os.homedir(), '.pi', 'agent', 'skills', 'prompt-optimizer', 'SKILL.md'),
    path.join(os.homedir(), '.agents', 'skills', 'prompt-optimizer', 'SKILL.md'),
    path.resolve(__dirname, '..', 'SKILL.md'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return path.join(os.homedir(), '.agents', 'skills', 'prompt-optimizer', 'SKILL.md');
}

function resolveSessionMode(entries, fallbackMode) {
  const fallback = fallbackMode === 'off' ? 'off' : 'on';
  if (!Array.isArray(entries)) return fallback;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== 'custom' || entry.customType !== ENTRY_TYPE) continue;
    const mode = entry.data && entry.data.mode;
    if (mode === 'on' || mode === 'off') return mode;
  }
  return fallback;
}

function hasExplicitSessionMode(entries) {
  if (!Array.isArray(entries)) return false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && entry.type === 'custom' && entry.customType === ENTRY_TYPE) {
      const mode = entry.data && entry.data.mode;
      if (mode === 'on' || mode === 'off') return true;
    }
  }
  return false;
}

function extractAssistantText(message) {
  if (!message || message.role !== 'assistant') return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((block) => (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function getLastAssistantText(entries) {
  if (!Array.isArray(entries)) return '';
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== 'message' || !entry.message) continue;
    if (entry.message.role !== 'assistant') continue;
    const text = extractAssistantText(entry.message);
    if (text) return text;
  }
  return '';
}

function gateInstruction(isExplicit, skillPath) {
  if (isExplicit) {
    return [
      '[PROMPT-OPTIMIZER EXPLICIT]',
      `The user explicitly invoked /prompt-optimizer. Skip the REWRITE/SKIP routing and follow ${skillPath} (sections 2 and 3) directly.`,
      '- Preserve 100% of the original intent, scope and constraints; drop irrelevant fields and redundant IDs; write one short natural paragraph (no section templates, no long lists).',
      "- Reply in the same language as the user's message. Output only the optimized-prompt heading, the prompt in a blockquote, and one confirmation line (approve / edit / use original), localized to the user's language. No change notes, no extra suggestions. Do not execute the original task or modify files.",
    ].join('\n');
  }
  return [
    '[PROMPT-OPTIMIZER ROUTER]',
    "Silently decide, using the conversation context, whether the user's latest message is worth rewriting: REWRITE or SKIP. Apply this equally to Turn 1 AND follow-up turns in an ongoing conversation.",
    `- REWRITE whenever the message asks for substantive work (including follow-up requirements, redesigns, bug fixes, feature additions or revisions on the current work) AND its wording is vague, subjective, colloquial or lacks concrete criteria, method or verification (e.g. "make it prettier, no green", "too plain, make it cooler", "why doesn't hover play all of them", or a pasted error/screenshot with no instruction). Criticizing current output AND asking for vague/subjective changes is REWRITE, not SKIP. On REWRITE: read ${skillPath} and follow it; ground follow-up rewrites in the established context; reply in the user's language with only the optimized-prompt heading, one short blockquote paragraph and one confirmation line (approve / edit / use original). No change notes or extra suggestions. Do not execute the task or modify files this turn.`,
    `- SKIP only when: pure venting/complaints/chit-chat with no actionable request; pure confirmations, rejections, option picks, delegations ("you decide") or nudges ("continue", "deploy"); a clear single-step edit or simple factual question; pure meta-commentary about this tool with no new work; a message whose goal, criteria and constraints are already concrete; or a bare skill/command call (or one with already-concrete instructions). Note: \`/skill:<name>\`, \`/skill\`, \`$skill\` or \`@file\` followed by a vague request—or asking to edit that skill itself—is still eligible for REWRITE (keep the original reference intact). On SKIP: do not read SKILL.md, do not mention routing or rewriting, and just answer or act normally.`,
  ].join('\n');
}

function pendingReplyInstruction(skillPath) {
  return [
    '[PROMPT-OPTIMIZER PENDING-REPLY]',
    'The user is replying to the optimized prompt you showed in the previous turn. Handle it as follows:',
    '1. If they approve (optionally adding details): execute the original task with the final optimized prompt right away; do not optimize again.',
    '2. If they ask for the original wording ("use original", "raw", "skip"): execute the task exactly as originally written.',
    '3. If they request edits and want to review again: output the revised optimized prompt in the same format and wait (if they say "edit and just run it", run it directly).',
    `4. If they clearly start an unrelated new task: apply [PROMPT-OPTIMIZER ROUTER] to it silently; read ${skillPath} only if it is worth rewriting, otherwise just handle it.`,
  ].join('\n');
}

function completePromptOptimizerArgs(prefix) {
  const typed = String(prefix || '').trimStart().toLowerCase();
  const values = ['on', 'off', 'status', 'default on', 'default off'].filter((v) => v.startsWith(typed));
  return values.length ? values.map((value) => ({ value, label: value })) : null;
}

function clearSection(event) {
  const sections = event && event.systemPromptOptions && event.systemPromptOptions.sections;
  if (sections && typeof sections === 'object') {
    delete sections[SECTION_KEY];
  }
}

function injectSection(event, text) {
  const sections = event && event.systemPromptOptions && event.systemPromptOptions.sections;
  if (sections && typeof sections === 'object') {
    sections[SECTION_KEY] = text;
    return undefined;
  }
  if (Array.isArray(event && event.systemPrompt)) {
    return { systemPrompt: [...event.systemPrompt, text] };
  }
  const base = event && event.systemPrompt ? `${event.systemPrompt}\n\n` : '';
  return { systemPrompt: `${base}${text}` };
}

function parsePromptOptimizerCmd(text) {
  return String(text || '').match(/^(?:\/skill:|[/@$])prompt-optimizer(?:[:：]prompt-optimizer)?(?:\s+([\s\S]*))?$/i);
}

function formatConfigInstruction(argText, currentMode, defaultMode, hasOverride, applyChange) {
  const trimmed = String(argText || '').trim();
  const lower = trimmed.toLowerCase();

  if (lower === 'off') {
    if (applyChange) applyChange('session', 'off');
    return '[PROMPT-OPTIMIZER CONFIG] Automatic prompt optimization is now OFF for this session. Tell the user briefly (they can re-enable it with `/prompt-optimizer on`) and do nothing else.';
  }
  if (lower === 'on') {
    if (applyChange) applyChange('session', 'on');
    return '[PROMPT-OPTIMIZER CONFIG] Automatic prompt optimization is now ON for this session. Tell the user briefly and do nothing else.';
  }
  if (lower === 'default off' || lower === 'default on') {
    const nextDefault = lower.endsWith('on') ? 'on' : 'off';
    if (applyChange) applyChange('default', nextDefault);
    return `[PROMPT-OPTIMIZER CONFIG] New sessions will now default to \`${nextDefault}\`. Tell the user briefly and do nothing else.`;
  }
  const curDisplay = hasOverride ? currentMode : `${defaultMode} (inherited default)`;
  return (
    `[PROMPT-OPTIMIZER CONFIG] This session: ${curDisplay}; default for new sessions: ${defaultMode}. ` +
    'Commands: `/prompt-optimizer on|off|status|default on|default off`, or `/prompt-optimizer <prompt to optimize>`; prefix a message with `raw:` to bypass once. Reply to the user with a brief summary.'
  );
}

function promptOptimizerExtension(pi) {
  let currentMode = readDefaultMode();
  let explicitNextTurn = false;
  let awaitingExplicitConfirm = false;
  let pendingRawInput = null;

  function getEntries(ctx) {
    return ctx && ctx.sessionManager
      ? (ctx.sessionManager.getBranch ? ctx.sessionManager.getBranch() : (ctx.sessionManager.getEntries ? ctx.sessionManager.getEntries() : []))
      : [];
  }

  function restoreSessionMode(ctx) {
    const entries = getEntries(ctx);
    currentMode = resolveSessionMode(entries, readDefaultMode());
  }

  function setSessionMode(mode) {
    const normalized = mode === 'off' ? 'off' : 'on';
    currentMode = normalized;
    if (typeof pi.appendEntry === 'function') {
      pi.appendEntry(ENTRY_TYPE, { mode: normalized });
    }
  }

  pi.on('session_start', (_event, ctx) => {
    explicitNextTurn = false;
    awaitingExplicitConfirm = false;
    pendingRawInput = null;
    restoreSessionMode(ctx);
  });

  for (const eventName of ['session_tree', 'session_switch', 'session_branch']) {
    pi.on(eventName, (_event, ctx) => {
      if (eventName === 'session_switch') {
        explicitNextTurn = false;
        awaitingExplicitConfirm = false;
        pendingRawInput = null;
      }
      restoreSessionMode(ctx);
    });
  }

  pi.registerCommand('prompt-optimizer', {
    description: 'Configure or invoke prompt-optimizer (on | off | status | default on | default off | <text>)',
    getArgumentCompletions: (prefix) => completePromptOptimizerArgs(prefix),
    handler: async (args, ctx) => {
      const trimmed = String(args || '').trim();
      const lower = trimmed.toLowerCase();

      if (lower === 'off') {
        setSessionMode('off');
        explicitNextTurn = false;
        awaitingExplicitConfirm = false;
        ctx?.ui?.notify?.('Prompt optimizer: OFF for this session (re-enable with /prompt-optimizer on).', 'info');
        return;
      }
      if (lower === 'on') {
        setSessionMode('on');
        ctx?.ui?.notify?.('Prompt optimizer: ON for this session.', 'info');
        return;
      }
      if (lower === 'default on' || lower === 'default off') {
        const nextDefault = lower.endsWith('on') ? 'on' : 'off';
        const written = writeDefaultMode(nextDefault);
        restoreSessionMode(ctx);
        ctx?.ui?.notify?.(`Prompt optimizer: default for new sessions set to ${written}.`, 'info');
        return;
      }
      if (lower === 'status' || !trimmed) {
        const entries = getEntries(ctx);
        const defMode = readDefaultMode();
        const curMode = hasExplicitSessionMode(entries) ? resolveSessionMode(entries, defMode) : `${defMode} (inherited default)`;
        ctx?.ui?.notify?.(
          `Prompt optimizer — session: ${curMode}; default: ${defMode}. Commands: /prompt-optimizer on|off|status|default on|default off|<text>; prefix "raw:" to bypass once.`,
          'info'
        );
        return;
      }

      explicitNextTurn = true;
      pendingRawInput = { text: trimmed, ts: Date.now() };
      const options = ctx?.isIdle?.() === false ? { deliverAs: 'followUp' } : undefined;
      pi.sendUserMessage(trimmed, options);
    },
  });

  pi.on('input', (event) => {
    if (event && event.source === 'extension') {
      return { action: 'continue' };
    }
    pendingRawInput = { text: String((event && event.text) || '').trim(), ts: Date.now() };
    return { action: 'continue' };
  });

  pi.on('before_agent_start', (event, ctx) => {
    if (event && event.messageType && event.messageType !== 'user') {
      clearSection(event);
      return;
    }

    const expanded = String((event && event.prompt) || '').trim();
    let rawText = expanded;
    const rawSnap = pendingRawInput;
    pendingRawInput = null;
    if (rawSnap && typeof rawSnap.text === 'string' && Date.now() - rawSnap.ts < RAW_INPUT_TTL_MS) {
      if (rawSnap.text === expanded || /^\/skill:/i.test(rawSnap.text) || rawSnap.text.startsWith('/')) {
        rawText = rawSnap.text;
      }
    }

    const hasImages = Array.isArray(event && event.images) && event.images.length > 0;
    if ((!rawText && !hasImages) || (rawText && MACHINE_RE.test(rawText))) {
      clearSection(event);
      return;
    }

    const skillPath = resolveSkillPath(event);

    if (explicitNextTurn) {
      explicitNextTurn = false;
      awaitingExplicitConfirm = true;
      return injectSection(event, gateInstruction(true, skillPath));
    }

    const cmdMatch = rawText ? parsePromptOptimizerCmd(rawText) : null;
    if (cmdMatch) {
      const argText = (cmdMatch[1] || '').trim();
      const lowerArg = argText.toLowerCase();
      if (!argText || lowerArg === 'on' || lowerArg === 'off' || lowerArg === 'status' || lowerArg === 'default on' || lowerArg === 'default off') {
        const entries = getEntries(ctx);
        const defMode = readDefaultMode();
        const cfg = formatConfigInstruction(argText, currentMode, defMode, hasExplicitSessionMode(entries), (kind, val) => {
          if (kind === 'session') {
            setSessionMode(val);
            if (val === 'off') awaitingExplicitConfirm = false;
          } else if (kind === 'default') {
            writeDefaultMode(val);
            restoreSessionMode(ctx);
          }
        });
        return injectSection(event, cfg);
      }
      awaitingExplicitConfirm = true;
      return injectSection(event, gateInstruction(true, skillPath));
    }

    if (rawText && !hasImages && (isControlCommand(rawText) || BARE_SKILL_BLOCK_RE.test(rawText))) {
      awaitingExplicitConfirm = false;
      clearSection(event);
      return;
    }

    const entries = getEntries(ctx);
    const enabled = resolveSessionMode(entries, readDefaultMode()) === 'on';
    currentMode = enabled ? 'on' : 'off';

    const lastAssistant = getLastAssistantText(entries);
    const isAwaiting = Boolean((enabled || awaitingExplicitConfirm) && lastAssistant && looksLikeOptimizedPrompt(lastAssistant));
    if (isAwaiting) {
      awaitingExplicitConfirm = false;
      if (rawText && BYPASS_PREFIX_RE.test(rawText)) {
        clearSection(event);
        return;
      }
      return injectSection(event, pendingReplyInstruction(skillPath));
    }

    awaitingExplicitConfirm = false;
    if (!enabled) {
      clearSection(event);
      return;
    }

    if (rawText && !hasImages && shouldSkipNonTask(rawText)) {
      clearSection(event);
      return;
    }

    return injectSection(event, gateInstruction(false, skillPath));
  });
}

Object.assign(promptOptimizerExtension, {
  default: promptOptimizerExtension,
  SECTION_KEY,
  ENTRY_TYPE,
  readDefaultMode,
  writeDefaultMode,
  resolveSkillPath,
  resolveSessionMode,
  getLastAssistantText,
  looksLikeOptimizedPrompt,
  shouldSkipNonTask,
  isControlCommand,
  gateInstruction,
  pendingReplyInstruction,
  completePromptOptimizerArgs,
});

module.exports = promptOptimizerExtension;
