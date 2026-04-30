import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { getAllChanges } from '../src/git.js';

const execFileAsync = promisify(execFile);

describe('git.js — edge cases', () => {
  let repoDir;
  let originalCwd;

  async function execGit(args, cwd = repoDir) {
    return execFileAsync('git', args, { cwd, encoding: 'utf8' });
  }

  before(async () => {
    originalCwd = process.cwd();
    repoDir = await mkdtemp(join(tmpdir(), 'kommit-git-edge-'));
    await execGit(['init']);
    await execGit(['config', 'user.email', 'test@test.com']);
    await execGit(['config', 'user.name', 'Test']);

    await writeFile(join(repoDir, 'baseline.txt'), 'baseline');
    await execGit(['add', 'baseline.txt']);
    await execGit(['commit', '-m', 'baseline']);

    process.chdir(repoDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(repoDir, { recursive: true, force: true });
  });

  describe('getAllChanges', () => {
    it('throws no_changes when working tree is clean', async () => {
      await execGit(['reset', '--hard', 'HEAD']);
      await execGit(['clean', '-fd']);

      await assert.rejects(
        async () => getAllChanges({ maxDiffLength: 12000 }),
        err => err.code === 'no_changes'
      );
    });

    it('parses renamed files correctly', async () => {
      await execGit(['reset', '--hard', 'HEAD']);
      await execGit(['clean', '-fd']);

      await writeFile(join(repoDir, 'rename-me.txt'), 'content');
      await execGit(['add', 'rename-me.txt']);
      await execGit(['commit', '-m', 'add rename-me']);
      await execGit(['mv', 'rename-me.txt', 'renamed.txt']);

      const result = await getAllChanges({ maxDiffLength: 12000 });
      const renameFile = result.files.find(f => f.displayPath.includes('->'));
      assert.ok(renameFile, 'should find renamed file');
      assert.ok(renameFile.stagePaths.includes('rename-me.txt'));
      assert.ok(renameFile.stagePaths.includes('renamed.txt'));
    });

    it('handles quoted paths from git status', async () => {
      await execGit(['reset', '--hard', 'HEAD']);
      await execGit(['clean', '-fd']);

      const fileName = 'file with spaces.txt';
      await writeFile(join(repoDir, fileName), 'content');

      const result = await getAllChanges({ maxDiffLength: 12000 });
      const file = result.files.find(f => f.path === fileName);
      assert.ok(file, 'should parse quoted path');
      assert.strictEqual(file.displayPath, fileName);
    });
  });
});
