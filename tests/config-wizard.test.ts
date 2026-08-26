import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, readFile, mkdir, rm, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { runInitWizard, runSetWizard, setPromptsForTesting } from '../src/config.ts';
import type { Config, ProviderConfig } from '../src/types.ts';

type Overrides = NonNullable<Parameters<typeof setPromptsForTesting>[0]>;

/** A scripted prompt stub that also records the options it was called with. */
interface Stub {
  (opts: any): Promise<any>;
  calls: any[];
}

const CANCEL = Symbol('cancel');

// The seam types exit as `never`, so a stub has to throw. That is exactly what production
// does to control flow, and it means a test can never silently run past an exit.
class ExitSignal extends Error {
  code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function exit(code: number): never {
  throw new ExitSignal(code);
}

// Answers each prompt in order, and refuses to invent an answer nobody scripted.
function queue(values: unknown[]): Stub {
  const remaining = [...values];
  const fn = (async (opts: any) => {
    fn.calls.push(opts);
    if (remaining.length === 0) {
      throw new Error('prompt called more times than the test scripted');
    }
    return remaining.shift();
  }) as Stub;
  fn.calls = [];
  return fn;
}

function isCancel(value: unknown): value is symbol {
  return value === CANCEL;
}

// intro/outro write ANSI sequences to stdout, which corrupts the test runner's IPC on the
// same stream. Every test goes through here so none can forget to silence them.
function overrides(extra: Overrides = {}): Overrides {
  return { intro() {}, outro() {}, isCancel, exit, ...extra };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('config.ts wizards', () => {
  let baseDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let configPath: string;
  let authPath: string;

  before(async () => {
    originalEnv = { ...process.env };
    baseDir = await mkdtemp(join(tmpdir(), 'kommit-wizard-test-'));
  });

  after(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    setPromptsForTesting(null);
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    setPromptsForTesting(null);
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('KOMMIT_')) delete process.env[key];
    }
    const configDir = await mkdtemp(join(baseDir, 'config-'));
    const dataDir = await mkdtemp(join(baseDir, 'data-'));
    process.env.XDG_CONFIG_HOME = configDir;
    process.env.XDG_DATA_HOME = dataDir;
    configPath = join(configDir, 'kommit', 'config.json');
    authPath = join(dataDir, 'kommit', 'auth.json');
  });

  async function readJson(path: string): Promise<any> {
    return JSON.parse(await readFile(path, 'utf8'));
  }

  describe('runInitWizard', () => {
    it('writes config and auth from the entered key', async () => {
      setPromptsForTesting(overrides({
        select: queue(['openai']),
        password: queue(['sk-typed'])
      }));

      await runInitWizard();

      assert.strictEqual((await readJson(configPath)).defaultProvider, 'openai');
      assert.strictEqual((await readJson(authPath)).openai, 'sk-typed');
    });

    it('reuses the environment key when confirmed, without prompting', async () => {
      process.env.KOMMIT_OPENAI_API_KEY = 'sk-from-env';
      const password = queue([]);
      setPromptsForTesting(overrides({
        select: queue(['openai']),
        confirm: queue([true]),
        password
      }));

      await runInitWizard();

      assert.strictEqual((await readJson(authPath)).openai, 'sk-from-env');
      assert.strictEqual(password.calls.length, 0);
    });

    it('falls back to prompting when the environment key is declined', async () => {
      process.env.KOMMIT_OPENAI_API_KEY = 'sk-from-env';
      setPromptsForTesting(overrides({
        select: queue(['openai']),
        confirm: queue([false]),
        password: queue(['sk-typed'])
      }));

      await runInitWizard();

      assert.strictEqual((await readJson(authPath)).openai, 'sk-typed');
    });

    it('writes no auth file for a local provider', async () => {
      setPromptsForTesting(overrides({
        select: queue(['ollama']),
        password: queue([])
      }));

      await runInitWizard();

      assert.strictEqual((await readJson(configPath)).defaultProvider, 'ollama');
      assert.strictEqual(await exists(authPath), false);
    });

    it('exits 0 and writes nothing when cancelled', async () => {
      setPromptsForTesting(overrides({ select: queue([CANCEL]) }));

      await assert.rejects(
        async () => runInitWizard(),
        err => err instanceof ExitSignal && err.code === 0
      );

      assert.strictEqual(await exists(configPath), false);
      assert.strictEqual(await exists(authPath), false);
    });

    it('keeps an existing config but still records the new key', async () => {
      await mkdir(join(configPath, '..'), { recursive: true });
      await writeFile(configPath, JSON.stringify({
        version: 2,
        defaultProvider: 'google',
        skillName: null,
        providers: {}
      }));

      setPromptsForTesting(overrides({
        select: queue(['openai']),
        password: queue(['sk-typed'])
      }));

      await runInitWizard();

      assert.strictEqual((await readJson(configPath)).defaultProvider, 'google');
      assert.strictEqual((await readJson(authPath)).openai, 'sk-typed');
    });
  });

