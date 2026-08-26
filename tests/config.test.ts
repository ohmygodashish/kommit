import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveProvider, resolveSkill, migrateConfig, getAvailableProviders } from '../src/config.ts';
import { config as makeConfig, flags, providerConfig, providers } from './fixtures.ts';

describe('config.ts', () => {
  describe('resolveProvider', () => {
    const config = makeConfig({
      defaultProvider: 'openrouter',
      providers: providers('openai', 'openrouter', 'ollama', 'lmstudio')
    });
    const auth = { openai: 'sk-xxx' };

    it('returns flag provider first', () => {
      const result = resolveProvider(config, flags({ provider: 'openai' }), {}, auth);
      assert.strictEqual(result, 'openai');
    });

    it('returns env provider second', () => {
      const result = resolveProvider(config, flags(), { KOMMIT_PROVIDER: 'ollama' }, auth);
      assert.strictEqual(result, 'ollama');
    });

    it('returns config default third', () => {
      const result = resolveProvider(config, flags(), {}, auth);
      assert.strictEqual(result, 'openrouter');
    });

    it('falls back to first provider with key', () => {
      const noDefault = { ...config, defaultProvider: '' };
      const result = resolveProvider(noDefault, flags(), {}, auth);
      assert.strictEqual(result, 'openai');
    });

    it('falls back to local provider when no keys', () => {
      const noDefault = { ...config, defaultProvider: '' };
      const result = resolveProvider(noDefault, flags(), {}, {});
      assert.ok(result === 'ollama' || result === 'lmstudio');
    });

    it('returns null when nothing configured', () => {
      const empty = makeConfig({ defaultProvider: '', providers: {} });
      assert.strictEqual(resolveProvider(empty, flags(), {}, {}), null);
    });
  });

  describe('resolveSkill', () => {
    const config = makeConfig({ skillName: 'base' });

    it('returns flag skill first', () => {
      assert.strictEqual(resolveSkill(config, flags({ skill: 'custom' }), {}), 'custom');
    });

    it('returns env skill second', () => {
      assert.strictEqual(resolveSkill(config, flags(), { KOMMIT_SKILL: 'env-skill' }), 'env-skill');
    });

    it('returns config skill third', () => {
      assert.strictEqual(resolveSkill(config, flags(), {}), 'base');
    });

    it('returns null when not set', () => {
      assert.strictEqual(resolveSkill(makeConfig({ skillName: null }), flags(), {}), null);
    });

    it('handles empty string as null', () => {
      assert.strictEqual(resolveSkill(makeConfig(), flags({ skill: '' }), {}), null);
    });
  });

  describe('migrateConfig', () => {
    it('fills defaults for v0 config', () => {
      const old = { providers: { openai: providerConfig({ model: 'custom' }) } };
      const { config, migrated, warning } = migrateConfig(old);
      assert.strictEqual(migrated, true);
      assert.strictEqual(config.version, 2);
      assert.strictEqual(config.providers.openai.model, 'custom');
      assert.ok(config.providers.anthropic);
      assert.ok(warning);
      assert.match(warning, /v0→v2/);
      assert.match(warning, /gemini-3\.1-flash/);
    });

    it('migrates v1 config to v2 and emits warning', () => {
      const old = { version: 1, defaultProvider: 'google' };
      const { config, migrated, warning } = migrateConfig(old);
      assert.strictEqual(migrated, true);
      assert.strictEqual(config.version, 2);
      assert.strictEqual(config.defaultProvider, 'google');
      assert.ok(warning);
      assert.match(warning, /v1→v2/);
      assert.match(warning, /gemini-3\.1-flash/);
    });

    it('does not migrate v2 config', () => {
      const current = { version: 2, defaultProvider: 'openai' };
      const { config, migrated, warning } = migrateConfig(current);
      assert.strictEqual(migrated, false);
      assert.strictEqual(config.defaultProvider, 'openai');
      assert.strictEqual(warning, null);
    });
  });

  describe('getAvailableProviders', () => {
    const config = makeConfig({
      providers: providers('openai', 'anthropic', 'google', 'openrouter', 'ollama', 'lmstudio')
    });

    it('returns providers with API keys', () => {
      const auth = { openai: 'sk-xxx', anthropic: 'sk-ant' };
      const result = getAvailableProviders(config, auth, {});
      assert.ok(result.includes('openai'));
      assert.ok(result.includes('anthropic'));
      assert.ok(!result.includes('google'));
    });

    it('includes providers with env API keys', () => {
      const auth = {};
      const env = { KOMMIT_OPENAI_API_KEY: 'env-key', KOMMIT_ANTHROPIC_API_KEY: 'env-ant' };
      const result = getAvailableProviders(config, auth, env);
      assert.ok(result.includes('openai'));
      assert.ok(result.includes('anthropic'));
      assert.ok(!result.includes('google'));
    });

    it('prefers either auth or env key (not both required)', () => {
      const auth = { openai: 'sk-xxx' };
      const env = { KOMMIT_ANTHROPIC_API_KEY: 'env-ant' };
      const result = getAvailableProviders(config, auth, env);
      assert.ok(result.includes('openai'));
      assert.ok(result.includes('anthropic'));
      assert.ok(!result.includes('google'));
    });

    it('includes local providers without keys', () => {
      const auth = {};
      const result = getAvailableProviders(config, auth, {});
      assert.ok(result.includes('ollama'));
      assert.ok(result.includes('lmstudio'));
      assert.ok(!result.includes('openai'));
    });

    it('returns empty array when no providers configured', () => {
      const result = getAvailableProviders(makeConfig({ providers: {} }), {}, {});
      assert.deepStrictEqual(result, []);
    });

    it('excludes providers missing from config', () => {
      const auth = { unknown: 'key' };
      const result = getAvailableProviders(config, auth, {});
      assert.ok(!result.includes('unknown'));
    });
  });
});
