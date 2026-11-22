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

  // Silent paths: delegation, acknowledgements, machine prompts, "raw:" bypass, other slash commands.
  for (const prompt of ['you decide', 'gracias', '[KROUTER_PROACTIVE] hi', 'raw: fix the typo', '/compact']) {
    assert.strictEqual(run('codex', { session_id: 's4', prompt }), '', prompt);
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
