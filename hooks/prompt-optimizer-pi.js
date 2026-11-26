'use strict';
// Pi coding agent extension for prompt-optimizer.
// Works both as a standalone file in ~/.pi/agent/extensions/prompt-optimizer.js
// and as a Pi package entry via package.json (`"extensions": ["./hooks/prompt-optimizer-pi.js"]`).

const fs = require('fs');
const os = require('os');
const path = require('path');

const BYPASS_PREFIX_RE = /^(?:(?:raw|原文|直接)\s*[:：]|(?:不优化|跳过优化)(?:\s*[:：]|\s|$))/i;
const PURE_ACK_RE = /^(?:同意|确认|好的?|好了|可以|可以了|行|行了|嗯|是的?|对|收到|明白|知道了|了解|懂了|没事了|不用改了|弄好了|搞定了|完成了|做完了|登好了|登录好了|绑好了|谢谢|感谢|没问题|按这个来?|就这样|发吧|执行|按原话|跳过优化|跳过|不用了|取消|算了|停止|ok|okay|yes|no|y|n|lgtm|looks\s+good|选\s*\d+|第\s*\d+\s*[个项条]?|sí|si|vale|gracias|oui|merci|ja|danke|はい|了解です?|ありがとう|네|좋아요|감사합니다|да|спасибо|[a-d1-4])$/i;
const ACTION_ACK_RE = /^(?:继续|go|continue|proceed)$/i;
const ACK_LEAD_RE = /^(?:同意|确认|好的|好了|弄好了|搞定了|继续|可以|没问题|按这个来?|就这样|发吧|执行|按原话|跳过优化)(?:[，,。.！!\s]+|$)/i;
const SHORT_DELEGATION_TAIL_RE = /^(?:(?:那就|那|请)?(?:你来帮我|你来|你帮我|帮我|直接|先)?(?:继续|弄|绑|搞|跑|试|查|看|修|改|发|推|提|建|装|配|同步|部署|上线|验证|测试|处理)(?:一下|吧|呗)?)$/;
const SHORT_FOLLOWUP_RE = /^(?:(?:下面|接下来|下一步|然后|后面)(?:该|要)?(?:做什么|怎么做|干什么|呢)|下一步(?:呢)?|继续吧|然后呢)[？?！!。.]*$/i;
const CONTEXT_ONLY_RE = /^(?:you decide|up to you|your call|do what you (?:recommend|suggest)|go ahead|do it|(?:fix|deploy|ship|publish|commit|push)(?: it)?|你(?:自己|来)?(?:决定|定吧?|看着办|安排吧?)|听你的|按照?你(?:的)?(?:推荐|建议|说|方案|计划)的?(?:做|来|办|改)?(?:吧)?|(?:那就)?(?:修复|修吧|改吧|部署|部署上线|上线|发布|提交|推送|开始|开始吧|开干|做吧|干吧|去做吧)(?:吧)?)$/i;
const PROSE_WORDS_RE = /\b(?:is|are|was|were|has|have|had|does|do|did|can|could|should|would|will|keeps?|makes?|please|help|fix|optimize|redesign|investigate|explain|why|how|what|when|where|our|my|the|this|that|website|page|app|module|workflow)\b/i;
const SINGLE_LINE_CMD_RE = /^(?:pwd|git\s+(?:status|diff|log|branch|checkout|switch|pull|push|fetch|add|commit|stash|rebase|merge|reset|restore|show|tag|remote|clone|init|rev-parse|cherry-pick|worktree)(?:\s+.*)?|(?:npm|pnpm|yarn|bun)\s+(?:run|test|install|i|add|remove|rm|build|dev|start|lint|exec|dlx|ci|update|outdated|audit|ls|list|pack|publish|-v|--version)(?:\s+.*)?|(?:pytest|vitest|jest)(?:\s+(?:-[\w-]+|[\w./:=*?-]+))*|(?:ls|cd|cat|rg|grep)(?:\s+(?:-[\w-]+|['"][^'"]+['"]|[^\s,;?!]+)){0,4})$/;
// Skip bare single-token /skill, @mention, $skill calls and built-in host/Pi control commands,
// but let `/skill:name <task body>`, `/skill <task body>` or `@file <task body>` pass through.
const CONTROL_CMD_RE = /^\/(?:compact|clear|plan|goal|schedule|browser|grill-me|teamwork|learn|boost|hooks?|help|status|model|models|config|permissions|mcp|memory|plugins?|login|logout|resume|rewind|rename|cost|doctor|init|exit|quit|ponytail(?:[:：][\w-]+)?|reload|settings|tree|fork|clone|new|name|export|share|session|hotkeys|changelog|copy|thinking|theme|scoped-models|debug)(?:\s|$)/i;
const MACHINE_RE = /^\s*(?:<\\?~?(?:hook_prompt|system-reminder|task-notification|cross-session-message|side-sessions-event|ci-monitor-event|send_user_message_question_reply)\b|\[(?:KROUTER_PROACTIVE|LMEMORY_PROACTIVE|PROMPT-OPTIMIZER)\b)/i;
const BARE_SKILL_BLOCK_RE = /^<skill\b[^>]*>[\s\S]*?<\/skill>\s*$/i;
const OPTIMIZER_HEADING_RE = /^#{2,4}\s*(?:优化后的提问|优化后的提示词|Optimized Prompt)(?:$|[\s:：\-—(（])/i;
const SKILL_META_RE = /(?:(?:这个|该|当前|本|此)\s*(?:skill|技能|hook|钩子|扩展|插件|脚本|提示词优化器)|SKILL\.md|\b(?:this|the)\s+(?:skill|hook|extension|plugin|script|repo|readme|prompt-optimizer)\b|^(?:(?:还有|有|存在|哪里有)(?:什么|啥)?问题|为什么(?:没触发|不触发|会触发|没生效|不生效|老是|总是)|(?:怎么|如何)(?:用|安装|配置|工作|触发|关闭|开启|修复|优化)|(?:审查|检查|修复|优化|改进|重构|调试)(?:一下)?(?:这个|该|当前|本)?\s*(?:skill|技能|hook|钩子|扩展|插件|脚本)|what(?:'s| is) wrong|any (?:issues?|bugs?|problems?)|how does (?:this|it) work|why (?:didn't|did|doesn't|isn't) (?:this|it)|(?:review|audit|inspect|debug|fix|edit|update|refactor|improve)\s+(?:this|the|your|its)?\s*(?:skill|hook|extension|plugin|script|prompt-optimizer)\b))/i;
const RAW_INPUT_TTL_MS = 30000;
const MAX_PENDING_EXPLICIT = 20;
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

function nextDefaultModeFile() {
  return path.join(getStateRoot(), 'pi-next-default-mode.txt');
}

function readNextDefaultMode() {
  try {
    const mode = fs.readFileSync(nextDefaultModeFile(), 'utf8').trim().toLowerCase();
    if (mode === 'on' || mode === 'off') return mode;
  } catch (_) {}
  return 'on';
}

function writeNextDefaultMode(mode) {
  const normalized = mode === 'off' ? 'off' : 'on';
  try {
    atomicWrite(nextDefaultModeFile(), normalized);
  } catch (_) {}
  return normalized;
}

function isControlCommand(text) {
  return /^[/@$][^\s]+$/.test(text) || CONTROL_CMD_RE.test(text);
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

function shouldSkipNonTask(text) {
  return classifyNonTask(text) !== 'task';
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

function resolveSessionState(entries) {
  let mode = null;
  let nextMode = null;
  let hasModeOverride = false;
  let hasNextOverride = false;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!entry || entry.type !== 'custom' || entry.customType !== ENTRY_TYPE || !entry.data || typeof entry.data !== 'object') continue;
      if (entry.data.mode === 'on' || entry.data.mode === 'off') {
        mode = entry.data.mode;
        hasModeOverride = true;
      }
      if ('nextMode' in entry.data) {
        if (entry.data.nextMode === 'on' || entry.data.nextMode === 'off') {
          nextMode = entry.data.nextMode;
          hasNextOverride = true;
        } else if (entry.data.nextMode === null) {
          nextMode = null;
          hasNextOverride = false;
        }
      }
    }
  }
  return { mode, nextMode, hasModeOverride, hasNextOverride };
}

