import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { main, setExitForTesting } from '../src/index.ts';
import { saveConfig, saveAuth } from '../src/config.ts';
import { config as makeConfig, providerConfig, ExitSignal } from './fixtures.ts';
import type { Config } from '../src/types.ts';

const exec = promisify(execFile);

interface RunResult {
  code: number | null;
  out: string;
  err: string;
}

// main() reads argv, env and cwd directly, so a case is set up by arranging those rather
// than by stubbing the modules it imports. Only the exit seam is overridden.
async function runMain(argv: string[]): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { out.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { err.push(args.join(' ')); };

  process.argv = ['node', 'kommit', ...argv];
  let code: number | null = null;
  setExitForTesting((c: number) => { code = c; throw new ExitSignal(c); });

  try {
    await main();
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    setExitForTesting(null);
  }

  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('index.ts main()', () => {
  let baseDir: string;
  let repoDir: string;
  let plainDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let originalArgv: string[];
  let originalCwd: string;

  before(async () => {
    originalEnv = { ...process.env };
    originalArgv = [...process.argv];
    originalCwd = process.cwd();
    baseDir = await mkdtemp(join(tmpdir(), 'kommit-main-test-'));

    repoDir = join(baseDir, 'repo');
    await mkdir(repoDir);
    await exec('git', ['init', '-q'], { cwd: repoDir });

    // A directory that is deliberately not a repository, for the getRepoRoot guard.
    plainDir = join(baseDir, 'plain');
    await mkdir(plainDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    process.argv = originalArgv;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // A stray KOMMIT_PROVIDER or API key in the developer's real environment would silently
    // pick a different branch than the one under test.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('KOMMIT_')) delete process.env[key];
    }
    const configDir = await mkdtemp(join(baseDir, 'cfg-'));
    const dataDir = await mkdtemp(join(baseDir, 'data-'));
    process.env.XDG_CONFIG_HOME = configDir;
    process.env.XDG_DATA_HOME = dataDir;
    process.chdir(repoDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  // Both of these answer and exit before any config or repository is touched.
  describe('flags handled before config is loaded', () => {
    it('--help prints usage and exits 0', async () => {
      const { code, out } = await runMain(['--help']);
      assert.strictEqual(code, 0);
      assert.match(out, /Usage:/);
      assert.match(out, /--dry-run/);
    });

    it('--version prints the package version and exits 0', async () => {
      const { code, out } = await runMain(['--version']);
      assert.strictEqual(code, 0);
      assert.match(out.trim(), /^\d+\.\d+\.\d+/);
    });

    // parseArgs throws rather than exiting; cli.ts is what turns that into exit 1.
    it('propagates a bad option out of main() for cli.ts to report', async () => {
      await assert.rejects(() => runMain(['--dryrun']), /unknown option '--dryrun'/);
    });
  });

  describe('config guards', () => {
    it('--set exits 1 when the config file is unreadable', async () => {
      const dir = join(process.env.XDG_CONFIG_HOME!, 'kommit');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'config.json'), '{ not json');

      const { code, err } = await runMain(['--set']);
      assert.strictEqual(code, 1);
      assert.match(err, /^kommit: /m);
    });
  });

  describe('repository and provider guards', () => {
    async function writeValidConfig(overrides: Partial<Config> = {}): Promise<void> {
      await saveConfig(makeConfig(overrides));
    }

    it('exits 1 outside a git repository', async () => {
      await writeValidConfig();
      await saveAuth({ openai: 'sk-test' });
      process.chdir(plainDir);

      const { code, err } = await runMain([]);
      assert.strictEqual(code, 1);
      assert.match(err, /Not a git repository/);
    });

    it('exits 1 when no provider can be resolved', async () => {
      await writeValidConfig({ defaultProvider: '', providers: {} });

      const { code, err } = await runMain([]);
      assert.strictEqual(code, 1);
      assert.match(err, /No provider configured/);
    });

    it('exits 1 when the configured provider is unknown', async () => {
      await writeValidConfig({ defaultProvider: 'nope' });

      const { code, err } = await runMain([]);
      assert.strictEqual(code, 1);
      assert.match(err, /Unknown provider 'nope'/);
    });

    it('exits 1 when --provider names a provider that is not configured', async () => {
      await writeValidConfig();

      const { code, err } = await runMain(['--provider', 'nope']);
      assert.strictEqual(code, 1);
      assert.match(err, /Unknown provider 'nope'/);
    });

    it('exits 1 when the resolved provider has no API key', async () => {
      await writeValidConfig();

      const { code, err } = await runMain([]);
      assert.strictEqual(code, 1);
      assert.match(err, /No API key found for provider 'openai'/);
    });

    it('accepts an API key from the environment instead of the auth file', async () => {
      await writeValidConfig();
      process.env.KOMMIT_OPENAI_API_KEY = 'sk-from-env';

      // Past the key guard the flow needs a diff, so it stops on the empty repo instead.
      const { err } = await runMain([]);
      assert.doesNotMatch(err, /No API key found/);
    });

    it('does not require an API key for local providers', async () => {
      await writeValidConfig({
        defaultProvider: 'ollama',
        providers: { ollama: providerConfig({ endpoint: 'http://localhost:11434/api/chat' }) }
      });

      const { err } = await runMain([]);
      assert.doesNotMatch(err, /No API key found/);
    });
  });
});
