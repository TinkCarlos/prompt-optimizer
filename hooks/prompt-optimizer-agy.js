#!/usr/bin/env node
'use strict';
// Antigravity PreInvocation hook for prompt-optimizer.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const STATE_ROOT = process.env.AGY_HOOK_STATE_DIR || path.join(os.homedir(), '.gemini', 'config', 'hooks', 'state');
const STATE_DIR = path.join(STATE_ROOT, 'prompt-optimizer');
const SKILL_PATH = process.env.PROMPT_OPTIMIZER_SKILL_PATH || path.join(os.homedir(), '.gemini', 'config', 'skills', 'prompt-optimizer', 'SKILL.md');

const BYPASS_PREFIX_RE = /^(?:(?:raw|原文|直接)\s*[:：]|(?:不优化|跳过优化)(?:\s*[:：]|\s|$))/i;
const PURE_ACK_RE = /^(?:同意|确认|好的?|好了|可以|可以了|行|行了|嗯|是的?|对|收到|明白|知道了|了解|懂了|没事了|不用改了|弄好了|搞定了|完成了|做完了|登好了|登录好了|绑好了|谢谢|感谢|没问题|按这个来?|就这样|发吧|执行|按原话|跳过优化|跳过|不用了|取消|算了|停止|ok|okay|yes|no|y|n|lgtm|looks\s+good|选\s*\d+|第\s*\d+\s*[个项条]?|sí|si|vale|gracias|oui|merci|ja|danke|はい|了解です?|ありがとう|네|좋아요|감사합니다|да|спасибо|[a-d1-4])$/i;
const ACTION_ACK_RE = /^(?:继续|go|continue|proceed)$/i;
const ACK_LEAD_RE = /^(?:同意|确认|好的|好了|弄好了|搞定了|继续|可以|没问题|按这个来?|就这样|发吧|执行|按原话|跳过优化)(?:[，,。.！!\s]+|$)/i;
const SHORT_DELEGATION_TAIL_RE = /^(?:(?:那就|那|请)?(?:你来帮我|你来|你帮我|帮我|直接|先)?(?:继续|弄|绑|搞|跑|试|查|看|修|改|发|推|提|建|装|配|同步|部署|上线|验证|测试|处理)(?:一下|吧|呗)?)$/;
const SHORT_FOLLOWUP_RE = /^(?:(?:下面|接下来|下一步|然后|后面)(?:该|要)?(?:做什么|怎么做|干什么|呢)|下一步(?:呢)?|继续吧|然后呢)[？?！!。.]*$/i;
// Delegation and bare context verbs ("你自己决定", "按你推荐的做", "修复") only make sense against the previous turn.
const CONTEXT_ONLY_RE = /^(?:you decide|up to you|your call|do what you (?:recommend|suggest)|go ahead|do it|(?:fix|deploy|ship|publish|commit|push)(?: it)?|你(?:自己|来)?(?:决定|定吧?|看着办|安排吧?)|听你的|按照?你(?:的)?(?:推荐|建议|说|方案|计划)的?(?:做|来|办|改)?(?:吧)?|(?:那就)?(?:修复|修吧|改吧|部署|部署上线|上线|发布|提交|推送|开始|开始吧|开干|做吧|干吧|去做吧)(?:吧)?)$/i;
const PROSE_WORDS_RE = /\b(?:is|are|was|were|has|have|had|does|do|did|can|could|should|would|will|keeps?|makes?|please|help|fix|optimize|redesign|investigate|explain|why|how|what|when|where|our|my|the|this|that|website|page|app|module|workflow)\b/i;
const SINGLE_LINE_CMD_RE = /^(?:pwd|git\s+(?:status|diff|log|branch|checkout|switch|pull|push|fetch|add|commit|stash|rebase|merge|reset|restore|show|tag|remote|clone|init|rev-parse|cherry-pick|worktree)(?:\s+.*)?|(?:npm|pnpm|yarn|bun)\s+(?:run|test|install|i|add|remove|rm|build|dev|start|lint|exec|dlx|ci|update|outdated|audit|ls|list|pack|publish|-v|--version)(?:\s+.*)?|(?:pytest|vitest|jest)(?:\s+(?:-[\w-]+|[\w./:=*?-]+))*|(?:ls|cd|cat|rg|grep)(?:\s+(?:-[\w-]+|['"][^'"]+['"]|[^\s,;?!]+)){0,4})$/;
// Skip bare single-token /skill, @mention, $skill calls and built-in host control commands,
// but let `/skill <task body>` or `@file <task body>` pass through to the router.
const CONTROL_CMD_RE = /^\/(?:compact|clear|plan|goal|schedule|browser|grill-me|teamwork|learn|boost|hooks?|help|status|model|models|config|permissions|mcp|memory|plugins?|login|logout|resume|rewind|rename|cost|doctor|init|exit|quit|ponytail(?:[:：][\w-]+)?)(?:\s|$)/i;
const OPTIMIZER_HEADING_RE = /^#{2,4}\s*(?:优化后的提问|优化后的提示词|Optimized Prompt)(?:$|[\s:：\-—(（])/i;
const SKILL_META_RE = /(?:(?:这个|该|当前|本|此)\s*(?:skill|技能|hook|钩子|扩展|插件|脚本|提示词优化器)|SKILL\.md|\b(?:this|the)\s+(?:skill|hook|extension|plugin|script|repo|readme|prompt-optimizer)\b|^(?:(?:还有|有|存在|哪里有)(?:什么|啥)?问题|为什么(?:没触发|不触发|会触发|没生效|不生效|老是|总是)|(?:怎么|如何)(?:用|安装|配置|工作|触发|关闭|开启|修复|优化)|(?:审查|检查|修复|优化|改进|重构|调试)(?:一下)?(?:这个|该|当前|本)?\s*(?:skill|技能|hook|钩子|扩展|插件|脚本)|what(?:'s| is) wrong|any (?:issues?|bugs?|problems?)|how does (?:this|it) work|why (?:didn't|did|doesn't|isn't) (?:this|it)|(?:review|audit|inspect|debug|fix|edit|update|refactor|improve)\s+(?:this|the|your|its)?\s*(?:skill|hook|extension|plugin|script|prompt-optimizer)\b))/i;
const STATE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
  const m = s.match(/^(?:<t3_code_instructions>[\s\S]*?<\/t3_code_instructions>\s*)?<user_request>([\s\S]*)<\/user_request>(?:\s*<runtime_info>[\s\S]*?<\/runtime_info>)?\s*$/);
  return m ? m[1].trim() : s;
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function hashId(id) {
  return crypto.createHash('sha256').update(String(id || 'default')).digest('hex').slice(0, 16);
}

