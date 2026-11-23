#!/usr/bin/env node
'use strict';
// Unit tests for scripts/install-t3.js (T3 Code Antigravity installer).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const installer = require(path.join(__dirname, '..', 'scripts', 'install-t3.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'po-t3-install-'));

try {
  const t3Dir = path.join(tmp, '.t3');
  const cfgA = path.join(t3Dir, 'userdata', 'providers', 'antigravity', 'hash-a', 'config');
  const cfgB = path.join(t3Dir, 'userdata', 'providers', 'antigravity', 'hash-b', 'config');
  fs.mkdirSync(path.join(cfgA, 'skills'), { recursive: true });
  fs.mkdirSync(cfgB, { recursive: true });
  fs.writeFileSync(path.join(cfgA, 'hooks.json'), JSON.stringify({ lmemory: { PreInvocation: [{ type: 'command', command: 'lmemory' }] } }, null, 2), 'utf8');
  const hookDest = path.join(tmp, 'hooks', 'prompt-optimizer-agy.js');

  // 1. Discovery finds both T3 Antigravity config dirs sorted
  assert.deepStrictEqual(installer.discoverT3AntigravityConfigs(t3Dir), [cfgA, cfgB]);

  // 2. Dry run changes nothing on disk
  const dry = installer.run(['--t3-dir', t3Dir, '--node', '/opt/homebrew/bin/node', '--hook-path', hookDest, '--dry-run']);
  assert.strictEqual(dry.dryRun, true);
  assert.strictEqual(dry.configs.length, 2);
  assert(!fs.existsSync(hookDest));
  assert(!('prompt-optimizer' in JSON.parse(fs.readFileSync(path.join(cfgA, 'hooks.json'), 'utf8'))));

  // 3. Real install copies hook, writes/merges hooks.json preserving lmemory, and installs SKILL.md where skills/ exists
  const applied = installer.run(['--t3-dir', t3Dir, '--node', '/opt/homebrew/bin/node', '--hook-path', hookDest]);
  assert.strictEqual(applied.dryRun, false);
  assert(fs.existsSync(hookDest));
  const hooksA = JSON.parse(fs.readFileSync(path.join(cfgA, 'hooks.json'), 'utf8'));
  assert(hooksA.lmemory, 'Existing lmemory hook must be preserved');
  assert.strictEqual(hooksA['prompt-optimizer'].PreInvocation[0].command, `/opt/homebrew/bin/node ${hookDest} prompt`);
  assert(fs.existsSync(path.join(cfgA, 'skills', 'prompt-optimizer', 'SKILL.md')));
  assert(fs.existsSync(path.join(cfgB, 'hooks.json')));

  // 4. Second install is idempotent (no actions)
  const rerun = installer.run(['--t3-dir', t3Dir, '--node', '/opt/homebrew/bin/node', '--hook-path', hookDest]);
  assert.deepStrictEqual(rerun.configs[0].actions, []);
  assert.deepStrictEqual(rerun.configs[1].actions, []);

  // 5. Uninstall removes only prompt-optimizer and preserves lmemory
  const removed = installer.run(['--t3-dir', t3Dir, '--uninstall']);
  assert(removed.configs[0].actions.length === 1);
  const hooksAfter = JSON.parse(fs.readFileSync(path.join(cfgA, 'hooks.json'), 'utf8'));
  assert(hooksAfter.lmemory, 'Existing lmemory hook must survive uninstall');
  assert(!('prompt-optimizer' in hooksAfter));

  console.log('All T3 Code installer tests passed.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
