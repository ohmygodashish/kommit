import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  buildFullMessage,
  getVariationHint,
  commitMessage,
  executeMultiCommits,
  setExitForTesting
} from '../src/index.js';
import { unstageAll } from '../src/git.js';

const execFileAsync = promisify(execFile);

describe('index.js helpers', () => {
  describe('buildFullMessage', () => {
    it('returns subject only when body is empty', () => {
      const result = buildFullMessage({ subject: 'feat: add auth', body: '' });
      assert.strictEqual(result, 'feat: add auth');
    });

    it('returns subject and body separated by blank line', () => {
      const result = buildFullMessage({ subject: 'feat: add auth', body: 'Adds JWT validation' });
      assert.strictEqual(result, 'feat: add auth\n\nAdds JWT validation');
    });
  });

  describe('getVariationHint', () => {
    it('returns concise hint for count 1', () => {
      assert.strictEqual(getVariationHint(1), 'Try to be more concise.');
    });

    it('returns why hint for count 2', () => {
      assert.strictEqual(getVariationHint(2), 'Focus on the \'why\' rather than the \'what\'.');
    });

    it('returns scope hint for count 3', () => {
      assert.strictEqual(getVariationHint(3), 'Use a broader scope if appropriate.');
    });

    it('caps at last hint for counts beyond array length', () => {
      assert.strictEqual(getVariationHint(10), 'Use a broader scope if appropriate.');
    });
  });

  describe('commitMessage', () => {
    let repoDir;
    let originalCwd;

    async function execGit(args, cwd = repoDir) {
      return execFileAsync('git', args, { cwd, encoding: 'utf8' });
    }

    before(async () => {
      originalCwd = process.cwd();
      repoDir = await mkdtemp(join(tmpdir(), 'kommit-index-test-'));
      await execGit(['init']);
      await execGit(['config', 'user.email', 'test@test.com']);
      await execGit(['config', 'user.name', 'Test']);
      process.chdir(repoDir);
    });

    after(async () => {
      process.chdir(originalCwd);
      await rm(repoDir, { recursive: true, force: true });
    });

    it('writes temp file and commits with the message', async () => {
      await writeFile(join(repoDir, 'commit-test.txt'), 'content');
      await execGit(['add', 'commit-test.txt']);

      const result = await commitMessage({ subject: 'feat: test commit', body: '' });
      assert.ok(result.hash);
      assert.strictEqual(result.hash.length, 40);

      const { stdout } = await execGit(['log', '-1', '--format=%s']);
      assert.strictEqual(stdout.trim(), 'feat: test commit');
    });

    it('includes body in the commit message', async () => {
      await writeFile(join(repoDir, 'commit-body.txt'), 'body content');
      await execGit(['add', 'commit-body.txt']);

      const result = await commitMessage({
        subject: 'feat: with body',
        body: 'This explains the motivation.'
      });
      assert.ok(result.hash);

      const { stdout } = await execGit(['log', '-1', '--format=%B']);
      assert.ok(stdout.includes('feat: with body'));
      assert.ok(stdout.includes('This explains the motivation.'));
    });
  });

  describe('executeMultiCommits', () => {
    let repoDir;
    let originalCwd;

    async function execGit(args, cwd = repoDir) {
      return execFileAsync('git', args, { cwd, encoding: 'utf8' });
    }

    before(async () => {
      originalCwd = process.cwd();
      repoDir = await mkdtemp(join(tmpdir(), 'kommit-multi-test-'));
      await execGit(['init']);
      await execGit(['config', 'user.email', 'test@test.com']);
      await execGit(['config', 'user.name', 'Test']);

      // baseline commit
      await writeFile(join(repoDir, 'base.txt'), 'base');
      await execGit(['add', 'base.txt']);
      await execGit(['commit', '-m', 'baseline']);

      process.chdir(repoDir);
    });

    after(async () => {
      process.chdir(originalCwd);
      await rm(repoDir, { recursive: true, force: true });
    });

    it('creates multiple commits in order', async () => {
      await writeFile(join(repoDir, 'a.txt'), 'a');
      await writeFile(join(repoDir, 'b.txt'), 'b');
      await writeFile(join(repoDir, 'c.txt'), 'c');

      const changeMap = new Map([
        ['a.txt', { displayPath: 'a.txt', stagePaths: ['a.txt'] }],
        ['b.txt', { displayPath: 'b.txt', stagePaths: ['b.txt'] }],
        ['c.txt', { displayPath: 'c.txt', stagePaths: ['c.txt'] }]
      ]);

      const commits = [
        { files: ['a.txt'], subject: 'feat: add a', body: '' },
        { files: ['b.txt'], subject: 'feat: add b', body: '' },
        { files: ['c.txt'], subject: 'feat: add c', body: '' }
      ];

      await executeMultiCommits(commits, changeMap);

      const { stdout } = await execGit(['log', '--format=%s', '-n', '3']);
      const messages = stdout.trim().split('\n');
      assert.strictEqual(messages[0], 'feat: add c');
      assert.strictEqual(messages[1], 'feat: add b');
      assert.strictEqual(messages[2], 'feat: add a');
    });

    it('handles renamed files with multiple stage paths', async () => {
      await writeFile(join(repoDir, 'old.txt'), 'old content');
      await execGit(['add', 'old.txt']);
      await execGit(['commit', '-m', 'add old']);
      await execGit(['mv', 'old.txt', 'new.txt']);

      const changeMap = new Map([
        ['old.txt -> new.txt', { displayPath: 'old.txt -> new.txt', stagePaths: ['old.txt', 'new.txt'] }]
      ]);

      const commits = [
        { files: ['old.txt -> new.txt'], subject: 'refactor: rename old to new', body: '' }
      ];

      await executeMultiCommits(commits, changeMap);

      const { stdout } = await execGit(['log', '-1', '--format=%s']);
      assert.strictEqual(stdout.trim(), 'refactor: rename old to new');
    });

    it('throws when commit plan references unknown file', async () => {
      const changeMap = new Map();
      const commits = [
        { files: ['nonexistent.txt'], subject: 'feat: bad', body: '' }
      ];

      await assert.rejects(
        async () => executeMultiCommits(commits, changeMap),
        err => err.message.includes('Unknown file in commit plan')
      );
    });
  });
});
