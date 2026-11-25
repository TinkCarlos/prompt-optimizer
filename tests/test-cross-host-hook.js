#!/usr/bin/env node
'use strict';
// Tests for hooks/prompt-optimizer-hook.js (Claude Code and Codex UserPromptSubmit).

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'hooks', 'prompt-optimizer-hook.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'po-cross-host-'));

function run(host, payload) {
  return execFileSync(process.execPath, [HOOK, host], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, PROMPT_OPTIMIZER_STATE_DIR: tmp },
  }).trim();
}

function context(host, payload) {
  const out = run(host, payload);
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : '';
}

try {
  // Claude Code: a vague task is routed with NEXT-STEP enabled by default, and the skill path points at the Claude skills folder.
  let ctx = context('claude', { session_id: 's1', prompt: 'make a deck introducing the new product' });
  assert(
    ctx.includes('[PROMPT-OPTIMIZER ROUTER]') &&
    ctx.includes('REWRITE') &&
    ctx.includes('SKIP') &&
    ctx.includes('FIRST—before calling tools') &&
    ctx.includes('prefer REWRITE')
  );
  assert(
    ctx.includes('[PROMPT-OPTIMIZER NEXT-STEP]') &&
    ctx.includes('Before ending your final reply') &&
    ctx.includes('ALWAYS append this block') &&
    ctx.includes('AFTER any closing risk/skipped-check notes') &&
    ctx.includes('never suggest just for the sake of suggesting') &&
    ctx.includes('concrete offline/external action') &&
    ctx.includes('open-ended clarifying questions')
  );
  assert(ctx.includes(path.join('.claude', 'skills', 'prompt-optimizer', 'SKILL.md')));
  assert(!context('claude', { session_id: 's1b', prompt: 'you decide' }).includes('[PROMPT-OPTIMIZER ROUTER]') && context('claude', { session_id: 's1b', prompt: 'you decide' }).includes('[PROMPT-OPTIMIZER NEXT-STEP]'));
  assert.strictEqual(run('claude', { session_id: 's1c', prompt: 'gracias' }), '');

  // Codex: the skill path points at the Codex skills folder, and NEXT-STEP defaults to on.
  ctx = context('codex', { session_id: 's2', prompt: 'make a deck introducing the new product' });
  assert(ctx.includes(path.join('.codex', 'skills', 'prompt-optimizer', 'SKILL.md')));
  assert(ctx.includes('[PROMPT-OPTIMIZER NEXT-STEP]'));
  const codexActCtx = context('codex', { session_id: 's2-ctx', prompt: 'you decide' });
  assert(!codexActCtx.includes('[PROMPT-OPTIMIZER ROUTER]') && codexActCtx.includes('[PROMPT-OPTIMIZER NEXT-STEP]'));

  // A stale awaiting flag is ignored when the previous assistant reply was an ordinary answer (Claude Code log shape).
  const claudeTx = path.join(tmp, 'claude.jsonl');
  fs.writeFileSync(claudeTx, [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done, the deck is ready.' }] } },
    { type: 'user', message: { role: 'user', content: 'write the weekly report' } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  ctx = context('claude', { session_id: 's2c', transcript_path: claudeTx, prompt: 'write the weekly report' });
  assert(ctx.includes('[PROMPT-OPTIMIZER ROUTER]'));

  // The reply after an optimized prompt is a pending confirmation, in any language (Codex log shape, Spanish; Codex includes NEXT-STEP by default).
  const codexTx = path.join(tmp, 'codex.jsonl');
  fs.writeFileSync(codexTx, JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '### Prompt optimizado\n\n> Prepara una presentación del producto.\n\n¿Usar este prompt? (aprobar / editar / usar original)' }] },
  }) + '\n');
  ctx = context('codex', { session_id: 's3', transcript_path: codexTx, prompt: 'aprobar' });
  assert(ctx.includes('[PROMPT-OPTIMIZER PENDING-REPLY]') && ctx.includes('[PROMPT-OPTIMIZER NEXT-STEP]'));

  // False-positive guard: short reply with --- next-step footer must NOT be detected as confirmation prompt in Claude or Codex.
  const claudeFooterTx = path.join(tmp, 'claude-footer.jsonl');
  fs.writeFileSync(claudeFooterTx, JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '### Fixed\nDone.\n\n---\n**Suggested next prompt**:\n> Run integration tests' }] },
  }) + '\n');
  assert(context('claude', { session_id: 's3c-fp', transcript_path: claudeFooterTx, prompt: 'check auth flow too' }).includes('[PROMPT-OPTIMIZER ROUTER]'));
  const codexFooterTx = path.join(tmp, 'codex-footer.jsonl');
  fs.writeFileSync(codexFooterTx, JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '### Fixed\nDone.\n\n---\n**Suggested next prompt**:\n> Run integration tests' }] },
  }) + '\n');
  assert(context('codex', { session_id: 's3x-fp', transcript_path: codexFooterTx, prompt: 'check auth flow too' }).includes('[PROMPT-OPTIMIZER ROUTER]'));

  // Silent paths: acknowledgements, machine prompts (including Codex question replies), "raw:" bypass, bare/control slash commands; "you decide" carries NEXT-STEP only.
  const codexDecide = context('codex', { session_id: 's4-act', prompt: 'you decide' });
  assert(!codexDecide.includes('[PROMPT-OPTIMIZER ROUTER]') && codexDecide.includes('[PROMPT-OPTIMIZER NEXT-STEP]'), 'you decide');
  for (const prompt of ['gracias', '[KROUTER_PROACTIVE] hi', '<send_user_message_question_reply> [{"questionItem":"1"}]', 'raw: fix the typo', '/compact', '/compact focus on tests', '/ponytail off', '/frontend-design-lab']) {
    assert.strictEqual(run('codex', { session_id: 's4', prompt }), '', prompt);
  }

  // Follow-up multi-turn router text explicitly covers follow-up turns (not only Turn 1).
  const multiCtx = context('codex', { session_id: 's-multi', prompt: '开头几个模块太普通了，换个酷炫的样式' });
  assert(multiCtx.includes('[PROMPT-OPTIMIZER ROUTER]') && multiCtx.includes('follow-up turns'), 'Expected follow-up turn guidance in ROUTER');

  // /skill, $skill or @file followed by a real task body must enter ROUTER.
  for (const [idx, prompt] of [
    '/frontend-design-lab 帮我优化这个skill，让页面更有质感',
    '$frontend-design-lab 帮我做个官网',
    '@src/app.tsx 帮我重构这部分状态管理',
  ].entries()) {
    assert(context('claude', { session_id: 's-pref-' + idx, prompt }).includes('[PROMPT-OPTIMIZER ROUTER]'), prompt);
  }

  // "raw data ..." is a normal task, not a bypass.
  assert(context('codex', { session_id: 's5', prompt: 'raw data analysis of Q3 sales' }).includes('[PROMPT-OPTIMIZER ROUTER]'));

  // Switches: off silences the session, on restores it, status reports.
  assert(context('codex', { session_id: 's6', prompt: '/prompt-optimizer off' }).includes('OFF'));
  assert.strictEqual(run('codex', { session_id: 's6', prompt: 'investigate the failing checkout flow' }), '');
  assert(context('codex', { session_id: 's6', prompt: '/prompt-optimizer on' }).includes('ON'));
  assert(context('codex', { session_id: 's6', prompt: '/prompt-optimizer status' }).includes('[PROMPT-OPTIMIZER CONFIG]'));

  // Explicit invocation forces a rewrite even when auto mode is off (no NEXT-STEP).
  context('codex', { session_id: 's7', prompt: '/prompt-optimizer off' });
  const expCtx = context('codex', { session_id: 's7', prompt: '/prompt-optimizer plan our launch' });
  assert(expCtx.includes('[PROMPT-OPTIMIZER EXPLICIT]') && !expCtx.includes('[PROMPT-OPTIMIZER NEXT-STEP]'));

  // Next-step toggles: /prompt-optimizer next off/on in Codex, off + next on, and host-scoped next defaults.
  assert(context('codex', { session_id: 's8', prompt: '/prompt-optimizer next off' }).includes('OFF'));
  const nextOffCodex = context('codex', { session_id: 's8', prompt: 'make a deck' });
  assert(nextOffCodex.includes('[PROMPT-OPTIMIZER ROUTER]') && !nextOffCodex.includes('[PROMPT-OPTIMIZER NEXT-STEP]'));
  assert(context('codex', { session_id: 's8', prompt: '/prompt-optimizer next on' }).includes('ON'));
  assert(context('codex', { session_id: 's8', prompt: 'make a deck' }).includes('[PROMPT-OPTIMIZER NEXT-STEP]'));
  assert(context('codex', { session_id: 's8', prompt: '/prompt-optimizer off' }).includes('OFF'));
  assert.strictEqual(run('codex', { session_id: 's8', prompt: 'make a deck' }), '');
  context('codex', { session_id: 's8', prompt: '/prompt-optimizer next on' });
  const nextOnlyCodex = context('codex', { session_id: 's8', prompt: 'make a deck' });
  assert(!nextOnlyCodex.includes('[PROMPT-OPTIMIZER ROUTER]') && nextOnlyCodex.includes('[PROMPT-OPTIMIZER NEXT-STEP]'));

  // Host-scoped defaults: changing Claude next default off does NOT disable Codex, and toggling Codex next default does NOT affect Claude.
  context('claude', { session_id: 's9', prompt: '/prompt-optimizer next default off' });
  assert(!context('claude', { session_id: 's9-new', prompt: 'make a deck' }).includes('[PROMPT-OPTIMIZER NEXT-STEP]'));
  assert(context('codex', { session_id: 's9-codex', prompt: 'make a deck' }).includes('[PROMPT-OPTIMIZER NEXT-STEP]'));
  context('codex', { session_id: 's9', prompt: '/prompt-optimizer next default off' });
  assert(!context('codex', { session_id: 's9-codex2', prompt: 'make a deck' }).includes('[PROMPT-OPTIMIZER NEXT-STEP]'));
  context('codex', { session_id: 's9', prompt: '/prompt-optimizer next default on' });
  assert(context('codex', { session_id: 's9-codex3', prompt: 'make a deck' }).includes('[PROMPT-OPTIMIZER NEXT-STEP]'));
  assert(!context('claude', { session_id: 's9-claude2', prompt: 'make a deck' }).includes('[PROMPT-OPTIMIZER NEXT-STEP]'));

  // Broken input fails open: no output, no crash.
  assert.strictEqual(execFileSync(process.execPath, [HOOK, 'codex'], { input: '{bad json', encoding: 'utf8' }).trim(), '');

  // T3 Code harness wrapper unwrapping
  const wrapT3 = (body) => `<t3_code_instructions>\n## T3 Code\n</t3_code_instructions>\n\n<user_request>\n${body}\n</user_request><runtime_info>info</runtime_info>`;
  assert(context('claude', { session_id: 's-t3', prompt: wrapT3('/prompt-optimizer status') }).includes('[PROMPT-OPTIMIZER CONFIG]'));
  assert.strictEqual(run('claude', { session_id: 's-t3', prompt: wrapT3('raw: fix typo') }), '');
  assert.strictEqual(run('claude', { session_id: 's-t3', prompt: wrapT3('好的') }), '');

  // $prompt-optimizer meta-question routes normally instead of hijacking as EXPLICIT
  const metaCtx = context('claude', { session_id: 's-meta', prompt: '$prompt-optimizer 这个skill还有什么问题么？' });
  assert(metaCtx.includes('[PROMPT-OPTIMIZER ROUTER]') && !metaCtx.includes('[PROMPT-OPTIMIZER EXPLICIT]'));

  // Polite Chinese openers + real tasks, English non-CLI sentences, and colonless 直接/原文 must hit ROUTER
  for (const prompt of [
    '好的，帮我把首页改成暗黑风格',
    '可以，顺便帮我查一下登录为什么变慢了',
    'git workflow is messy, redesign it',
    'npm build is slow, optimize it',
    'cat photo website, make it cute',
    '直接 refactor 这个组件',
    '原文 帮我翻译一下这段英文：Hello world',
  ]) {
    assert(context('claude', { session_id: 's-real-' + prompt.slice(0, 8), prompt }).includes('[PROMPT-OPTIMIZER ROUTER]'), prompt);
  }

  // Tool-only / interrupted Turn 2 must NOT resurrect Turn 1's optimized prompt in Claude Code or Codex
  const toolOnlyTx = path.join(tmp, 'claude-tool-only.jsonl');
  fs.writeFileSync(toolOnlyTx, [
    { type: 'user', message: { role: 'user', content: '帮我做个PPT' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '### Optimized Prompt\n\n> Draft deck.\n\nUse this prompt?' }] } },
    { type: 'user', message: { role: 'user', content: 'approve' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'user', message: { role: 'user', content: '帮我写个周报' } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const afterToolOnly = context('claude', { session_id: 's-tool-only', transcript_path: toolOnlyTx, prompt: '帮我写个周报' });
  assert(afterToolOnly.includes('[PROMPT-OPTIMIZER ROUTER]') && !afterToolOnly.includes('[PROMPT-OPTIMIZER PENDING-REPLY]'));

  // looksLikeOptimizedPrompt false positives (callout, long doc) + OFF mode must never fire PENDING-REPLY
  const calloutTx = path.join(tmp, 'claude-callout.jsonl');
  fs.writeFileSync(calloutTx, JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '### Done\nFixed auth.\n> Note: clear cookies.' }] },
  }) + '\n');
  assert(context('claude', { session_id: 's-callout', transcript_path: calloutTx, prompt: '帮我写个测试' }).includes('[PROMPT-OPTIMIZER ROUTER]'));
  context('claude', { session_id: 's-off-guard', prompt: '/prompt-optimizer off' });
  const optTx = path.join(tmp, 'claude-opt.jsonl');
  fs.writeFileSync(optTx, JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '### Optimized Prompt\n\n> Draft.\n\nUse this prompt?' }] },
  }) + '\n');
  assert.strictEqual(run('claude', { session_id: 's-off-guard', transcript_path: optTx, prompt: '帮我写个测试' }), '');

  // Explicit multi-round edit while OFF stays tracked until normal reply
  context('claude', { session_id: 's-off-edit', prompt: '/prompt-optimizer off' });
  assert(context('claude', { session_id: 's-off-edit', prompt: '/prompt-optimizer make a deck' }).includes('[PROMPT-OPTIMIZER EXPLICIT]'));
  assert(context('claude', { session_id: 's-off-edit', transcript_path: optTx, prompt: 'edit: focus on Q3' }).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'));
  assert(context('claude', { session_id: 's-off-edit', transcript_path: optTx, prompt: 'approve' }).includes('[PROMPT-OPTIMIZER PENDING-REPLY]'));
  assert.strictEqual(run('claude', { session_id: 's-off-edit', transcript_path: calloutTx, prompt: 'make another deck' }), '');

  // next off -> off -> on preserves explicit next off
  context('claude', { session_id: 's-keep-next', prompt: '/prompt-optimizer next off' });
  context('claude', { session_id: 's-keep-next', prompt: '/prompt-optimizer off' });
  context('claude', { session_id: 's-keep-next', prompt: '/prompt-optimizer on' });
  const keepNextCtx = context('claude', { session_id: 's-keep-next', prompt: 'make a deck' });
  assert(keepNextCtx.includes('[PROMPT-OPTIMIZER ROUTER]') && !keepNextCtx.includes('[PROMPT-OPTIMIZER NEXT-STEP]'));

  // Claude SessionStart(source="compact") restores NEXT-STEP reminder and clears stale awaitingConfirm
  context('claude', { session_id: 's-claude-cmp', prompt: '/prompt-optimizer next on' });
  context('claude', { session_id: 's-claude-cmp', prompt: 'make a deck' });
  const cmpRaw = run('claude', { session_id: 's-claude-cmp', hook_event_name: 'SessionStart', source: 'compact' });
  const cmpObj = JSON.parse(cmpRaw);
  assert.strictEqual(cmpObj.hookSpecificOutput.hookEventName, 'SessionStart');
  assert(
    cmpObj.hookSpecificOutput.additionalContext.includes('[PROMPT-OPTIMIZER NEXT-STEP]') &&
    cmpObj.hookSpecificOutput.additionalContext.includes('Context was compacted') &&
    !cmpObj.hookSpecificOutput.additionalContext.includes('[PROMPT-OPTIMIZER ROUTER]')
  );
  // SessionStart(compact) stays silent when next is off
  context('claude', { session_id: 's-claude-cmp-off', prompt: '/prompt-optimizer next off' });
  assert.strictEqual(run('claude', { session_id: 's-claude-cmp-off', hook_event_name: 'SessionStart', source: 'compact' }), '');

  // Compaction entry after an optimizer prompt clears pending confirmation (Codex & Claude shapes)
  const codexCmpTx = path.join(tmp, 'codex-compacted.jsonl');
  fs.writeFileSync(codexCmpTx, [
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '### Optimized Prompt\n\n> Draft.\n\nUse this prompt?' }] } },
    { type: 'compacted', payload: { message: '', replacement_history: [] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const afterCodexCmp = context('codex', { session_id: 's-codex-cmp', transcript_path: codexCmpTx, prompt: 'redesign the onboarding page' });
  assert(afterCodexCmp.includes('[PROMPT-OPTIMIZER ROUTER]') && !afterCodexCmp.includes('[PROMPT-OPTIMIZER PENDING-REPLY]'));

  // Transcript > 4MB of tool outputs after a normal reply still yields transcript truth (no stuck awaitingConfirm)
  context('claude', { session_id: 's-huge-tx', prompt: 'make a deck' }); // sets awaitingConfirm=true
  const hugeTx = path.join(tmp, 'huge-claude.jsonl');
  const fd = fs.openSync(hugeTx, 'w');
  fs.writeSync(fd, JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Finished generating the deck.' }] },
  }) + '\n');
  const padLine = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'z'.repeat(16000) }] } }) + '\n';
  for (let i = 0; i < 320; i++) fs.writeSync(fd, padLine); // ~5.1 MB of tool outputs
  fs.closeSync(fd);
  const afterHuge = context('claude', { session_id: 's-huge-tx', transcript_path: hugeTx, prompt: 'now polish the landing page' });
  assert(afterHuge.includes('[PROMPT-OPTIMIZER ROUTER]') && !afterHuge.includes('[PROMPT-OPTIMIZER PENDING-REPLY]'));

  // Assistant reply straddling the exact size - 4MB chunk boundary must NOT be dropped
  context('claude', { session_id: 's-straddle', prompt: 'make a deck' }); // sets awaitingConfirm=true
  const straddleTx = path.join(tmp, 'straddle-claude.jsonl');
  const fd2 = fs.openSync(straddleTx, 'w');
  // Put an earlier optimizer prompt before the boundary, then place a normal assistant reply RIGHT across the 4MB tail boundary
  fs.writeSync(fd2, JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '### Optimized Prompt\n\n> Old draft.\n\nUse this prompt?' }] },
  }) + '\n');
  const boundaryReply = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Normal reply straddling 4MB boundary ' + 'a'.repeat(4000) }] },
  }) + '\n';
  fs.writeSync(fd2, boundaryReply);
  // Pad tail to just under 4MB so `size - 4MB` lands right in the middle of `boundaryReply`!
  const tailTarget = 4 * 1024 * 1024 - 1500;
  const smallPad = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'p'.repeat(15900) }] } }) + '\n';
  let tailWritten = 0;
  while (tailWritten + smallPad.length < tailTarget) {
    fs.writeSync(fd2, smallPad);
    tailWritten += smallPad.length;
  }
  const rem = tailTarget - tailWritten;
  if (rem > 100) {
    fs.writeSync(fd2, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'q'.repeat(rem - 90) }] } }) + '\n');
  }
  fs.closeSync(fd2);
  const afterStraddle = context('claude', { session_id: 's-straddle', transcript_path: straddleTx, prompt: 'redesign the footer' });
  assert(afterStraddle.includes('[PROMPT-OPTIMIZER ROUTER]') && !afterStraddle.includes('[PROMPT-OPTIMIZER PENDING-REPLY]'));

  // Flushed current user row that is itself >4MB (e.g., base64 screenshot) must still be skipped to see prior optimizer prompt
  context('claude', { session_id: 's-big-user-row', prompt: 'make a deck' });
  const bigUserTx = path.join(tmp, 'big-user-row.jsonl');
  const fd3 = fs.openSync(bigUserTx, 'w');
  fs.writeSync(fd3, JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '### Optimized Prompt\n\n> Build a clean deck.\n\nUse this prompt?' }] },
  }) + '\n');
  fs.writeSync(fd3, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'approve with screenshot' }, { type: 'image', data: 'x'.repeat(4 * 1024 * 1024 + 5000) }] },
  }) + '\n');
  fs.closeSync(fd3);
  const afterBigUser = context('claude', { session_id: 's-big-user-row', transcript_path: bigUserTx, prompt: 'approve with screenshot' });
  assert(afterBigUser.startsWith('[PROMPT-OPTIMIZER PENDING-REPLY]'));

  console.log('All cross-host (Claude Code / Codex) hook tests passed.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
