import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, rm, rename } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { getAllChanges } from '../src/git.ts';
import { providerConfig } from './fixtures.ts';

const execFileAsync = promisify(execFile);

describe('git.js — edge cases', () => {
  let repoDir: any;
  let originalCwd: any;

  async function execGit(args: any, cwd = repoDir) {
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
        async () => getAllChanges(providerConfig({ maxDiffLength: 12000 })),
        (err: any) => err.code === 'no_changes'
      );
    });

    it('detects filesystem renames as one change', async () => {
      await execGit(['reset', '--hard', 'HEAD']);
      await execGit(['clean', '-fd']);

      await writeFile(join(repoDir, 'rename-me.txt'), 'content');
      await execGit(['add', 'rename-me.txt']);
      await execGit(['commit', '-m', 'add rename-me']);
      await rename(join(repoDir, 'rename-me.txt'), join(repoDir, 'renamed.txt'));

      const result = await getAllChanges(providerConfig({ maxDiffLength: 12000 }));
      const renameFile = result.files.find(f => f.displayPath.includes('->'));
      assert.ok(renameFile, 'should find renamed file');
      assert.ok(renameFile.stagePaths.includes('rename-me.txt'));
      assert.ok(renameFile.stagePaths.includes('renamed.txt'));
      assert.ok(result.diff.includes('rename from rename-me.txt'));
      assert.ok(result.diff.includes('rename to renamed.txt'));
    });

    it('preserves already staged renames', async () => {
      await execGit(['reset', '--hard', 'HEAD']);
      await execGit(['clean', '-fd']);

      await writeFile(join(repoDir, 'staged-rename.txt'), 'content');
      await execGit(['add', 'staged-rename.txt']);
      await execGit(['commit', '-m', 'add staged rename']);
      await execGit(['mv', 'staged-rename.txt', 'staged-renamed.txt']);

      const result = await getAllChanges(providerConfig({ maxDiffLength: 12000 }));
      const renameFile = result.files.find(f => f.displayPath === 'staged-rename.txt -> staged-renamed.txt');
      assert.ok(renameFile, 'should retain staged rename metadata');
      assert.ok(result.diff.includes('rename from staged-rename.txt'));
      assert.ok(result.diff.includes('rename to staged-renamed.txt'));
    });

    it('handles quoted paths from git status', async () => {
      await execGit(['reset', '--hard', 'HEAD']);
      await execGit(['clean', '-fd']);

      const fileName = 'file with spaces.txt';
      await writeFile(join(repoDir, fileName), 'content');

      const result = await getAllChanges(providerConfig({ maxDiffLength: 12000 }));
      const file = result.files.find(f => f.path === fileName);
      assert.ok(file, 'should parse quoted path');
      assert.strictEqual(file.displayPath, fileName);
    });

    it('falls back to staged+unstaged diff on unborn HEAD', async () => {
      const unbornDir = await mkdtemp(join(tmpdir(), 'kommit-unborn-'));
      await execFileAsync('git', ['init'], { cwd: unbornDir, encoding: 'utf8' });
      await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: unbornDir, encoding: 'utf8' });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: unbornDir, encoding: 'utf8' });

      const prevCwd = process.cwd();
      process.chdir(unbornDir);

      await writeFile(join(unbornDir, 'first.js'), 'console.log("hello");');
      await execFileAsync('git', ['add', 'first.js'], { cwd: unbornDir, encoding: 'utf8' });
      await writeFile(join(unbornDir, 'second.js'), 'console.log("world");');

      try {
        const result = await getAllChanges(providerConfig({ maxDiffLength: 12000 }));
        assert.ok(result.diff.includes('first.js'), 'diff should include staged file');
        assert.ok(result.diff.includes('second.js'), 'diff should include unstaged file');
        assert.strictEqual(result.files.length, 2);
      } finally {
        process.chdir(prevCwd);
        await rm(unbornDir, { recursive: true, force: true });
      }
    });

    it('does not treat " -> " in a filename as a rename', async () => {
      await execGit(['reset', '--hard', 'HEAD']);
      await execGit(['clean', '-fd']);

      const fileName = 'a -> b.txt';
      await writeFile(join(repoDir, fileName), 'content');
      await execGit(['add', fileName]);

      const result = await getAllChanges(providerConfig({ maxDiffLength: 12000 }));
      const file = result.files.find(f => f.path === fileName);
      assert.ok(file, 'should find the file');
      assert.strictEqual(file.displayPath, fileName);
      assert.deepStrictEqual(file.stagePaths, [fileName]);
    });
  });
});
