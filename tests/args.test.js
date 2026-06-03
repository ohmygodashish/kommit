import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseArgs } from '../src/args.js';

describe('args.js', () => {
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
});
