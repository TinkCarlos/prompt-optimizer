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
  // Claude Code: a vague task is routed, and the skill path points at the Claude skills folder.
  let ctx = context('claude', { session_id: 's1', prompt: 'make a deck introducing the new product' });
  assert(ctx.includes('[PROMPT-OPTIMIZER ROUTER]') && ctx.includes('REWRITE') && ctx.includes('SKIP'));
  assert(ctx.includes(path.join('.claude', 'skills', 'prompt-optimizer', 'SKILL.md')));

  // Codex: the skill path points at the Codex skills folder.
  ctx = context('codex', { session_id: 's2', prompt: 'make a deck introducing the new product' });
  assert(ctx.includes(path.join('.codex', 'skills', 'prompt-optimizer', 'SKILL.md')));

  // A stale awaiting flag is ignored when the previous assistant reply was an ordinary answer (Claude Code log shape).
  const claudeTx = path.join(tmp, 'claude.jsonl');
  fs.writeFileSync(claudeTx, [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done, the deck is ready.' }] } },
    { type: 'user', message: { role: 'user', content: 'write the weekly report' } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  ctx = context('claude', { session_id: 's2c', transcript_path: claudeTx, prompt: 'write the weekly report' });
  assert(ctx.includes('[PROMPT-OPTIMIZER ROUTER]'));

  // The reply after an optimized prompt is a pending confirmation, in any language (Codex log shape, Spanish).
  const codexTx = path.join(tmp, 'codex.jsonl');
  fs.writeFileSync(codexTx, JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '### Prompt optimizado\n\n> Prepara una presentación del producto.\n\n¿Usar este prompt? (aprobar / editar / usar original)' }] },
  }) + '\n');
  ctx = context('codex', { session_id: 's3', transcript_path: codexTx, prompt: 'aprobar' });
  assert(ctx.includes('[PROMPT-OPTIMIZER PENDING-REPLY]'));

  // Silent paths: delegation, acknowledgements, machine prompts (including Codex question replies), "raw:" bypass, bare/control slash commands.
  for (const prompt of ['you decide', 'gracias', '[KROUTER_PROACTIVE] hi', '<send_user_message_question_reply> [{"questionItem":"1"}]', 'raw: fix the typo', '/compact', '/compact focus on tests', '/ponytail off', '/frontend-design-lab']) {
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

  // Explicit invocation forces a rewrite even when auto mode is off.
  context('codex', { session_id: 's7', prompt: '/prompt-optimizer off' });
  assert(context('codex', { session_id: 's7', prompt: '/prompt-optimizer plan our launch' }).includes('[PROMPT-OPTIMIZER EXPLICIT]'));

  // Broken input fails open: no output, no crash.
  assert.strictEqual(execFileSync(process.execPath, [HOOK, 'codex'], { input: '{bad json', encoding: 'utf8' }).trim(), '');

  console.log('All cross-host (Claude Code / Codex) hook tests passed.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
