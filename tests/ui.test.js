import { describe, it } from 'node:test';
import assert from 'node:assert';
import { promptError, promptSelectProvider, promptMultiCommitPlan, promptSelectCommits, promptSelectCommitToEdit, editMessage, setSelectForTesting } from '../src/ui.js';

describe('ui.js', () => {
  describe('promptError', () => {
    it('returns retry when user selects retry', async () => {
      setSelectForTesting(() => 'retry');
      const result = await promptError(new Error('timeout'), true, ['openai']);
      setSelectForTesting(null);
      assert.strictEqual(result, 'retry');
    });

    it('returns cancel when user selects cancel', async () => {
      setSelectForTesting(() => 'cancel');
      const result = await promptError(new Error('timeout'), true, ['openai']);
      setSelectForTesting(null);
      assert.strictEqual(result, 'cancel');
    });

    it('returns switch when user selects switch', async () => {
      setSelectForTesting(() => 'switch');
      const result = await promptError(new Error('timeout'), true, ['openai']);
      setSelectForTesting(null);
      assert.strictEqual(result, 'switch');
    });

    it('shows switch option only when availableProviders is non-empty', async () => {
      let capturedOptions;
      setSelectForTesting((opts) => {
        capturedOptions = opts;
        return 'cancel';
      });

      await promptError(new Error('timeout'), true, ['openai']);
      setSelectForTesting(null);

      const values = capturedOptions.options.map(o => o.value);
      assert.ok(values.includes('switch'));
    });

    it('hides switch option when availableProviders is empty', async () => {
      let capturedOptions;
      setSelectForTesting((opts) => {
        capturedOptions = opts;
        return 'cancel';
      });

      await promptError(new Error('timeout'), true, []);
      setSelectForTesting(null);

      const values = capturedOptions.options.map(o => o.value);
      assert.ok(!values.includes('switch'));
    });

    it('hides retry option when canRetry is false', async () => {
      let capturedOptions;
      setSelectForTesting((opts) => {
        capturedOptions = opts;
        return 'cancel';
      });

      await promptError(new Error('bad request'), false, ['openai']);
      setSelectForTesting(null);

      const values = capturedOptions.options.map(o => o.value);
      assert.ok(!values.includes('retry'));
    });

    it('returns cancel on isCancel', async () => {
      setSelectForTesting(() => Symbol('cancel'), () => true);
      const result = await promptError(new Error('timeout'), true, ['openai']);
      setSelectForTesting(null);
      assert.strictEqual(result, 'cancel');
    });

    it('always shows cancel option', async () => {
      let capturedOptions;
      setSelectForTesting((opts) => {
        capturedOptions = opts;
        return 'cancel';
      });

      await promptError(new Error('timeout'), false, []);
      setSelectForTesting(null);

      const values = capturedOptions.options.map(o => o.value);
      assert.ok(values.includes('cancel'));
    });
  });

  describe('promptSelectProvider', () => {
    it('returns selected provider', async () => {
      setSelectForTesting(() => 'openai');
      const result = await promptSelectProvider(['openai', 'anthropic']);
      setSelectForTesting(null);
      assert.strictEqual(result, 'openai');
    });

    it('returns null on cancel', async () => {
      setSelectForTesting(() => Symbol('cancel'), () => true);
      const result = await promptSelectProvider(['openai', 'anthropic']);
      setSelectForTesting(null);
      assert.strictEqual(result, null);
    });

    it('passes all providers as options', async () => {
      let capturedOptions;
      setSelectForTesting((opts) => {
        capturedOptions = opts;
        return 'anthropic';
      });

      await promptSelectProvider(['openai', 'anthropic', 'google']);
      setSelectForTesting(null);

      const values = capturedOptions.options.map(o => o.value);
      assert.deepStrictEqual(values, ['openai', 'anthropic', 'google']);
    });
  });

  describe('promptMultiCommitPlan', () => {
    it('returns acceptAll when selected', async () => {
      setSelectForTesting(() => 'acceptAll');
      const result = await promptMultiCommitPlan([{ subject: 'feat: add x', body: '', files: ['src/x.js'] }], false);
      setSelectForTesting(null);
      assert.strictEqual(result, 'acceptAll');
    });
  });

  describe('promptSelectCommits', () => {
    it('returns selected commit indexes', async () => {
      setSelectForTesting(null, null, () => [0, 2]);
      const result = await promptSelectCommits([
        { subject: 'feat: one', files: ['a.js'] },
        { subject: 'fix: two', files: ['b.js'] },
        { subject: 'test: three', files: ['c.js'] }
      ]);
      setSelectForTesting(null);
      assert.deepStrictEqual(result, [0, 2]);
    });

    it('returns null on cancel', async () => {
      setSelectForTesting(null, () => true, () => Symbol('cancel'));
      const result = await promptSelectCommits([{ subject: 'feat: one', files: ['a.js'] }]);
      setSelectForTesting(null);
      assert.strictEqual(result, null);
    });
  });

  describe('promptSelectCommitToEdit', () => {
    it('returns the selected commit index', async () => {
      setSelectForTesting(() => 1);
      const result = await promptSelectCommitToEdit([
        { subject: 'feat: one', files: ['a.js'] },
        { subject: 'fix: two', files: ['b.js'] }
      ]);
      setSelectForTesting(null);
      assert.strictEqual(result, 1);
    });
  });

  describe('editMessage', () => {
    it('edits subject and body through test overrides', async () => {
      const inputs = ['feat: edited', 'body line 1\\nbody line 2'];
      setSelectForTesting(null, null, null, () => inputs.shift());
      const result = await editMessage({ subject: 'feat: original', body: '' });
      setSelectForTesting(null);
      assert.deepStrictEqual(result, {
        subject: 'feat: edited',
        body: 'body line 1\nbody line 2'
      });
    });
  });
});
