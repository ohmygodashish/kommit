import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseArgs } from '../src/args.ts';

describe('args.ts', () => {
  describe('parseArgs', () => {
    it('parses --undo flag without count', () => {
      const flags = parseArgs(['--undo']);
      assert.strictEqual(flags.undo, true);
      assert.strictEqual(flags.undoCount, 1);
    });

    it('parses --undo flag with count', () => {
      const flags = parseArgs(['--undo', '3']);
      assert.strictEqual(flags.undo, true);
      assert.strictEqual(flags.undoCount, 3);
    });

    it('parses --undo flag with count and other flags', () => {
      const flags = parseArgs(['--undo', '5', '--verbose']);
      assert.strictEqual(flags.undo, true);
      assert.strictEqual(flags.undoCount, 5);
      assert.strictEqual(flags.verbose, true);
    });

    it('defaults undo to false and undoCount to 1', () => {
      const flags = parseArgs([]);
      assert.strictEqual(flags.undo, false);
      assert.strictEqual(flags.undoCount, 1);
    });

    it('does not parse non-numeric argument as count', () => {
      const flags = parseArgs(['--undo', '--verbose']);
      assert.strictEqual(flags.undo, true);
      assert.strictEqual(flags.undoCount, 1);
      assert.strictEqual(flags.verbose, true);
    });

    it('parses --undo with zero', () => {
      const flags = parseArgs(['--undo', '0']);
      assert.strictEqual(flags.undo, true);
      assert.strictEqual(flags.undoCount, 0);
    });
  });

  describe('parseArgs rejects bad input', () => {
    it('throws on an unknown option', () => {
      assert.throws(() => parseArgs(['--nope']), /unknown option '--nope'/);
    });

    it('suggests the right flag when only the hyphens are wrong', () => {
      assert.throws(() => parseArgs(['--dryrun']), /Did you mean '--dry-run'\?/);
      assert.throws(() => parseArgs(['-verbose']), /Did you mean '--verbose'\?/);
    });

    it('points at --help when nothing is close', () => {
      assert.throws(() => parseArgs(['--zzz']), /kommit --help/);
    });

    it('throws when --provider is missing its value', () => {
      assert.throws(() => parseArgs(['--provider']), /'--provider' requires a value/);
    });

    it('throws when --provider swallows the next flag', () => {
      assert.throws(() => parseArgs(['--provider', '--verbose']), /'--provider' requires a value/);
    });

    it('throws when --skill is missing its value', () => {
      assert.throws(() => parseArgs(['--skill']), /'--skill' requires a value/);
      assert.throws(() => parseArgs(['--skill', '--dry-run']), /'--skill' requires a value/);
    });

    it('throws on an unexpected positional argument', () => {
      assert.throws(() => parseArgs(['fix-stuff']), /unexpected argument 'fix-stuff'/);
    });
  });

  describe('parseArgs accepts valid input', () => {
    it('parses options that take a value', () => {
      const flags = parseArgs(['--provider', 'ollama', '--skill', 'terse']);
      assert.strictEqual(flags.provider, 'ollama');
      assert.strictEqual(flags.skill, 'terse');
    });

    it('parses short forms', () => {
      assert.strictEqual(parseArgs(['-h']).help, true);
      assert.strictEqual(parseArgs(['-v']).version, true);
    });

    it('parses every long flag', () => {
      const flags = parseArgs(['--init', '--set', '--multi', '--dry-run', '--verbose', '--help', '--version']);
      assert.deepStrictEqual(
        [flags.init, flags.set, flags.multi, flags.dryRun, flags.verbose, flags.help, flags.version],
        [true, true, true, true, true, true, true]
      );
    });
  });
});
