import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('standalone bundle renders Codex and Claude transcripts without installed packages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-bundle-'));
  try {
    const script = join(dir, 'recall.mjs');
    copyFileSync(new URL('../skills/recall/recall.mjs', import.meta.url), script);
    const timestamp = '2026-11-18T10:00:00Z';
    const fixtures = {
      codex: [
        { type: 'session_meta', payload: { id: '12345678-example', cwd: '/project' } },
        { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read &amp; inspect' }] } },
        { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '**Done** in /project/src.' }] } },
      ],
      claude: [
        { uuid: 'u', type: 'user', timestamp, cwd: '/project', message: { content: '<system-reminder>hidden</system-reminder>Inspect' } },
        { uuid: 'a', type: 'assistant', timestamp, message: { id: 'a', model: 'test', stop_reason: 'end_turn', content: [{ type: 'text', text: '**Done** in /project/src.' }] } },
      ],
    };
    for (const [name, events] of Object.entries(fixtures)) {
      const transcript = join(dir, `${name}.jsonl`);
      writeFileSync(transcript, events.map(event => JSON.stringify(event)).join('\n'));
      const result = spawnSync(process.execPath, [script, transcript], { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /\[u\]/);
      assert.match(result.stdout, /\[f\]/);
      assert.match(result.stdout, /Done in \.\/src\./);
      assert.doesNotMatch(result.stdout, /hidden/);
      if (name === 'codex') assert.match(result.stdout, /Read & inspect/);
    }
    const usage = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /usage: recall\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
