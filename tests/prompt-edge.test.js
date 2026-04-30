import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseMultiResponse } from '../src/prompt.js';

describe('prompt.js — multi-commit edge cases', () => {
  describe('parseMultiResponse', () => {
    it('throws when commit shape is invalid (missing files array)', () => {
      const raw = JSON.stringify({
        commits: [
          { subject: 'feat: bad', body: '' }
        ]
      });

      assert.throws(() => parseMultiResponse(raw, ['a.js']), { code: 'PARSE_ERROR' });
    });

    it('throws when file entry is an empty string', () => {
      const raw = JSON.stringify({
        commits: [
          { files: ['a.js', ''], subject: 'feat: bad', body: '' }
        ]
      });

      assert.throws(() => parseMultiResponse(raw, ['a.js', '']), { code: 'PARSE_ERROR' });
    });

    it('throws when a file is referenced that is not in allowedFiles', () => {
      const raw = JSON.stringify({
        commits: [
          { files: ['a.js', 'unexpected.js'], subject: 'feat: bad', body: '' }
        ]
      });

      assert.throws(() => parseMultiResponse(raw, ['a.js']), { code: 'PARSE_ERROR' });
    });

    it('throws when commits array is empty', () => {
      const raw = JSON.stringify({ commits: [] });
      assert.throws(() => parseMultiResponse(raw, ['a.js']), { code: 'PARSE_ERROR' });
    });

    it('does not validate file coverage when allowedFiles is null', () => {
      const raw = JSON.stringify({
        commits: [
          { files: ['a.js'], subject: 'feat: add a', body: '' }
        ]
      });

      const result = parseMultiResponse(raw, null);
      assert.strictEqual(result.length, 1);
    });

    it('throws when a commit has no files', () => {
      const raw = JSON.stringify({
        commits: [
          { files: [], subject: 'feat: empty', body: '' }
        ]
      });

      assert.throws(() => parseMultiResponse(raw, null), { code: 'PARSE_ERROR' });
    });
  });
});
