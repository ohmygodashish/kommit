import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseArgs, getApiKey, getVersion } from '../src/args.js';

describe('index.js', () => {
  describe('parseArgs', () => {
    it('parses --init', () => {
      const flags = parseArgs(['--init']);
      assert.strictEqual(flags.init, true);
      assert.strictEqual(flags.set, false);
    });

    it('parses --set', () => {
      const flags = parseArgs(['--set']);
      assert.strictEqual(flags.set, true);
    });

    it('parses --provider with value', () => {
      const flags = parseArgs(['--provider', 'anthropic']);
      assert.strictEqual(flags.provider, 'anthropic');
    });

    it('parses --skill with value', () => {
      const flags = parseArgs(['--skill', 'my-team']);
      assert.strictEqual(flags.skill, 'my-team');
    });

    it('parses --dry-run', () => {
      const flags = parseArgs(['--dry-run']);
      assert.strictEqual(flags.dryRun, true);
    });

    it('parses --verbose', () => {
      const flags = parseArgs(['--verbose']);
      assert.strictEqual(flags.verbose, true);
    });

    it('parses --help', () => {
      const flags = parseArgs(['--help']);
      assert.strictEqual(flags.help, true);
      assert.strictEqual(flags.init, false);
    });

    it('parses -h alias', () => {
      const flags = parseArgs(['-h']);
      assert.strictEqual(flags.help, true);
    });

    it('parses --version', () => {
      const flags = parseArgs(['--version']);
      assert.strictEqual(flags.version, true);
    });

    it('parses -v alias', () => {
      const flags = parseArgs(['-v']);
      assert.strictEqual(flags.version, true);
    });

    it('ignores unknown flags', () => {
      const flags = parseArgs(['--unknown', '--provider', 'openai']);
      assert.strictEqual(flags.provider, 'openai');
      assert.strictEqual(flags.init, false);
    });

    it('parses multiple flags', () => {
      const flags = parseArgs(['--init', '--verbose', '--provider', 'google']);
      assert.strictEqual(flags.init, true);
      assert.strictEqual(flags.verbose, true);
      assert.strictEqual(flags.provider, 'google');
    });
  });

  describe('getApiKey', () => {
    it('returns env var key when present', () => {
      const key = getApiKey('openai', {}, { KOMMIT_OPENAI_API_KEY: 'env-key' });
      assert.strictEqual(key, 'env-key');
    });

    it('returns auth key when no env var', () => {
      const key = getApiKey('anthropic', { anthropic: 'auth-key' }, {});
      assert.strictEqual(key, 'auth-key');
    });

    it('prefers env over auth', () => {
      const key = getApiKey(
        'openai',
        { openai: 'auth-key' },
        { KOMMIT_OPENAI_API_KEY: 'env-key' }
      );
      assert.strictEqual(key, 'env-key');
    });

    it('returns empty string when no key', () => {
      const key = getApiKey('google', {}, {});
      assert.strictEqual(key, '');
    });
  });

  describe('getVersion', () => {
    it('returns version from package.json', async () => {
      const version = await getVersion();
      assert.strictEqual(typeof version, 'string');
      assert.ok(version.match(/^\d+\.\d+\.\d+/));
    });
  });
});