function resolveSessionMode(entries, fallbackMode) {
  const fallback = fallbackMode === 'off' ? 'off' : 'on';
  const state = resolveSessionState(entries);
  return state.mode || fallback;
}

function hasExplicitSessionMode(entries) {
  return resolveSessionState(entries).hasModeOverride;
}

function resolveEffectiveModes(entries) {
  const state = resolveSessionState(entries);
  const defMode = readDefaultMode();
  const defNext = readNextDefaultMode();
  const rewriteMode = state.mode || defMode;
  const rewriteEnabled = rewriteMode === 'on';
  let nextEnabled;
  if (state.nextMode === 'on' || state.nextMode === 'off') {
    nextEnabled = state.nextMode === 'on';
  } else if (!rewriteEnabled) {
    nextEnabled = false;
  } else {
    nextEnabled = defNext === 'on';
  }
  return { state, defMode, defNext, rewriteMode, rewriteEnabled, nextEnabled };
}

function extractMessageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((block) => (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractAssistantText(message) {
  if (!message || message.role !== 'assistant') return '';
  return extractMessageText(message);
}

function getLastAssistantText(entries, currentPrompt) {
  if (!Array.isArray(entries)) return '';
  const normalizedCur = unwrapHarnessPrompt(currentPrompt);
  let skippedCurrentUser = false;
  let sawPostUserActivity = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.type === 'compaction') return '';
    if (entry.type !== 'message' || !entry.message) continue;
    const role = entry.message.role;
    if (role === 'assistant') {
      const text = extractAssistantText(entry.message);
      if (text) return text;
      sawPostUserActivity = true;
      continue;
    }
    if (role === 'user') {
      const uText = unwrapHarnessPrompt(extractMessageText(entry.message));
      if (!uText) {
        sawPostUserActivity = true;
        continue;
      }
      if (!skippedCurrentUser && !sawPostUserActivity && normalizedCur && uText === normalizedCur) {
        skippedCurrentUser = true;
        continue;
      }
      // Hit an earlier user turn before finding any assistant text (e.g., tool-only or interrupted turn).
      return '';
    }
    if (role === 'toolResult') {
      sawPostUserActivity = true;
    }
  }
  return '';
}

