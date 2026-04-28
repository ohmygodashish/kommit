import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveProvider, resolveSkill, migrateConfig, getAvailableProviders } from '../src/config.js';

describe('config.js', () => {
  describe('resolveProvider', () => {
    const config = {
      defaultProvider: 'openrouter',
      providers: { openai: {}, openrouter: {}, ollama: {}, lmstudio: {} }
    };
    const auth = { openai: 'sk-xxx' };

    it('returns flag provider first', () => {
      const result = resolveProvider(config, { provider: 'openai' }, {}, auth);
      assert.strictEqual(result, 'openai');
    });

    it('returns env provider second', () => {
      const result = resolveProvider(config, {}, { KOMMIT_PROVIDER: 'ollama' }, auth);
      assert.strictEqual(result, 'ollama');
    });

    it('returns config default third', () => {
      const result = resolveProvider(config, {}, {}, auth);
      assert.strictEqual(result, 'openrouter');
    });

    it('falls back to first provider with key', () => {
      const noDefault = { ...config, defaultProvider: null };
      const result = resolveProvider(noDefault, {}, {}, auth);
      assert.strictEqual(result, 'openai');
    });

    it('falls back to local provider when no keys', () => {
      const noDefault = { ...config, defaultProvider: null };
      const result = resolveProvider(noDefault, {}, {}, {});
      assert.ok(result === 'ollama' || result === 'lmstudio');
    });

    it('returns null when nothing configured', () => {
      const empty = { providers: {} };
      assert.strictEqual(resolveProvider(empty, {}, {}, {}), null);
    });
  });

  describe('resolveSkill', () => {
    const config = { skillName: 'base' };

    it('returns flag skill first', () => {
      assert.strictEqual(resolveSkill(config, { skill: 'custom' }, {}), 'custom');
    });

    it('returns env skill second', () => {
      assert.strictEqual(resolveSkill(config, {}, { KOMMIT_SKILL: 'env-skill' }), 'env-skill');
    });

    it('returns config skill third', () => {
      assert.strictEqual(resolveSkill(config, {}, {}), 'base');
    });

    it('returns null when not set', () => {
      assert.strictEqual(resolveSkill({ skillName: null }, {}, {}), null);
    });

    it('handles empty string as null', () => {
      assert.strictEqual(resolveSkill({}, { skill: '' }, {}), null);
    });
  });

  describe('migrateConfig', () => {
    it('fills defaults for v0 config', () => {
      const old = { providers: { openai: { model: 'custom' } } };
      const { config, migrated } = migrateConfig(old);
      assert.strictEqual(migrated, true);
      assert.strictEqual(config.version, 1);
      assert.strictEqual(config.providers.openai.model, 'custom');
      assert.ok(config.providers.anthropic);
    });

    it('does not migrate v1 config', () => {
      const current = { version: 1, defaultProvider: 'openai' };
      const { config, migrated } = migrateConfig(current);
      assert.strictEqual(migrated, false);
      assert.strictEqual(config.defaultProvider, 'openai');
    });
  });

  describe('getAvailableProviders', () => {
    const config = {
      providers: { openai: {}, anthropic: {}, google: {}, openrouter: {}, ollama: {}, lmstudio: {} }
    };

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
      const result = getAvailableProviders({ providers: {} }, {}, {});
      assert.deepStrictEqual(result, []);
    });

    it('excludes providers missing from config', () => {
      const auth = { unknown: 'key' };
      const result = getAvailableProviders(config, auth, {});
      assert.ok(!result.includes('unknown'));
    });
  });
});
