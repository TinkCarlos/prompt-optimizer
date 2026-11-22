#!/opt/homebrew/bin/node
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_SCRIPT = process.env.PROMPT_OPTIMIZER_HOOK || [path.join(__dirname, '..', 'hooks', 'prompt-optimizer-agy.js'), path.join(os.homedir(), '.gemini', 'config', 'hooks', 'prompt-optimizer-agy.js')].find((p) => fs.existsSync(p));
const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-optimizer-test-'));

function runHook(payload, rawOverride) {
  const input = rawOverride !== undefined ? rawOverride : JSON.stringify(payload);
  const stdout = execFileSync(process.execPath, [HOOK_SCRIPT, 'prompt'], {
    input,
    encoding: 'utf8',
    env: { ...process.env, AGY_HOOK_STATE_DIR: tmpState },
  });
  return JSON.parse(stdout.trim());
}

function getInjectedText(res) {
  const steps = res && res.injectSteps;
  if (!Array.isArray(steps) || !steps.length) return '';
  return String(steps[0]?.systemMessage?.systemMessage || '');
}

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

  // 9. Pure acknowledgements and single-line CLI commands return {}
  for (const [idx, msg] of ['好的', '继续', 'git status'].entries()) {
    res = runHook({
      conversationId: convA,
      initialNumSteps: 16 + idx,
      lastUserInput: `<USER_REQUEST>\n${msg}\n</USER_REQUEST>`,
    });
    assert.deepStrictEqual(res, {}, `9. Expected {} for "${msg}"`);
  }

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

  // 13. Bug 1 regression: daily progress phrases and follow-ups return {}
  for (const [idx, msg] of ['好了', '搞定了', '登录好了', '下面该做什么', '继续，你来帮我绑'].entries()) {
    res = runHook({
      conversationId: convA,
      initialNumSteps: 40 + idx,
      lastUserInput: `<USER_REQUEST>\n${msg}\n</USER_REQUEST>`,
    });
    assert.deepStrictEqual(res, {}, `13.${idx} Expected {} for "${msg}"`);
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

  // 19. Delegation / bare context verbs are skipped locally; real short tasks still route
  for (const [idx, msg] of ['你自己决定', '按照你推荐的做', '听你的', '修复', '部署上线', '那就发布吧'].entries()) {
    res = runHook({
      conversationId: 'conv-ctx',
      initialNumSteps: 100 + idx,
      lastUserInput: `<USER_REQUEST>\n${msg}\n</USER_REQUEST>`,
    });
    assert.deepStrictEqual(res, {}, `19.${idx} Expected {} for context-only "${msg}"`);
  }
  res = runHook({
    conversationId: 'conv-ctx',
    initialNumSteps: 120,
    lastUserInput: '<USER_REQUEST>\n修复登录页在 Safari 下白屏的问题\n</USER_REQUEST>',
  });
  assert(getInjectedText(res).includes('[PROMPT-OPTIMIZER ROUTER]'), '19b. Verb + object is a real task');

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
  assert.deepStrictEqual(res, {}, '20b. Same turn after >1MB of steps must be deduped');

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

  console.log('All 23 prompt-optimizer hook test groups passed.');
} finally {
  fs.rmSync(tmpState, { recursive: true, force: true });
}