function gateInstruction(isExplicit, skillPath) {
  if (isExplicit) {
    return [
      '[PROMPT-OPTIMIZER EXPLICIT]',
      `The user explicitly invoked /prompt-optimizer. Skip the REWRITE/SKIP routing and follow ${skillPath} (sections 2 and 3) directly.`,
      '- Preserve 100% of the original intent, scope, constraints and exact identifiers/paths; drop irrelevant noise (keep IDs if the user will copy to another tool); write one short natural paragraph (no section templates, no long lists).',
      "- Reply in the user's language. Output only the optimized-prompt heading, the prompt in a blockquote, and one confirmation line (approve / edit / use original)—unless the user explicitly asked to optimize without executing, in which case output only the optimized prompt text. Do not execute the task or modify files.",
    ].join('\n');
  }
  return [
    '[PROMPT-OPTIMIZER ROUTER]',
    "FIRST—before calling tools (including memory lookups, codebase reads, or web searches) or planning—silently decide from context whether the user's latest message is worth rewriting: REWRITE or SKIP (for both Turn 1 and follow-up turns).",
    `- REWRITE when the message asks for substantive work (new or follow-up coding, redesign, bug fix, feature, debugging/root-cause analysis, strategy/content/workflow improvement, doc comparison, or multi-part requests) AND is vague, subjective, colloquial, lacks clear scope/criteria/verification, or pastes an error/screenshot with broad or missing instructions (criticizing current output with vague revision wishes is REWRITE). Listing multiple actions or attaching screenshots does NOT make a request concrete when acceptance criteria, boundaries, or verification are unstated—when unsure between REWRITE and SKIP on a substantive task, prefer REWRITE. On REWRITE: do NOT investigate the codebase or call other tools first; read ${skillPath} and follow it; ground follow-ups in established context; reply in the user's language with only the heading, one short blockquote paragraph, and one confirmation line (approve / edit / use original). Do not execute or modify files this turn.`,
    '- SKIP only when: venting/chit-chat with no actionable request; confirmations, option picks, delegations ("you decide") or nudges ("continue", "deploy"); an unambiguous single-step edit or single-fact lookup; meta-commentary about this tool with no new work; a prompt whose target, constraints, and verifiable outcome are ALL already explicit (including one copied from a prior next-step suggestion); or a bare/already-concrete skill or command call (vague tasks after `/skill:<name>`, `/skill`, `$skill`, or `@file`—or editing that skill—still evaluate for REWRITE with the reference kept intact). On SKIP: do not read SKILL.md or mention routing; act normally.',
  ].join('\n');
}