const BLOCK_TAG_RE = /<(\/?)(USER_REQUEST|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/g;

function isAllWhitespace(s, start, end) {
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 10 && c !== 13 && c !== 9 && c !== 12 && c !== 11 && c !== 160 && !/\s/.test(s[i])) {
      return false;
    }
  }
  return true;
}

function parseTopLevelBlocks(raw) {
  const s = String(raw || '');
  const tokens = [];
  BLOCK_TAG_RE.lastIndex = 0;
  let m;
  while ((m = BLOCK_TAG_RE.exec(s)) !== null) {
    tokens.push({ index: m.index, end: m.index + m[0].length, isClose: Boolean(m[1]), tag: m[2] });
  }
  const k = tokens.length;
  if (!k) return { text: unwrapHarnessPrompt(s), outerMeta: '' };

  const validTailAfter = new Uint8Array(k);
  const blockCloseIdx = new Int32Array(k).fill(-1);
  const firstCloseIdx = new Int32Array(k).fill(-1);
  const unmatchedClose = { ADDITIONAL_METADATA: [], USER_SETTINGS_CHANGE: [] };
  const unmatchedValidClose = { ADDITIONAL_METADATA: [], USER_SETTINGS_CHANGE: [] };
  const unclosedFallback = { ADDITIONAL_METADATA: -1, USER_SETTINGS_CHANGE: -1 };
  const nextClose = { ADDITIONAL_METADATA: -1, USER_SETTINGS_CHANGE: -1 };
  let nearestValidUrClose = -1;
  let lastValidUrClose = -1;
  let lastUrClose = -1;

  for (let i = k - 1; i >= 0; i--) {
    const tok = tokens[i];
    if (tok.isClose) {
      const nextStart = i + 1 < k ? tokens[i + 1].index : s.length;
      const nextIsBlock = i + 1 < k && !tokens[i + 1].isClose && blockCloseIdx[i + 1] !== -1;
      const canFollow = i + 1 === k || (nextIsBlock && (tok.tag !== 'USER_REQUEST' || tokens[i + 1].tag !== 'USER_REQUEST'));
      const tailOk = isAllWhitespace(s, tok.end, nextStart) && canFollow;
      if (tailOk) validTailAfter[i] = 1;
      if (tok.tag === 'USER_REQUEST') {
        if (lastUrClose === -1) lastUrClose = i;
        if (tailOk) {
          nearestValidUrClose = i;
          if (lastValidUrClose === -1) lastValidUrClose = i;
          unclosedFallback.ADDITIONAL_METADATA = -1;
          unclosedFallback.USER_SETTINGS_CHANGE = -1;
        }
      } else {
        unmatchedClose[tok.tag].push(i);
        if (tailOk) {
          unmatchedValidClose[tok.tag].push(i);
          unclosedFallback[tok.tag] = i;
        } else if (unclosedFallback[tok.tag] === -1) {
          unclosedFallback[tok.tag] = i;
        }
        nextClose[tok.tag] = i;
      }
    } else if (tok.tag === 'USER_REQUEST') {
      if (nearestValidUrClose !== -1) blockCloseIdx[i] = nearestValidUrClose;
    } else {
      const stack = unmatchedClose[tok.tag];
      const validStack = unmatchedValidClose[tok.tag];
      let c = -1;
      if (validStack.length) {
        c = validStack.pop();
        while (stack.length && stack.pop() !== c) {}
      } else if (stack.length) {
        c = stack.pop();
      } else {
        c = unclosedFallback[tok.tag];
      }
      firstCloseIdx[i] = c !== -1 ? c : nextClose[tok.tag];
      if (c !== -1 && validTailAfter[c]) blockCloseIdx[i] = c;
    }
  }

  const userRequests = [];
  const outerMetas = [];
  const unwrappedParts = [];
  let hasUserRequest = false;
  let outsideStart = 0;

  for (let i = 0; i < k; i++) {
    const tok = tokens[i];
    if (tok.isClose) continue;
    if (tok.tag === 'USER_REQUEST') {
      let closeIdx = -1;
      if (lastValidUrClose > i) {
        let depth = 1;
        let firstBoundary = -1;
        for (let j = i + 1; j <= lastValidUrClose; j++) {
          if (tokens[j].tag !== 'USER_REQUEST') continue;
          if (tokens[j].isClose) {
            depth--;
            if (validTailAfter[j] && firstBoundary === -1) firstBoundary = j;
            if (depth === 0) {
              if (validTailAfter[j]) { closeIdx = j; break; }
              depth = 1;
            }
          } else {
            depth++;
          }
        }
        if (closeIdx === -1) closeIdx = firstBoundary;
      } else if (lastUrClose > i) {
        closeIdx = lastUrClose;
      }
      if (closeIdx === -1) continue;
      hasUserRequest = true;
      const body = s.slice(tok.end, tokens[closeIdx].index).trim();
      if (body) userRequests.push(body);
      i = closeIdx;
    } else {
      const closeIdx = blockCloseIdx[i] !== -1 ? blockCloseIdx[i] : firstCloseIdx[i];
      if (closeIdx === -1) continue;
      unwrappedParts.push(s.slice(outsideStart, tok.index));
      outsideStart = tokens[closeIdx].end;
      if (tok.tag === 'ADDITIONAL_METADATA') {
        const body = s.slice(tok.end, tokens[closeIdx].index).trim();
        if (body) outerMetas.push(body);
      }
      i = closeIdx;
    }
  }
  unwrappedParts.push(s.slice(outsideStart));
  return {
    text: unwrapHarnessPrompt(hasUserRequest ? userRequests.join('\n') : unwrappedParts.join('').trim()),
    outerMeta: outerMetas.join('\n'),
  };
}

