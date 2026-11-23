#!/usr/bin/env node
'use strict';
// Install or remove prompt-optimizer for T3 Code's Antigravity provider configs.
// Other T3 Code providers (Claude Code, Codex, Pi, Cursor) inherit their native host configs automatically.

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const HOOK_SRC = path.join(REPO, 'hooks', 'prompt-optimizer-agy.js');
const SKILL_SRC = path.join(REPO, 'SKILL.md');

function discoverT3AntigravityConfigs(t3Dir) {
  const base = t3Dir || process.env.T3_DATA_DIR || path.join(os.homedir(), '.t3');
  const root = path.join(base, 'userdata', 'providers', 'antigravity');
  if (!fs.existsSync(root)) return [];
  const configs = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cfg = path.join(root, entry.name, 'config');
    try {
      if (fs.statSync(cfg).isDirectory()) configs.push(cfg);
    } catch (_) {}
  }
  return configs.sort();
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return {};
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return data;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function hookEntry(nodeBin, hookPath) {
  return {
    PreInvocation: [
      {
        type: 'command',
        command: `${nodeBin} ${hookPath} prompt`,
        timeout: 5,
      },
    ],
  };
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function installIntoConfig(cfgDir, opts) {
  const actions = [];
  const { nodeBin, hookPath, installSkill, dryRun } = opts;

  if (fs.existsSync(HOOK_SRC)) {
    const srcBuf = fs.readFileSync(HOOK_SRC);
    const needsCopy = !fs.existsSync(hookPath) || !fs.readFileSync(hookPath).equals(srcBuf);
    if (needsCopy) {
      actions.push(`copy-hook:${hookPath}`);
      if (!dryRun) {
        fs.mkdirSync(path.dirname(hookPath), { recursive: true });
        fs.writeFileSync(hookPath, srcBuf);
        fs.chmodSync(hookPath, 0o755);
      }
    }
  }

  const hooksFile = path.join(cfgDir, 'hooks.json');
  const hooksData = readJson(hooksFile);
  const desired = hookEntry(nodeBin, hookPath);
  if (!sameJson(hooksData['prompt-optimizer'], desired)) {
    actions.push(`hooks:${hooksFile}`);
    if (!dryRun) {
      hooksData['prompt-optimizer'] = desired;
      writeJsonAtomic(hooksFile, hooksData);
    }
  }

  if (installSkill && fs.existsSync(SKILL_SRC)) {
    const skillsDir = path.join(cfgDir, 'skills');
    if (fs.existsSync(skillsDir)) {
      const target = path.join(skillsDir, 'prompt-optimizer', 'SKILL.md');
      const srcBuf = fs.readFileSync(SKILL_SRC);
      const needsSkill = !fs.existsSync(target) || !fs.readFileSync(target).equals(srcBuf);
      if (needsSkill) {
        actions.push(`skill:${target}`);
        if (!dryRun) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, srcBuf);
        }
      }
    }
  }

  return { config: cfgDir, actions };
}

function uninstallFromConfig(cfgDir, opts) {
  const actions = [];
  const hooksFile = path.join(cfgDir, 'hooks.json');
  if (fs.existsSync(hooksFile)) {
    const hooksData = readJson(hooksFile);
    if (Object.prototype.hasOwnProperty.call(hooksData, 'prompt-optimizer')) {
      actions.push(`remove-hooks:${hooksFile}`);
      if (!opts.dryRun) {
        delete hooksData['prompt-optimizer'];
        writeJsonAtomic(hooksFile, hooksData);
      }
    }
  }
  return { config: cfgDir, actions };
}

function defaultNodeBin() {
  try {
    const realExec = fs.realpathSync(process.execPath);
    for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
      try {
        if (fs.existsSync(candidate) && fs.realpathSync(candidate) === realExec) return candidate;
      } catch (_) {}
    }
  } catch (_) {}
  return process.execPath;
}

function parseArgs(argv) {
  const opts = {
    t3Dir: '',
    nodeBin: defaultNodeBin(),
    hookPath: path.join(os.homedir(), '.gemini', 'config', 'hooks', 'prompt-optimizer-agy.js'),
    installSkill: true,
    uninstall: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--t3-dir' && argv[i + 1]) opts.t3Dir = argv[++i];
    else if (arg === '--node' && argv[i + 1]) opts.nodeBin = argv[++i];
    else if (arg === '--hook-path' && argv[i + 1]) opts.hookPath = argv[++i];
    else if (arg === '--skip-skill') opts.installSkill = false;
    else if (arg === '--uninstall') opts.uninstall = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/install-t3.js [--t3-dir DIR] [--node NODE_BIN] [--hook-path PATH] [--skip-skill] [--uninstall] [--dry-run]');
      process.exit(0);
    }
  }
  return opts;
}

function run(argv) {
  const opts = parseArgs(argv);
  const configs = discoverT3AntigravityConfigs(opts.t3Dir || undefined);
  if (!configs.length) {
    return { dryRun: opts.dryRun, configs: [] };
  }
  const results = configs.map((cfg) => (opts.uninstall ? uninstallFromConfig(cfg, opts) : installIntoConfig(cfg, opts)));
  return { dryRun: opts.dryRun, configs: results };
}

if (require.main === module) {
  const summary = run(process.argv.slice(2));
  console.log(JSON.stringify(summary, null, 2));
}

module.exports = { discoverT3AntigravityConfigs, installIntoConfig, uninstallFromConfig, run };