  describe('runSetWizard', () => {
    function baseConfig(providers: Record<string, ProviderConfig>): Config {
      return {
        version: 2,
        defaultProvider: 'openai',
        skillName: null,
        providers
      };
    }

    const twoProviders = () => ({
      openai: { model: 'gpt-x', endpoint: 'https://o', maxDiffLength: 12000, timeout: 30000 },
      anthropic: { model: 'claude-x', endpoint: 'https://a', maxDiffLength: 12000, timeout: 30000 }
    });

    it('updates the default provider and its model', async () => {
      const config = baseConfig(twoProviders());
      setPromptsForTesting(overrides({
        select: queue(['defaultProvider', 'anthropic']),
        text: queue(['claude-haiku-4-5'])
      }));

      await runSetWizard(config, { openai: 'k1', anthropic: 'k2' });

      const saved = await readJson(configPath);
      assert.strictEqual(saved.defaultProvider, 'anthropic');
      assert.strictEqual(saved.providers.anthropic.model, 'claude-haiku-4-5');
      assert.strictEqual(saved.providers.anthropic.endpoint, 'https://a');
    });

    it('offers only providers that have a key or are local', async () => {
      const config = baseConfig(twoProviders());
      const select = queue(['defaultProvider', 'openai']);
      setPromptsForTesting(overrides({ select, text: queue(['gpt-y']) }));

      await runSetWizard(config, { openai: 'k1' });

      const offered = select.calls[1].options.map((o: any) => o.value);
      assert.deepStrictEqual(offered, ['openai']);
    });

    it('sets the skill name, and an empty value clears it', async () => {
      const config = baseConfig(twoProviders());

      setPromptsForTesting(overrides({ select: queue(['skillName']), text: queue(['my-skill']) }));
      await runSetWizard(config, {});
      assert.strictEqual((await readJson(configPath)).skillName, 'my-skill');

      setPromptsForTesting(overrides({ select: queue(['skillName']), text: queue(['   ']) }));
      await runSetWizard(config, {});
      assert.strictEqual((await readJson(configPath)).skillName, null);
    });

    it('exits 1 when no provider has a key', async () => {
      const config = baseConfig({
        openai: { model: 'gpt-x', endpoint: 'https://o', maxDiffLength: 12000, timeout: 30000 }
      });
      setPromptsForTesting(overrides({ select: queue(['defaultProvider']) }));

      await assert.rejects(
        async () => runSetWizard(config, {}),
        err => err instanceof ExitSignal && err.code === 1
      );
    });

    it('exits 0 when cancelled at the setting prompt', async () => {
      const config = baseConfig(twoProviders());
      setPromptsForTesting(overrides({ select: queue([CANCEL]) }));

      await assert.rejects(
        async () => runSetWizard(config, { openai: 'k1' }),
        err => err instanceof ExitSignal && err.code === 0
      );
      assert.strictEqual(await exists(configPath), false);
    });
  });
});