function extractUserText(raw) {
  return parseTopLevelBlocks(raw).text;
}

function digestText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

function isMachinePrompt(raw) {
  const s = String(raw || '');
  return !s.trim() || /^\s*(?:\[plan review(?:\s+due)?\]|<(?:hook_prompt|system-reminder|task-notification)\b)/i.test(s);
}

function isExplicitUserInput(d) {
  return Boolean(d && d.type === 'USER_INPUT' && (d.source === 'USER_EXPLICIT' || d.source == null));
}

function sameUserMessage(row, curText) {
  if (!row || !curText) return false;
  const rowText = extractUserText(row.content);
  if (!rowText) return false;
  if (rowText === curText) return true;
  if (Array.isArray(row.truncated_fields) && row.truncated_fields.includes('content')) {
    const prefix = rowText.slice(0, 80);
    return prefix.length >= 20 && curText.startsWith(prefix);
  }
  return false;
}

function inspectTranscript(payload, curBlocks, digest) {
  const result = { stepKey: null, stepNum: null, hasTranscriptTruth: false, lastReplyWasOptimizerPrompt: false };
  const tpath = String(payload.transcriptPath || '');
  if (!tpath) return result;
  const blocks = curBlocks || parseTopLevelBlocks(payload.lastUserInput);
  const curText = blocks.text;
  const curOuterMeta = blocks.outerMeta;
  const curDigest = digest != null ? digest : digestText(curText);
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

      let latestTurnFinished = false;
      if (latestUserIdx >= 0) {
        const pendingTaskIds = new Set();
        let hasAnonRunningAfterSys = false;
        for (let i = latestUserIdx + 1; i < rows.length; i++) {
          const r = rows[i];
          const c = String(r.content || '');
          if (r.type === 'SYSTEM_MESSAGE' && (r.source === 'SYSTEM' || r.source == null)) {
            const hasMessageEnvelope = /(?:^|\n)\[Message\](?:\s|$)/i.test(c);
            const senderMatch = hasMessageEnvelope
              ? c.match(/(?:^|\n)\[Message\](?:(?!\bcontent=)[^\n])*?\bsender=([^\s]+)/i)
              : null;
            const taskMatch = hasMessageEnvelope
              ? null
              : c.match(/(?:^|\n)(?:Background notification:\s*)?Task id "([^"]+)"\s+finished\b/i);
            const completedId = (senderMatch && senderMatch[1]) || (taskMatch && taskMatch[1]) || null;
            if (completedId) pendingTaskIds.delete(completedId);
            else if (!hasMessageEnvelope) hasAnonRunningAfterSys = false;
          } else if (r.status === 'RUNNING') {
            const tm = c.match(/task id:\s*([^\s"'`.,;]+)/i);
            if (tm) pendingTaskIds.add(tm[1]);
            else hasAnonRunningAfterSys = true;
          }
        }
        const hasUnresolvedRunning = pendingTaskIds.size > 0 || hasAnonRunningAfterSys;
        if (!hasUnresolvedRunning) {
          for (let i = rows.length - 1; i > latestUserIdx; i--) {
            const d = rows[i];
            if (d.type === 'PLANNER_RESPONSE' && !String(d.content || '').trim() && !(Array.isArray(d.tool_calls) && d.tool_calls.length > 0)) {
              continue;
            }
            latestTurnFinished = Boolean(
              d.type === 'PLANNER_RESPONSE' &&
              String(d.content || '').trim() &&
              !(Array.isArray(d.tool_calls) && d.tool_calls.length > 0)
            );
            break;
          }
        }
      }

      const rowOuterMeta = latestUserIdx >= 0 ? parseTopLevelBlocks(rows[latestUserIdx].content).outerMeta : '';
      const sameOuterMeta = Boolean(curOuterMeta && rowOuterMeta && curOuterMeta === rowOuterMeta);
      // If the transcript has not yet flushed the current queued/new USER_INPUT,
      // latestUserIdx still points to the previous turn; scan from the tail for its reply.
      // shortcut: a cancelled turn with no text PLANNER_RESPONSE is indistinguishable from an active tool loop before the next USER_INPUT flushes; requires host turnId to disambiguate
      const currentFlushed = latestUserIdx >= 0 && (!latestTurnFinished || sameOuterMeta) && (!curText || sameUserMessage(rows[latestUserIdx], curText));
      const scanFrom = currentFlushed ? latestUserIdx - 1 : rows.length - 1;

      let decided = false;
      let replyIsPrompt = false;
      if (latestUserIdx >= 0 || start === 0) {
        for (let i = scanFrom; i >= 0; i--) {
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

      if ((latestUserIdx >= 0 || start === 0) && decided) {
        if (currentFlushed && rows[latestUserIdx].step_index != null) {
          result.stepNum = Number(rows[latestUserIdx].step_index);
          result.stepKey = 'step:' + result.stepNum + ':' + curDigest;
        }
        result.hasTranscriptTruth = true;
        result.lastReplyWasOptimizerPrompt = replyIsPrompt;
        break;
      }
      if (start === 0) break;
    }
  } catch (_) {}
  return result;
}

function turnKeys(payload, tx, precomputedDigest) {
  const digest = precomputedDigest != null ? precomputedDigest : digestText(extractUserText(payload.lastUserInput));
  const initialNumSteps = payload.initialNumSteps != null ? Number(payload.initialNumSteps) : null;
  const initKey = initialNumSteps != null ? 'init:' + String(initialNumSteps) + ':' + digest : null;
  const stepKey = tx && tx.stepKey ? tx.stepKey : null;
  const stepNum = tx && tx.stepNum != null ? tx.stepNum : null;
  const fallbackKey = stepKey || initKey || 'raw:' + digest;
  return { stepKey, stepNum, initKey, digest, initialNumSteps, fallbackKey };
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

const LOCK_WAIT_MS = 1000;
const LOCK_STALE_MS = 5000;
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function withTurnLock(convId, fn, onTimeout) {
  const lockFile = path.join(STATE_DIR, 'turn-' + hashId(convId) + '.lock');
  let acquired = false;
  let acquiredIno = null;
  let timedOut = false;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const deadline = performance.now() + LOCK_WAIT_MS;
    while (true) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        acquired = true;
        try {
          fs.writeSync(fd, String(process.pid));
          acquiredIno = fs.fstatSync(fd).ino;
        } finally {
          fs.closeSync(fd);
        }
        break;
      } catch (err) {
        if (!err || err.code !== 'EEXIST') break;
        if (performance.now() >= deadline) {
          timedOut = true;
          break;
        }
        let retryNow = false;
        try {
          const st = fs.statSync(lockFile);
          if (performance.now() >= deadline) {
            timedOut = true;
            break;
          }
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            // shortcut: path-based stale unlink has a microsecond TOCTOU under simultaneous crash recovery; switch to flock if crash contention occurs
            fs.unlinkSync(lockFile);
            retryNow = true;
          }
        } catch (e) {
          if (e && e.code === 'ENOENT') retryNow = true;
          else break;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          timedOut = true;
          break;
        }
        if (!retryNow) {
          Atomics.wait(SLEEP_BUF, 0, 0, Math.min(10, Math.ceil(remaining)));
          if (performance.now() >= deadline) {
            timedOut = true;
            break;
          }
        }
      }
    }
  } catch (_) {}

  if (!acquired && timedOut) return onTimeout;

  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        const st = fs.statSync(lockFile);
        if (acquiredIno == null || st.ino === acquiredIno) {
          fs.unlinkSync(lockFile);
        }
      } catch (_) {}
    }
  }
}

