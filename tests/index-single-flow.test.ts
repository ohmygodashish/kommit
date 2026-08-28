import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { runSingleCommitFlow, setExitForTesting } from '../src/index.ts';
import { setSelectForTesting, setSpinnerForTesting } from '../src/ui.ts';
import { setSpawnForTesting } from '../src/clipboard.ts';
import { config as makeConfig, providerConfig, flags as makeFlags, ExitSignal } from './fixtures.ts';

const exec = promisify(execFile);

const silentSpinner = (() => ({
  start() {}, stop() {}, message() {}
})) as unknown as Parameters<typeof setSpinnerForTesting>[0];

/**
 * A fetch stub returning each subject in order as the JSON body the prompt asks the model
 * for, so the flow exercises parseResponse rather than the raw-text fallback.
 */
function respondWith(subjects: string[]) {
  let i = 0;
  return async () => {
    const subject = subjects[Math.min(i, subjects.length - 1)];
    i++;
    const content = JSON.stringify({ subject, body: 'Generated body.' });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] })
    } as any;
  };
}

/** Answers each select in order; refuses to invent an answer nobody scripted. */
function queue(values: unknown[]) {
  const remaining = [...values];
  return async () => {
    if (remaining.length === 0) throw new Error('select called more times than scripted');
    return remaining.shift();
  };
}

describe('index.ts runSingleCommitFlow', () => {
  let baseDir: string;
  let repoDir: string;
  let originalCwd: string;
  let originalFetch: typeof globalThis.fetch;
  let logs: string[];
  let errors: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalWarn: typeof console.warn;

  before(async () => {
    originalCwd = process.cwd();
    baseDir = await mkdtemp(join(tmpdir(), 'kommit-single-flow-'));
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    logs = [];
    errors = [];
    originalLog = console.log;
    originalError = console.error;
    originalWarn = console.warn;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    console.warn = (...a: unknown[]) => { errors.push(a.join(' ')); };

    setSpinnerForTesting(silentSpinner);
    globalThis.fetch = respondWith(['feat: add a thing']) as any;

    repoDir = await mkdtemp(join(baseDir, 'repo-'));
    await exec('git', ['init', '-q'], { cwd: repoDir });
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    process.chdir(repoDir);
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
    setSelectForTesting(null, null, null, null);
    setSpinnerForTesting(null);
    setSpawnForTesting(null);
    setExitForTesting(null);
    process.chdir(originalCwd);
  });

  async function stageAFile(name = 'a.txt', content = 'hello\n'): Promise<void> {
    await writeFile(join(repoDir, name), content);
    await exec('git', ['add', name], { cwd: repoDir });
  }

  /** Runs the flow, capturing the exit code the seam reports. */
  async function run(overrides: Record<string, unknown> = {}): Promise<number | null> {
    let code: number | null = null;
    setExitForTesting((c: number) => { code = c; throw new ExitSignal(c); });
    const opts = {
      flags: makeFlags(),
      config: makeConfig(),
      auth: { openai: 'sk-test' },
      provider: 'openai',
      providerConfig: providerConfig(),
      apiKey: 'sk-test',
      ...overrides
    } as any;
    try {
      await runSingleCommitFlow(opts);
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
    }
    return code;
  }

  async function log(): Promise<string> {
    // Subjects only: --oneline prepends a hash, and a hash can contain the text a test is
    // asserting against (a real 'c3' match once came from the hash 5e79ec3).
    const { stdout } = await exec('git', ['log', '--format=%s'], { cwd: repoDir }).catch(() => ({ stdout: '' }));
    return stdout;
  }

  it('exits 1 when there is nothing to commit', async () => {
    assert.strictEqual(await run(), 1);
    assert.match(errors.join('\n'), /No changes detected/);
  });

  it('commits the generated message when the user accepts it', async () => {
    await stageAFile();
    setSelectForTesting(queue(['use']), () => false);

    assert.strictEqual(await run(), 0);
    assert.match(await log(), /feat: add a thing/);
    assert.match(logs.join('\n'), /Committed: /);
  });

  it('does not commit on cancel', async () => {
    await stageAFile();
    setSelectForTesting(queue(['cancel']), () => false);

    assert.strictEqual(await run(), 0);
    assert.strictEqual((await log()).trim(), '');
  });

  it('does not commit under --dry-run', async () => {
    await stageAFile();
    setSelectForTesting(queue(['use']), () => false);

    assert.strictEqual(await run({ flags: makeFlags({ dryRun: true }) }), 0);
    assert.strictEqual((await log()).trim(), '');
    assert.match(logs.join('\n'), /Dry run/);
  });

  it('falls back to the unstaged diff and stages before committing', async () => {
    // Committed first so the file is tracked; the later edit stays unstaged.
    await stageAFile('tracked.txt', 'v1\n');
    await exec('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
    await writeFile(join(repoDir, 'tracked.txt'), 'v2\n');

    setSelectForTesting(queue(['stageAndUse']), () => false);
    assert.strictEqual(await run(), 0);
    assert.match(logs.join('\n'), /No staged changes found/);
    assert.match(await log(), /feat: add a thing/);
  });

  it('copies to the clipboard without committing', async () => {
    await stageAFile();
    setSelectForTesting(queue(['copy']), () => false);

    let copied = '';
    setSpawnForTesting(() => ({
      stdin: { write: (t: string) => { copied += t; }, end() {} },
      on(event: string, cb: (arg?: unknown) => void) {
        if (event === 'close') queueMicrotask(() => cb(0));
        return this;
      }
    }));

    const code = await run();
    assert.strictEqual(code, 0, `errors: ${errors.join(' | ')}`);
    assert.match(copied, /feat: add a thing/);
    assert.strictEqual((await log()).trim(), '');
  });

  it('exits 1 when the clipboard is unavailable', async () => {
    await stageAFile();
    setSelectForTesting(queue(['copy']), () => false);
    setSpawnForTesting(() => ({
      stdin: { write() {}, end() {} },
      on(event: string, cb: (arg?: unknown) => void) {
        if (event === 'error') queueMicrotask(() => cb(new Error('no clipboard tool')));
        return this;
      }
    }));

    assert.strictEqual(await run(), 1);
  });

  it('applies an inline edit before committing', async () => {
    await stageAFile();
    const edits = ['fix: edited subject', 'edited body'];
    setSelectForTesting(queue(['edit', 'use']), () => false, null, () => edits.shift());

    assert.strictEqual(await run(), 0);
    assert.match(await log(), /fix: edited subject/);
  });

  it('regenerates with a variation hint and commits the second message', async () => {
    await stageAFile();
    globalThis.fetch = respondWith(['feat: first try', 'feat: second try']) as any;
    setSelectForTesting(queue(['regenerate', 'use']), () => false);

    assert.strictEqual(await run(), 0);
    assert.match(await log(), /feat: second try/);
  });

  it('exits 1 when generation is abandoned', async () => {
    await stageAFile();
    globalThis.fetch = (async () => { throw new Error('network down'); }) as any;
    // The error prompt is the only select reached; cancelling gives up on the message.
    setSelectForTesting(queue(['cancel']), () => false);

    assert.strictEqual(await run(), 1);
    assert.strictEqual((await log()).trim(), '');
  });
});
