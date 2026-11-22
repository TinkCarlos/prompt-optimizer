#!/usr/bin/env node
'use strict';
// Unit tests for hooks/prompt-optimizer-pi.js (Pi coding agent extension).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'po-pi-ext-'));
process.env.PROMPT_OPTIMIZER_STATE_DIR = tmp;
delete process.env.PROMPT_OPTIMIZER_SKILL_PATH;

const ext = require(path.join(__dirname, '..', 'hooks', 'prompt-optimizer-pi.js'));

function createHarness(initialBranch = []) {
  const handlers = new Map();
  const commands = new Map();
  const branch = [...initialBranch];
  const sent = [];
  const notifications = [];

  const pi = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    },
    registerCommand(name, spec) {
      commands.set(name, spec);
    },
    appendEntry(customType, data) {
      branch.push({ type: 'custom', customType, data });
    },
    sendUserMessage(text, options) {
      sent.push({ text, options });
    },
  };

  ext(pi);

  const ctx = {
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => branch,
    },
    ui: {
      notify(msg, level) {
        notifications.push({ msg, level });
      },
    },
    isIdle: () => true,
  };

  function emit(name, event = {}) {
    let last;
    for (const fn of handlers.get(name) || []) {
      last = fn(event, ctx);
    }
    return last;
  }

  function makeEvent(prompt, extra = {}) {
    return {
      type: 'before_agent_start',
      messageType: 'user',
      prompt,
      systemPrompt: 'Base system prompt',
      systemPromptOptions: {
        sections: { preamble: 'Base' },
        skills: [
          {
            name: 'prompt-optimizer',
            filePath: '/mock/skills/prompt-optimizer/SKILL.md',
          },
        ],
      },
      ...extra,
    };
  }

  function runTurn(rawInput, expandedPrompt = rawInput, extra = {}) {
    emit('input', { text: rawInput, source: 'interactive', images: extra.images });
    const ev = makeEvent(expandedPrompt, extra);
    const ret = emit('before_agent_start', ev);
    return { ev, ret, section: ev.systemPromptOptions?.sections?.prompt_optimizer };
  }

  return { branch, commands, ctx, emit, makeEvent, notifications, runTurn, sent };
}