function dedupeTurn(convId, payload, tx, digest) {
  const cur = turnKeys(payload, tx, digest);
  return withTurnLock(convId, () => {
    const file = path.join(STATE_DIR, 'turn-' + hashId(convId) + '.json');
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (prev && typeof prev === 'object') {
        if ((cur.initKey && prev.initKey === cur.initKey) ||
            (cur.stepKey && prev.stepKey === cur.stepKey) ||
            prev.fallbackKey === cur.fallbackKey) {
          return false;
        }
        // First invocation ran before the new USER_INPUT flushed to transcript; upgrade key on the second invocation.
        if (!prev.stepKey && cur.stepKey && prev.digest === cur.digest &&
            cur.stepNum != null && prev.initialNumSteps != null && cur.stepNum <= prev.initialNumSteps) {
          try { atomicWrite(file, JSON.stringify(cur)); } catch (_) {}
          return false;
        }
        // Second invocation saw flushed transcript and won the lock before an earlier pre-flush invocation entered dedupeTurn.
        if (prev.stepKey && !cur.stepKey && prev.digest === cur.digest &&
            cur.initialNumSteps != null && prev.initialNumSteps != null && cur.initialNumSteps <= prev.initialNumSteps) {
          return false;
        }
      }
    } catch (_) {}
    try {
      atomicWrite(file, JSON.stringify(cur));
    } catch (_) {}
    return true;
  }, false);
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

