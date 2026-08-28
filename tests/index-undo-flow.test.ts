import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { runUndoFlow, setExitForTesting } from '../src/index.ts';
import { setSelectForTesting, setSpinnerForTesting } from '../src/ui.ts';
import { config as makeConfig, providerConfig, flags as makeFlags, ExitSignal } from './fixtures.ts';

/** Returns each subject in order as the JSON body the prompt asks the model for. */
function respondWith(subjects: string[]) {
  let i = 0;
  return async () => {
    const subject = subjects[Math.min(i, subjects.length - 1)];
    i++;
    const content = JSON.stringify({ subject, body: 'Regenerated body.' });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] })
    } as any;
  };
}

const exec = promisify(execFile);

const silentSpinner = (() => ({
  start() {}, stop() {}, message() {}
})) as unknown as Parameters<typeof setSpinnerForTesting>[0];

function queue(values: unknown[]) {
  const remaining = [...values];
  return async () => {
    if (remaining.length === 0) throw new Error('select called more times than scripted');
    return remaining.shift();
  };
}

describe('index.ts runUndoFlow', () => {
  let baseDir: string;
  let repoDir: string;
  let originalCwd: string;
  let logs: string[];
  let errors: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalWarn: typeof console.warn;
  let originalFetch: typeof globalThis.fetch;

  before(async () => {
    originalCwd = process.cwd();
    baseDir = await mkdtemp(join(tmpdir(), 'kommit-undo-flow-'));
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    logs = [];
    errors = [];
    originalLog = console.log;
    originalError = console.error;
    originalWarn = console.warn;
    originalFetch = globalThis.fetch;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    console.warn = (...a: unknown[]) => { errors.push(a.join(' ')); };
    setSpinnerForTesting(silentSpinner);
    globalThis.fetch = respondWith(['feat: regenerated message']) as any;

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

  /** Creates `n` commits named c1..cn. */
  async function commits(n: number): Promise<void> {
    for (let i = 1; i <= n; i++) {
      await writeFile(join(repoDir, `f${i}.txt`), `content ${i}\n`);
      await exec('git', ['add', `f${i}.txt`], { cwd: repoDir });
      await exec('git', ['commit', '-q', '-m', `c${i}`], { cwd: repoDir });
    }
  }

  async function run(flagOverrides: Record<string, unknown> = {}): Promise<number | null> {
    let code: number | null = null;
    setExitForTesting((c: number) => { code = c; throw new ExitSignal(c); });
    try {
      await runUndoFlow({
        flags: makeFlags({ undo: true, ...flagOverrides }),
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

  async function staged(): Promise<string> {
    const { stdout } = await exec('git', ['diff', '--cached', '--name-only'], { cwd: repoDir });
    return stdout.trim();
  }

  describe('guards', () => {
    it('rejects a count below 1', async () => {
      await commits(1);
      assert.strictEqual(await run({ undoCount: 0 }), 1);
      assert.match(errors.join('\n'), /at least 1/);
    });

    it('refuses to undo more commits than exist', async () => {
      await commits(2);
      assert.strictEqual(await run({ undoCount: 5 }), 1);
      assert.match(errors.join('\n'), /only has 2 commits/);
      assert.match(await log(), /c2/);
    });

    it('refuses to undo a merge commit', async () => {
      await commits(1);
      await exec('git', ['checkout', '-q', '-b', 'side'], { cwd: repoDir });
      await writeFile(join(repoDir, 'side.txt'), 'side\n');
      await exec('git', ['add', 'side.txt'], { cwd: repoDir });
      await exec('git', ['commit', '-q', '-m', 'side work'], { cwd: repoDir });
      await exec('git', ['checkout', '-q', '-'], { cwd: repoDir });
      await writeFile(join(repoDir, 'main.txt'), 'main\n');
      await exec('git', ['add', 'main.txt'], { cwd: repoDir });
      await exec('git', ['commit', '-q', '-m', 'main work'], { cwd: repoDir });
      await exec('git', ['merge', '--no-ff', '-q', '-m', 'merge side', 'side'], { cwd: repoDir });

      assert.strictEqual(await run({ undoCount: 1 }), 1);
      assert.match(errors.join('\n'), /Cannot undo merge commit/);
      assert.match(await log(), /merge side/);
    });
  });

  describe('dry run', () => {
    it('lists the commits and changes nothing', async () => {
      await commits(2);
      assert.strictEqual(await run({ undoCount: 2, dryRun: true }), 0);

      const out = logs.join('\n');
      assert.match(out, /Would undo 2 commits/);
      assert.match(out, /c1/);
      assert.match(out, /c2/);
      assert.match(out, /No changes made/);
      assert.match(await log(), /c2/);
    });
  });

  describe('confirmation', () => {
    it('leaves history alone when the user declines', async () => {
      await commits(2);
      setSelectForTesting(queue(['cancel']), () => false);

      assert.strictEqual(await run({ undoCount: 1 }), 0);
      assert.match(await log(), /c2/);
    });

    it('undoes the commit and leaves the changes staged', async () => {
      await commits(2);
      // Confirm the undo, then choose to leave the changes staged.
      setSelectForTesting(queue(['yes', 'cancel']), () => false);

      assert.strictEqual(await run({ undoCount: 1 }), 0);
      const history = await log();
      assert.doesNotMatch(history, /c2/, 'c2 should have been undone');
      assert.match(history, /c1/, 'c1 should survive');
      assert.strictEqual(await staged(), 'f2.txt');
      assert.match(logs.join('\n'), /Undone 1 commit/);
    });

    it('undoes several commits at once', async () => {
      await commits(3);
      setSelectForTesting(queue(['yes', 'cancel']), () => false);

      assert.strictEqual(await run({ undoCount: 2 }), 0);
      const history = await log();
      assert.match(history, /c1/);
      assert.doesNotMatch(history, /c2/);
      assert.doesNotMatch(history, /c3/);
      assert.match(logs.join('\n'), /Undone 2 commits/);
    });
  });

  // After the undo, the changes are staged and the user is offered a follow-up.
  describe('post-undo actions', () => {
    it('regenerates a message and commits it', async () => {
      await commits(2);
      setSelectForTesting(queue(['yes', 'regenerate', 'use']), () => false);

      assert.strictEqual(await run({ undoCount: 1 }), 0);
      const history = await log();
      assert.match(history, /feat: regenerated message/);
      assert.doesNotMatch(history, /c2/);
    });

    it('leaves the changes staged when the regenerated message is declined', async () => {
      await commits(2);
      setSelectForTesting(queue(['yes', 'regenerate', 'cancel']), () => false);

      assert.strictEqual(await run({ undoCount: 1 }), 0);
      assert.doesNotMatch(await log(), /c2/);
      assert.strictEqual(await staged(), 'f2.txt');
    });

    it('shows an edited message without committing it', async () => {
      await commits(2);
      const edits = ['fix: reworded', 'new body'];
      setSelectForTesting(
        queue(['yes', 'edit', 0]),
        () => false,
        null,
        () => edits.shift()
      );

      assert.strictEqual(await run({ undoCount: 1 }), 0);
      const out = logs.join('\n');
      assert.match(out, /Edited message:/);
      assert.match(out, /fix: reworded/);
      assert.match(out, /Changes are staged/);
      // Deliberately not committed: the user finishes with git commit themselves.
      assert.doesNotMatch(await log(), /fix: reworded/);
      assert.strictEqual(await staged(), 'f2.txt');
    });
  });
});
