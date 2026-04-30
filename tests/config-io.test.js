import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, rm, mkdir, access, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { loadConfig, saveConfig, saveAuth } from '../src/config.js';

describe('config.js I/O', () => {
  let baseConfigDir;
  let baseDataDir;
  let originalEnv;

  before(async () => {
    originalEnv = { ...process.env };
    baseConfigDir = await mkdtemp(join(tmpdir(), 'kommit-config-test-'));
    baseDataDir = await mkdtemp(join(tmpdir(), 'kommit-data-test-'));
  });

  after(async () => {
    Object.assign(process.env, originalEnv);
    await rm(baseConfigDir, { recursive: true, force: true });
    await rm(baseDataDir, { recursive: true, force: true });
  });

  // Use isolated subdirectories per test to avoid file pollution
  async function setupDirs() {
    const configDir = await mkdtemp(join(baseConfigDir, 'case-'));
    const dataDir = await mkdtemp(join(baseDataDir, 'case-'));
    process.env.XDG_CONFIG_HOME = configDir;
    process.env.XDG_DATA_HOME = dataDir;
    return { configDir, dataDir };
  }

  describe('loadConfig', () => {
    it('throws CONFIG_MISSING when config file does not exist', async () => {
      await setupDirs();
      await assert.rejects(
        async () => loadConfig(),
        err => err.code === 'CONFIG_MISSING'
      );
    });

    it('throws CONFIG_PARSE_ERROR when config is malformed JSON', async () => {
      const { configDir } = await setupDirs();
      const kommitDir = join(configDir, 'kommit');
      await mkdir(kommitDir, { recursive: true });
      await writeFile(join(kommitDir, 'config.json'), 'not json', { mode: 0o600 });

      await assert.rejects(
        async () => loadConfig(),
        err => err.code === 'CONFIG_PARSE_ERROR'
      );
    });

    it('loads config and empty auth when only config exists', async () => {
      const { configDir } = await setupDirs();
      const kommitDir = join(configDir, 'kommit');
      await mkdir(kommitDir, { recursive: true });
      await writeFile(join(kommitDir, 'config.json'), JSON.stringify({
        version: 1,
        defaultProvider: 'openai'
      }), { mode: 0o600 });

      const { config, auth } = await loadConfig();
      assert.strictEqual(config.defaultProvider, 'openai');
      assert.deepStrictEqual(auth, {});
    });

    it('loads both config and auth when both exist', async () => {
      const { configDir, dataDir } = await setupDirs();
      const cfgDir = join(configDir, 'kommit');
      const authDir = join(dataDir, 'kommit');
      await mkdir(cfgDir, { recursive: true });
      await mkdir(authDir, { recursive: true });

      await writeFile(join(cfgDir, 'config.json'), JSON.stringify({
        version: 1,
        defaultProvider: 'openai'
      }), { mode: 0o600 });

      await writeFile(join(authDir, 'auth.json'), JSON.stringify({
        openai: 'sk-test'
      }), { mode: 0o600 });

      const { config, auth } = await loadConfig();
      assert.strictEqual(config.defaultProvider, 'openai');
      assert.strictEqual(auth.openai, 'sk-test');
    });

    it('throws AUTH_PARSE_ERROR when auth is malformed', async () => {
      const { configDir, dataDir } = await setupDirs();
      const cfgDir = join(configDir, 'kommit');
      const authDir = join(dataDir, 'kommit');
      await mkdir(cfgDir, { recursive: true });
      await mkdir(authDir, { recursive: true });

      await writeFile(join(cfgDir, 'config.json'), JSON.stringify({ version: 1 }), { mode: 0o600 });
      await writeFile(join(authDir, 'auth.json'), 'not json', { mode: 0o600 });

      await assert.rejects(
        async () => loadConfig(),
        err => err.code === 'AUTH_PARSE_ERROR'
      );
    });

    it('migrates v0 config to current version', async () => {
      const { configDir } = await setupDirs();
      const cfgDir = join(configDir, 'kommit');
      await mkdir(cfgDir, { recursive: true });

      await writeFile(join(cfgDir, 'config.json'), JSON.stringify({
        defaultProvider: 'anthropic'
      }), { mode: 0o600 });

      const { config } = await loadConfig();
      assert.strictEqual(config.version, 1);
      assert.ok(config.providers);
      assert.strictEqual(config.defaultProvider, 'anthropic');
    });
  });

  describe('saveConfig', () => {
    it('writes config with correct permissions', async () => {
      const { configDir } = await setupDirs();
      const config = {
        version: 1,
        defaultProvider: 'openai',
        skillName: null,
        providers: {}
      };

      await saveConfig(config);

      const configPath = join(configDir, 'kommit', 'config.json');
      const content = await readFile(configPath, 'utf8');
      const parsed = JSON.parse(content);
      assert.strictEqual(parsed.defaultProvider, 'openai');
    });

    it('creates parent directories if missing', async () => {
      const { configDir } = await setupDirs();
      const config = { version: 1, defaultProvider: 'google' };
      await saveConfig(config);

      const configPath = join(configDir, 'kommit', 'config.json');
      await assert.doesNotReject(async () => access(configPath));
    });
  });

  describe('saveAuth', () => {
    it('writes auth with correct permissions', async () => {
      const { dataDir } = await setupDirs();
      const auth = { openai: 'sk-test' };
      await saveAuth(auth);

      const authPath = join(dataDir, 'kommit', 'auth.json');
      await assert.doesNotReject(async () => access(authPath));
    });
  });
});
