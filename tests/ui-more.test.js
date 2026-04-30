import { describe, it } from 'node:test';
import assert from 'node:assert';
import { promptAction, withSpinner, setSelectForTesting } from '../src/ui.js';

describe('ui.js — additional coverage', () => {
  describe('promptAction', () => {
    it('returns use for staged diff', async () => {
      let capturedOptions;
      setSelectForTesting((opts) => {
        capturedOptions = opts;
        return 'use';
      });

      const result = await promptAction(
        { subject: 'feat: add auth', body: '' },
        false,
        'staged'
      );
      setSelectForTesting(null);

      assert.strictEqual(result, 'use');
      const labels = capturedOptions.options.map(o => o.label);
      assert.ok(labels.some(l => l.includes('[u]')));
      assert.ok(!labels.some(l => l.includes('[s]')));
    });

    it('returns stageAndUse for unstaged diff', async () => {
      let capturedOptions;
      setSelectForTesting((opts) => {
        capturedOptions = opts;
        return 'stageAndUse';
      });

      const result = await promptAction(
        { subject: 'feat: add auth', body: '' },
        false,
        'unstaged'
      );
      setSelectForTesting(null);

      assert.strictEqual(result, 'stageAndUse');
      const labels = capturedOptions.options.map(o => o.label);
      assert.ok(labels.some(l => l.includes('[s]')));
      assert.ok(!labels.some(l => l.includes('[u]')));
    });

    it('shows truncated warning when diff was truncated', async () => {
      setSelectForTesting(() => 'cancel');
      // We can't easily capture console output, but we can at least verify it doesn't throw
      await assert.doesNotReject(async () =>
        promptAction({ subject: 'feat: x', body: '' }, true, 'staged')
      );
      setSelectForTesting(null);
    });

    it('returns cancel on isCancel', async () => {
      setSelectForTesting(() => Symbol('cancel'), () => true);
      const result = await promptAction({ subject: 'feat: x', body: '' }, false, 'staged');
      setSelectForTesting(null);
      assert.strictEqual(result, 'cancel');
    });
  });

  describe('withSpinner', () => {
    it('resolves with the promise result', async () => {
      const result = await withSpinner(Promise.resolve('ok'), 'Testing...');
      assert.strictEqual(result, 'ok');
    });

    it('rethrows when the promise rejects', async () => {
      await assert.rejects(
        async () => withSpinner(Promise.reject(new Error('fail')), 'Testing...'),
        err => err.message === 'fail'
      );
    });
  });
});
