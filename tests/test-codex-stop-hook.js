#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const hook = path.join(__dirname, '..', 'hooks', 'prompt-optimizer-hook.js');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'po-codex-stop-'));
const emptyResult = '批次 `105` 去重后有 4 个提示词。优化页没有符合条件的未提及提示词，页面显示「暂无数据」。';
after(() => fs.rmSync(state, { recursive: true, force: true }));

function run(session, event, fields = {}, host = 'codex') {
  const payload = { session_id: session, turn_id: 'turn-1', hook_event_name: event, ...fields };
  const result = execFileSync(process.execPath, [hook, host], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, PROMPT_OPTIMIZER_STATE_DIR: state },
  }).trim();
  return result ? JSON.parse(result) : null;
}

function submit(session, fields) {
  return run(session, 'UserPromptSubmit', { prompt: 'Check the report results.', ...fields });
}

function finish(session, reply = emptyResult, fields, host) {
  return run(session, 'Stop', { last_assistant_message: reply, stop_hook_active: false, ...fields }, host);
}

test('asks for a missing footer once when known inputs can explain an empty result', () => {
  assert.match(submit('missing').hookSpecificOutput.additionalContext, /\[PROMPT-OPTIMIZER NEXT-STEP\]/);
  const repair = finish('missing');
  assert.equal(repair?.decision, 'block');
  assert.match(repair.reason, /batch identifiers and counts/);
  assert.match(repair.reason, /item by item/);
  assert.match(repair.reason, /capture and recommendation status/);
  assert.match(repair.reason, /Output only/);
  assert.equal(finish('missing'), null);
  submit('missing');
  assert.equal(finish('missing'), null, 'replayed submission cannot request a second continuation');
  submit('separate-batches');
  const twoBatches = '批次 105 有 4 个提示词，优化页显示暂无数据。批次 104 的提示词都被过滤。';
  assert.equal(finish('separate-batches', twoBatches)?.decision, 'block');
  submit('leading-count');
  const leadingCount = '4 个提示词均来自批次 105，优化页显示暂无数据。批次 104 的提示词都被过滤。';
  assert.equal(finish('leading-count', leadingCount)?.decision, 'block');
});

test('allows completion when the reply is complete or has already explained the empty result', () => {
  submit('complete');
  assert.equal(finish('complete', '复测通过，导出按钮可点击，下载的文件也能正常打开。'), null);
  submit('reconciled');
  assert.equal(finish('reconciled', emptyResult + ' 已逐条核对，4 个提示词均已推荐，空结果符合预期。'), null);
  submit('filtered');
  assert.equal(finish('filtered', '批次有 2 个提示词，页面显示暂无数据。A 已推荐，B 已下架，两条都被过滤。'), null);
  submit('clarification');
  assert.equal(finish('clarification', emptyResult + ' 你想先核对哪个平台？'), null);
  submit('footer');
  assert.equal(finish('footer', emptyResult + '\n\n---\n**下一步可用指令**\n请逐条核对这 4 个提示词。'), null);
});

test('requires next-step rules in the same turn and honors bypass and next off', () => {
  assert.equal(finish('unmarked'), null);
  submit('wrong-turn', { turn_id: 'other-turn' });
  assert.equal(finish('wrong-turn'), null);
  submit('bypass', { prompt: 'raw: Check the report results.' });
  assert.equal(finish('bypass'), null);
  const optedOut = submit('opted-out', { prompt: '只报告批次的结果，不要给下一步建议。' });
  assert.doesNotMatch(optedOut.hookSpecificOutput.additionalContext, /\[PROMPT-OPTIMIZER NEXT-STEP\]/);
  assert.equal(submit('opted-out', { prompt: '/compact' }), null);
  assert.equal(run('opted-out', 'SessionStart', { source: 'compact' }), null);
  assert.equal(finish('opted-out'), null);
  assert.match(submit('opted-out', { turn_id: 'new-turn' }).hookSpecificOutput.additionalContext, /\[PROMPT-OPTIMIZER NEXT-STEP\]/);
  submit('disabled', { prompt: '/prompt-optimizer next off', turn_id: 'toggle' });
  submit('disabled');
  assert.equal(finish('disabled'), null);
  submit('toggle-after');
  submit('toggle-after', { prompt: '/prompt-optimizer next off', turn_id: 'toggle' });
  assert.equal(finish('toggle-after'), null);
});

test('does not intervene in rewrites, blocked handoffs, other hosts or a resumed Stop', () => {
  submit('rewrite');
  assert.equal(finish('rewrite', '### 优化后的提示词\n\n> ' + emptyResult + '\n\n按这版执行吗？'), null);
  submit('blocked');
  assert.equal(finish('blocked', emptyResult + ' 后续检查需要你先登录。'), null);
  submit('sign-in-needed');
  assert.equal(finish('sign-in-needed', emptyResult + ' 当前未登录，登录后才能核对。'), null);
  submit('other-host');
  assert.equal(finish('other-host', emptyResult, {}, 'claude'), null);
  submit('continued');
  assert.equal(finish('continued', emptyResult, { stop_hook_active: true }), null);
});