(async () => {
try {
  // 1. Vague Turn 1 task injects [PROMPT-OPTIMIZER ROUTER] with the resolved skill path from systemPromptOptions.skills.
  {
    const h = createHarness();
    h.emit('session_start', {});
    const { section } = h.runTurn('帮我做个PPT介绍新产品');
    assert(section && section.includes('[PROMPT-OPTIMIZER ROUTER]'));
    assert(section.includes('/mock/skills/prompt-optimizer/SKILL.md'));
    assert(section.includes('follow-up turns'));
  }

  // 2. Pending confirmation detection via getBranch() across languages & skipping thinking/empty assistant entries.
  for (const replyText of [
    '### 优化后的提示词\n\n> 制作一份新产品介绍 PPT。\n\n确认用这版、修改，还是按原话执行？',
    '### 优化后的提问\n\n> 整理产品介绍大纲。\n\n按这句提问吗？',
    '### Prompt optimizado\n\n> Prepara una presentación del producto.\n\n¿Usar este prompt? (aprobar / editar / usar original)',
  ]) {
    const h = createHarness([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'internal thoughts' },
            { type: 'text', text: replyText },
          ],
        },
      },
      // Trailing empty tool-call-only assistant entry should be skipped when scanning backwards.
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'post-reply thought' }],
        },
      },
    ]);
    h.emit('session_start', {});
    const { section } = h.runTurn('同意');
    assert(section && section.includes('[PROMPT-OPTIMIZER PENDING-REPLY]'), `Expected PENDING-REPLY for: ${replyText}`);
  }

  // 3. "raw:" bypasses even during pending confirmation and clears any prior section.
  {
    const h = createHarness([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '### 优化后的提示词\n\n> 优化内容。\n\n确认？' }],
        },
      },
    ]);
    h.emit('session_start', {});
    const ev = h.makeEvent('raw: 按我刚才原话做', {
      systemPromptOptions: {
        sections: { prompt_optimizer: 'STALE' },
        skills: [],
      },
    });
    h.emit('input', { text: 'raw: 按我刚才原话做', source: 'interactive' });
    h.emit('before_agent_start', ev);
    assert.strictEqual(ev.systemPromptOptions.sections.prompt_optimizer, undefined);
  }

  // 4. Turn 3 multi-turn vague follow-up after normal assistant output triggers ROUTER again.
  {
    const h = createHarness([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '第 1 页：痛点。\n第 2 页：方案。\n第 3 页：演示。' }],
        },
      },
    ]);
    h.emit('session_start', {});
    const { section } = h.runTurn('第一页和第三页太普通了，帮我改得更有质感一点');
    assert(section && section.includes('[PROMPT-OPTIMIZER ROUTER]'));
    assert(section.includes('follow-up turns'));
  }

  // 5. Silent paths clear stale sections.
  {
    const h = createHarness();
    h.emit('session_start', {});
    for (const [rawInput, expanded] of [
      ['you decide', 'you decide'],
      ['同意', '同意'],
      ['gracias', 'gracias'],
      ['raw: fix typo', 'raw: fix typo'],
      ['/compact', '/compact'],
      ['/reload', '/reload'],
      ['/skill:frontend-design-lab', '<skill name="frontend-design-lab" location="/x">body</skill>'],
      ['[KROUTER_PROACTIVE] hi', '[KROUTER_PROACTIVE] hi'],
    ]) {
      h.emit('input', { text: rawInput, source: 'interactive' });
      const ev = h.makeEvent(expanded, {
        systemPromptOptions: {
          sections: { prompt_optimizer: 'STALE' },
          skills: [{ name: 'prompt-optimizer', filePath: '/mock/SKILL.md' }],
        },
      });
      h.emit('before_agent_start', ev);
      assert.strictEqual(ev.systemPromptOptions.sections.prompt_optimizer, undefined, `Should skip & clear: ${rawInput}`);
    }

    // Direct expanded bare <skill> without input event also skips, and custom messageType skips.
    const evBareSkill = h.makeEvent('<skill name="demo" location="/d/SKILL.md">\ncontents\n</skill>\n', {
      systemPromptOptions: { sections: { prompt_optimizer: 'STALE' }, skills: [] },
    });
    h.emit('before_agent_start', evBareSkill);
    assert.strictEqual(evBareSkill.systemPromptOptions.sections.prompt_optimizer, undefined);

    const evCustom = h.makeEvent('ignored custom run', {
      messageType: 'custom',
      systemPromptOptions: { sections: { prompt_optimizer: 'STALE' }, skills: [] },
    });
    h.emit('before_agent_start', evCustom);
    assert.strictEqual(evCustom.systemPromptOptions.sections.prompt_optimizer, undefined);
  }

  // 6. /skill:name <vague task>, image-only turn, and "raw data analysis" all trigger ROUTER.
  {
    const h = createHarness();
    h.emit('session_start', {});
    const expandedSkillTask = '<skill name="frontend-design-lab" location="/s/SKILL.md">\n...\n</skill>\n\n帮我优化这个skill';
    const rSkill = h.runTurn('/skill:frontend-design-lab 帮我优化这个skill', expandedSkillTask);
    assert(rSkill.section && rSkill.section.includes('[PROMPT-OPTIMIZER ROUTER]'));

    const rImg = h.runTurn('', '', { images: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] });
    assert(rImg.section && rImg.section.includes('[PROMPT-OPTIMIZER ROUTER]'));

    const rRawWord = h.runTurn('raw data analysis of Q3 sales');
    assert(rRawWord.section && rRawWord.section.includes('[PROMPT-OPTIMIZER ROUTER]'));
  }

  // 7. Registered /prompt-optimizer command: off/on/status/default/explicit + session_tree/switch/branch restore.
  {
    const h = createHarness();
    h.emit('session_start', {});
    const cmd = h.commands.get('prompt-optimizer');
    assert(cmd, 'prompt-optimizer command must be registered');
    assert(cmd.getArgumentCompletions('def').some((c) => c.value === 'default off'));

    await cmd.handler('off', h.ctx);
    assert.strictEqual(h.runTurn('investigate the failing checkout flow').section, undefined);

    // Explicit command still forces EXPLICIT rewrite even while auto mode is off, and next turn handles confirmation.
    await cmd.handler('plan our launch', h.ctx);
    assert.strictEqual(h.sent[0].text, 'plan our launch');
    const evExplicit = h.makeEvent('plan our launch');
    h.emit('before_agent_start', evExplicit);
    assert(evExplicit.systemPromptOptions.sections.prompt_optimizer.includes('[PROMPT-OPTIMIZER EXPLICIT]'));

    h.branch.push({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '### Optimized Prompt\n\n> Plan the launch.\n\nUse this prompt?' }],
      },
    });
    const evConfirmWhileOff = h.makeEvent('approve');
    h.emit('input', { text: 'approve', source: 'interactive' });
    h.emit('before_agent_start', evConfirmWhileOff);
    assert(evConfirmWhileOff.systemPromptOptions.sections.prompt_optimizer.includes('[PROMPT-OPTIMIZER PENDING-REPLY]'));

    // Next unrelated turn returns to OFF mode cleanly.
    h.branch.push({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Launch plan ready.' }] },
    });
    assert.strictEqual(h.runTurn('make a deck for the team').section, undefined);

    await cmd.handler('on', h.ctx);
    assert(h.runTurn('make a deck for the team').section.includes('[PROMPT-OPTIMIZER ROUTER]'));

    await cmd.handler('status', h.ctx);
    assert(h.notifications.at(-1).msg.includes('session: on'));

    // Branch restore: setting default off and switching to a branch with no explicit override inherits default off.
    await cmd.handler('default off', h.ctx);
    h.branch.length = 0;
    h.emit('session_switch', {});
    assert.strictEqual(h.runTurn('make a deck for the team').section, undefined);

    // Switching to a branch with `mode: "on"` restores ON even when default is off.
    h.branch.push({ type: 'custom', customType: ext.ENTRY_TYPE, data: { mode: 'on' } });
    h.emit('session_tree', {});
    assert(h.runTurn('make a deck for the team').section.includes('[PROMPT-OPTIMIZER ROUTER]'));

    await cmd.handler('default on', h.ctx);
    h.branch.length = 0;
    h.emit('session_branch', {});
    assert(h.runTurn('make a deck for the team').section.includes('[PROMPT-OPTIMIZER ROUTER]'));
  }

  // 8. Fallback when systemPromptOptions.sections is missing returns { systemPrompt }.
  {
    const h = createHarness();
    h.emit('session_start', {});
    h.emit('input', { text: 'make a deck introducing the new product', source: 'interactive' });
    const ret = h.emit('before_agent_start', {
      type: 'before_agent_start',
      messageType: 'user',
      prompt: 'make a deck introducing the new product',
      systemPrompt: 'Base prompt',
      systemPromptOptions: {},
    });
    assert(ret && typeof ret.systemPrompt === 'string' && ret.systemPrompt.includes('[PROMPT-OPTIMIZER ROUTER]'));
  }

  console.log('All Pi extension unit tests passed.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
