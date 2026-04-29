import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseResponse, parseMultiResponse, validateSubject, buildPrompt, buildMultiCommitPrompt } from '../src/prompt.js';
import { writeFile, mkdir, rm } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

describe('prompt.js', () => {
  describe('parseResponse', () => {
    it('parses clean JSON', () => {
      const raw = '{"subject": "feat: add auth", "body": "Adds JWT validation"}';
      const result = parseResponse(raw);
      assert.strictEqual(result.subject, 'feat: add auth');
      assert.strictEqual(result.body, 'Adds JWT validation');
    });

    it('strips ```json fence', () => {
      const raw = '```json\n{"subject": "fix: bug", "body": ""}\n```';
      const result = parseResponse(raw);
      assert.strictEqual(result.subject, 'fix: bug');
      assert.strictEqual(result.body, '');
    });

    it('strips plain ``` fence', () => {
      const raw = '```\n{"subject": "chore: update deps", "body": ""}\n```';
      const result = parseResponse(raw);
      assert.strictEqual(result.subject, 'chore: update deps');
    });

    it('throws on invalid JSON', () => {
      assert.throws(() => parseResponse('not json'), { code: 'PARSE_ERROR' });
    });

    it('throws when subject is missing', () => {
      assert.throws(() => parseResponse('{"body": "only body"}'), { code: 'PARSE_ERROR' });
    });

    it('throws when body is missing', () => {
      assert.throws(() => parseResponse('{"subject": "feat: x"}'), { code: 'PARSE_ERROR' });
    });
  });

  describe('validateSubject', () => {
    it('accepts valid conventional commits', () => {
      assert.strictEqual(validateSubject('feat: add feature'), true);
      assert.strictEqual(validateSubject('fix(scope): fix bug'), true);
      assert.strictEqual(validateSubject('feat!: breaking change'), true);
      assert.strictEqual(validateSubject('refactor(ci): update pipeline'), true);
    });

    it('rejects invalid subjects', () => {
      assert.strictEqual(validateSubject('not-a-type: invalid'), false);
      assert.strictEqual(validateSubject('feat no colon'), false);
      assert.strictEqual(validateSubject('feat: '), false);
      assert.strictEqual(validateSubject('feat(a b): spaced scope'), false);
    });

    it('rejects subjects with description over 72 chars', () => {
      const long = 'feat: ' + 'x'.repeat(73);
      assert.strictEqual(validateSubject(long), false);
    });

    it('accepts subjects at exactly 72 description chars', () => {
      const exact = 'feat: ' + 'x'.repeat(72);
      assert.strictEqual(validateSubject(exact), true);
    });
  });

  describe('buildPrompt', () => {
    const skillBaseDir = join(homedir(), '.agents', 'skills');

    it('returns system and user prompts', async () => {
      const config = { _resolvedSkill: null };
      const result = await buildPrompt('some diff', config);
      assert.strictEqual(typeof result.system, 'string');
      assert.ok(result.system.includes('Conventional Commits'));
      assert.ok(result.user.includes('--- BEGIN GIT DIFF ---'));
      assert.ok(result.user.includes('some diff'));
      assert.strictEqual(result.warning, null);
    });

    it('appends skill content when skill is set', async () => {
      const skillDir = join(skillBaseDir, 'test-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), 'Always use present tense.');

      try {
        const config = { _resolvedSkill: 'test-skill' };
        const result = await buildPrompt('diff', config);
        assert.ok(result.system.includes('Always use present tense.'));
        assert.ok(result.system.includes('</skill>'));
        assert.strictEqual(result.warning, null);
      } finally {
        await rm(skillDir, { recursive: true, force: true });
      }
    });

    it('warns when skill file is missing', async () => {
      const config = { _resolvedSkill: 'missing-skill-xyz' };
      const result = await buildPrompt('diff', config);
      assert.ok(result.warning.includes("Skill 'missing-skill-xyz' not found"));
      assert.ok(result.warning.includes('Using base prompt'));
    });
  });

  describe('buildMultiCommitPrompt', () => {
    it('includes the file list and multi-commit instructions', async () => {
      const config = { _resolvedSkill: null };
      const result = await buildMultiCommitPrompt('diff body', [
        { status: 'M ', displayPath: 'src/index.js' },
        { status: '??', displayPath: 'tests/new.test.js' }
      ], config);

      assert.ok(result.system.includes('Split the changes into multiple logical commits'));
      assert.ok(result.user.includes('BEGIN FILE LIST'));
      assert.ok(result.user.includes('[M ] src/index.js'));
      assert.ok(result.user.includes('[??] tests/new.test.js'));
    });
  });

  describe('parseMultiResponse', () => {
    it('parses a valid multi-commit response', () => {
      const raw = JSON.stringify({
        commits: [
          { files: ['src/index.js'], subject: 'feat: add multi mode', body: '' },
          { files: ['tests/index.test.js'], subject: 'test: cover multi mode', body: 'Adds regression coverage' }
        ]
      });

      const result = parseMultiResponse(raw, ['src/index.js', 'tests/index.test.js']);
      assert.strictEqual(result.length, 2);
      assert.deepStrictEqual(result[0].files, ['src/index.js']);
      assert.strictEqual(result[1].body, 'Adds regression coverage');
    });

    it('throws when a file is duplicated across commits', () => {
      const raw = JSON.stringify({
        commits: [
          { files: ['src/index.js'], subject: 'feat: add multi mode', body: '' },
          { files: ['src/index.js'], subject: 'test: cover multi mode', body: '' }
        ]
      });

      assert.throws(() => parseMultiResponse(raw, ['src/index.js']), { code: 'PARSE_ERROR' });
    });

    it('throws when a changed file is missing from the plan', () => {
      const raw = JSON.stringify({
        commits: [
          { files: ['src/index.js'], subject: 'feat: add multi mode', body: '' }
        ]
      });

      assert.throws(() => parseMultiResponse(raw, ['src/index.js', 'tests/index.test.js']), { code: 'PARSE_ERROR' });
    });
  });
});
