#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { execFile, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_SCRIPT = process.env.PROMPT_OPTIMIZER_HOOK || [path.join(__dirname, '..', 'hooks', 'prompt-optimizer-agy.js'), path.join(os.homedir(), '.gemini', 'config', 'hooks', 'prompt-optimizer-agy.js')].find((p) => fs.existsSync(p));
const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-optimizer-test-'));

function runHook(payload, rawOverride, opts = {}) {
  const input = rawOverride !== undefined ? rawOverride : JSON.stringify(payload);
  const stdout = execFileSync(process.execPath, [HOOK_SCRIPT, 'prompt'], {
    input,
    encoding: 'utf8',
    env: { ...process.env, AGY_HOOK_STATE_DIR: tmpState },
    ...(opts.timeout != null ? { timeout: opts.timeout } : {}),
  });
  return JSON.parse(stdout.trim());
}

function runHookAsync(payload, rawOverride, opts = {}) {
  const input = rawOverride !== undefined ? rawOverride : JSON.stringify(payload);
  const args = [...(opts.preload ? ['-r', opts.preload] : []), HOOK_SCRIPT, 'prompt'];
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      args,
      { encoding: 'utf8', env: { ...process.env, AGY_HOOK_STATE_DIR: tmpState, ...(opts.env || {}) } },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    );
    child.stdin.on('error', reject);
    child.stdin.end(input, (err) => {
      if (err) reject(err);
    });
  });
}

function getInjectedText(res) {
  const steps = res && res.injectSteps;
  if (!Array.isArray(steps) || !steps.length) return '';
  return String(steps[0]?.systemMessage?.systemMessage || '');
}

