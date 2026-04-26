import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import { copyToClipboard, setSpawnForTesting } from '../src/clipboard.js';

function makeEnoent() {
  const err = new Error('ENOENT');
  err.code = 'ENOENT';
  return err;
}

function spawnFactory(behaviors) {
  let call = 0;
  const calls = [];

  return {
    spawn: (cmd, args, options) => {
      calls.push({ cmd, args });
      const behavior = behaviors[call] || behaviors[behaviors.length - 1];
      const child = new EventEmitter();
      child.stdin = {
        write: (data) => { calls[calls.length - 1].text = (calls[calls.length - 1].text || '') + data; },
        end: () => {}
      };
      call++;

      setImmediate(() => {
        if (behavior.errorEvent) {
          child.emit('error', behavior.errorEvent);
        } else {
          child.emit('close', behavior.exitCode);
        }
      });

      return child;
    },
    calls: () => calls,
  };
}

describe('clipboard.js', () => {
  describe('copyToClipboard', () => {
    it('uses pbcopy on darwin', async () => {
      const { spawn, calls } = spawnFactory([{ exitCode: 0 }]);
      setSpawnForTesting(spawn);
      await copyToClipboard('hello world', 'darwin');
      setSpawnForTesting(null);

      assert.deepStrictEqual(calls()[0].cmd, 'pbcopy');
    });

    it('uses clip.exe on win32', async () => {
      const { spawn, calls } = spawnFactory([{ exitCode: 0 }]);
      setSpawnForTesting(spawn);
      await copyToClipboard('hello world', 'win32');
      setSpawnForTesting(null);

      assert.deepStrictEqual(calls()[0].cmd, 'clip.exe');
    });

    it('writes text to stdin on success', async () => {
      const { spawn, calls } = spawnFactory([{ exitCode: 0 }]);
      setSpawnForTesting(spawn);
      await copyToClipboard('commit message text', 'darwin');
      setSpawnForTesting(null);

      assert.strictEqual(calls()[0].text, 'commit message text');
    });

    it('linux: resolves on first success (xclip)', async () => {
      const { spawn, calls } = spawnFactory([{ exitCode: 0 }]);
      setSpawnForTesting(spawn);
      await copyToClipboard('test', 'linux');
      setSpawnForTesting(null);

      assert.strictEqual(calls().length, 1);
      assert.strictEqual(calls()[0].cmd, 'xclip');
    });

    it('linux: falls through ENOENT to next tool', async () => {
      const err = makeEnoent();
      const { spawn, calls } = spawnFactory([
        { exitCode: 0, errorEvent: err },
        { exitCode: 0 },
      ]);
      setSpawnForTesting(spawn);
      await copyToClipboard('test', 'linux');
      setSpawnForTesting(null);

      assert.strictEqual(calls().length, 2);
      assert.strictEqual(calls()[0].cmd, 'xclip');
      assert.strictEqual(calls()[1].cmd, 'xsel');
    });

    it('linux: falls through non-zero exit to next tool', async () => {
      const { spawn, calls } = spawnFactory([
        { exitCode: 1 },
        { exitCode: 0 },
      ]);
      setSpawnForTesting(spawn);
      await copyToClipboard('test', 'linux');
      setSpawnForTesting(null);

      assert.strictEqual(calls().length, 2);
      assert.strictEqual(calls()[0].cmd, 'xclip');
      assert.strictEqual(calls()[1].cmd, 'xsel');
    });

    it('linux: tries wl-copy when xclip and xsel both fail', async () => {
      const { spawn, calls } = spawnFactory([
        { exitCode: 1 },
        { exitCode: 1 },
        { exitCode: 0 },
      ]);
      setSpawnForTesting(spawn);
      await copyToClipboard('test', 'linux');
      setSpawnForTesting(null);

      assert.strictEqual(calls().length, 3);
      assert.strictEqual(calls()[0].cmd, 'xclip');
      assert.strictEqual(calls()[1].cmd, 'xsel');
      assert.strictEqual(calls()[2].cmd, 'wl-copy');
    });

    it('linux: throws when all tools are missing (ENOENT)', async () => {
      const err = makeEnoent();
      const { spawn } = spawnFactory([
        { exitCode: 0, errorEvent: err },
        { exitCode: 0, errorEvent: err },
        { exitCode: 0, errorEvent: err },
      ]);
      setSpawnForTesting(spawn);

      await assert.rejects(
        () => copyToClipboard('test', 'linux'),
        (e) => {
          return e.message.includes('Clipboard not available') &&
            e.message.includes('xclip:') &&
            e.message.includes('xsel:') &&
            e.message.includes('wl-copy:');
        }
      );
      setSpawnForTesting(null);
    });

    it('linux: throws when all tools fail with non-zero exit', async () => {
      const { spawn } = spawnFactory([
        { exitCode: 1 },
        { exitCode: 1 },
        { exitCode: 1 },
      ]);
      setSpawnForTesting(spawn);

      await assert.rejects(
        () => copyToClipboard('test', 'linux'),
        (e) => {
          return e.message.includes('Clipboard not available') &&
            e.message.includes('xclip exited with code 1') &&
            e.message.includes('xsel exited with code 1') &&
            e.message.includes('wl-copy exited with code 1');
        }
      );
      setSpawnForTesting(null);
    });

    it('linux: throws with mixed error details', async () => {
      const enoent = makeEnoent();
      const { spawn } = spawnFactory([
        { exitCode: 0, errorEvent: enoent },
        { exitCode: 1 },
        { exitCode: 1 },
      ]);
      setSpawnForTesting(spawn);

      await assert.rejects(
        () => copyToClipboard('test', 'linux'),
        (e) => {
          return e.message.includes('Clipboard not available') &&
            e.message.includes('xclip: ENOENT') &&
            e.message.includes('xsel exited with code 1') &&
            e.message.includes('wl-copy exited with code 1');
        }
      );
      setSpawnForTesting(null);
    });
  });
});
