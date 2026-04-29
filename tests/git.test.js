import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { getDiff, getAllChanges, stageTracked, stageFiles, unstageAll, commit } from '../src/git.js';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

describe('git.js', () => {
  let repoDir;
  let originalCwd;

  async function execGit(args, cwd = repoDir) {
    return execFileAsync('git', args, { cwd, encoding: 'utf8' });
  }

  before(async () => {
    originalCwd = process.cwd();
    repoDir = await mkdtemp(join(tmpdir(), 'kommit-git-test-'));
    await execGit(['init']);
    await execGit(['config', 'user.email', 'test@test.com']);
    await execGit(['config', 'user.name', 'Test']);

    // Commit a baseline file so we have tracked files to modify
    await writeFile(join(repoDir, 'baseline.txt'), 'baseline');
    await execGit(['add', 'baseline.txt']);
    await execGit(['commit', '-m', 'baseline']);

    process.chdir(repoDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(repoDir, { recursive: true, force: true });
  });

  describe('getDiff', () => {
    it('returns staged diff', async () => {
      await writeFile(join(repoDir, 'staged.txt'), 'hello');
      await execGit(['add', 'staged.txt']);

      const result = await getDiff({ maxDiffLength: 12000 });
      assert.strictEqual(result.source, 'staged');
      assert.ok(result.diff.includes('diff --git'));
      assert.ok(result.diff.includes('staged.txt'));
      assert.strictEqual(result.truncated, false);
    });

    it('falls back to unstaged diff', async () => {
      await execGit(['reset', 'HEAD']);
      await writeFile(join(repoDir, 'baseline.txt'), 'modified');

      const result = await getDiff({ maxDiffLength: 12000 });
      assert.strictEqual(result.source, 'unstaged');
      assert.ok(result.diff.includes('baseline.txt'));
    });

    it('throws when no changes', async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), 'kommit-empty-'));
      await execFileAsync('git', ['init'], { cwd: emptyDir });
      await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: emptyDir });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: emptyDir });

      const prevCwd = process.cwd();
      process.chdir(emptyDir);

      await assert.rejects(
        async () => getDiff({ maxDiffLength: 12000 }),
        err => err.code === 'no_changes'
      );

      process.chdir(prevCwd);
      await rm(emptyDir, { recursive: true, force: true });
    });

    it('truncates large diffs at hunk boundary', async () => {
      const bigFile = join(repoDir, 'big.txt');
      let content = '';
      for (let i = 0; i < 100; i++) {
        content += `line ${i} with some padding to make it longer\n`;
      }
      await writeFile(bigFile, content);
      await execGit(['add', 'big.txt']);

      const result = await getDiff({ maxDiffLength: 200 });
      assert.strictEqual(result.truncated, true);
      assert.ok(result.diff.endsWith('[diff truncated...]'));
    });

    it('does not truncate small diffs', async () => {
      await writeFile(join(repoDir, 'small.txt'), 'tiny');
      await execGit(['add', 'small.txt']);

      const result = await getDiff({ maxDiffLength: 12000 });
      assert.strictEqual(result.truncated, false);
      assert.ok(!result.diff.includes('[diff truncated...]'));
    });
  });

  describe('getAllChanges', () => {
    it('includes mixed tracked changes and untracked files', async () => {
      await execGit(['reset', '--hard', 'HEAD']);
      await execGit(['clean', '-fd']);

      await writeFile(join(repoDir, 'baseline.txt'), 'staged version');
      await execGit(['add', 'baseline.txt']);
      await writeFile(join(repoDir, 'baseline.txt'), 'staged and unstaged version');
      await writeFile(join(repoDir, 'new-file.txt'), 'brand new');

      const result = await getAllChanges({ maxDiffLength: 12000 });

      assert.ok(result.diff.includes('baseline.txt'));
      assert.ok(result.diff.includes('new-file.txt'));
      assert.ok(result.files.some(file => file.displayPath === 'baseline.txt'));
      assert.ok(result.files.some(file => file.displayPath === 'new-file.txt' && file.status === '??'));
    });
  });

  describe('stageTracked', () => {
    it('stages tracked modifications', async () => {
      await writeFile(join(repoDir, 'baseline.txt'), 'stage-test');
      await stageTracked();

      const { stdout } = await execGit(['diff', '--cached', '--name-only']);
      assert.ok(stdout.includes('baseline.txt'));
    });
  });

  describe('stageFiles', () => {
    it('stages only the requested files', async () => {
      await execGit(['reset', '--hard', 'HEAD']);
      await execGit(['clean', '-fd']);

      await writeFile(join(repoDir, 'select-a.txt'), 'a');
      await writeFile(join(repoDir, 'select-b.txt'), 'b');

      await stageFiles(['select-a.txt']);

      const { stdout } = await execGit(['diff', '--cached', '--name-only']);
      assert.ok(stdout.includes('select-a.txt'));
      assert.ok(!stdout.includes('select-b.txt'));
    });
  });

  describe('unstageAll', () => {
    it('unstages staged changes', async () => {
      await execGit(['reset', '--hard', 'HEAD']);
      await execGit(['clean', '-fd']);

      await writeFile(join(repoDir, 'baseline.txt'), 'unstage me');
      await execGit(['add', 'baseline.txt']);

      await unstageAll();

      const { stdout } = await execGit(['diff', '--cached', '--name-only']);
      assert.strictEqual(stdout.trim(), '');
    });
  });

  describe('commit', () => {
    it('commits with message file', async () => {
      const msgFile = join(tmpdir(), 'kommit-test-msg.txt');
      await writeFile(msgFile, 'test commit message');

      await writeFile(join(repoDir, 'commit.txt'), 'content');
      await execGit(['add', 'commit.txt']);

      const result = await commit(msgFile);
      assert.ok(result.hash);
      assert.strictEqual(result.hash.length, 40);

      const { stdout } = await execGit(['log', '-1', '--format=%s']);
      assert.strictEqual(stdout.trim(), 'test commit message');

      await rm(msgFile);
    });
  });
});
