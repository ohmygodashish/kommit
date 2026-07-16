import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { getDiff, getAllChanges, stageTracked, stageFiles, unstageAll, commit, getRepoRoot, getLastCommits, isMergeCommit, isCommitPushed, undoCommits } from '../src/git.js';
import { mkdtemp, writeFile, rm, mkdir, rename } from 'fs/promises';
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

    it('detects filesystem renames without staging unrelated untracked files', async () => {
      await execGit(['reset', '--hard', 'HEAD']);
      await execGit(['clean', '-fd']);

      await writeFile(join(repoDir, 'rename-source.txt'), 'rename content');
      await execGit(['add', 'rename-source.txt']);
      await execGit(['commit', '-m', 'add rename source']);
      await rename(join(repoDir, 'rename-source.txt'), join(repoDir, 'rename-target.txt'));
      await writeFile(join(repoDir, 'unrelated.txt'), 'leave me untracked');

      const result = await getDiff({ maxDiffLength: 12000 });

      assert.strictEqual(result.source, 'unstaged');
      assert.ok(result.diff.includes('rename from rename-source.txt'));
      assert.ok(result.diff.includes('rename to rename-target.txt'));
      assert.deepStrictEqual(result.stagePaths, ['rename-source.txt', 'rename-target.txt']);

      await stageTracked(result.stagePaths);

      const { stdout: staged } = await execGit(['diff', '--cached', '--name-status']);
      assert.match(staged, /^R\d+\trename-source\.txt\trename-target\.txt/m);
      const { stdout: status } = await execGit(['status', '--porcelain']);
      assert.ok(status.includes('?? unrelated.txt'));
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

  describe('getRepoRoot', () => {
    it('returns the absolute path to the repo root', async () => {
      const root = await getRepoRoot();
      assert.strictEqual(root, repoDir);
    });

    it('returns the same root when called from a subdirectory', async () => {
      const subDir = join(repoDir, 'src', 'components');
      await mkdir(subDir, { recursive: true });

      const prevCwd = process.cwd();
      process.chdir(subDir);

      try {
        const root = await getRepoRoot();
        assert.strictEqual(root, repoDir);
      } finally {
        process.chdir(prevCwd);
      }
    });
  });

  describe('getLastCommits', () => {
    it('returns the last N commits', async () => {
      await execGit(['reset', '--hard', 'HEAD']);
      await execGit(['clean', '-fd']);

      await writeFile(join(repoDir, 'file1.txt'), 'content1');
      await execGit(['add', 'file1.txt']);
      await execGit(['commit', '-m', 'first commit']);

      await writeFile(join(repoDir, 'file2.txt'), 'content2');
      await execGit(['add', 'file2.txt']);
      await execGit(['commit', '-m', 'second commit']);

      const commits = await getLastCommits(2);
      assert.strictEqual(commits.length, 2);
      assert.strictEqual(commits[0].subject, 'second commit');
      assert.strictEqual(commits[1].subject, 'first commit');
      assert.ok(commits[0].hash);
      assert.ok(commits[0].shortHash);
    });

    it('returns fewer commits if count exceeds history', async () => {
      const commits = await getLastCommits(100);
      assert.ok(commits.length > 0);
      assert.ok(commits.length <= 100);
    });

    it('handles commits with multi-line bodies correctly', async () => {
      await execGit(['reset', '--hard', 'HEAD']);
      await execGit(['clean', '-fd']);

      await writeFile(join(repoDir, 'multiline1.txt'), 'content1');
      await execGit(['add', 'multiline1.txt']);
      await execGit(['commit', '-m', 'multiline commit 1', '-m', 'This is line 1 of the body.\nThis is line 2 of the body.\nThis is line 3 of the body.']);

      await writeFile(join(repoDir, 'multiline2.txt'), 'content2');
      await execGit(['add', 'multiline2.txt']);
      await execGit(['commit', '-m', 'multiline commit 2', '-m', 'Another multi-line body.\nWith two lines.']);

      const commits = await getLastCommits(2);
      assert.strictEqual(commits.length, 2);
      assert.strictEqual(commits[0].subject, 'multiline commit 2');
      assert.ok(commits[0].body.includes('Another multi-line body'));
      assert.ok(commits[0].body.includes('With two lines'));
      assert.strictEqual(commits[1].subject, 'multiline commit 1');
      assert.ok(commits[1].body.includes('This is line 1'));
      assert.ok(commits[1].body.includes('This is line 3'));
    });
  });

  describe('isMergeCommit', () => {
    it('returns false for regular commits', async () => {
      const { stdout } = await execGit(['rev-parse', 'HEAD']);
      const hash = stdout.trim();
      const result = await isMergeCommit(hash);
      assert.strictEqual(result, false);
    });

    it('returns true for merge commits', async () => {
      await execGit(['reset', '--hard', 'HEAD']);
      await execGit(['clean', '-fd']);

      const { stdout: currentBranch } = await execGit(['rev-parse', '--abbrev-ref', 'HEAD']);
      const baseBranch = currentBranch.trim();

      await execGit(['checkout', '-b', 'feature-branch']);
      await writeFile(join(repoDir, 'feature.txt'), 'feature');
      await execGit(['add', 'feature.txt']);
      await execGit(['commit', '-m', 'add feature']);

      await execGit(['checkout', baseBranch]);
      await execGit(['merge', 'feature-branch', '--no-ff']);

      const { stdout } = await execGit(['rev-parse', 'HEAD']);
      const mergeHash = stdout.trim();
      const result = await isMergeCommit(mergeHash);
      assert.strictEqual(result, true);

      await execGit(['branch', '-D', 'feature-branch']);
    });
  });

  describe('isCommitPushed', () => {
    it('returns false for unpushed commits', async () => {
      await execGit(['reset', '--hard', 'HEAD']);
      await execGit(['clean', '-fd']);

      await writeFile(join(repoDir, 'unpushed.txt'), 'content');
      await execGit(['add', 'unpushed.txt']);
      await execGit(['commit', '-m', 'unpushed commit']);

      const { stdout } = await execGit(['rev-parse', 'HEAD']);
      const hash = stdout.trim();
      const result = await isCommitPushed(hash);
      assert.strictEqual(result, false);
    });
  });

  describe('undoCommits', () => {
    it('undoes the last commit and stages changes', async () => {
      await execGit(['reset', '--hard', 'HEAD']);
      await execGit(['clean', '-fd']);

      await writeFile(join(repoDir, 'undo-test.txt'), 'content');
      await execGit(['add', 'undo-test.txt']);
      await execGit(['commit', '-m', 'commit to undo']);

      const { stdout: beforeHead } = await execGit(['rev-parse', 'HEAD']);
      const beforeHash = beforeHead.trim();

      const result = await undoCommits(1);

      assert.strictEqual(result.previousHead, beforeHash);
      assert.ok(result.newHead);
      assert.notStrictEqual(result.newHead, beforeHash);

      const { stdout: stagedFiles } = await execGit(['diff', '--cached', '--name-only']);
      assert.ok(stagedFiles.includes('undo-test.txt'));
    });

    it('undoes multiple commits', async () => {
      await execGit(['reset', '--hard', 'HEAD']);
      await execGit(['clean', '-fd']);

      await writeFile(join(repoDir, 'multi1.txt'), 'content1');
      await execGit(['add', 'multi1.txt']);
      await execGit(['commit', '-m', 'commit 1']);

      await writeFile(join(repoDir, 'multi2.txt'), 'content2');
      await execGit(['add', 'multi2.txt']);
      await execGit(['commit', '-m', 'commit 2']);

      const result = await undoCommits(2);

      assert.strictEqual(result.commitCount, 2);

      const { stdout: stagedFiles } = await execGit(['diff', '--cached', '--name-only']);
      assert.ok(stagedFiles.includes('multi1.txt'));
      assert.ok(stagedFiles.includes('multi2.txt'));
    });

    it('throws when not enough commits', async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), 'kommit-undo-empty-'));
      await execFileAsync('git', ['init'], { cwd: emptyDir });
      await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: emptyDir });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: emptyDir });

      const prevCwd = process.cwd();
      process.chdir(emptyDir);

      try {
        await assert.rejects(
          async () => undoCommits(1),
          err => err.code === 'undo_failed'
        );
      } finally {
        process.chdir(prevCwd);
        await rm(emptyDir, { recursive: true, force: true });
      }
    });
  });
});
