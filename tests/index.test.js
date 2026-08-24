import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, rm, mkdir, rename } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  buildFileAliases,
  buildFullMessage,
  getVariationHint,
  commitMessage,
  executeMultiCommits,
  setExitForTesting
} from '../src/index.js';
import { unstageAll, getAllChanges } from '../src/git.js';
import { parseMultiResponse } from '../src/prompt.js';

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
      await rename(join(repoDir, 'old.txt'), join(repoDir, 'new.txt'));

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

describe('buildFileAliases', () => {
  it('maps the display path, the new path, and both rename sides to one canonical id', () => {
    const file = {
      status: 'R ',
      changeType: 'R',
      path: 'src/clipboard.ts',
      displayPath: 'src/clipboard.js -> src/clipboard.ts',
      stagePaths: ['src/clipboard.js', 'src/clipboard.ts']
    };

    const aliases = buildFileAliases([file]);
    assert.strictEqual(aliases.get('src/clipboard.js -> src/clipboard.ts'), file.displayPath);
    assert.strictEqual(aliases.get('src/clipboard.js'), file.displayPath);
    assert.strictEqual(aliases.get('src/clipboard.ts'), file.displayPath);
  });

  it('never lets a rename side shadow another entry that owns that exact path', () => {
    const renamed = {
      status: 'R ',
      changeType: 'R',
      path: 'b.js',
      displayPath: 'a.js -> b.js',
      stagePaths: ['a.js', 'b.js']
    };
    const added = {
      status: '??',
      changeType: 'A',
      path: 'a.js',
      displayPath: 'a.js',
      stagePaths: ['a.js']
    };

    const aliases = buildFileAliases([renamed, added]);
    assert.strictEqual(aliases.get('a.js'), 'a.js');
    assert.strictEqual(aliases.get('b.js'), 'a.js -> b.js');
    assert.strictEqual(aliases.get('a.js -> b.js'), 'a.js -> b.js');
  });
});

// Regression: a rename is identified to the model as 'old -> new', which is not a path.
// The model answers with a real path from one side, so the whole pipeline has to agree
// on one canonical id: getAllChanges -> buildFileAliases -> parseMultiResponse -> commit.
describe('multi-commit pipeline with a renamed file', () => {
  let repoDir;
  let originalCwd;

  async function execGit(args, cwd = repoDir) {
    return execFileAsync('git', args, { cwd, encoding: 'utf8' });
  }

  before(async () => {
    originalCwd = process.cwd();
    repoDir = await mkdtemp(join(tmpdir(), 'kommit-rename-pipeline-'));
    await execGit(['init']);
    await execGit(['config', 'user.email', 'test@test.com']);
    await execGit(['config', 'user.name', 'Test']);

    await writeFile(join(repoDir, 'old.txt'), 'line one\nline two\nline three\n');
    await execGit(['add', 'old.txt']);
    await execGit(['commit', '-m', 'baseline']);

    process.chdir(repoDir);
    await rename(join(repoDir, 'old.txt'), join(repoDir, 'new.txt'));
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(repoDir, { recursive: true, force: true });
  });

  it('commits a rename the model referenced by its old path', async () => {
    const changeResult = await getAllChanges({ maxDiffLength: 12000 });

    const renameEntry = changeResult.files.find(file => file.changeType === 'R');
    assert.ok(renameEntry, 'expected git to detect the rename');
    assert.strictEqual(renameEntry.displayPath, 'old.txt -> new.txt');

    const aliases = buildFileAliases(changeResult.files);
    const changeMap = new Map(changeResult.files.map(file => [file.displayPath, file]));

    // The model answers with the old path, exactly as it does in practice, because the
    // diff it reads says 'rename from old.txt'.
    const raw = JSON.stringify({
      commits: [
        { files: ['old.txt'], subject: 'refactor: rename old to new', body: '' }
      ]
    });

    const commits = parseMultiResponse(raw, aliases);
    assert.deepStrictEqual(commits[0].files, ['old.txt -> new.txt']);

    await executeMultiCommits(commits, changeMap);

    const { stdout: subject } = await execGit(['log', '-1', '--format=%s']);
    assert.strictEqual(subject.trim(), 'refactor: rename old to new');

    // The commit must actually record the rename, not an unrelated add/delete pair.
    const { stdout: nameStatus } = await execGit(['show', '--name-status', '--format=', '-M', 'HEAD']);
    assert.match(nameStatus, /^R\d*\s+old\.txt\s+new\.txt$/m);

    const { stdout: remaining } = await execGit(['status', '--porcelain']);
    assert.strictEqual(remaining.trim(), '', 'expected no leftover changes');
  });
});
