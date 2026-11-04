// can-fail, run the way a person runs it, on small projects made for each case.
// Built-in modules only; runs on Windows, macOS and Linux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'can-fail.mjs');

// A fresh folder under the system's temporary folder; only that folder is ever removed.
async function withProject(files, use) {
  const dir = mkdtempSync(join(tmpdir(), 'can-fail-test-'));
  assert.ok(dir.startsWith(tmpdir()) && dir.length > tmpdir().length + 1, `unexpected project folder ${dir}`);
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return await use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function canFail(dir, args, env = {}) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [TOOL, ...args], { cwd: dir, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } });
  assert.equal(run.error, undefined, `can-fail did not run: ${run.error}`);
  return { code: run.status, stdout: run.stdout, stderr: run.stderr, seconds: (Date.now() - started) / 1000 };
}

const MAX = ['module.exports = function max(a, b) {', '  if (a > b) {', '    return a;', '  }', '  return b;', '};', ''].join('\n');
const MAX_RETURN_B_LINE = 5;
const WEAK_CHECK = "const max = require('./max.js');\nif (max(2, 1) !== 2) process.exit(1);\n";
const STRONG_CHECK = [
  "const max = require('./max.js');",
  'if (max(2, 1) !== 2) process.exit(1);',
  'if (max(1, 2) !== 2) process.exit(1);',
  'if (max(3, 3) !== 3) process.exit(1);',
  '',
].join('\n');

test('a weak check: the change it cannot see survives, on the line it was made', async () => {
  await withProject({ 'max.js': MAX, 'check.js': WEAK_CHECK }, (dir) => {
    const run = canFail(dir, ['--src', 'max.js', '--test', 'node check.js', '--json']);
    assert.equal(run.code, 1, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.ok(result.survived >= 1, `expected a survivor in ${run.stdout}`);
    assert.equal(result.survivors.length, result.survived);
    assert.ok(
      result.survivors.some((s) => s.file === 'max.js' && s.line === MAX_RETURN_B_LINE && s.change === 'replace return value with undefined'),
      `expected "return b" on line ${MAX_RETURN_B_LINE} to survive, got ${JSON.stringify(result.survivors)}`,
    );
    assert.equal(result.killed + result.survived, result.total);
  });
});

test('a strong check: every change is noticed, exit 0, no survivor', async () => {
  await withProject({ 'max.js': MAX, 'check.js': STRONG_CHECK }, (dir) => {
    const run = canFail(dir, ['--src', 'max.js', '--test', 'node check.js', '--json']);
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
    const result = JSON.parse(run.stdout);
    assert.ok(result.total > 0, 'expected changes to be made');
    assert.equal(result.survived, 0);
    assert.deepEqual(result.survivors, []);
    assert.equal(result.killed, result.total);
  });
});

test('tests that fail before any change: exit 2, nothing on stdout, and the reason on stderr', async () => {
  await withProject({ 'max.js': MAX, 'check.js': 'process.exit(1);\n' }, (dir) => {
    const run = canFail(dir, ['--src', 'max.js', '--test', 'node check.js', '--json']);
    assert.equal(run.code, 2);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /test command fails before any change/);
  });
});

test('a change that makes a loop endless is stopped, with everything it started, and counted as noticed', async () => {
  // The loop writes a heartbeat on every pass, so a run left alive after can-fail returns is visible.
  const loop = [
    "const fs = require('fs');",
    'module.exports = function count() {',
    '  let i = 0;',
    '  while (i < 3) {',
    '    i += 1;',
    '    if (process.env.CAN_FAIL_BEAT) fs.writeFileSync(process.env.CAN_FAIL_BEAT, String(Date.now()));',
    '  }',
    '  return i;',
    '};',
    '',
  ].join('\n');
  const check = "if (require('./loop.js')() !== 3) process.exit(1);\n";
  const beatDir = mkdtempSync(join(tmpdir(), 'can-fail-beat-'));
  assert.ok(beatDir.startsWith(tmpdir()) && beatDir.length > tmpdir().length + 1, `unexpected folder ${beatDir}`);
  const beat = join(beatDir, 'beat.txt');
  try {
    await withProject({ 'loop.js': loop, 'check.js': check }, async (dir) => {
      const run = canFail(dir, ['--src', 'loop.js', '--test', 'node check.js', '--json', '--timeout', '2'], { CAN_FAIL_BEAT: beat });
      assert.ok(run.code === 0 || run.code === 1, `unexpected exit ${run.code}: ${run.stderr}`);
      const result = JSON.parse(run.stdout);
      assert.ok(
        result.timeouts.some((t) => t.file === 'loop.js' && t.line === 5 && t.change === '1 -> 0'),
        `expected "i += 1" turned into "i += 0" to time out, got ${JSON.stringify(result.timeouts)}`,
      );
      assert.ok(!result.survivors.some((s) => s.line === 5 && s.change === '1 -> 0'), 'a timed-out change must not be a survivor');
      assert.equal(result.killed + result.survived, result.total);
      assert.ok(result.killed >= result.timeouts.length);
      assert.ok(run.seconds < 60, `took ${run.seconds} s: a hung run was not stopped`);
      // nothing the timed-out runs started may still be running
      const first = readFileSync(beat, 'utf8');
      await new Promise((done) => setTimeout(done, 2500));
      assert.equal(readFileSync(beat, 'utf8'), first, 'a run that timed out is still running after can-fail returned');
    });
  } finally {
    rmSync(beatDir, { recursive: true, force: true });
  }
});

test("the project's own files are byte-identical after a run", async () => {
  await withProject({ 'max.js': MAX, 'check.js': WEAK_CHECK }, (dir) => {
    const before = { max: readFileSync(join(dir, 'max.js')), check: readFileSync(join(dir, 'check.js')) };
    canFail(dir, ['--src', 'max.js', '--test', 'node check.js', '--json']);
    assert.ok(readFileSync(join(dir, 'max.js')).equals(before.max), 'max.js changed');
    assert.ok(readFileSync(join(dir, 'check.js')).equals(before.check), 'check.js changed');
  });
});
