import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { runMultiCommitFlow, setExitForTesting } from '../src/index.ts';
import { setSelectForTesting, setSpinnerForTesting } from '../src/ui.ts';
import { config as makeConfig, providerConfig, flags as makeFlags, ExitSignal } from './fixtures.ts';

const exec = promisify(execFile);

const silentSpinner = (() => ({
  start() {}, stop() {}, message() {}
})) as unknown as Parameters<typeof setSpinnerForTesting>[0];

interface PlannedCommit {
  subject: string;
  body: string;
  files: string[];
}

/** Returns each plan in order as the JSON envelope parseMultiResponse expects. */
function respondWith(plans: PlannedCommit[][]) {
  let i = 0;
  return async () => {
    const commits = plans[Math.min(i, plans.length - 1)];
    i++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ commits }) } }]
      })
    } as any;
  };
}

function queue(values: unknown[]) {
  const remaining = [...values];
  return async () => {
    if (remaining.length === 0) throw new Error('prompt called more times than scripted');
    return remaining.shift();
  };
}

describe('index.ts runMultiCommitFlow', () => {
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
    baseDir = await mkdtemp(join(tmpdir(), 'kommit-multi-flow-'));
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
    setExitForTesting(null);
    process.chdir(originalCwd);
  });

  /** Two independent changes, which is the case multi-commit exists to split. */
  async function twoChanges(): Promise<void> {
    await writeFile(join(repoDir, 'a.txt'), 'alpha\n');
    await writeFile(join(repoDir, 'b.txt'), 'beta\n');
    await exec('git', ['add', 'a.txt', 'b.txt'], { cwd: repoDir });
  }

  const twoCommitPlan: PlannedCommit[] = [
    { subject: 'feat: add a', body: 'Adds a.', files: ['a.txt'] },
    { subject: 'feat: add b', body: 'Adds b.', files: ['b.txt'] }
  ];

  async function run(flagOverrides: Record<string, unknown> = {}): Promise<number | null> {
    let code: number | null = null;
    setExitForTesting((c: number) => { code = c; throw new ExitSignal(c); });
    try {
      await runMultiCommitFlow({
        flags: makeFlags({ multi: true, ...flagOverrides }),
        config: makeConfig(),
        auth: { openai: 'sk-test' },
        provider: 'openai',
        providerConfig: providerConfig(),
        apiKey: 'sk-test'
      } as any);
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

  it('exits 1 when there is nothing to split', async () => {
    globalThis.fetch = respondWith([twoCommitPlan]) as any;
    assert.strictEqual(await run(), 1);
    assert.match(errors.join('\n'), /No changes/i);
  });

  it('creates one commit per planned group', async () => {
    await twoChanges();
    globalThis.fetch = respondWith([twoCommitPlan]) as any;
    setSelectForTesting(queue(['acceptAll']), () => false);

    assert.strictEqual(await run(), 0);
    const history = await log();
    assert.match(history, /feat: add a/);
    assert.match(history, /feat: add b/);
    assert.strictEqual(history.trim().split('\n').length, 2);
  });

  it('does not commit on cancel', async () => {
    await twoChanges();
    globalThis.fetch = respondWith([twoCommitPlan]) as any;
    setSelectForTesting(queue(['cancel']), () => false);

    assert.strictEqual(await run(), 0);
    assert.strictEqual((await log()).trim(), '');
  });

  it('does not commit under --dry-run', async () => {
    await twoChanges();
    globalThis.fetch = respondWith([twoCommitPlan]) as any;
    setSelectForTesting(queue(['acceptAll']), () => false);

    assert.strictEqual(await run({ dryRun: true }), 0);
    assert.strictEqual((await log()).trim(), '');
    assert.match(logs.join('\n'), /Would commit:/);
  });

  it('commits only the groups the user selects', async () => {
    await twoChanges();
    globalThis.fetch = respondWith([twoCommitPlan]) as any;
    // promptSelectCommits uses multiselect, so the second stub answers with the indexes.
    setSelectForTesting(queue(['select']), () => false, queue([[1]]));

    assert.strictEqual(await run(), 0);
    const history = await log();
    assert.match(history, /feat: add b/);
    assert.doesNotMatch(history, /feat: add a/);
  });

  it('returns to the plan when the selection is empty', async () => {
    await twoChanges();
    globalThis.fetch = respondWith([twoCommitPlan]) as any;
    // Empty selection loops back to the plan prompt, where the user then cancels.
    setSelectForTesting(queue(['select', 'cancel']), () => false, queue([[]]));

    assert.strictEqual(await run(), 0);
    assert.strictEqual((await log()).trim(), '');
  });

  it('applies an edit to one group before committing', async () => {
    await twoChanges();
    globalThis.fetch = respondWith([twoCommitPlan]) as any;
    const edits = ['fix: edited a', 'edited body'];
    setSelectForTesting(
      queue(['edit', 0, 'acceptAll']),
      () => false,
      null,
      () => edits.shift()
    );

    assert.strictEqual(await run(), 0);
    const history = await log();
    assert.match(history, /fix: edited a/);
    assert.match(history, /feat: add b/);
  });

  it('regenerates the plan and commits the second one', async () => {
    await twoChanges();
    globalThis.fetch = respondWith([
      twoCommitPlan,
      [
        { subject: 'chore: regrouped', body: 'All together.', files: ['a.txt', 'b.txt'] }
      ]
    ]) as any;
    setSelectForTesting(queue(['regenerate', 'acceptAll']), () => false);

    assert.strictEqual(await run(), 0);
    const history = await log();
    assert.match(history, /chore: regrouped/);
    assert.strictEqual(history.trim().split('\n').length, 1);
  });

  it('exits 1 when planning is abandoned', async () => {
    await twoChanges();
    globalThis.fetch = (async () => { throw new Error('network down'); }) as any;
    setSelectForTesting(queue(['cancel']), () => false);

    assert.strictEqual(await run(), 1);
    assert.strictEqual((await log()).trim(), '');
  });
});