function nextStepInstruction() {
  return [
    '[PROMPT-OPTIMIZER NEXT-STEP]',
    'Before ending your final reply (even after long tool runs, plan-to-execution handoffs, or context compaction), check whether an obvious, high-value next prompt grounded in context and loaded session memory/rules exists: (a) after substantive work with concrete remaining verification, unverified risks, uncommitted/unpushed changes, or natural follow-up steps, or (b) after handing the user a concrete offline/external action to complete and return with results (draft the exact return prompt naming items, counts, and next action). When it exists, ALWAYS append this block at the very end—AFTER any closing risk/skipped-check notes (such as Ponytail summaries)—and never let a closing note replace it or bury it in prose.',
    '- Omit completely (stay silent, never suggest just for the sake of suggesting) only when the task is truly self-contained with no remaining checks, risks, or natural follow-up, during optimized-prompt confirmation turns, when asking open-ended clarifying questions, when blocked on login/payment, or for chit-chat/config/trivial Q&A.',
    '- Draft the pending outcome as the user would ask for it. From the latest confirmed context, carry over the actual target, environment and sample, the workflow from its real entry point to its end, the specific integrations and pending regressions to check, and the evidence or deliverable the user expects. Keep the details that affect execution and acceptance. Turn broad phrases like "verify the integration" into observable checks.',
    '- Use only supported details and retain existing authorization boundaries, prerequisites and approval gates. If only one useful check is known, keep the prompt that narrow. If no concrete next action is known, omit the block.',
    "- Format: `---` and one short bold localized label, then 1 concrete 1–2 sentence prompt in the user's language and voice (or 2–3 `- ` bullets only at a real fork). Plain text only—no `###`, `>`, or code fences.",
  ].join('\n');
}