(async () => {
try {
  const convA = 'conv-a';
  const convB = 'conv-b';

  // 1. Short Chinese task triggers [PROMPT-OPTIMIZER ROUTER] with silent skip & rewrite guidance
  let res = runHook({
    conversationId: convA,
    initialNumSteps: 1,
    lastUserInput: '<USER_REQUEST>\n帮我做个PPT介绍新产品\n</USER_REQUEST>',
  });
  const routerText = getInjectedText(res);
  assert(routerText.includes('[PROMPT-OPTIMIZER ROUTER]'), '1a. Expected router for short Chinese task');
  assert(routerText.includes('REWRITE') && routerText.includes('SKIP'), '1b. Expected binary routing options');

  // 2. Duplicate call in same turn returns {}
  res = runHook({
    conversationId: convA,
    initialNumSteps: 1,
    lastUserInput: '<USER_REQUEST>\n帮我做个PPT介绍新产品\n</USER_REQUEST>',
  });
  assert.deepStrictEqual(res, {}, '2. Expected {} on duplicate turn call');

  // 3. Machine prompts ([plan review] / [plan review due]) return {} and preserve awaitingConfirm
  for (const [idx, msg] of ['[plan review] check status', '[plan review due]'].entries()) {
    res = runHook({
      conversationId: convA,
      initialNumSteps: 2 + idx,
      lastUserInput: msg,
    });
    assert.deepStrictEqual(res, {}, `3.${idx} Expected {} for machine prompt`);
  }

  // 4. Next user reply triggers [PROMPT-OPTIMIZER PENDING-REPLY] and clears awaitingConfirm
  res = runHook({
    conversationId: convA,
    initialNumSteps: 4,
    lastUserInput: '<USER_REQUEST>\n同意，把时间改成最近3个月\n</USER_REQUEST>',
  });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '4. Expected pending-reply on confirmation');

  // 5. Subsequent new task triggers [PROMPT-OPTIMIZER ROUTER] again
  res = runHook({
    conversationId: convA,
    initialNumSteps: 6,
    lastUserInput: '<USER_REQUEST>\n帮我重构登录模块的错误处理逻辑\n</USER_REQUEST>',
  });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '5. Expected router on next new task');

  // 5b. Explicit bypass during awaitingConfirm clears awaitingConfirm and returns {}
  res = runHook({
    conversationId: convA,
    initialNumSteps: 7,
    lastUserInput: '<USER_REQUEST>\n原文：直接帮我写个周报\n</USER_REQUEST>',
  });
  assert.deepStrictEqual(res, {}, '5b. Expected bypass prefix during awaitingConfirm to return {} and clear state');

  // 5c. Subsequent normal message triggers router cleanly (confirming awaitingConfirm was cleared)
  res = runHook({
    conversationId: convA,
    initialNumSteps: 8,
    lastUserInput: '<USER_REQUEST>\n分析一下昨天线上慢查询原因\n</USER_REQUEST>',
  });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '5c. Expected router after bypass cleared awaitingConfirm');

  // Clear awaitingConfirm via normal reply before testing remaining skip cases
  res = runHook({
    conversationId: convA,
    initialNumSteps: 9,
    lastUserInput: '<USER_REQUEST>\n按原话\n</USER_REQUEST>',
  });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '5d. Expected pending-reply to clear state');

  // 6. ask_question structured answer returns {}
  res = runHook({
    conversationId: convA,
    initialNumSteps: 10,
    lastUserInput: 'A1: 选第一个\nA2: 好的',
  });
  assert.deepStrictEqual(res, {}, '6. Expected {} for ask_question answer');

  // 7. Other slash/skill invocations return {}
  for (const [idx, cmd] of ['/compact', '$talking-us', '@ponytail'].entries()) {
    res = runHook({
      conversationId: convA,
      initialNumSteps: 11 + idx,
      lastUserInput: cmd,
    });
    assert.deepStrictEqual(res, {}, `7.${idx} Expected {} for ${cmd}`);
  }

  // 8. Explicit bypass prefix returns {}
  res = runHook({
    conversationId: convA,
    initialNumSteps: 15,
    lastUserInput: '<USER_REQUEST>\n原文：帮我查一下接口超时\n</USER_REQUEST>',
  });
  assert.deepStrictEqual(res, {}, '8. Expected {} for bypass prefix');

  // 9. Pure acknowledgements and single-line CLI commands return {}; actionable follow-ups get NEXT-STEP only
  for (const [idx, msg] of ['好的', 'git status'].entries()) {
    res = runHook({
      conversationId: convA,
      initialNumSteps: 16 + idx,
      lastUserInput: `<USER_REQUEST>\n${msg}\n</USER_REQUEST>`,
    });
    assert.deepStrictEqual(res, {}, `9.${idx} Expected {} for "${msg}"`);
  }
  res = runHook({
    conversationId: convA,
    initialNumSteps: 18,
    lastUserInput: '<USER_REQUEST>\n继续\n</USER_REQUEST>',
  });
  assert(!getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]') && getInjectedText(res).includes('[PROMPT-OPTIMIZER NEXT-STEP]'), '9.2 Expected NEXT-STEP only for "继续"');

  // 10. /prompt-optimizer off/on/status and explicit payload while off
  res = runHook({
    conversationId: convA,
    initialNumSteps: 20,
    lastUserInput: '/prompt-optimizer off',
  });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER CONFIG]'), '10a. Expected config notice for off');

  res = runHook({
    conversationId: convA,
    initialNumSteps: 21,
    lastUserInput: '帮我分析这份销售数据为什么下降了',
  });
  assert.deepStrictEqual(res, {}, '10b. Expected {} when session mode is off');

  res = runHook({
    conversationId: convA,
    initialNumSteps: 22,
    lastUserInput: '/prompt-optimizer 帮我分析这份报表',
  });
  const explicitText = getInjectedText(res);
  assert(explicitText.includes('[PROMPT-OPTIMIZER EXPLICIT]') && explicitText.includes('Skip the REWRITE/SKIP routing'), '10c. Expected explicit /prompt-optimizer to bypass router even when off');

  res = runHook({
    conversationId: convA,
    initialNumSteps: 23,
    lastUserInput: '/prompt-optimizer on',
  });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER CONFIG]'), '10d. Expected config notice for on');

  res = runHook({
    conversationId: convA,
    initialNumSteps: 24,
    lastUserInput: '/prompt-optimizer status',
  });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER CONFIG]'), '10e. Expected status output');

  // 11. default off / default on across fresh conversations
  res = runHook({
    conversationId: convA,
    initialNumSteps: 30,
    lastUserInput: '/prompt-optimizer default off',
  });
  assert(getInjectedText(res).includes('off'), '11a. Expected default off notice');

  res = runHook({
    conversationId: convB,
    initialNumSteps: 1,
    lastUserInput: '帮我总结这份文档的核心风险',
  });
  assert.deepStrictEqual(res, {}, '11b. Expected new conversation to inherit default off');

  res = runHook({
    conversationId: convA,
    initialNumSteps: 31,
    lastUserInput: '/prompt-optimizer default on',
  });
  assert(getInjectedText(res).includes('on'), '11c. Expected default on notice');

  // 12. Malformed JSON fails open with {}
  res = runHook(null, '{bad json');
  assert.deepStrictEqual(res, {}, '12. Expected {} on malformed JSON');

  // 13. Bug 1 regression: daily progress acks return {}; actionable follow-ups get NEXT-STEP only (no ROUTER, no awaitingConfirm)
  for (const [idx, msg] of ['好了', '搞定了', '登录好了'].entries()) {
    res = runHook({
      conversationId: convA,
      initialNumSteps: 40 + idx,
      lastUserInput: `<USER_REQUEST>\n${msg}\n</USER_REQUEST>`,
    });
    assert.deepStrictEqual(res, {}, `13.${idx} Expected {} for "${msg}"`);
  }
  for (const [idx, msg] of ['下面该做什么', '继续，你来帮我绑'].entries()) {
    res = runHook({
      conversationId: convA,
      initialNumSteps: 44 + idx,
      lastUserInput: `<USER_REQUEST>\n${msg}\n</USER_REQUEST>`,
    });
    const txt = getInjectedText(res);
    assert(!txt.includes('[PROMPT-OPTIMIZER ROUTER]') && txt.includes('[PROMPT-OPTIMIZER NEXT-STEP]'), `13a.${idx} Expected NEXT-STEP only for "${msg}"`);
  }

  // Real short tasks must still trigger ROUTER
  for (const [idx, msg] of ['帮我做个PPT', '修复登录报错'].entries()) {
    res = runHook({
      conversationId: convA,
      initialNumSteps: 50 + idx * 2,
      lastUserInput: `<USER_REQUEST>\n${msg}\n</USER_REQUEST>`,
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), `13b.${idx} Expected ROUTER for real short task "${msg}"`);
    res = runHook({
      conversationId: convA,
      initialNumSteps: 51 + idx * 2,
      lastUserInput: '<USER_REQUEST>\n按原话\n</USER_REQUEST>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '13c. Clear awaitingConfirm');
  }

  // 14-18: Transcript-truth state checks
  const txConv = 'conv-transcript-truth';
  const txPath = path.join(tmpState, 'transcript.jsonl');
  const writeTx = (rows) => fs.writeFileSync(txPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  // 14. Bug 2 regression: stale awaitingConfirm=true must NOT trigger PENDING-REPLY if previous PLANNER_RESPONSE skipped optimizer prompt
  writeTx([
    { step_index: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '上一轮输入' },
    { step_index: 2, type: 'PLANNER_RESPONSE', content: '已为你绑定完成。' },
  ]);
  res = runHook({
    conversationId: txConv,
    transcriptPath: txPath,
    initialNumSteps: 3,
    lastUserInput: '<USER_REQUEST>\n再帮我优化一下首页加载速度\n</USER_REQUEST>',
  });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '14a. Trigger router to set awaitingConfirm=true');

  writeTx([
    { step_index: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '上一轮输入' },
    { step_index: 2, type: 'PLANNER_RESPONSE', content: '已为你绑定完成。' },
    { step_index: 3, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '再帮我优化一下首页加载速度' },
    { step_index: 4, type: 'PLANNER_RESPONSE', content: '本轮无需改写，已开始优化首页加载。' },
    { step_index: 5, type: 'PLANNER_RESPONSE', content: '' },
    { step_index: 6, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '帮我做个新功能：导出 PDF 报表' },
  ]);
  res = runHook({
    conversationId: txConv,
    transcriptPath: txPath,
    initialNumSteps: 7,
    lastUserInput: '<USER_REQUEST>\n帮我做个新功能：导出 PDF 报表\n</USER_REQUEST>',
  });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '14b. Expected ROUTER (not PENDING-REPLY) when previous reply skipped optimization');

  // 15. True confirmation state: previous non-empty PLANNER_RESPONSE contains ### 优化后的提问 (even with trailing empty tool-call PLANNER_RESPONSE)
  writeTx([
    { step_index: 6, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '帮我做个新功能：导出 PDF 报表' },
    { step_index: 7, type: 'PLANNER_RESPONSE', content: '' },
    { step_index: 8, type: 'PLANNER_RESPONSE', content: '### 优化后的提问\n\n> 请基于当前项目实现 PDF 报表导出...\n\n按这句提问吗？（同意 / 修改 / 按原话）' },
    { step_index: 9, type: 'PLANNER_RESPONSE', content: '' },
    { step_index: 10, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '你帮我全部做完' },
  ]);
  res = runHook({
    conversationId: txConv,
    transcriptPath: txPath,
    initialNumSteps: 11,
    lastUserInput: '<USER_REQUEST>\n你帮我全部做完\n</USER_REQUEST>',
  });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '15. Expected PENDING-REPLY when previous reply actually showed optimizer prompt');

  // 16. Multi-round revision: even after awaitingConfirm was cleared, if model outputs another ### 优化后的提问, next turn detects it
  writeTx([
    { step_index: 10, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '把范围缩到仅限订单模块' },
    { step_index: 11, type: 'PLANNER_RESPONSE', content: '### 优化后的提问\n\n> 仅针对订单模块实现 PDF 报表导出...' },
    { step_index: 12, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '同意' },
  ]);
  res = runHook({
    conversationId: txConv,
    transcriptPath: txPath,
    initialNumSteps: 13,
    lastUserInput: '<USER_REQUEST>\n同意\n</USER_REQUEST>',
  });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '16. Expected PENDING-REPLY on multi-round revision');

  // 17. Fenced code block false-positive guard
  writeTx([
    { step_index: 12, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '看看 SKILL.md 模板' },
    { step_index: 13, type: 'PLANNER_RESPONSE', content: '这是模板示例：\n```markdown\n### 优化后的提问\n> 示例\n```\n说明完毕。' },
    { step_index: 14, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '帮我写一份季度总结' },
  ]);
  res = runHook({
    conversationId: txConv,
    transcriptPath: txPath,
    initialNumSteps: 15,
    lastUserInput: '<USER_REQUEST>\n帮我写一份季度总结\n</USER_REQUEST>',
  });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '17. Expected ROUTER (ignore optimizer heading inside fenced code block)');

  // 18. Silent "不改写" path (venting/complaint) resets state cleanly for next turn
  writeTx([
    { step_index: 14, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '烦死了今天怎么老是报错' },
    { step_index: 15, type: 'PLANNER_RESPONSE', content: '理解，连续报错确实让人头大。你歇口气，想继续看哪块随时跟我说。' },
    { step_index: 16, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '帮我写个周报总结本周进度' },
  ]);
  res = runHook({
    conversationId: txConv,
    transcriptPath: txPath,
    initialNumSteps: 17,
    lastUserInput: '<USER_REQUEST>\n帮我写个周报总结本周进度\n</USER_REQUEST>',
  });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '18. Expected ROUTER after previous silent 不改写 reply');

  // 19. Delegation / bare context verbs get NEXT-STEP only (no ROUTER, no awaitingConfirm); real short tasks still route
  for (const [idx, msg] of ['你自己决定', '按照你推荐的做', '听你的', '修复', '部署上线', '那就发布吧'].entries()) {
    res = runHook({
      conversationId: 'conv-ctx',
      initialNumSteps: 100 + idx,
      lastUserInput: `<USER_REQUEST>\n${msg}\n</USER_REQUEST>`,
    });
    const txt = getInjectedText(res);
    assert(!txt.includes('[PROMPT-OPTIMIZER ROUTER]') && txt.includes('[PROMPT-OPTIMIZER NEXT-STEP]'), `19.${idx} Expected NEXT-STEP only for context-only "${msg}"`);
  }
  res = runHook({
    conversationId: 'conv-ctx',
    initialNumSteps: 120,
    lastUserInput: '<USER_REQUEST>\n修复登录页在 Safari 下白屏的问题\n</USER_REQUEST>',
  });
  const ctxRouteText = getInjectedText(res);
  assert(ctxRouteText.includes('[PROMPT-OPTIMIZER ROUTER]') && !ctxRouteText.includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '19b. Verb + object is a real task (and prior NEXT-STEP did not set awaitingConfirm)');

  // 20. Long agent turn (> 1 MB of tool output after the user input): later invocations in the
  // same turn must be deduped, not re-route mid-task.
  const longConv = 'conv-long-turn';
  const longTx = path.join(tmpState, 'long-transcript.jsonl');
  const filler = 'x'.repeat(4000);
  const longRows = [
    { step_index: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '帮我把整个网站做完并上线' },
  ];
  for (let i = 2; i < 400; i++) longRows.push({ step_index: i, type: 'GENERIC', content: filler });
  fs.writeFileSync(longTx, longRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  res = runHook({ conversationId: longConv, transcriptPath: longTx, initialNumSteps: 2, lastUserInput: '帮我把整个网站做完并上线' });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '20a. First invocation routes');
  res = runHook({ conversationId: longConv, transcriptPath: longTx, initialNumSteps: 400, lastUserInput: '帮我把整个网站做完并上线' });
  const longRefresh = getInjectedText(res);
  assert(
    !longRefresh.includes('[PROMPT-OPTIMIZER ROUTER]') &&
    !longRefresh.includes('[PROMPT-OPTIMIZER PENDING-REPLY]') &&
    longRefresh.includes('[PROMPT-OPTIMIZER NEXT-STEP]'),
    '20b. Same turn after >1MB / many steps must never re-route, and refreshes NEXT-STEP reminder'
  );
  res = runHook({ conversationId: longConv, transcriptPath: longTx, initialNumSteps: 401, lastUserInput: '帮我把整个网站做完并上线' });
  assert.deepStrictEqual(res, {}, '20c. Immediate next step after long-turn refresh stays silent');

  // 21. Previous turn had only tool calls (no text reply) + stale awaitingConfirm → not a pending reply
  const toolConv = 'conv-tool-only';
  res = runHook({ conversationId: toolConv, initialNumSteps: 1, lastUserInput: '帮我分析下这周的转化率为什么掉了' });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '21a. Sets stale awaitingConfirm');
  const toolTx = path.join(tmpState, 'tool-transcript.jsonl');
  fs.writeFileSync(toolTx, [
    { step_index: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '帮我分析下这周的转化率为什么掉了' },
    { step_index: 2, type: 'PLANNER_RESPONSE', content: '' },
    { step_index: 3, type: 'GENERIC', content: 'tool output' },
    { step_index: 4, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '再帮我写一份复盘文档' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  res = runHook({ conversationId: toolConv, transcriptPath: toolTx, initialNumSteps: 5, lastUserInput: '再帮我写一份复盘文档' });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '21b. Tool-only previous turn must not be treated as pending confirmation');

  // 22. Language-neutral detection: a localized optimized prompt (Spanish) is still recognized as pending confirmation
  writeTx([
    { step_index: 20, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'hazme una presentación' },
    { step_index: 21, type: 'PLANNER_RESPONSE', content: '### Prompt optimizado\n\n> Prepara una presentación del producto para decidir si lo lanzamos.\n\n¿Usar este prompt? (aprobar / editar / usar original)' },
    { step_index: 22, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'aprobar' },
  ]);
  res = runHook({ conversationId: 'conv-es', transcriptPath: txPath, initialNumSteps: 23, lastUserInput: '<USER_REQUEST>\naprobar\n</USER_REQUEST>' });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '22. Expected PENDING-REPLY for a localized optimized prompt');

  // 23. "raw data ..." is a normal task; only "raw:" bypasses; non-CJK acknowledgements are skipped locally
  res = runHook({ conversationId: 'conv-raw', initialNumSteps: 1, lastUserInput: '<USER_REQUEST>\nraw data analysis of Q3 sales\n</USER_REQUEST>' });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '23a. "raw data ..." must not bypass');
  res = runHook({ conversationId: 'conv-raw', initialNumSteps: 2, lastUserInput: '<USER_REQUEST>\nraw: fix the typo in the title\n</USER_REQUEST>' });
  assert.deepStrictEqual(res, {}, '23b. "raw:" bypasses');
  res = runHook({ conversationId: 'conv-raw', initialNumSteps: 3, lastUserInput: '<USER_REQUEST>\ngracias\n</USER_REQUEST>' });
  assert.deepStrictEqual(res, {}, '23c. Spanish acknowledgement is skipped locally');

  // 24. /skill, $skill or @file followed by a task body routes normally; bare calls and host control commands still skip
  for (const [idx, msg] of [
    '/frontend-design-lab 帮我优化这个skill，让页面更有质感',
    '$frontend-design-lab 帮我做一个落地页',
    '@src/app.tsx 帮我看看性能瓶颈在哪',
  ].entries()) {
    const cid = 'conv-prefixed-' + idx;
    res = runHook({ conversationId: cid, initialNumSteps: 1, lastUserInput: `<USER_REQUEST>\n${msg}\n</USER_REQUEST>` });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), `24a.${idx} Expected ROUTER for "${msg}"`);
  }
  for (const [idx, cmd] of ['/frontend-design-lab', '/ponytail off', '/ponytail:ponytail full', '/compact focus on tests', '/model opus'].entries()) {
    res = runHook({ conversationId: 'conv-ctrl', initialNumSteps: 10 + idx, lastUserInput: `<USER_REQUEST>\n${cmd}\n</USER_REQUEST>` });
    assert.deepStrictEqual(res, {}, `24b.${idx} Expected {} for control/bare command "${cmd}"`);
  }

  // 25. Queued / unflushed multi-turn transcript race:
  // Turn 2 arrives before transcript flushes step 441 (still ends at step 410 + reply 440):
  // Invocation 1 must fire ROUTER immediately (not falsely deduped against step 410),
  // Invocation 2 after step 441 flushes must dedupe, and a later Turn 3 with identical text must fire again.
  const qConv = 'conv-queued-race';
  const qTx = path.join(tmpState, 'queued-transcript.jsonl');
  const writeQ = (rows) => fs.writeFileSync(qTx, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  writeQ([
    { step_index: 410, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\n帮我把首页改成暗黑风格\n</USER_REQUEST>' },
  ]);
  res = runHook({ conversationId: qConv, transcriptPath: qTx, initialNumSteps: 411, lastUserInput: '<USER_REQUEST>\n帮我把首页改成暗黑风格\n</USER_REQUEST>' });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '25a. Turn 1 fires ROUTER');
  writeQ([
    { step_index: 410, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\n帮我把首页改成暗黑风格\n</USER_REQUEST>' },
    { step_index: 440, type: 'PLANNER_RESPONSE', content: '已完成首页暗黑风格改造。' },
  ]);
  res = runHook({ conversationId: qConv, transcriptPath: qTx, initialNumSteps: 442, lastUserInput: '<USER_REQUEST>\n开头几个模块太普通了，换个酷炫的样式\n</USER_REQUEST>' });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '25b. Turn 2 fires ROUTER immediately even before transcript flushes step 441');
  writeQ([
    { step_index: 410, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\n帮我把首页改成暗黑风格\n</USER_REQUEST>' },
    { step_index: 440, type: 'PLANNER_RESPONSE', content: '已完成首页暗黑风格改造。' },
    { step_index: 441, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\n开头几个模块太普通了，换个酷炫的样式\n</USER_REQUEST>' },
  ]);
  res = runHook({ conversationId: qConv, transcriptPath: qTx, initialNumSteps: 446, lastUserInput: '<USER_REQUEST>\n开头几个模块太普通了，换个酷炫的样式\n</USER_REQUEST>' });
  assert.deepStrictEqual(res, {}, '25c. Turn 2 invocation 2 after step 441 flushes must dedupe');
  writeQ([
    { step_index: 441, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\n开头几个模块太普通了，换个酷炫的样式\n</USER_REQUEST>' },
    { step_index: 454, type: 'PLANNER_RESPONSE', content: '已重做前三个模块。' },
    { step_index: 455, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\n开头几个模块太普通了，换个酷炫的样式\n</USER_REQUEST>' },
  ]);
  res = runHook({ conversationId: qConv, transcriptPath: qTx, initialNumSteps: 456, lastUserInput: '<USER_REQUEST>\n开头几个模块太普通了，换个酷炫的样式\n</USER_REQUEST>' });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '25d. Turn 3 with identical text at a new step fires ROUTER');

  // 26. Next-step suggestion composition, false-positive guard, and toggles
  {
    const nextConv = 'conv-next-controls';
    const nextTx = path.join(tmpState, 'next-transcript.jsonl');
    const writeNTx = (rows) => fs.writeFileSync(nextTx, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    // 26a. Normal task includes both ROUTER and NEXT-STEP; EXPLICIT omits NEXT-STEP; PENDING-REPLY includes NEXT-STEP.
    res = runHook({ conversationId: nextConv, initialNumSteps: 1, lastUserInput: '帮我写个发布说明' });
    const bothText = getInjectedText(res);
    assert(
      bothText.includes('[PROMPT-OPTIMIZER ROUTER]') &&
      bothText.includes('[PROMPT-OPTIMIZER NEXT-STEP]') &&
      bothText.includes('Before ending your final reply') &&
      bothText.includes('ALWAYS append this block') &&
      bothText.includes('never suggest just for the sake of suggesting') &&
      bothText.includes('concrete offline/external action') &&
      bothText.includes('open-ended clarifying questions'),
      '26a.1 ROUTER + optional NEXT-STEP'
    );

    res = runHook({ conversationId: nextConv, initialNumSteps: 2, lastUserInput: '同意' });
    const pendingBoth = getInjectedText(res);
    assert(pendingBoth.includes('[PROMPT-OPTIMIZER PENDING-REPLY]') && pendingBoth.includes('[PROMPT-OPTIMIZER NEXT-STEP]'), '26a.2 PENDING-REPLY + NEXT-STEP');

    res = runHook({ conversationId: nextConv, initialNumSteps: 3, lastUserInput: '/prompt-optimizer 帮我重写官网文案' });
    const expOnly = getInjectedText(res);
    assert(expOnly.includes('[PROMPT-OPTIMIZER EXPLICIT]') && !expOnly.includes('[PROMPT-OPTIMIZER NEXT-STEP]'), '26a.3 EXPLICIT omits NEXT-STEP');

    // 26b. Short reply starting with ### and ending with --- next-step footer (even with >) must NOT look like confirmation prompt.
    writeNTx([
      { step_index: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '修一下超时问题' },
      { step_index: 2, type: 'PLANNER_RESPONSE', content: '### 修复完成\n已调整超时时间。\n\n---\n**下一步建议提示词**：\n> 运行集成测试确认接口恢复正常' },
      { step_index: 3, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '再帮我查下日志里的慢请求' },
    ]);
    res = runHook({ conversationId: 'conv-next-fp', transcriptPath: nextTx, initialNumSteps: 4, lastUserInput: '再帮我查下日志里的慢请求' });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '26b. Reply with --- divider must not trigger PENDING-REPLY');

    // 26c. /prompt-optimizer next off/on, status, next default off/on, and off + next on (next-only mode)
    res = runHook({ conversationId: nextConv, initialNumSteps: 10, lastUserInput: '/prompt-optimizer next off' });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER CONFIG]'), '26c.1 next off');
    res = runHook({ conversationId: nextConv, initialNumSteps: 11, lastUserInput: '继续' });
    assert.deepStrictEqual(res, {}, '26c.2 Actionable follow-up returns {} when next is off');
    res = runHook({ conversationId: nextConv, initialNumSteps: 12, lastUserInput: '帮我写个季度复盘' });
    const routeNoNext = getInjectedText(res);
    assert(routeNoNext.includes('[PROMPT-OPTIMIZER ROUTER]') && !routeNoNext.includes('[PROMPT-OPTIMIZER NEXT-STEP]'), '26c.3 ROUTER omits NEXT-STEP when next is off');

    // Clear awaitingConfirm then test off + next on
    res = runHook({ conversationId: nextConv, initialNumSteps: 13, lastUserInput: '同意' });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]') && !getInjectedText(res).includes('[PROMPT-OPTIMIZER NEXT-STEP]'), '26c.4 PENDING-REPLY omits NEXT-STEP when next is off');

    runHook({ conversationId: nextConv, initialNumSteps: 14, lastUserInput: '/prompt-optimizer off' });
    res = runHook({ conversationId: nextConv, initialNumSteps: 15, lastUserInput: '帮我整理测试报告' });
    assert.deepStrictEqual(res, {}, '26c.5 off silences both');

    runHook({ conversationId: nextConv, initialNumSteps: 16, lastUserInput: '/prompt-optimizer next on' });
    res = runHook({ conversationId: nextConv, initialNumSteps: 17, lastUserInput: '帮我整理测试报告' });
    const nextOnlyTask = getInjectedText(res);
    assert(!nextOnlyTask.includes('[PROMPT-OPTIMIZER ROUTER]') && nextOnlyTask.includes('[PROMPT-OPTIMIZER NEXT-STEP]'), '26c.6 off + next on runs next-only');
    res = runHook({ conversationId: nextConv, initialNumSteps: 18, lastUserInput: '继续' });
    const nextOnlyFollowup = getInjectedText(res);
    assert(!nextOnlyFollowup.includes('[PROMPT-OPTIMIZER ROUTER]') && nextOnlyFollowup.includes('[PROMPT-OPTIMIZER NEXT-STEP]'), '26c.7 off + next on gives NEXT-STEP for follow-up without awaitingConfirm');

    res = runHook({ conversationId: nextConv, initialNumSteps: 19, lastUserInput: '/prompt-optimizer status' });
    const statusText = getInjectedText(res);
    assert(statusText.includes('Rewrite: off') && statusText.includes('Next-step suggestions: on'), '26c.8 status reports both rewrite and next');

    // next default off / on for fresh sessions
    runHook({ conversationId: nextConv, initialNumSteps: 20, lastUserInput: '/prompt-optimizer next default off' });
    res = runHook({ conversationId: 'conv-fresh-next-off', initialNumSteps: 1, lastUserInput: '帮我重构认证中间件' });
    const freshText = getInjectedText(res);
    assert(freshText.includes('[PROMPT-OPTIMIZER ROUTER]') && !freshText.includes('[PROMPT-OPTIMIZER NEXT-STEP]'), '26c.9 Fresh session inherits next default off');
    runHook({ conversationId: nextConv, initialNumSteps: 21, lastUserInput: '/prompt-optimizer next default on' });
  }

  // 27. Literal <ADDITIONAL_METADATA> inside <USER_REQUEST> is preserved, deduped, and used in transcript matching
  {
    const literalBody = '<USER_REQUEST>\n<ADDITIONAL_METADATA>keep this literal tag</ADDITIONAL_METADATA>\n</USER_REQUEST>';
    res = runHook({
      conversationId: 'conv-literal-meta',
      initialNumSteps: 1,
      lastUserInput: `${literalBody}\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:00:00+08:00.\n</ADDITIONAL_METADATA>`,
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '27a. Expected literal <ADDITIONAL_METADATA> inside <USER_REQUEST> to route');

    res = runHook({
      conversationId: 'conv-literal-meta',
      initialNumSteps: 1,
      lastUserInput: `${literalBody}\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:00:05+08:00.\n</ADDITIONAL_METADATA>`,
    });
    assert.deepStrictEqual(res, {}, '27b. Same inner literal <ADDITIONAL_METADATA> with updated outer timestamp must dedupe');

    const litTx = path.join(tmpState, 'literal-meta-transcript.jsonl');
    fs.writeFileSync(litTx, [
      { step_index: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '初始任务' },
      { step_index: 2, type: 'PLANNER_RESPONSE', content: '### 优化后的提问\n\n> 初始优化提示词\n\n确认？' },
      { step_index: 3, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\n帮我保留 <ADDITIONAL_METADATA>v1</ADDITIONAL_METADATA> 标签\n</USER_REQUEST>' },
      { step_index: 4, type: 'PLANNER_RESPONSE', content: '已按 v1 完成处理。' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({
      conversationId: 'conv-literal-meta-tx',
      transcriptPath: litTx,
      initialNumSteps: 5,
      lastUserInput: '<USER_REQUEST>\n帮我保留 <ADDITIONAL_METADATA>v2</ADDITIONAL_METADATA> 标签\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:01:00+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '27c. Literal inner <ADDITIONAL_METADATA> difference must prevent false transcript match to prior turn');
  }

  // 28. Timestamp and outer metadata invariance (turnDigest)
  {
    const wrappedReq = '<USER_REQUEST>\n帮我整理发布检查清单\n</USER_REQUEST>';
    res = runHook({
      conversationId: 'conv-ts-invariant',
      initialNumSteps: 10,
      lastUserInput: `${wrappedReq}\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:02:00+08:00.\n</ADDITIONAL_METADATA>`,
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '28a.1 Initial wrapped request routes');

    res = runHook({
      conversationId: 'conv-ts-invariant',
      initialNumSteps: 10,
      lastUserInput: `${wrappedReq}\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:02:05+08:00.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nModel changed.\n</USER_SETTINGS_CHANGE>`,
    });
    assert.deepStrictEqual(res, {}, '28a.2 Updated outer timestamp and settings change must dedupe');

    const tsTx = path.join(tmpState, 'ts-transcript.jsonl');
    const tsRows = [
      { step_index: 10, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '上一轮需求' },
      { step_index: 11, type: 'PLANNER_RESPONSE', content: '已完成上一轮。' },
    ];
    fs.writeFileSync(tsTx, tsRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({
      conversationId: 'conv-ts-flush',
      transcriptPath: tsTx,
      initialNumSteps: 13,
      lastUserInput: `${wrappedReq}\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:02:10+08:00.\n</ADDITIONAL_METADATA>`,
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '28b.1 Pre-flush invocation routes');

    tsRows.push({ step_index: 12, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: wrappedReq });
    fs.writeFileSync(tsTx, tsRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({
      conversationId: 'conv-ts-flush',
      transcriptPath: tsTx,
      initialNumSteps: 15,
      lastUserInput: `${wrappedReq}\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:02:15+08:00.\n</ADDITIONAL_METADATA>`,
    });
    assert.deepStrictEqual(res, {}, '28b.2 Post-flush upgrade with changed timestamp must dedupe');

    res = runHook({
      conversationId: 'conv-ts-flush',
      transcriptPath: tsTx,
      initialNumSteps: 20,
      lastUserInput: `${wrappedReq}\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:02:20+08:00.\n</ADDITIONAL_METADATA>`,
    });
    assert.deepStrictEqual(res, {}, '28b.3 Subsequent invocation matches upgraded stepKey regardless of timestamp');

    res = runHook({
      conversationId: 'conv-ts-unwrapped',
      initialNumSteps: 1,
      lastUserInput: '帮我写接口压测脚本\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:03:00+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '28c.1 Unwrapped prompt routes');
    res = runHook({
      conversationId: 'conv-ts-unwrapped',
      initialNumSteps: 1,
      lastUserInput: '帮我写接口压测脚本\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:03:09+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert.deepStrictEqual(res, {}, '28c.2 Unwrapped prompt dedupes across outer timestamp change');
  }

  // 29. withTurnLock concurrent deduplication, out-of-order flush race, stale recovery, and live lock wait
  {
    const sha16 = (str) => crypto.createHash('sha256').update(String(str)).digest('hex').slice(0, 16);
    const stateDir = path.join(tmpState, 'prompt-optimizer');

    // 29a. 6-way parallel burst on same turn with distinct outer timestamps -> exactly 1 ROUTER, 5 {}, 0 leftover locks
    const burstResults = await Promise.all(
      Array.from({ length: 6 }, (_, i) => runHookAsync({
        conversationId: 'conv-concurrent-lock',
        initialNumSteps: 10,
        lastUserInput: `<USER_REQUEST>\n帮我设计灰度发布方案\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:04:0${i}+08:00.\n</ADDITIONAL_METADATA>`,
      }))
    );
    const burstRouted = burstResults.filter((r) => getInjectedText(r).includes('[PROMPT-OPTIMIZER ROUTER]'));
    const burstEmpty = burstResults.filter((r) => Object.keys(r).length === 0);
    assert.strictEqual(burstRouted.length, 1, '29a.1 Expected exactly 1 ROUTER across 6 concurrent calls');
    assert.strictEqual(burstEmpty.length, 5, '29a.2 Expected 5 empty dedupe results across 6 concurrent calls');
    assert.strictEqual(fs.readdirSync(stateDir).filter((f) => f.endsWith('.lock')).length, 0, '29a.3 Expected no leftover lock files');

    // 29b. Out-of-order race: post-flush wins before pre-flush, plus mixed 6-way concurrent burst
    const raceBody = '<USER_REQUEST>\n帮我优化数据库索引\n</USER_REQUEST>';
    const preFlushTx = path.join(tmpState, 'race-pre-flush.jsonl');
    const postFlushTx = path.join(tmpState, 'race-post-flush.jsonl');
    const baseRows = [
      { step_index: 10, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '先看下慢查询' },
      { step_index: 11, type: 'PLANNER_RESPONSE', content: '已列出慢查询清单。' },
    ];
    fs.writeFileSync(preFlushTx, baseRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    fs.writeFileSync(postFlushTx, [
      ...baseRows,
      { step_index: 12, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: raceBody },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    res = runHook({
      conversationId: 'conv-lock-order',
      transcriptPath: postFlushTx,
      initialNumSteps: 14,
      lastUserInput: `${raceBody}\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:05:02+08:00.\n</ADDITIONAL_METADATA>`,
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '29b.1 Post-flush call winning first routes');

    res = runHook({
      conversationId: 'conv-lock-order',
      transcriptPath: preFlushTx,
      initialNumSteps: 13,
      lastUserInput: `${raceBody}\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:05:01+08:00.\n</ADDITIONAL_METADATA>`,
    });
    assert.deepStrictEqual(res, {}, '29b.2 Late pre-flush call must dedupe against already-stored post-flush state');

    const mixedCalls = [];
    for (let i = 0; i < 3; i++) {
      mixedCalls.push(runHookAsync({
        conversationId: 'conv-lock-mixed',
        transcriptPath: preFlushTx,
        initialNumSteps: 13,
        lastUserInput: `${raceBody}\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:06:0${i}+08:00.\n</ADDITIONAL_METADATA>`,
      }));
      mixedCalls.push(runHookAsync({
        conversationId: 'conv-lock-mixed',
        transcriptPath: postFlushTx,
        initialNumSteps: 14,
        lastUserInput: `${raceBody}\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:06:1${i}+08:00.\n</ADDITIONAL_METADATA>`,
      }));
    }
    const mixedResults = await Promise.all(mixedCalls);
    assert.strictEqual(mixedResults.filter((r) => getInjectedText(r).includes('[PROMPT-OPTIMIZER ROUTER]')).length, 1, '29b.3 Expected exactly 1 ROUTER in mixed pre/post-flush burst');
    assert.strictEqual(mixedResults.filter((r) => Object.keys(r).length === 0).length, 5, '29b.4 Expected 5 empty dedupe results in mixed pre/post-flush burst');
    assert.strictEqual(fs.readdirSync(stateDir).filter((f) => f.endsWith('.lock')).length, 0, '29b.5 Expected no leftover lock files after mixed burst');

    // 29c. Stale lock recovery and live lock wait
    fs.mkdirSync(stateDir, { recursive: true });
    const staleLock = path.join(stateDir, `turn-${sha16('conv-stale-lock')}.lock`);
    fs.writeFileSync(staleLock, '999999', 'utf8');
    const staleTime = new Date(Date.now() - 10000);
    fs.utimesSync(staleLock, staleTime, staleTime);
    res = runHook({
      conversationId: 'conv-stale-lock',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n帮我梳理监控告警规则\n</USER_REQUEST>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '29c.1 Expected stale lock to be recovered and turn to route');
    assert(!fs.existsSync(staleLock), '29c.2 Expected stale lock file to be cleaned up');

    const waitConv = 'conv-wait-lock';
    const waitLock = path.join(stateDir, `turn-${sha16(waitConv)}.lock`);
    const waitTurnFile = path.join(stateDir, `turn-${sha16(waitConv)}.json`);
    const waitProbe = path.join(tmpState, 'eexist-probe.js');
    const waitMarker = path.join(tmpState, 'eexist.marker');
    const waitBody = '帮我检查队列堆积';
    const waitDigest = sha16(waitBody);
    fs.writeFileSync(waitProbe, [
      "'use strict';",
      "const fs = require('fs');",
      "const origOpenSync = fs.openSync;",
      "let marked = false;",
      "fs.openSync = function (p, flags, ...rest) {",
      "  try {",
      "    return origOpenSync.call(this, p, flags, ...rest);",
      "  } catch (err) {",
      "    if (!marked && err && err.code === 'EEXIST' && String(p) === process.env.PO_WATCH_LOCK) {",
      "      marked = true;",
      "      try { const fd = origOpenSync.call(fs, process.env.PO_EEXIST_MARKER, 'w'); fs.closeSync(fd); } catch (_) {}",
      "    }",
      "    throw err;",
      "  }",
      "};",
    ].join('\n'), 'utf8');
    fs.writeFileSync(waitLock, '999999', 'utf8');
    const waitPromise = runHookAsync({
      conversationId: waitConv,
      initialNumSteps: 1,
      lastUserInput: `<USER_REQUEST>\n${waitBody}\n</USER_REQUEST>`,
    }, undefined, {
      preload: waitProbe,
      env: { PO_WATCH_LOCK: waitLock, PO_EEXIST_MARKER: waitMarker },
    });
    let settledBeforeRelease = false;
    const waitSettled = waitPromise.then(() => { settledBeforeRelease = true; }, () => { settledBeforeRelease = true; });
    const markerDeadline = Date.now() + 2000;
    while (!fs.existsSync(waitMarker) && !settledBeforeRelease && Date.now() < markerDeadline) {
      await Promise.race([waitSettled, new Promise((r) => setTimeout(r, 10))]);
    }
    if (settledBeforeRelease) {
      const earlyRes = await waitPromise;
      assert.fail(`29c.3 Waiter exited before lock release with: ${JSON.stringify(earlyRes)}`);
    }
    assert(fs.existsSync(waitMarker), '29c.3 Expected waiter to encounter EEXIST on live lock');
    await Promise.race([waitSettled, new Promise((r) => setTimeout(r, 50))]);
    if (settledBeforeRelease) {
      const earlyRes = await waitPromise;
      assert.fail(`29c.4 Waiter must remain blocked while live lock is held, exited with: ${JSON.stringify(earlyRes)}`);
    }
    assert(fs.existsSync(waitLock), '29c.5 Fresh lock must not be evicted before LOCK_STALE_MS');
    fs.writeFileSync(waitTurnFile, JSON.stringify({
      stepKey: null,
      stepNum: null,
      initKey: `init:1:${waitDigest}`,
      digest: waitDigest,
      initialNumSteps: 1,
      fallbackKey: `init:1:${waitDigest}`,
    }), 'utf8');
    fs.unlinkSync(waitLock);
    const waitRes = await waitPromise;
    assert.deepStrictEqual(waitRes, {}, '29c.6 Waiter must read holder state after lock release and dedupe');
    assert(!fs.existsSync(waitLock), '29c.7 Expected waiter lock file to be cleaned up');
  }

  // 30. Consecutive identical-text turns before transcript flush must not collide with prior stepKey
  {
    const repConv = 'conv-repeat-flush';
    const repTx = path.join(tmpState, 'repeat-flush-transcript.jsonl');
    const repBody = '<USER_REQUEST>\n帮我重跑一下回归测试\n</USER_REQUEST>';
    const writeRep = (rows) => fs.writeFileSync(repTx, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    const repRows = [
      { step_index: 10, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: repBody },
    ];
    writeRep(repRows);
    res = runHook({
      conversationId: repConv,
      transcriptPath: repTx,
      initialNumSteps: 11,
      lastUserInput: `${repBody}\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:30:01+08:00.\n</ADDITIONAL_METADATA>`,
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '30a.1 Turn 1 routes and records step:10');

    repRows.push(
      { step_index: 11, type: 'PLANNER_RESPONSE', content: '', tool_calls: [{ name: 'run_command' }] },
      { step_index: 12, type: 'GENERIC', content: 'ok' },
      { step_index: 13, type: 'PLANNER_RESPONSE', content: '回归测试全部通过。' },
      { step_index: 14, type: 'PLANNER_RESPONSE', content: '' },
    );
    writeRep(repRows);
    res = runHook({
      conversationId: repConv,
      transcriptPath: repTx,
      initialNumSteps: 16,
      lastUserInput: `${repBody}\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:30:02+08:00.\n</ADDITIONAL_METADATA>`,
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '30a.2 Unflushed identical Turn 2 must route instead of colliding with step:10');

    repRows.push({ step_index: 15, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: repBody });
    writeRep(repRows);
    res = runHook({
      conversationId: repConv,
      transcriptPath: repTx,
      initialNumSteps: 18,
      lastUserInput: `${repBody}\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:30:03+08:00.\n</ADDITIONAL_METADATA>`,
    });
    assert.deepStrictEqual(res, {}, '30a.3 Turn 2 invocation 2 after step 15 flushes must upgrade key and dedupe');

    repRows.push({ step_index: 16, type: 'PLANNER_RESPONSE', content: '正在执行测试...', tool_calls: [{ name: 'run_command' }] });
    writeRep(repRows);
    res = runHook({
      conversationId: repConv,
      transcriptPath: repTx,
      initialNumSteps: 19,
      lastUserInput: `${repBody}\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:30:04+08:00.\n</ADDITIONAL_METADATA>`,
    });
    assert.deepStrictEqual(res, {}, '30b.1 Mid-turn PLANNER_RESPONSE with tool_calls must still dedupe');

    repRows.push(
      { step_index: 17, type: 'GENERIC', content: 'done' },
      { step_index: 18, type: 'PLANNER_RESPONSE', content: '先汇报阶段结果。' },
      { step_index: 19, type: 'SYSTEM_MESSAGE', content: 'background task finished' },
    );
    writeRep(repRows);
    res = runHook({
      conversationId: repConv,
      transcriptPath: repTx,
      initialNumSteps: 20,
      lastUserInput: `${repBody}\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:30:05+08:00.\n</ADDITIONAL_METADATA>`,
    });
    assert.deepStrictEqual(res, {}, '30b.2 Mid-turn continuation after SYSTEM_MESSAGE must still dedupe');

    const repPendingTx = path.join(tmpState, 'repeat-pending-transcript.jsonl');
    fs.writeFileSync(repPendingTx, [
      { step_index: 20, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: repBody },
      { step_index: 21, type: 'PLANNER_RESPONSE', content: '### 优化后的提问\n\n> 重跑全量回归测试并汇报结果。\n\n确认吗？' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({
      conversationId: 'conv-repeat-pending',
      transcriptPath: repPendingTx,
      initialNumSteps: 23,
      lastUserInput: `${repBody}\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:30:06+08:00.\n</ADDITIONAL_METADATA>`,
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '30c. Unflushed identical Turn 2 after optimizer prompt must detect PENDING-REPLY');

    // 30d. Live background-task wakeup regression: GENERIC RUNNING + progress PLANNER_RESPONSE must stay mid-turn
    const bgConv = 'conv-bg-wakeup';
    const bgTx = path.join(tmpState, 'bg-wakeup-transcript.jsonl');
    const bgMeta1 = '<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:29:41+08:00.\n</ADDITIONAL_METADATA>';
    const bgMeta2 = '<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:40:50+08:00.\n</ADDITIONAL_METADATA>';
    const bgRows = [
      { step_index: 105, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: `${repBody}\n${bgMeta1}` },
    ];
    fs.writeFileSync(bgTx, bgRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({
      conversationId: bgConv,
      transcriptPath: bgTx,
      initialNumSteps: 106,
      lastUserInput: `${repBody}\n${bgMeta1}`,
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '30d.1 Initial turn routes');

    bgRows.push(
      { step_index: 134, type: 'GENERIC', status: 'RUNNING', content: 'Tool is running as a background task' },
      { step_index: 135, type: 'PLANNER_RESPONSE', content: '正在等待后台任务返回。' },
    );
    fs.writeFileSync(bgTx, bgRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({
      conversationId: bgConv,
      transcriptPath: bgTx,
      initialNumSteps: 136,
      lastUserInput: `${repBody}\n${bgMeta1}`,
    });
    const bgWakeText = getInjectedText(res);
    assert(
      !bgWakeText.includes('[PROMPT-OPTIMIZER ROUTER]') &&
      !bgWakeText.includes('[PROMPT-OPTIMIZER PENDING-REPLY]') &&
      bgWakeText.includes('[PROMPT-OPTIMIZER NEXT-STEP]'),
      '30d.2 Background wakeup after 30 steps must dedupe ROUTER and only refresh NEXT-STEP'
    );
    res = runHook({
      conversationId: bgConv,
      transcriptPath: bgTx,
      initialNumSteps: 137,
      lastUserInput: `${repBody}\n${bgMeta2}`,
    });
    assert.deepStrictEqual(res, {}, '30d.3 Background wakeup with updated timestamp while RUNNING task pending must dedupe');

    // 30e. Completed text turn: identical outer metadata replays dedupe; new outer metadata timestamp starts Turn 2
    const replayConv = 'conv-replay-meta';
    const replayTx = path.join(tmpState, 'replay-meta-transcript.jsonl');
    const metaT1 = '<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:29:41+08:00.\n</ADDITIONAL_METADATA>';
    const metaT2 = '<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:45:00+08:00.\n</ADDITIONAL_METADATA>';
    fs.writeFileSync(replayTx, [
      { step_index: 10, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: `${repBody}\n${metaT1}` },
      { step_index: 11, type: 'PLANNER_RESPONSE', content: '任务已完成。' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({
      conversationId: replayConv,
      transcriptPath: replayTx,
      initialNumSteps: 11,
      lastUserInput: `${repBody}\n${metaT1}`,
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '30e.1 Turn 1 routes with step:10');
    res = runHook({
      conversationId: replayConv,
      transcriptPath: replayTx,
      initialNumSteps: 12,
      lastUserInput: `${repBody}\n${metaT1}`,
    });
    assert.deepStrictEqual(res, {}, '30e.2 Re-invocation with identical outer timestamp dedupes against step:10');
    res = runHook({
      conversationId: replayConv,
      transcriptPath: replayTx,
      initialNumSteps: 12,
      lastUserInput: `${repBody}\n${metaT2}`,
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '30e.3 Unflushed Turn 2 with new outer timestamp routes cleanly');

    // 30f. Multiple concurrent background tasks: verify sender= and Task id completion formats independently
    for (const { label, fmt } of [
      { label: 'sender', fmt: (id) => `[Message] sender=${id} content=finished` },
      { label: 'taskid', fmt: (id) => `Task id "${id}" finished` },
    ]) {
      const multiBgConv = `conv-multi-bg-${label}`;
      const multiBgTx = path.join(tmpState, `multi-bg-${label}-transcript.jsonl`);
      const t1 = `${multiBgConv}/task-1`;
      const t2 = `${multiBgConv}/task-2`;
      const multiBgRows = [
        { step_index: 10, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: `${repBody}\n${metaT1}` },
      ];
      fs.writeFileSync(multiBgTx, multiBgRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      res = runHook({
        conversationId: multiBgConv,
        transcriptPath: multiBgTx,
        initialNumSteps: 11,
        lastUserInput: `${repBody}\n${metaT1}`,
      });
      assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), `30f.${label}.1 Initial multi-task turn routes`);

      multiBgRows.push(
        { step_index: 11, type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: ${t1}\n` },
        { step_index: 12, type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: ${t2}\n` },
        { step_index: 13, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: fmt(t1) },
        { step_index: 14, type: 'PLANNER_RESPONSE', content: 'task-1 完成，继续等待 task-2。' },
      );
      fs.writeFileSync(multiBgTx, multiBgRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      res = runHook({
        conversationId: multiBgConv,
        transcriptPath: multiBgTx,
        initialNumSteps: 15,
        lastUserInput: `${repBody}\n${metaT2}`,
      });
      assert.deepStrictEqual(res, {}, `30f.${label}.2 Wakeup while task-2 still pending must dedupe`);

      multiBgRows.push(
        { step_index: 16, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: fmt(t2) },
        { step_index: 17, type: 'PLANNER_RESPONSE', content: '两项任务全部完成。' },
      );
      fs.writeFileSync(multiBgTx, multiBgRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      res = runHook({
        conversationId: multiBgConv,
        transcriptPath: multiBgTx,
        initialNumSteps: 18,
        lastUserInput: `${repBody}\n${metaT2}`,
      });
      assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), `30f.${label}.3 Turn 2 after all background tasks complete routes cleanly`);
    }

    // 30g. Named task completion must not clear anonymous RUNNING task state
    const mixedBgConv = 'conv-mixed-bg';
    const mixedBgTx = path.join(tmpState, 'mixed-bg-transcript.jsonl');
    const mixedBgRows = [
      { step_index: 10, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: `${repBody}\n${metaT1}` },
    ];
    fs.writeFileSync(mixedBgTx, mixedBgRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({
      conversationId: mixedBgConv,
      transcriptPath: mixedBgTx,
      initialNumSteps: 11,
      lastUserInput: `${repBody}\n${metaT1}`,
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '30g.1 Initial mixed-task turn routes');

    mixedBgRows.push(
      { step_index: 11, type: 'GENERIC', status: 'RUNNING', content: 'Tool is running as a background task with task id: conv-mixed-bg/task-1\n' },
      { step_index: 12, type: 'GENERIC', status: 'RUNNING', content: 'Anonymous running operation' },
      { step_index: 13, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: '[Message] sender=conv-mixed-bg/task-1 content=finished' },
      { step_index: 14, type: 'PLANNER_RESPONSE', content: 'task-1 完成，匿名任务仍在运行。' },
    );
    fs.writeFileSync(mixedBgTx, mixedBgRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({
      conversationId: mixedBgConv,
      transcriptPath: mixedBgTx,
      initialNumSteps: 15,
      lastUserInput: `${repBody}\n${metaT2}`,
    });
    assert.deepStrictEqual(res, {}, '30g.2 Named task completion must not clear anonymous RUNNING task');

    mixedBgRows.push(
      { step_index: 16, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: 'Task id "conv-mixed-bg/other" finished' },
      { step_index: 17, type: 'PLANNER_RESPONSE', content: '仍需等待匿名后台任务。' },
    );
    fs.writeFileSync(mixedBgTx, mixedBgRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({
      conversationId: mixedBgConv,
      transcriptPath: mixedBgTx,
      initialNumSteps: 18,
      lastUserInput: `${repBody}\n${metaT2}`,
    });
    assert.deepStrictEqual(res, {}, '30g.3 Unmatched named completion must still keep anonymous RUNNING task');

    mixedBgRows.push(
      { step_index: 19, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: 'Anonymous operation finished' },
      { step_index: 20, type: 'PLANNER_RESPONSE', content: '全部完成。' },
    );
    fs.writeFileSync(mixedBgTx, mixedBgRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({
      conversationId: mixedBgConv,
      transcriptPath: mixedBgTx,
      initialNumSteps: 21,
      lastUserInput: `${repBody}\n${metaT2}`,
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '30g.4 Turn 2 after anonymous completion routes cleanly');

    // 30h. Single-envelope task ID extraction: sender= in [Message] must not delete a different Task id mentioned inside content=
    const envBgConv = 'conv-envelope-bg';
    const envBgTx = path.join(tmpState, 'envelope-bg-transcript.jsonl');
    const envBgRows = [
      { step_index: 10, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: `${repBody}\n${metaT1}` },
    ];
    fs.writeFileSync(envBgTx, envBgRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({
      conversationId: envBgConv,
      transcriptPath: envBgTx,
      initialNumSteps: 11,
      lastUserInput: `${repBody}\n${metaT1}`,
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '30h.1 Initial envelope-test turn routes');

    envBgRows.push(
      { step_index: 11, type: 'GENERIC', status: 'RUNNING', content: 'Tool is running as a background task with task id: conv-envelope-bg/task-a\n' },
      { step_index: 12, type: 'GENERIC', status: 'RUNNING', content: 'Tool is running as a background task with task id: conv-envelope-bg/task-b\n' },
      { step_index: 13, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: '[Message] sender=conv-envelope-bg/task-a content=Task id "conv-envelope-bg/task-b" is still running' },
      { step_index: 14, type: 'PLANNER_RESPONSE', content: 'task-a 已完成，task-b 仍在运行。' },
    );
    fs.writeFileSync(envBgTx, envBgRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({
      conversationId: envBgConv,
      transcriptPath: envBgTx,
      initialNumSteps: 15,
      lastUserInput: `${repBody}\n${metaT2}`,
    });
    assert.deepStrictEqual(res, {}, '30h.2 Message mentioning another Task id inside content= must not clear task-b');

    envBgRows.push(
      { step_index: 16, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: '[Message] content=Task id "conv-envelope-bg/task-b" is still running' },
      { step_index: 17, type: 'PLANNER_RESPONSE', content: '收到无 sender 状态消息，task-b 仍在运行。' },
    );
    fs.writeFileSync(envBgTx, envBgRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({
      conversationId: envBgConv,
      transcriptPath: envBgTx,
      initialNumSteps: 18,
      lastUserInput: `${repBody}\n${metaT2}`,
    });
    assert.deepStrictEqual(res, {}, '30h.3 Senderless [Message] mentioning Task id must not clear task-b');

    envBgRows.push(
      { step_index: 18, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: 'Task id "conv-envelope-bg/task-b" is still running' },
      { step_index: 19, type: 'PLANNER_RESPONSE', content: 'task-b 状态仍为运行中。' },
    );
    fs.writeFileSync(envBgTx, envBgRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({
      conversationId: envBgConv,
      transcriptPath: envBgTx,
      initialNumSteps: 20,
      lastUserInput: `${repBody}\n${metaT2}`,
    });
    assert.deepStrictEqual(res, {}, '30h.4 Non-finished standalone Task id notice must not clear task-b');

    envBgRows.push(
      { step_index: 20, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: '[Message] sender=conv-envelope-bg/task-b content=finished' },
      { step_index: 21, type: 'PLANNER_RESPONSE', content: '全部任务完成。' },
    );
    fs.writeFileSync(envBgTx, envBgRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({
      conversationId: envBgConv,
      transcriptPath: envBgTx,
      initialNumSteps: 22,
      lastUserInput: `${repBody}\n${metaT2}`,
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '30h.5 Turn 2 routes cleanly after task-b finishes');
  }

  // 31. Literal <USER_REQUEST> inside outer metadata or nested inside <USER_REQUEST> must be handled accurately
  {
    res = runHook({
      conversationId: 'conv-outer-req-tag',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n帮我检查缓存穿透问题\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:30:00+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31a.1 Initial wrapped request routes');

    res = runHook({
      conversationId: 'conv-outer-req-tag',
      initialNumSteps: 1,
      lastUserInput: '<ADDITIONAL_METADATA>\nPrefix <USER_REQUEST>ignored-before</USER_REQUEST>\n</ADDITIONAL_METADATA>\n<USER_REQUEST>\n帮我检查缓存穿透问题\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nSetting mentions <USER_REQUEST>ignored-after</USER_REQUEST>\n</USER_SETTINGS_CHANGE>',
    });
    assert.deepStrictEqual(res, {}, '31a.2 Literal <USER_REQUEST> inside outer metadata must be ignored');

    res = runHook({
      conversationId: 'conv-outer-req-unwrapped',
      initialNumSteps: 1,
      lastUserInput: '帮我优化接口超时配置\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:31:00+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31b.1 Initial unwrapped request routes');

    res = runHook({
      conversationId: 'conv-outer-req-unwrapped',
      initialNumSteps: 1,
      lastUserInput: '帮我优化接口超时配置\n<ADDITIONAL_METADATA>\nNote: <USER_REQUEST>fake-unwrapped</USER_REQUEST>\n</ADDITIONAL_METADATA>',
    });
    assert.deepStrictEqual(res, {}, '31b.2 Unwrapped request with literal <USER_REQUEST> inside outer metadata must dedupe');

    res = runHook({
      conversationId: 'conv-inner-settings-tag',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n<USER_SETTINGS_CHANGE>literal inner setting</USER_SETTINGS_CHANGE>\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nouter <USER_REQUEST>fake</USER_REQUEST>\n</USER_SETTINGS_CHANGE>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31c.1 Inner literal <USER_SETTINGS_CHANGE> preserved while outer <USER_REQUEST> ignored');
    res = runHook({
      conversationId: 'conv-inner-settings-tag',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\nliteral inner setting\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nouter <USER_REQUEST>fake</USER_REQUEST>\n</USER_SETTINGS_CHANGE>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '31c.2 Stripping inner <USER_SETTINGS_CHANGE> tags must produce a distinct digest');

    res = runHook({
      conversationId: 'conv-nested-req',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n帮我保留 <USER_REQUEST>foo</USER_REQUEST> 以及后面的关键约束 A\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:40:00+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31d.1 Nested literal <USER_REQUEST>...</USER_REQUEST> routes');
    res = runHook({
      conversationId: 'conv-nested-req',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n帮我保留 <USER_REQUEST>foo</USER_REQUEST> 以及后面的关键约束 A\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:40:05+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert.deepStrictEqual(res, {}, '31d.2 Nested literal <USER_REQUEST> dedupes across outer timestamp change');
    res = runHook({
      conversationId: 'conv-nested-req',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n帮我保留 <USER_REQUEST>foo</USER_REQUEST> 以及后面的关键约束 B\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:40:05+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '31d.3 Tail after inner </USER_REQUEST> is preserved in digest');

    res = runHook({
      conversationId: 'conv-unclosed-req',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释 <USER_REQUEST> 标签和后面的约束 A\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:40:00+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31d.4 Unclosed literal <USER_REQUEST> inside body routes');
    res = runHook({
      conversationId: 'conv-unclosed-req',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释 <USER_REQUEST> 标签和后面的约束 A\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:40:09+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert.deepStrictEqual(res, {}, '31d.5 Unclosed literal <USER_REQUEST> dedupes across outer timestamp change');

    res = runHook({
      conversationId: 'conv-lone-close-req',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST> 后面的约束 A\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:40:00+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31d.6 Lone closing </USER_REQUEST> inside body routes');
    res = runHook({
      conversationId: 'conv-lone-close-req',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST> 后面的约束 B\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:40:05+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '31d.7 Tail after lone closing </USER_REQUEST> is preserved in digest');

    res = runHook({
      conversationId: 'conv-lone-close-settings',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST>\n<USER_SETTINGS_CHANGE>示例</USER_SETTINGS_CHANGE>\n保留约束 A\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:40:00+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31d.8 Lone </USER_REQUEST> followed by literal <USER_SETTINGS_CHANGE> and tail routes');
    res = runHook({
      conversationId: 'conv-lone-close-settings',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST>\n<USER_SETTINGS_CHANGE>示例</USER_SETTINGS_CHANGE>\n保留约束 A\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:40:03+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert.deepStrictEqual(res, {}, '31d.9 Lone </USER_REQUEST> + literal <USER_SETTINGS_CHANGE> + tail dedupes across outer timestamp change');
    res = runHook({
      conversationId: 'conv-lone-close-settings',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST>\n<USER_SETTINGS_CHANGE>示例</USER_SETTINGS_CHANGE>\n保留约束 B\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:40:05+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '31d.10 Tail after lone </USER_REQUEST> + literal <USER_SETTINGS_CHANGE> is preserved in digest');

    res = runHook({
      conversationId: 'conv-lone-close-settings-adj',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST><USER_SETTINGS_CHANGE>示例 A</USER_SETTINGS_CHANGE>\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:40:00+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31d.11 Adjacent literal <USER_SETTINGS_CHANGE> after lone </USER_REQUEST> routes');
    res = runHook({
      conversationId: 'conv-lone-close-settings-adj',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST><USER_SETTINGS_CHANGE>示例 B</USER_SETTINGS_CHANGE>\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:40:05+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '31d.12 Content inside adjacent literal <USER_SETTINGS_CHANGE> is preserved in digest');

    res = runHook({
      conversationId: 'conv-lone-close-settings-direct',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST>\n<USER_SETTINGS_CHANGE>示例 A</USER_SETTINGS_CHANGE>\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:40:00+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31d.13 Lone </USER_REQUEST> directly before literal <USER_SETTINGS_CHANGE> and outer close routes');
    res = runHook({
      conversationId: 'conv-lone-close-settings-direct',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST>\n<USER_SETTINGS_CHANGE>示例 B</USER_SETTINGS_CHANGE>\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:40:05+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '31d.14 Literal <USER_SETTINGS_CHANGE> directly after lone </USER_REQUEST> is preserved in digest');

    res = runHook({
      conversationId: 'conv-lone-close-meta-tail',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST>\n<ADDITIONAL_METADATA>字面示例</ADDITIONAL_METADATA>\n保留约束 A\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:40:00+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31d.15 Lone </USER_REQUEST> followed by literal <ADDITIONAL_METADATA> and tail text routes');
    res = runHook({
      conversationId: 'conv-lone-close-meta-tail',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST>\n<ADDITIONAL_METADATA>字面示例</ADDITIONAL_METADATA>\n保留约束 B\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T13:40:05+08:00.\n</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '31d.16 Tail after lone </USER_REQUEST> + literal <ADDITIONAL_METADATA> is preserved in digest');

    res = runHook({
      conversationId: 'conv-lone-close-unclosed-settings',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST>\n<USER_SETTINGS_CHANGE>未闭合\n保留约束 A\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nModel changed.\n</USER_SETTINGS_CHANGE>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31d.17 Lone </USER_REQUEST> + unclosed literal <USER_SETTINGS_CHANGE> routes');
    res = runHook({
      conversationId: 'conv-lone-close-unclosed-settings',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST>\n<USER_SETTINGS_CHANGE>未闭合\n保留约束 B\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nModel changed.\n</USER_SETTINGS_CHANGE>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '31d.18 Tail after lone </USER_REQUEST> + unclosed literal <USER_SETTINGS_CHANGE> is preserved in digest');

    res = runHook({
      conversationId: 'conv-split-ur-literal',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>raw</USER_REQUEST><USER_REQUEST>: 帮我解释字面标签</USER_REQUEST>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31d.19 Lone </USER_REQUEST> followed by unclosed literal <USER_REQUEST> must stay one body and not trigger raw: bypass');

    res = runHook({
      conversationId: 'conv-split-ur-digest',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>alpha</USER_REQUEST><USER_REQUEST>beta 解释标签</USER_REQUEST>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31d.20a Literal </USER_REQUEST><USER_REQUEST> inside body routes');
    res = runHook({
      conversationId: 'conv-split-ur-digest',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>alpha</USER_REQUEST><USER_REQUEST>beta 解释标签</USER_REQUEST>\n<ADDITIONAL_METADATA>t2</ADDITIONAL_METADATA>',
    });
    assert.deepStrictEqual(res, {}, '31d.20b Identical body with literal </USER_REQUEST><USER_REQUEST> dedupes across outer metadata');
    res = runHook({
      conversationId: 'conv-split-ur-digest',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>alpha\nbeta 解释标签</USER_REQUEST>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '31d.20c Preserving literal </USER_REQUEST><USER_REQUEST> produces distinct digest from plain newline');

    res = runHook({
      conversationId: 'conv-outer-unclosed-meta',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST>\n<USER_SETTINGS_CHANGE>示例</USER_SETTINGS_CHANGE>\n保留约束 A\n</USER_REQUEST>\n<ADDITIONAL_METADATA>host quotes <ADDITIONAL_METADATA> literally</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>host quotes <USER_REQUEST>A</USER_REQUEST></USER_SETTINGS_CHANGE>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31e.1 Outer unclosed metadata + settings quoting <USER_REQUEST> routes');
    res = runHook({
      conversationId: 'conv-outer-unclosed-meta',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST>\n<USER_SETTINGS_CHANGE>示例</USER_SETTINGS_CHANGE>\n保留约束 A\n</USER_REQUEST>\n<ADDITIONAL_METADATA>host quotes <ADDITIONAL_METADATA> literally</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>host quotes <USER_REQUEST>B</USER_REQUEST></USER_SETTINGS_CHANGE>',
    });
    assert.deepStrictEqual(res, {}, '31e.2 Changes inside outer host-quoted <USER_REQUEST> must not affect digest');

    res = runHook({
      conversationId: 'conv-outer-nested-meta',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST><USER_SETTINGS_CHANGE>unclosed\n保留约束 A\n</USER_REQUEST>\n<ADDITIONAL_METADATA>host quotes <ADDITIONAL_METADATA>inner</ADDITIONAL_METADATA> literally</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>outer <USER_REQUEST>X</USER_REQUEST></USER_SETTINGS_CHANGE>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31e.3 Outer balanced nested metadata + settings quoting <USER_REQUEST> routes');
    res = runHook({
      conversationId: 'conv-outer-nested-meta',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST><USER_SETTINGS_CHANGE>unclosed\n保留约束 A\n</USER_REQUEST>\n<ADDITIONAL_METADATA>host quotes <ADDITIONAL_METADATA>inner</ADDITIONAL_METADATA> literally</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>outer <USER_REQUEST>Y</USER_REQUEST></USER_SETTINGS_CHANGE>',
    });
    assert.deepStrictEqual(res, {}, '31e.4 Changes inside outer settings <USER_REQUEST> after nested metadata must dedupe');
    res = runHook({
      conversationId: 'conv-outer-nested-meta',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST><USER_SETTINGS_CHANGE>unclosed\n保留约束 B\n</USER_REQUEST>\n<ADDITIONAL_METADATA>host quotes <ADDITIONAL_METADATA>inner</ADDITIONAL_METADATA> literally</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>outer <USER_REQUEST>Y</USER_REQUEST></USER_SETTINGS_CHANGE>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '31e.5 Real user body change after outer-meta resilience still detects distinct digest');

    res = runHook({
      conversationId: 'conv-outer-close-meta',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n帮我排查缓存\n</USER_REQUEST>\n<ADDITIONAL_METADATA>host quotes </ADDITIONAL_METADATA> and <USER_REQUEST>A1: 宿主示例</USER_REQUEST></ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31e.6 Host metadata quoting literal </ADDITIONAL_METADATA> + <USER_REQUEST> routes');
    res = runHook({
      conversationId: 'conv-outer-close-meta',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n帮我排查缓存\n</USER_REQUEST>\n<ADDITIONAL_METADATA>host quotes </ADDITIONAL_METADATA> and <USER_REQUEST>B1: 宿主示例</USER_REQUEST></ADDITIONAL_METADATA>',
    });
    assert.deepStrictEqual(res, {}, '31e.7 Host-quoted <USER_REQUEST> after literal </ADDITIONAL_METADATA> must not affect digest');

    res = runHook({
      conversationId: 'conv-multi-ur-meta',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>帮我排查缓存</USER_REQUEST>\n<ADDITIONAL_METADATA>t1</ADDITIONAL_METADATA>\n<USER_REQUEST>再检查超时</USER_REQUEST>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31e.8 Separate top-level <USER_REQUEST> blocks separated by metadata route');
    res = runHook({
      conversationId: 'conv-multi-ur-meta',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>帮我排查缓存</USER_REQUEST>\n<ADDITIONAL_METADATA>t2</ADDITIONAL_METADATA>\n<USER_REQUEST>再检查超时</USER_REQUEST>',
    });
    assert.deepStrictEqual(res, {}, '31e.9 Middle metadata between separate <USER_REQUEST> blocks must be stripped before hashing');

    res = runHook({
      conversationId: 'conv-split-ur-outer-close-meta',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>raw</USER_REQUEST><USER_REQUEST>: 帮我解释字面标签</USER_REQUEST>\n<ADDITIONAL_METADATA>host quotes </ADDITIONAL_METADATA> literally</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31e.10 Literal </ADDITIONAL_METADATA> in outer metadata must preserve single outer <USER_REQUEST>');

    res = runHook({
      conversationId: 'conv-lone-close-outer-close-meta',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST>\n<USER_SETTINGS_CHANGE>示例</USER_SETTINGS_CHANGE>\n保留约束 A\n</USER_REQUEST>\n<ADDITIONAL_METADATA>host quotes </ADDITIONAL_METADATA> literally1</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31e.11 Lone </USER_REQUEST> + literal settings with outer </ADDITIONAL_METADATA> quote routes');
    res = runHook({
      conversationId: 'conv-lone-close-outer-close-meta',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST>\n<USER_SETTINGS_CHANGE>示例</USER_SETTINGS_CHANGE>\n保留约束 A\n</USER_REQUEST>\n<ADDITIONAL_METADATA>host quotes </ADDITIONAL_METADATA> literally2</ADDITIONAL_METADATA>',
    });
    assert.deepStrictEqual(res, {}, '31e.12 Outer metadata change with literal </ADDITIONAL_METADATA> dedupes');
    res = runHook({
      conversationId: 'conv-lone-close-outer-close-meta',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n解释字面 </USER_REQUEST>\n<USER_SETTINGS_CHANGE>示例</USER_SETTINGS_CHANGE>\n保留约束 B\n</USER_REQUEST>\n<ADDITIONAL_METADATA>host quotes </ADDITIONAL_METADATA> literally2</ADDITIONAL_METADATA>',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '31e.13 Body constraint B after lone </USER_REQUEST> + literal settings produces distinct digest');

    res = runHook({
      conversationId: 'conv-split-ur-trailing-untagged',
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>raw</USER_REQUEST><USER_REQUEST>: 帮我解释字面标签</USER_REQUEST>\ntrailing-untagged-note',
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31e.14 Fallback single-outer-<USER_REQUEST> rule must not split on trailing untagged text');

    const largeBody = 'x </USER_REQUEST><USER_SETTINGS_CHANGE>y</USER_SETTINGS_CHANGE> '.repeat(3500) + '约束 A';
    const largeStart = Date.now();
    res = runHook({
      conversationId: 'conv-large-tags',
      initialNumSteps: 1,
      lastUserInput: `<USER_REQUEST>\n${largeBody}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>t1</ADDITIONAL_METADATA>`,
    }, undefined, { timeout: 3000 });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '31f.1 ~220KB repeated tag body routes without stack overflow or quadratic stall');
    assert(Date.now() - largeStart < 1500, '31f.1b ~220KB repeated tag body must parse linearly (<1500ms)');
    res = runHook({
      conversationId: 'conv-large-tags',
      initialNumSteps: 1,
      lastUserInput: `<USER_REQUEST>\n${largeBody}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>t2</ADDITIONAL_METADATA>`,
    }, undefined, { timeout: 3000 });
    assert.deepStrictEqual(res, {}, '31f.2 ~220KB repeated tag body dedupes across outer metadata change');
    const largeBodyB = largeBody.slice(0, -1) + 'B';
    res = runHook({
      conversationId: 'conv-large-tags',
      initialNumSteps: 1,
      lastUserInput: `<USER_REQUEST>\n${largeBodyB}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>t2</ADDITIONAL_METADATA>`,
    }, undefined, { timeout: 3000 });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '31f.3 Trailing change in ~220KB repeated tag body produces distinct digest');
  }

  // 32. withTurnLock timeout fails closed, non-ENOENT stat errors fail open, and expired deadline never unlinks stale lock
  {
    const sha16 = (str) => crypto.createHash('sha256').update(String(str)).digest('hex').slice(0, 16);
    const stateDir = path.join(tmpState, 'prompt-optimizer');
    fs.mkdirSync(stateDir, { recursive: true });
    const timeoutConv = 'conv-lock-timeout';
    const timeoutLock = path.join(stateDir, `turn-${sha16(timeoutConv)}.lock`);
    const timeoutTurnFile = path.join(stateDir, `turn-${sha16(timeoutConv)}.json`);
    const timeoutInput = '<USER_REQUEST>\n帮我排查超时降级\n</USER_REQUEST>';
    fs.writeFileSync(timeoutLock, '999999', 'utf8');
    assert(!fs.existsSync(timeoutTurnFile), '32.pre Expected no prior turn file');

    const t0 = Date.now();
    const timeoutRes = await runHookAsync({
      conversationId: timeoutConv,
      initialNumSteps: 1,
      lastUserInput: timeoutInput,
    });
    assert.deepStrictEqual(timeoutRes, {}, '32a. Expected {} when lock wait times out');
    assert(Date.now() - t0 >= 900, '32b. Expected waiter to block until LOCK_WAIT_MS timeout');
    assert(!fs.existsSync(timeoutTurnFile), '32c. Timed-out waiter must not write turn state file');
    assert(fs.existsSync(timeoutLock), '32d. Timed-out waiter must not unlink holder lock file');

    fs.unlinkSync(timeoutLock);
    res = runHook({
      conversationId: timeoutConv,
      initialNumSteps: 1,
      lastUserInput: timeoutInput,
    });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '32e. Subsequent invocation after lock release routes cleanly');

    const statErrConv = 'conv-lock-stat-err';
    const statErrLock = path.join(stateDir, `turn-${sha16(statErrConv)}.lock`);
    const statErrProbe = path.join(tmpState, 'stat-err-probe.js');
    const statErrCountFile = path.join(tmpState, 'stat-err.count');
    const statErrWaitMarker = path.join(tmpState, 'stat-err.wait');
    fs.writeFileSync(statErrLock, '999999', 'utf8');
    fs.writeFileSync(statErrProbe, [
      "'use strict';",
      "const fs = require('fs');",
      "const origStatSync = fs.statSync;",
      "const origWait = Atomics.wait;",
      "fs.statSync = function (p, ...rest) {",
      "  if (String(p) === process.env.PO_WATCH_LOCK) {",
      "    fs.appendFileSync(process.env.PO_STAT_COUNT, '1');",
      "    const err = new Error('simulated EIO');",
      "    err.code = 'EIO';",
      "    throw err;",
      "  }",
      "  return origStatSync.call(this, p, ...rest);",
      "};",
      "Atomics.wait = function (...args) {",
      "  try { fs.writeFileSync(process.env.PO_WAIT_MARKER, '1'); } catch (_) {}",
      "  return origWait.apply(this, args);",
      "};",
    ].join('\n'), 'utf8');
    const statErrRes = await runHookAsync({
      conversationId: statErrConv,
      initialNumSteps: 1,
      lastUserInput: timeoutInput,
    }, undefined, {
      preload: statErrProbe,
      env: { PO_WATCH_LOCK: statErrLock, PO_STAT_COUNT: statErrCountFile, PO_WAIT_MARKER: statErrWaitMarker },
    });
    assert(getInjectedText(statErrRes).includes('[PROMPT-OPTIMIZER ROUTER]'), '32f.1 Non-ENOENT statSync error must fail open');
    assert(!fs.existsSync(statErrWaitMarker), '32f.2 Non-ENOENT statSync error must break immediately without entering Atomics.wait');
    assert.strictEqual(fs.readFileSync(statErrCountFile, 'utf8'), '1', '32f.3 Non-ENOENT statSync error must break on first stat failure');
    assert(fs.existsSync(statErrLock), '32f.4 Unacquired lock file must not be unlinked');
    fs.unlinkSync(statErrLock);

    const staleDeadlineConv = 'conv-lock-deadline-stale';
    const staleDeadlineLock = path.join(stateDir, `turn-${sha16(staleDeadlineConv)}.lock`);
    const staleDeadlineProbe = path.join(tmpState, 'deadline-delay-probe.js');
    fs.writeFileSync(staleDeadlineLock, '999999', 'utf8');
    const stalePast = new Date(Date.now() - 10000);
    fs.utimesSync(staleDeadlineLock, stalePast, stalePast);
    fs.writeFileSync(staleDeadlineProbe, [
      "'use strict';",
      "const fs = require('fs');",
      "const origOpenSync = fs.openSync;",
      "const buf = new Int32Array(new SharedArrayBuffer(4));",
      "let delayed = false;",
      "fs.openSync = function (p, flags, ...rest) {",
      "  try {",
      "    return origOpenSync.call(this, p, flags, ...rest);",
      "  } catch (err) {",
      "    if (!delayed && err && err.code === 'EEXIST' && String(p) === process.env.PO_WATCH_LOCK) {",
      "      delayed = true;",
      "      Atomics.wait(buf, 0, 0, 1020);",
      "    }",
      "    throw err;",
      "  }",
      "};",
    ].join('\n'), 'utf8');
    const staleDeadlineRes = await runHookAsync({
      conversationId: staleDeadlineConv,
      initialNumSteps: 1,
      lastUserInput: timeoutInput,
    }, undefined, { preload: staleDeadlineProbe, env: { PO_WATCH_LOCK: staleDeadlineLock } });
    assert.deepStrictEqual(staleDeadlineRes, {}, '32g.1 Expired deadline returns {} without retrying');
    assert(fs.existsSync(staleDeadlineLock), '32g.2 Stale lock must not be unlinked once deadline has expired');
    fs.unlinkSync(staleDeadlineLock);

    const statDeadlineConv = 'conv-lock-stat-deadline';
    const statDeadlineLock = path.join(stateDir, `turn-${sha16(statDeadlineConv)}.lock`);
    const statDeadlineProbe = path.join(tmpState, 'stat-deadline-probe.js');
    fs.writeFileSync(statDeadlineLock, '999999', 'utf8');
    fs.utimesSync(statDeadlineLock, stalePast, stalePast);
    fs.writeFileSync(statDeadlineProbe, [
      "'use strict';",
      "const fs = require('fs');",
      "const origStatSync = fs.statSync;",
      "const buf = new Int32Array(new SharedArrayBuffer(4));",
      "let delayed = false;",
      "fs.statSync = function (p, ...rest) {",
      "  if (!delayed && String(p) === process.env.PO_WATCH_LOCK) {",
      "    delayed = true;",
      "    Atomics.wait(buf, 0, 0, 1020);",
      "  }",
      "  return origStatSync.call(this, p, ...rest);",
      "};",
    ].join('\n'), 'utf8');
    const statDeadlineRes = await runHookAsync({
      conversationId: statDeadlineConv,
      initialNumSteps: 1,
      lastUserInput: timeoutInput,
    }, undefined, { preload: statDeadlineProbe, env: { PO_WATCH_LOCK: statDeadlineLock } });
    assert.deepStrictEqual(statDeadlineRes, {}, '32h.1 Deadline expiring inside statSync returns {}');
    assert(fs.existsSync(statDeadlineLock), '32h.2 Stale lock must not be unlinked when deadline expires during statSync');
    fs.unlinkSync(statDeadlineLock);

    const enoentDeadlineConv = 'conv-lock-enoent-deadline';
    const enoentDeadlineLock = path.join(stateDir, `turn-${sha16(enoentDeadlineConv)}.lock`);
    const enoentDeadlineTurnFile = path.join(stateDir, `turn-${sha16(enoentDeadlineConv)}.json`);
    const enoentDeadlineProbe = path.join(tmpState, 'enoent-deadline-probe.js');
    const enoentOpenCountFile = path.join(tmpState, 'enoent-open.count');
    fs.writeFileSync(enoentDeadlineLock, '999999', 'utf8');
    assert(!fs.existsSync(enoentDeadlineTurnFile), '32i.pre Expected no prior turn file');
    fs.writeFileSync(enoentDeadlineProbe, [
      "'use strict';",
      "const fs = require('fs');",
      "const origOpenSync = fs.openSync;",
      "const origStatSync = fs.statSync;",
      "const origUnlinkSync = fs.unlinkSync;",
      "const buf = new Int32Array(new SharedArrayBuffer(4));",
      "let triggered = false;",
      "fs.openSync = function (p, flags, ...rest) {",
      "  if (String(p) === process.env.PO_WATCH_LOCK) {",
      "    fs.appendFileSync(process.env.PO_OPEN_COUNT, '1');",
      "  }",
      "  return origOpenSync.call(this, p, flags, ...rest);",
      "};",
      "fs.statSync = function (p, ...rest) {",
      "  if (!triggered && String(p) === process.env.PO_WATCH_LOCK) {",
      "    triggered = true;",
      "    Atomics.wait(buf, 0, 0, 1020);",
      "    try { origUnlinkSync.call(fs, p); } catch (_) {}",
      "  }",
      "  return origStatSync.call(this, p, ...rest);",
      "};",
    ].join('\n'), 'utf8');
    const enoentDeadlineRes = await runHookAsync({
      conversationId: enoentDeadlineConv,
      initialNumSteps: 1,
      lastUserInput: timeoutInput,
    }, undefined, {
      preload: enoentDeadlineProbe,
      env: { PO_WATCH_LOCK: enoentDeadlineLock, PO_OPEN_COUNT: enoentOpenCountFile },
    });
    assert.deepStrictEqual(enoentDeadlineRes, {}, '32i.1 ENOENT after deadline expires must fail closed without retrying openSync');
    assert(!fs.existsSync(enoentDeadlineTurnFile), '32i.2 Expired ENOENT waiter must not write turn state file');
    assert(!fs.existsSync(enoentDeadlineLock), '32i.3 Expired ENOENT waiter must not recreate lock file');
    assert.strictEqual(fs.readFileSync(enoentOpenCountFile, 'utf8'), '1', '32i.4 Must not retry openSync after post-deadline ENOENT');

    const clockSkewConv = 'conv-lock-clock-skew';
    const clockSkewLock = path.join(stateDir, `turn-${sha16(clockSkewConv)}.lock`);
    const clockSkewTurnFile = path.join(stateDir, `turn-${sha16(clockSkewConv)}.json`);
    const clockSkewProbe = path.join(tmpState, 'clock-skew-probe.js');
    const clockSkewOpenCountFile = path.join(tmpState, 'clock-skew-open.count');
    const clockSkewUnlinkClocksFile = path.join(tmpState, 'clock-skew-unlink.clocks');
    fs.writeFileSync(clockSkewLock, '999999', 'utf8');
    fs.utimesSync(clockSkewLock, stalePast, stalePast);
    fs.writeFileSync(clockSkewProbe, [
      "'use strict';",
      "const fs = require('fs');",
      "const { performance } = require('perf_hooks');",
      "const origOpenSync = fs.openSync;",
      "const origStatSync = fs.statSync;",
      "const origUnlinkSync = fs.unlinkSync;",
      "const origPerfNow = performance.now.bind(performance);",
      "const P0 = origPerfNow();",
      "let afterStat = false;",
      "let postStatClockCalls = 0;",
      "performance.now = function () {",
      "  if (!afterStat) return P0;",
      "  postStatClockCalls += 1;",
      "  return postStatClockCalls === 1 ? P0 + 999 : P0 + 1500;",
      "};",
      "fs.openSync = function (p, flags, ...rest) {",
      "  if (String(p) === process.env.PO_WATCH_LOCK) {",
      "    fs.appendFileSync(process.env.PO_OPEN_COUNT, '1');",
      "  }",
      "  return origOpenSync.call(this, p, flags, ...rest);",
      "};",
      "fs.statSync = function (p, ...rest) {",
      "  const st = origStatSync.call(this, p, ...rest);",
      "  if (String(p) === process.env.PO_WATCH_LOCK) {",
      "    afterStat = true;",
      "  }",
      "  return st;",
      "};",
      "fs.unlinkSync = function (p, ...rest) {",
      "  if (String(p) === process.env.PO_WATCH_LOCK) {",
      "    fs.writeFileSync(process.env.PO_STAT_UNLINK_CLOCKS, String(postStatClockCalls), 'utf8');",
      "  }",
      "  return origUnlinkSync.call(this, p, ...rest);",
      "};",
    ].join('\n'), 'utf8');
    const clockSkewRes = await runHookAsync({
      conversationId: clockSkewConv,
      initialNumSteps: 1,
      lastUserInput: timeoutInput,
    }, undefined, {
      preload: clockSkewProbe,
      env: {
        PO_WATCH_LOCK: clockSkewLock,
        PO_OPEN_COUNT: clockSkewOpenCountFile,
        PO_STAT_UNLINK_CLOCKS: clockSkewUnlinkClocksFile,
      },
    });
    assert.deepStrictEqual(clockSkewRes, {}, '32j.1 Expired monotonic deadline after stale unlink returns {} without retrying');
    assert.strictEqual(fs.readFileSync(clockSkewUnlinkClocksFile, 'utf8'), '1', '32j.2 Only a single monotonic performance.now() read may occur between statSync and stale unlinkSync');
    assert.strictEqual(fs.readFileSync(clockSkewOpenCountFile, 'utf8'), '1', '32j.3 Must not retry openSync after post-unlink monotonic deadline expiration');
    assert(!fs.existsSync(clockSkewTurnFile), '32j.4 Timed-out waiter after stale unlink must not write turn state file');
    if (fs.existsSync(clockSkewLock)) fs.unlinkSync(clockSkewLock);

    const rollbackConv = 'conv-lock-wallclock-rollback';
    const rollbackLock = path.join(stateDir, `turn-${sha16(rollbackConv)}.lock`);
    const rollbackTurnFile = path.join(stateDir, `turn-${sha16(rollbackConv)}.json`);
    const rollbackProbe = path.join(tmpState, 'wallclock-rollback-probe.js');
    const rollbackOpenCountFile = path.join(tmpState, 'wallclock-rollback-open.count');
    fs.writeFileSync(rollbackLock, '999999', 'utf8');
    fs.writeFileSync(rollbackProbe, [
      "'use strict';",
      "const fs = require('fs');",
      "const origOpenSync = fs.openSync;",
      "const origStatSync = fs.statSync;",
      "const origUnlinkSync = fs.unlinkSync;",
      "const origDateNow = Date.now;",
      "const buf = new Int32Array(new SharedArrayBuffer(4));",
      "let rolledBack = false;",
      "Date.now = () => (rolledBack ? origDateNow() - 5000 : origDateNow());",
      "fs.openSync = function (p, flags, ...rest) {",
      "  if (String(p) === process.env.PO_WATCH_LOCK) {",
      "    fs.appendFileSync(process.env.PO_OPEN_COUNT, '1');",
      "  }",
      "  return origOpenSync.call(this, p, flags, ...rest);",
      "};",
      "fs.statSync = function (p, ...rest) {",
      "  if (!rolledBack && String(p) === process.env.PO_WATCH_LOCK) {",
      "    Atomics.wait(buf, 0, 0, 1020);",
      "    rolledBack = true;",
      "    try { origUnlinkSync.call(fs, p); } catch (_) {}",
      "  }",
      "  return origStatSync.call(this, p, ...rest);",
      "};",
    ].join('\n'), 'utf8');
    const rollbackRes = await runHookAsync({
      conversationId: rollbackConv,
      initialNumSteps: 1,
      lastUserInput: timeoutInput,
    }, undefined, {
      preload: rollbackProbe,
      env: { PO_WATCH_LOCK: rollbackLock, PO_OPEN_COUNT: rollbackOpenCountFile },
    });
    assert.deepStrictEqual(rollbackRes, {}, '32k.1 Wall-clock rollback during lock wait must not extend monotonic wait deadline');
    assert.strictEqual(fs.readFileSync(rollbackOpenCountFile, 'utf8'), '1', '32k.2 Must not retry openSync after wall-clock rollback when monotonic deadline expired');
    assert(!fs.existsSync(rollbackTurnFile), '32k.3 Timed-out waiter after wall-clock rollback must not write turn state file');
    if (fs.existsSync(rollbackLock)) fs.unlinkSync(rollbackLock);
  }

  // 33. T3 Code inner wrapper unwrapping (<t3_code_instructions> + <user_request> + <runtime_info>)
  {
    const wrapT3 = (body) =>
      `<USER_REQUEST>\n<t3_code_instructions>\n## T3 Code interaction mode: Default\n</t3_code_instructions>\n\n<user_request>\n${body}\n</user_request><runtime_info>T3 Code Antigravity</runtime_info>\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-23T15:00:00+08:00.\n</ADDITIONAL_METADATA>`;

    res = runHook({ conversationId: 'conv-t3-cmd', initialNumSteps: 1, lastUserInput: wrapT3('/prompt-optimizer status') });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER CONFIG]'), '33a. T3-wrapped /prompt-optimizer status must work');

    res = runHook({ conversationId: 'conv-t3-cmd', initialNumSteps: 2, lastUserInput: wrapT3('/prompt-optimizer off') });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER CONFIG]'), '33b. T3-wrapped /prompt-optimizer off must work');

    res = runHook({ conversationId: 'conv-t3-cmd', initialNumSteps: 3, lastUserInput: wrapT3('帮我做个PPT') });
    assert.deepStrictEqual(res, {}, '33c. T3-wrapped task stays silent after off');

    for (const [idx, msg] of ['raw: fix typo', '好的', '同意', '/compact', 'A1: 选第一个'].entries()) {
      res = runHook({ conversationId: `conv-t3-skip-${idx}`, initialNumSteps: 1, lastUserInput: wrapT3(msg) });
      assert.deepStrictEqual(res, {}, `33d.${idx} T3-wrapped "${msg}" must return {}`);
    }

    // Literal <user_request> inside non-T3 body must NOT be unwrapped away
    res = runHook({ conversationId: 'conv-t3-lit', initialNumSteps: 1, lastUserInput: '<USER_REQUEST>\n帮我解释 <user_request>foo</user_request> 标签\n</USER_REQUEST>' });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '33e. Literal <user_request> inside normal prompt still routes');
  }

  // 34. Meta-questions about prompt-optimizer itself, ACK_LEAD real tasks, CLI/bypass/A1 false positives
  {
    res = runHook({ conversationId: 'conv-meta-self', initialNumSteps: 1, lastUserInput: '<USER_REQUEST>\n$prompt-optimizer 这个skill还有什么问题么？\n</USER_REQUEST>' });
    const metaTxt = getInjectedText(res);
    assert(metaTxt.includes('[PROMPT-OPTIMIZER ROUTER]') && !metaTxt.includes('[PROMPT-OPTIMIZER EXPLICIT]'), '34a. $prompt-optimizer meta-question must route normally, not hijack as EXPLICIT');

    res = runHook({ conversationId: 'conv-meta-self-en', initialNumSteps: 1, lastUserInput: '/prompt-optimizer review this skill for bugs' });
    const metaEn = getInjectedText(res);
    assert(metaEn.includes('[PROMPT-OPTIMIZER ROUTER]') && !metaEn.includes('[PROMPT-OPTIMIZER EXPLICIT]'), '34b. English meta-request on /prompt-optimizer must not force EXPLICIT');

    // Polite Chinese openers followed by real substantive tasks (<=40 chars) must still reach ROUTER
    for (const [idx, msg] of [
      '好的，帮我把首页改成暗黑风格',
      '可以，顺便帮我查一下登录为什么变慢了',
      '搞定了，接下来帮我做一个数据看板',
      '没问题，把这几个模块改得更酷一点',
    ].entries()) {
      res = runHook({ conversationId: `conv-ack-task-${idx}`, initialNumSteps: 1, lastUserInput: `<USER_REQUEST>\n${msg}\n</USER_REQUEST>` });
      assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), `34c.${idx} Real Chinese follow-up task "${msg}" must hit ROUTER`);
    }

    // Natural-language sentences starting with git/npm/pytest/cat or 直接 / 原文 (without colon) must hit ROUTER
    for (const [idx, msg] of [
      'git workflow is messy, redesign it',
      'npm build is slow, optimize it',
      'pytest keeps hanging in CI, fix it',
      'cat photo website, make it cute',
      '直接 refactor 这个组件',
      '原文 帮我翻译一下这段英文：Hello world',
    ].entries()) {
      res = runHook({ conversationId: `conv-fp-${idx}`, initialNumSteps: 1, lastUserInput: `<USER_REQUEST>\n${msg}\n</USER_REQUEST>` });
      assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), `34d.${idx} Non-CLI / non-bypass "${msg}" must hit ROUTER`);
    }

    // Explicit colon bypass still skips
    for (const [idx, msg] of ['直接：帮我重构组件', '原文：直接帮我写周报', '不优化 帮我写周报'].entries()) {
      res = runHook({ conversationId: `conv-bp-${idx}`, initialNumSteps: 1, lastUserInput: `<USER_REQUEST>\n${msg}\n</USER_REQUEST>` });
      assert.deepStrictEqual(res, {}, `34e.${idx} Explicit bypass "${msg}" must return {}`);
    }

    // Multi-line user prompt containing A1: on line 2 must NOT be dropped as ask_question answer
    res = runHook({ conversationId: 'conv-a1-multiline', initialNumSteps: 1, lastUserInput: '<USER_REQUEST>\n帮我检查表格公式为什么报错：\nA1: 销售额\nB1: 成本\n</USER_REQUEST>' });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '34f. Multi-line prompt with A1: on line 2 must route normally');
  }

  // 35. looksLikeOptimizedPrompt hardening, /prompt-optimizer off silence, next off->off->on preservation, and state TTL pruning
  {
    const fpTx = path.join(tmpState, 'fp-guard.jsonl');
    const writeFp = (reply, nextUser = '帮我写个测试') => fs.writeFileSync(fpTx, [
      { step_index: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '修一下认证' },
      { step_index: 2, type: 'PLANNER_RESPONSE', content: reply },
      { step_index: 3, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: nextUser },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    for (const [idx, reply] of [
      '### Done\nUpdated `auth.ts` to fix refresh.\n> Note: re-login required once.',
      '### Warning\n> [!WARNING] Existing sessions expire on restart.\nCheck logs after deploy.',
      `${'x'.repeat(2500)}\n\n### Optimized Prompt\nDocumentation of the heading.\n\n---\n**Next**: check tests`,
      '示例：\n~~~~markdown\n### Optimized Prompt\n\n> 示例内容\n\n确认吗？\n~~~~\n完毕。',
    ].entries()) {
      writeFp(reply);
      res = runHook({ conversationId: `conv-lp-fp-${idx}`, transcriptPath: fpTx, initialNumSteps: 4, lastUserInput: '帮我写个测试' });
      assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), `35a.${idx} Non-optimizer reply must not trigger PENDING-REPLY`);
    }

    // Alternate ZH heading "### 优化后的提示词" (even >8 lines) MUST be recognized as PENDING-REPLY
    writeFp('### 优化后的提示词\n\n> 1. a\n> 2. b\n> 3. c\n> 4. d\n> 5. e\n> 6. f\n> 7. g\n\n确认？', '同意');
    res = runHook({ conversationId: 'conv-lp-zh-alt', transcriptPath: fpTx, initialNumSteps: 4, lastUserInput: '同意' });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '35b. Alternate ZH heading ### 优化后的提示词 must trigger PENDING-REPLY');

    // /prompt-optimizer off must stay completely silent even if transcript ends with an optimizer-like reply
    runHook({ conversationId: 'conv-off-silent', initialNumSteps: 1, lastUserInput: '/prompt-optimizer off' });
    writeFp('### Optimized Prompt\n\n> Something.\n\nUse this prompt?', '帮我写个测试');
    res = runHook({ conversationId: 'conv-off-silent', transcriptPath: fpTx, initialNumSteps: 4, lastUserInput: '帮我写个测试' });
    assert.deepStrictEqual(res, {}, '35c. OFF session without explicit rewrite must never fire PENDING-REPLY');

    // Multi-round edit after explicit /prompt-optimizer while OFF must stay tracked until normal reply
    runHook({ conversationId: 'conv-off-multi', initialNumSteps: 1, lastUserInput: '/prompt-optimizer off' });
    res = runHook({ conversationId: 'conv-off-multi', initialNumSteps: 2, lastUserInput: '/prompt-optimizer 帮我做个发布计划' });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER EXPLICIT]'), '35d.1 Explicit rewrite while OFF');
    writeFp('### 优化后的提问\n\n> 制定发布计划 v1。\n\n确认？', '把范围缩到仅限前端');
    res = runHook({ conversationId: 'conv-off-multi', transcriptPath: fpTx, initialNumSteps: 4, lastUserInput: '把范围缩到仅限前端' });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '35d.2 Edit turn 1 triggers PENDING-REPLY');
    writeFp('### 优化后的提问\n\n> 制定前端发布计划 v2。\n\n确认？', '同意');
    res = runHook({ conversationId: 'conv-off-multi', transcriptPath: fpTx, initialNumSteps: 6, lastUserInput: '同意' });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '35d.3 Approve after edit still triggers PENDING-REPLY while OFF');
    writeFp('已完成前端发布计划。', '帮我写个周报');
    res = runHook({ conversationId: 'conv-off-multi', transcriptPath: fpTx, initialNumSteps: 8, lastUserInput: '帮我写个周报' });
    assert.deepStrictEqual(res, {}, '35d.4 Next unrelated turn returns cleanly to OFF silence');

    // next off -> off -> on preserves explicit next off
    runHook({ conversationId: 'conv-keep-next-off', initialNumSteps: 1, lastUserInput: '/prompt-optimizer next off' });
    runHook({ conversationId: 'conv-keep-next-off', initialNumSteps: 2, lastUserInput: '/prompt-optimizer off' });
    runHook({ conversationId: 'conv-keep-next-off', initialNumSteps: 3, lastUserInput: '/prompt-optimizer on' });
    res = runHook({ conversationId: 'conv-keep-next-off', initialNumSteps: 4, lastUserInput: '帮我重构登录流程' });
    const keptText = getInjectedText(res);
    assert(keptText.includes('[PROMPT-OPTIMIZER ROUTER]') && !keptText.includes('[PROMPT-OPTIMIZER NEXT-STEP]'), '35e. next off -> off -> on must preserve explicit next off');

    // State directory TTL pruning removes expired session/turn files without deleting default-mode.txt
    const stateDir = path.join(tmpState, 'prompt-optimizer');
    const oldFile = path.join(stateDir, 'session-deadbeef00000001.json');
    const marker = path.join(stateDir, '.last-prune');
    const defFile = path.join(stateDir, 'default-mode.txt');
    fs.writeFileSync(oldFile, '{"mode":null,"nextMode":null,"awaitingConfirm":false}', 'utf8');
    fs.writeFileSync(defFile, 'on', 'utf8');
    const expiredDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, expiredDate, expiredDate);
    fs.utimesSync(defFile, expiredDate, expiredDate);
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    runHook({ conversationId: 'conv-prune-trigger', initialNumSteps: 1, lastUserInput: '帮我梳理测试用例' });
    assert(!fs.existsSync(oldFile), '35f.1 Expired session file must be pruned');
    assert(fs.existsSync(defFile), '35f.2 default-mode.txt must never be pruned');
  }

  // 36. Compaction CHECKPOINT restores [PROMPT-OPTIMIZER NEXT-STEP] once per compaction (never re-injects ROUTER),
  // and stays silent for silent turns or when next is off.
  {
    const cmpConv = 'conv-compaction-refresh';
    const cmpTx = path.join(tmpState, 'compaction-refresh.jsonl');
    const meta = '<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-24T17:00:00+08:00.\n</ADDITIONAL_METADATA>';
    const uPrompt = '<USER_REQUEST>\n帮我重构导出流水线并补齐测试\n</USER_REQUEST>\n' + meta;
    const rows = [
      { step_index: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: uPrompt },
    ];
    fs.writeFileSync(cmpTx, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({ conversationId: cmpConv, transcriptPath: cmpTx, initialNumSteps: 2, lastUserInput: uPrompt });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]') && getInjectedText(res).includes('[PROMPT-OPTIMIZER NEXT-STEP]'), '36a. Initial turn injects ROUTER + NEXT-STEP');

    // Step 10 (< 16 steps, no compaction): silent
    res = runHook({ conversationId: cmpConv, transcriptPath: cmpTx, initialNumSteps: 10, lastUserInput: uPrompt });
    assert.deepStrictEqual(res, {}, '36b. Mid-turn before refresh threshold stays silent');

    // Compaction #1 at step 12: restores NEXT-STEP immediately without ROUTER
    rows.push({ step_index: 12, type: 'CHECKPOINT', content: '# Resuming from a compaction' });
    fs.writeFileSync(cmpTx, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({ conversationId: cmpConv, transcriptPath: cmpTx, initialNumSteps: 13, lastUserInput: uPrompt });
    const cmp1Text = getInjectedText(res);
    assert(
      cmp1Text.includes('[PROMPT-OPTIMIZER NEXT-STEP]') &&
      cmp1Text.includes('Context was compacted') &&
      !cmp1Text.includes('[PROMPT-OPTIMIZER ROUTER]') &&
      !cmp1Text.includes('[PROMPT-OPTIMIZER PENDING-REPLY]'),
      '36c. Compaction #1 restores NEXT-STEP only'
    );

    // Step 14 right after compaction #1: silent (no duplicate)
    res = runHook({ conversationId: cmpConv, transcriptPath: cmpTx, initialNumSteps: 14, lastUserInput: uPrompt });
    assert.deepStrictEqual(res, {}, '36d. Immediate step after compaction #1 stays silent');

    // Compaction #2 at step 20: restores NEXT-STEP again
    rows.push({ step_index: 20, type: 'CHECKPOINT', content: '# Resuming from a compaction' });
    fs.writeFileSync(cmpTx, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({ conversationId: cmpConv, transcriptPath: cmpTx, initialNumSteps: 21, lastUserInput: uPrompt });
    const cmp2Text = getInjectedText(res);
    assert(cmp2Text.includes('[PROMPT-OPTIMIZER NEXT-STEP]') && !cmp2Text.includes('[PROMPT-OPTIMIZER ROUTER]'), '36e. Compaction #2 restores NEXT-STEP again');

    // Next-off session never refreshes after compaction
    const offCmpConv = 'conv-compaction-next-off';
    runHook({ conversationId: offCmpConv, initialNumSteps: 1, lastUserInput: '/prompt-optimizer next off' });
    res = runHook({ conversationId: offCmpConv, transcriptPath: cmpTx, initialNumSteps: 2, lastUserInput: uPrompt });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]') && !getInjectedText(res).includes('[PROMPT-OPTIMIZER NEXT-STEP]'), '36f.1 next-off turn has no NEXT-STEP');
    res = runHook({ conversationId: offCmpConv, transcriptPath: cmpTx, initialNumSteps: 25, lastUserInput: uPrompt });
    assert.deepStrictEqual(res, {}, '36f.2 next-off stays silent even after compaction and long steps');
  }

  // 37. Truncated USER_INPUT in compact transcript + subagent waiting response must NOT falsely re-inject ROUTER
  {
    const subConv = 'conv-truncated-subagent';
    const subTx = path.join(tmpState, 'truncated-subagent.jsonl');
    const longTask = '走内部自建方案：' + '详细部署要求与验收步骤'.repeat(30);
    const meta = '<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-24T16:40:00+08:00.\n</ADDITIONAL_METADATA>';
    const fullInput = `<USER_REQUEST>\n${longTask}\n</USER_REQUEST>\n${meta}`;
    const truncRows = [
      { step_index: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: `<USER_REQUEST>\n${longTask.slice(0, 120)}`, truncated_fields: ['content'] },
      { step_index: 4, type: 'PLANNER_RESPONSE', content: '已创建独立只读代码审查子任务，等待审查结论。' },
      { step_index: 5, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: '[Message] sender=subagent-1 content=done' },
    ];
    fs.writeFileSync(subTx, truncRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({ conversationId: subConv, transcriptPath: subTx, initialNumSteps: 2, lastUserInput: fullInput });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '37a. Initial turn routes');
    res = runHook({ conversationId: subConv, transcriptPath: subTx, initialNumSteps: 6, lastUserInput: fullInput });
    assert.deepStrictEqual(res, {}, '37b. Subagent wakeup after truncated USER_INPUT must not re-inject ROUTER');

    // 37c. Truncated USER_INPUT WITHOUT <ADDITIONAL_METADATA> must still match sameUserMessage for dedupe
    const subNoMetaConv = 'conv-truncated-nometa';
    const subNoMetaTx = path.join(tmpState, 'truncated-nometa.jsonl');
    const noMetaInput = `<USER_REQUEST>\n${longTask}\n</USER_REQUEST>`;
    fs.writeFileSync(subNoMetaTx, [
      { step_index: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: `<USER_REQUEST>\n${longTask.slice(0, 120)}`, truncated_fields: ['content'] },
      { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'working' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({ conversationId: subNoMetaConv, transcriptPath: subNoMetaTx, initialNumSteps: 2, lastUserInput: noMetaInput });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '37c.1 Initial turn without outerMeta routes');
    res = runHook({ conversationId: subNoMetaConv, transcriptPath: subNoMetaTx, initialNumSteps: 5, lastUserInput: noMetaInput });
    assert.deepStrictEqual(res, {}, '37c.2 Truncated USER_INPUT without outerMeta still matches step:1 and dedupes');

    // 37d. Long truncated user reply to an optimized prompt must trigger PENDING-REPLY (not ROUTER)
    const truncReplyTx = path.join(tmpState, 'truncated-pending-reply.jsonl');
    const longReply = '同意，另外请重点核对' + '所有缓存失效和重试边界条件'.repeat(20);
    fs.writeFileSync(truncReplyTx, [
      { step_index: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\n优化缓存逻辑\n</USER_REQUEST>' },
      { step_index: 2, type: 'PLANNER_RESPONSE', content: '### 优化后的提示词\n\n> 排查并优化缓存失效与重试机制。\n\n确认使用这条提示词吗？（同意 / 修改 / 按原话）' },
      { step_index: 3, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: `<USER_REQUEST>\n${longReply.slice(0, 100)}`, truncated_fields: ['content'] },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({ conversationId: 'conv-trunc-pending', transcriptPath: truncReplyTx, initialNumSteps: 4, lastUserInput: `<USER_REQUEST>\n${longReply}\n</USER_REQUEST>` });
    const truncPendingText = getInjectedText(res);
    assert(
      truncPendingText.startsWith('[PROMPT-OPTIMIZER PENDING-REPLY]'),
      '37d. Long truncated reply to optimizer prompt must resolve to PENDING-REPLY'
    );

    // 37e. T3 short user body truncated inside <runtime_info> still matches exactly, while short (<20 char) unclosed prefix does NOT falsely collide
    const t3TruncTx = path.join(tmpState, 't3-truncated-runtime.jsonl');
    fs.writeFileSync(t3TruncTx, [
      { step_index: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\n<t3_code_instructions>rules</t3_code_instructions>\n<user_request>\n优化缓存\n</user_request><runtime_info>T3...', truncated_fields: ['content'] },
      { step_index: 2, type: 'PLANNER_RESPONSE', content: '### 优化后的提示词\n\n> 优化缓存失效策略。\n\n确认使用这条提示词吗？' },
      { step_index: 3, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\n<t3_code_instructions>rules</t3_code_instructions>\n<user_request>\n同意\n</user_request><runtime_info>T3...', truncated_fields: ['content'] },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({ conversationId: 'conv-t3-trunc', transcriptPath: t3TruncTx, initialNumSteps: 4, lastUserInput: '<USER_REQUEST>\n<t3_code_instructions>rules</t3_code_instructions>\n<user_request>\n同意\n</user_request><runtime_info>T3 Code</runtime_info>\n</USER_REQUEST>' });
    assert(getInjectedText(res).startsWith('[PROMPT-OPTIMIZER PENDING-REPLY]'), '37e.1 T3 short body truncated inside <runtime_info> resolves to PENDING-REPLY');

    // Unfinished turn with truncated <20-char prefix ("帮我"): latestTurnFinished is false,
    // so inspectTranscript MUST invoke sameUserMessage(); a different message starting with "帮我"
    // must NOT falsely match as currentFlushed and trigger PENDING-REPLY.
    const shortPrefixTx = path.join(tmpState, 'short-prefix-trunc.jsonl');
    fs.writeFileSync(shortPrefixTx, [
      { step_index: 1, type: 'PLANNER_RESPONSE', content: '### 优化后的提示词\n\n> 旧草稿。\n\n确认？' },
      { step_index: 2, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\n帮我', truncated_fields: ['content'] },
      { step_index: 3, type: 'GENERIC', status: 'DONE', content: 'tool running' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({ conversationId: 'conv-short-prefix', transcriptPath: shortPrefixTx, initialNumSteps: 4, lastUserInput: '<USER_REQUEST>\n帮我把登录页重做一下\n</USER_REQUEST>' });
    const shortPrefixText = getInjectedText(res);
    assert(
      shortPrefixText.includes('[PROMPT-OPTIMIZER ROUTER]') && !shortPrefixText.startsWith('[PROMPT-OPTIMIZER PENDING-REPLY]'),
      '37e.2 Short <20 char unclosed truncated prefix must not collide as sameUserMessage'
    );
  }

  // 38. CHECKPOINT after an optimized prompt clears pending confirmation on the next user turn
  {
    const ckOptTx = path.join(tmpState, 'ckpt-after-opt.jsonl');
    fs.writeFileSync(ckOptTx, [
      { step_index: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '帮我优化搜索' },
      { step_index: 2, type: 'PLANNER_RESPONSE', content: '### 优化后的提示词\n\n> 优化站内搜索排序与性能。\n\n确认使用这条提示词吗？（同意 / 修改 / 按原话）' },
      { step_index: 3, type: 'CHECKPOINT', content: '# Resuming from a compaction' },
      { step_index: 4, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '顺便把登录页也改下' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    res = runHook({ conversationId: 'conv-ckpt-opt', transcriptPath: ckOptTx, initialNumSteps: 5, lastUserInput: '顺便把登录页也改下' });
    const txt = getInjectedText(res);
    assert(txt.includes('[PROMPT-OPTIMIZER ROUTER]') && !txt.includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), '38. Compaction boundary clears prior optimizer-prompt confirmation');
  }

  // 39. >16MB transcript handoff: (a) tail optimizer reply after >16MB tool output is NOT skipped,
  // and (b) flushed Turn 2 with identical text after >16MB tool output preserves its own stepKey (not Turn 1's).
  {
    const big17Tx = path.join(tmpState, 'big-17mb-handoff.jsonl');
    const fdBig = fs.openSync(big17Tx, 'w');
    fs.writeSync(fdBig, JSON.stringify({ step_index: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\n优化首页\n</USER_REQUEST>' }) + '\n');
    const padRow = JSON.stringify({ step_index: 2, type: 'GENERIC', content: 'm'.repeat(32000) }) + '\n';
    for (let i = 0; i < 540; i++) fs.writeSync(fdBig, padRow); // ~17.3 MB
    fs.writeSync(fdBig, JSON.stringify({ step_index: 545, type: 'PLANNER_RESPONSE', content: '### 优化后的提示词\n\n> 优化首页首屏性能与排版。\n\n确认使用这条提示词吗？' }) + '\n');
    fs.closeSync(fdBig);
    res = runHook({ conversationId: 'conv-big17-a', transcriptPath: big17Tx, initialNumSteps: 546, lastUserInput: '<USER_REQUEST>\n同意\n</USER_REQUEST>' });
    assert(getInjectedText(res).startsWith('[PROMPT-OPTIMIZER PENDING-REPLY]'), '39a. Tail optimizer reply after >16MB tool logs must resolve to PENDING-REPLY');
    fs.unlinkSync(big17Tx);

    const big17bTx = path.join(tmpState, 'big-17mb-stepkey.jsonl');
    const fdBigB = fs.openSync(big17bTx, 'w');
    fs.writeSync(fdBigB, JSON.stringify({ step_index: 1, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\n优化首页\n</USER_REQUEST>' }) + '\n');
    fs.writeSync(fdBigB, JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', content: '首页第一轮已完成。' }) + '\n');
    for (let i = 0; i < 540; i++) fs.writeSync(fdBigB, padRow); // ~17.3 MB of non-text rows
    fs.writeSync(fdBigB, JSON.stringify({ step_index: 550, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\n优化首页\n</USER_REQUEST>' }) + '\n');
    fs.closeSync(fdBigB);
    res = runHook({ conversationId: 'conv-big17-b', transcriptPath: big17bTx, initialNumSteps: 551, lastUserInput: '<USER_REQUEST>\n优化首页\n</USER_REQUEST>' });
    assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '39b.1 Turn 2 flushed at step:550 after >16MB routes cleanly');
    const turnFileB = path.join(tmpState, 'prompt-optimizer', 'turn-' + crypto.createHash('sha256').update('conv-big17-b').digest('hex').slice(0, 16) + '.json');
    const savedB = JSON.parse(fs.readFileSync(turnFileB, 'utf8'));
    assert.strictEqual(savedB.stepNum, 550, '39b.2 Saved stepNum must preserve Turn 2 step 550 instead of rebinding to Turn 1 step 1');
    fs.unlinkSync(big17bTx);
  }

  console.log('All 39 prompt-optimizer hook test groups passed.');
} finally {
  fs.rmSync(tmpState, { recursive: true, force: true });
}
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