function nextDefaultModeFile() {
  return path.join(STATE_DIR, 'next-default-mode.txt');
}

function readNextDefaultMode() {
  try {
    const m = fs.readFileSync(nextDefaultModeFile(), 'utf8').trim().toLowerCase();
    if (m === 'on' || m === 'off') return m;
  } catch (_) {}
  return 'on';
}

function writeNextDefaultMode(mode) {
  try {
    atomicWrite(nextDefaultModeFile(), mode);
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
      const nextMode = parsed.nextMode === 'on' || parsed.nextMode === 'off' ? parsed.nextMode : null;
      return { mode, nextMode, awaitingConfirm: Boolean(parsed.awaitingConfirm) };
    }
  } catch (_) {}
  return { mode: null, nextMode: null, awaitingConfirm: false };
}

function writeSession(convId, state) {
  try {
    const clean = {
      mode: state.mode === 'on' || state.mode === 'off' ? state.mode : null,
      nextMode: state.nextMode === 'on' || state.nextMode === 'off' ? state.nextMode : null,
      awaitingConfirm: Boolean(state.awaitingConfirm),
    };
    atomicWrite(sessionFile(convId), JSON.stringify(clean));
    maybePruneStateDir(STATE_DIR);
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

function injectOutput(text) {
  return { injectSteps: [{ systemMessage: { systemMessage: text } }] };
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
    'Optional—omit by default (stay silent in most turns). Only append this block when an obvious, high-value next prompt grounded in context and loaded session memory/rules genuinely exists: (a) after substantive work with concrete remaining verification, risks, or next steps, or (b) after handing the user a concrete offline/external action to complete and return with results (draft the exact return prompt naming items, counts, and next action).',
    '- Omit completely when the task is done/self-contained, when nothing clearly useful stands out (never suggest just for the sake of suggesting), during optimized-prompt confirmation turns, when asking open-ended clarifying questions, when blocked on login/payment, or for chit-chat/config/trivial Q&A.',
    "- When included, append after `---` and one short bold localized label: 1 concrete 1–2 sentence prompt in the user's language and voice (or 2–3 `- ` bullets only at a real fork). Plain text only—no `###`, `>`, or code fences.",
  ].join('\n');
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

function handleCommand(convId, session, argText) {
  const trimmed = argText.trim();
  const lower = trimmed.toLowerCase();

  if (lower === 'off') {
    const preservedNextMode = session.nextMode === 'off' ? 'off' : null;
    writeSession(convId, { mode: 'off', nextMode: preservedNextMode, awaitingConfirm: false });
    return out(injectOutput('[PROMPT-OPTIMIZER CONFIG] Automatic prompt optimization (rewrite and next-step suggestions) is now OFF for this session. Tell the user briefly (they can re-enable it with `/prompt-optimizer on`, or enable only next-step suggestions with `/prompt-optimizer next on`) and do nothing else.'));
  }
  if (lower === 'on') {
    writeSession(convId, { ...session, mode: 'on', awaitingConfirm: false });
    return out(injectOutput('[PROMPT-OPTIMIZER CONFIG] Automatic prompt optimization is now ON for this session. Tell the user briefly and do nothing else.'));
  }
  if (lower === 'default off' || lower === 'default on') {
    const nextDefault = lower.endsWith('on') ? 'on' : 'off';
    writeDefaultMode(nextDefault);
    return out(injectOutput(`[PROMPT-OPTIMIZER CONFIG] New sessions will now default to \`${nextDefault}\`. Tell the user briefly and do nothing else.`));
  }
  if (lower === 'next off' || lower === 'next on') {
    const nextMode = lower.endsWith('on') ? 'on' : 'off';
    writeSession(convId, { ...session, nextMode, awaitingConfirm: false });
    return out(injectOutput(`[PROMPT-OPTIMIZER CONFIG] Post-turn next-step suggestions are now ${nextMode.toUpperCase()} for this session. Tell the user briefly and do nothing else.`));
  }
  if (lower === 'next default off' || lower === 'next default on') {
    const nextDefault = lower.endsWith('on') ? 'on' : 'off';
    writeNextDefaultMode(nextDefault);
    return out(injectOutput(`[PROMPT-OPTIMIZER CONFIG] Post-turn next-step suggestions for new sessions will now default to \`${nextDefault}\`. Tell the user briefly and do nothing else.`));
  }
  if (lower === 'status' || trimmed === '') {
    const defMode = readDefaultMode();
    const defNext = readNextDefaultMode();
    const curMode = session.mode || `${defMode} (inherited default)`;
    const effective = resolveModes(session);
    const curNext = session.nextMode
      ? session.nextMode
      : (!effective.rewriteEnabled ? 'off (follows rewrite off)' : `${defNext} (inherited default)`);
    return out(injectOutput(
      `[PROMPT-OPTIMIZER CONFIG] Rewrite: ${curMode} (default: ${defMode}); Next-step suggestions: ${curNext} (default: ${defNext}). ` +
      'Commands: `/prompt-optimizer on|off|status|default on|default off|next on|next off|next default on|next default off`, or `/prompt-optimizer <prompt to optimize>`; prefix a message with `raw:` to bypass once. Reply to the user with a brief summary.'
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
  const curBlocks = parseTopLevelBlocks(raw);
  const text = curBlocks.text.trim();
  if (!text) return out({});

  const session = readSession(convId);
  const cmdMatch = text.match(/^[/@$]prompt-optimizer(?:[:：]prompt-optimizer)?(?:\s+([\s\S]*))?$/i);
  const cmdArg = cmdMatch ? (cmdMatch[1] || '').trim() : '';
  const isMetaCmd = Boolean(cmdMatch && cmdArg && !isConfigArg(cmdArg) && isSkillMetaRequest(cmdArg));
  const { rewriteEnabled, nextEnabled } = resolveModes(session);

  if ((!cmdMatch || isMetaCmd) && !rewriteEnabled && !nextEnabled && !session.awaitingConfirm) {
    return out({});
  }

  const digest = digestText(curBlocks.text);
  const tx = inspectTranscript(payload, curBlocks, digest);
  if (!dedupeTurn(convId, payload, tx, digest)) return out({});

  if (cmdMatch && !isMetaCmd) {
    return handleCommand(convId, session, cmdMatch[1] || '');
  }

  if (isControlCommand(text)) {
    if (session.awaitingConfirm) {
      writeSession(convId, { ...session, awaitingConfirm: false });
    }
    return out({});
  }

  // ask_question structured answers (e.g., "A1: ...") start at line 1 and should never disrupt pending state.
  if (/^A1:\s/.test(text)) {
    return out({});
  }

  const isAwaiting = rewriteEnabled
    ? (tx.hasTranscriptTruth ? tx.lastReplyWasOptimizerPrompt : session.awaitingConfirm)
    : (session.awaitingConfirm && (tx.hasTranscriptTruth ? tx.lastReplyWasOptimizerPrompt : true));
  if (!isAwaiting && session.awaitingConfirm) {
    writeSession(convId, { ...session, awaitingConfirm: false });
  }

  if (isAwaiting) {
    if (BYPASS_PREFIX_RE.test(text)) {
      writeSession(convId, { ...session, awaitingConfirm: false });
      return out({});
    }
    const keepExplicitConfirm = !rewriteEnabled && tx.hasTranscriptTruth;
    writeSession(convId, { ...session, awaitingConfirm: keepExplicitConfirm });
    return out(injectOutput(composeInstruction(pendingReplyInstruction(), nextEnabled)));
  }

  if (!rewriteEnabled && !nextEnabled) return out({});

  const kind = classifyNonTask(text);
  if (kind === 'silent') return out({});

  if (kind === 'actionable' || !rewriteEnabled) {
    if (!nextEnabled) return out({});
    return out(injectOutput(nextStepInstruction()));
  }

  writeSession(convId, { ...session, awaitingConfirm: true });
  return out(injectOutput(composeInstruction(gateInstruction(), nextEnabled)));
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