function composeInstruction(primary, includeNext) {
  return [primary, includeNext ? nextStepInstruction() : ''].filter(Boolean).join('\n\n');
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
  const values = ['on', 'off', 'status', 'default on', 'default off', 'next on', 'next off', 'next default on', 'next default off']
    .filter((v) => v.startsWith(typed));
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

function isConfigArg(argText) {
  const lower = String(argText || '').trim().toLowerCase();
  return !lower || lower === 'on' || lower === 'off' || lower === 'status' ||
    lower === 'default on' || lower === 'default off' ||
    lower === 'next on' || lower === 'next off' ||
    lower === 'next default on' || lower === 'next default off';
}

function formatConfigInstruction(argText, effective, applyChange) {
  const trimmed = String(argText || '').trim();
  const lower = trimmed.toLowerCase();

  if (lower === 'off') {
    if (applyChange) applyChange('session', 'off');
    return '[PROMPT-OPTIMIZER CONFIG] Automatic prompt optimization (rewrite and next-step suggestions) is now OFF for this session. Tell the user briefly (they can re-enable it with `/prompt-optimizer on`, or enable only next-step suggestions with `/prompt-optimizer next on`) and do nothing else.';
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
  if (lower === 'next off' || lower === 'next on') {
    const nextMode = lower.endsWith('on') ? 'on' : 'off';
    if (applyChange) applyChange('nextSession', nextMode);
    return `[PROMPT-OPTIMIZER CONFIG] Post-turn next-step suggestions are now ${nextMode.toUpperCase()} for this session. Tell the user briefly and do nothing else.`;
  }
  if (lower === 'next default off' || lower === 'next default on') {
    const nextDefault = lower.endsWith('on') ? 'on' : 'off';
    if (applyChange) applyChange('nextDefault', nextDefault);
    return `[PROMPT-OPTIMIZER CONFIG] Post-turn next-step suggestions for new sessions will now default to \`${nextDefault}\`. Tell the user briefly and do nothing else.`;
  }

  const curRewrite = effective.state.hasModeOverride ? effective.rewriteMode : `${effective.defMode} (inherited default)`;
  const curNext = effective.state.hasNextOverride
    ? effective.state.nextMode
    : (!effective.rewriteEnabled ? 'off (follows rewrite off)' : `${effective.defNext} (inherited default)`);
  return (
    `[PROMPT-OPTIMIZER CONFIG] Rewrite: ${curRewrite} (default: ${effective.defMode}); Next-step suggestions: ${curNext} (default: ${effective.defNext}). ` +
    'Commands: `/prompt-optimizer on|off|status|default on|default off|next on|next off|next default on|next default off`, or `/prompt-optimizer <prompt to optimize>`; prefix a message with `raw:` to bypass once. Reply to the user with a brief summary.'
  );
}

function promptOptimizerExtension(pi) {
  let currentMode = readDefaultMode();
  let currentNextMode = null;
  let pendingExplicitPrompts = [];
  let awaitingExplicitConfirm = false;
  let pendingRawInput = null;

  function consumePendingExplicit(rawText, expanded) {
    const idx = pendingExplicitPrompts.findIndex((p) => p === rawText || p === expanded);
    if (idx === -1) return false;
    pendingExplicitPrompts.splice(idx, 1);
    return true;
  }

  function getEntries(ctx) {
    return ctx && ctx.sessionManager
      ? (ctx.sessionManager.getBranch ? ctx.sessionManager.getBranch() : (ctx.sessionManager.getEntries ? ctx.sessionManager.getEntries() : []))
      : [];
  }

  function restoreSessionMode(ctx) {
    const entries = getEntries(ctx);
    const state = resolveSessionState(entries);
    currentMode = state.mode || readDefaultMode();
    currentNextMode = state.nextMode;
  }

  function setSessionMode(mode) {
    const normalized = mode === 'off' ? 'off' : 'on';
    currentMode = normalized;
    const preservedNextMode = currentNextMode === 'off' ? 'off' : null;
    const data = normalized === 'off' ? { mode: normalized, nextMode: preservedNextMode } : { mode: normalized };
    if (normalized === 'off') currentNextMode = preservedNextMode;
    if (typeof pi.appendEntry === 'function') {
      pi.appendEntry(ENTRY_TYPE, data);
    }
  }

  function setSessionNextMode(mode) {
    const normalized = mode === 'off' ? 'off' : 'on';
    currentNextMode = normalized;
    if (typeof pi.appendEntry === 'function') {
      pi.appendEntry(ENTRY_TYPE, { nextMode: normalized });
    }
  }

  pi.on('session_start', (_event, ctx) => {
    pendingExplicitPrompts = [];
    awaitingExplicitConfirm = false;
    pendingRawInput = null;
    restoreSessionMode(ctx);
  });

  for (const eventName of ['session_tree', 'session_switch', 'session_branch', 'session_compact']) {
    pi.on(eventName, (_event, ctx) => {
      if (eventName === 'session_switch' || eventName === 'session_compact') {
        pendingExplicitPrompts = [];
        awaitingExplicitConfirm = false;
        pendingRawInput = null;
      }
      restoreSessionMode(ctx);
    });
  }

  pi.registerCommand('prompt-optimizer', {
    description: 'Configure or invoke prompt-optimizer (on | off | status | default on | default off | next on | next off | next default on | next default off | <text>)',
    getArgumentCompletions: (prefix) => completePromptOptimizerArgs(prefix),
    handler: async (args, ctx) => {
      const trimmed = String(args || '').trim();
      const lower = trimmed.toLowerCase();

      if (lower === 'off') {
        setSessionMode('off');
        pendingExplicitPrompts = [];
        awaitingExplicitConfirm = false;
        ctx?.ui?.notify?.('Prompt optimizer: OFF for this session (use /prompt-optimizer on, or /prompt-optimizer next on for suggestions only).', 'info');
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
      if (lower === 'next on' || lower === 'next off') {
        const nextMode = lower.endsWith('on') ? 'on' : 'off';
        setSessionNextMode(nextMode);
        ctx?.ui?.notify?.(`Prompt optimizer next-step suggestions: ${nextMode.toUpperCase()} for this session.`, 'info');
        return;
      }
      if (lower === 'next default on' || lower === 'next default off') {
        const nextDefault = lower.endsWith('on') ? 'on' : 'off';
        const written = writeNextDefaultMode(nextDefault);
        restoreSessionMode(ctx);
        ctx?.ui?.notify?.(`Prompt optimizer next-step suggestions: default for new sessions set to ${written}.`, 'info');
        return;
      }
      if (lower === 'status' || !trimmed) {
        const effective = resolveEffectiveModes(getEntries(ctx));
        const curMode = effective.state.hasModeOverride ? effective.rewriteMode : `${effective.defMode} (inherited default)`;
        const curNext = effective.state.hasNextOverride
          ? effective.state.nextMode
          : (!effective.rewriteEnabled ? 'off (follows rewrite off)' : `${effective.defNext} (inherited default)`);
        ctx?.ui?.notify?.(
          `Prompt optimizer — rewrite: ${curMode} (default: ${effective.defMode}); next-step: ${curNext} (default: ${effective.defNext}). Commands: /prompt-optimizer on|off|status|default on|default off|next on|next off|next default on|next default off|<text>; prefix "raw:" to bypass once.`,
          'info'
        );
        return;
      }

      if (!isSkillMetaRequest(trimmed)) {
        pendingExplicitPrompts.push(trimmed);
        if (pendingExplicitPrompts.length > MAX_PENDING_EXPLICIT) {
          pendingExplicitPrompts.shift();
        }
      }
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

    const expanded = unwrapHarnessPrompt(String((event && event.prompt) || '').trim());
    let rawText = expanded;
    const rawSnap = pendingRawInput;
    pendingRawInput = null;
    if (rawSnap && typeof rawSnap.text === 'string' && Date.now() - rawSnap.ts < RAW_INPUT_TTL_MS) {
      const unwrappedSnap = unwrapHarnessPrompt(rawSnap.text);
      if (unwrappedSnap === expanded || /^\/skill:/i.test(unwrappedSnap) || unwrappedSnap.startsWith('/')) {
        rawText = unwrappedSnap;
      }
    }

    const hasImages = Array.isArray(event && event.images) && event.images.length > 0;
    if ((!rawText && !hasImages) || (rawText && MACHINE_RE.test(rawText))) {
      clearSection(event);
      return;
    }

    const skillPath = resolveSkillPath(event);

    if (consumePendingExplicit(rawText, expanded)) {
      awaitingExplicitConfirm = true;
      return injectSection(event, gateInstruction(true, skillPath));
    }

    const cmdMatch = rawText ? parsePromptOptimizerCmd(rawText) : null;
    if (cmdMatch) {
      const argText = (cmdMatch[1] || '').trim();
      if (isConfigArg(argText)) {
        const effective = resolveEffectiveModes(getEntries(ctx));
        const cfg = formatConfigInstruction(argText, effective, (kind, val) => {
          if (kind === 'session') {
            setSessionMode(val);
            if (val === 'off') {
              pendingExplicitPrompts = [];
              awaitingExplicitConfirm = false;
            }
          } else if (kind === 'default') {
            writeDefaultMode(val);
            restoreSessionMode(ctx);
          } else if (kind === 'nextSession') {
            setSessionNextMode(val);
          } else if (kind === 'nextDefault') {
            writeNextDefaultMode(val);
            restoreSessionMode(ctx);
          }
        });
        return injectSection(event, cfg);
      }
      if (!isSkillMetaRequest(argText)) {
        awaitingExplicitConfirm = true;
        return injectSection(event, gateInstruction(true, skillPath));
      }
    }

    if (rawText && !hasImages && (isControlCommand(rawText) || BARE_SKILL_BLOCK_RE.test(rawText))) {
      awaitingExplicitConfirm = false;
      clearSection(event);
      return;
    }

    const entries = getEntries(ctx);
    const { rewriteEnabled, nextEnabled } = resolveEffectiveModes(entries);
    currentMode = rewriteEnabled ? 'on' : 'off';

    const lastAssistant = getLastAssistantText(entries, rawText);
    const isAwaiting = Boolean((rewriteEnabled || awaitingExplicitConfirm) && lastAssistant && looksLikeOptimizedPrompt(lastAssistant));
    if (isAwaiting) {
      if (rawText && BYPASS_PREFIX_RE.test(rawText)) {
        awaitingExplicitConfirm = false;
        clearSection(event);
        return;
      }
      // Keep awaitingExplicitConfirm alive while rewrite=off so multi-round explicit edits stay tracked until assistant emits a non-optimizer reply.
      awaitingExplicitConfirm = !rewriteEnabled;
      return injectSection(event, composeInstruction(pendingReplyInstruction(skillPath), nextEnabled));
    }

    awaitingExplicitConfirm = false;
    if (!rewriteEnabled && !nextEnabled) {
      clearSection(event);
      return;
    }

    const kind = (!rawText && hasImages) ? 'task' : classifyNonTask(rawText);
    if (kind === 'silent') {
      clearSection(event);
      return;
    }

    if (kind === 'actionable' || !rewriteEnabled) {
      if (!nextEnabled) {
        clearSection(event);
        return;
      }
      return injectSection(event, nextStepInstruction());
    }

    return injectSection(event, composeInstruction(gateInstruction(false, skillPath), nextEnabled));
  });
}

Object.assign(promptOptimizerExtension, {
  default: promptOptimizerExtension,
  SECTION_KEY,
  ENTRY_TYPE,
  readDefaultMode,
  writeDefaultMode,
  readNextDefaultMode,
  writeNextDefaultMode,
  resolveSkillPath,
  resolveSessionState,
  resolveSessionMode,
  getLastAssistantText,
  looksLikeOptimizedPrompt,
  classifyNonTask,
  shouldSkipNonTask,
  isControlCommand,
  gateInstruction,
  nextStepInstruction,
  pendingReplyInstruction,
  completePromptOptimizerArgs,
});

module.exports = promptOptimizerExtension;
