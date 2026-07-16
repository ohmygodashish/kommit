import { execFile } from 'child_process';
import { copyFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function execGit(args, options = {}) {
  return execFileAsync('git', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...options });
}

async function ensureRepo() {
  try {
    await execGit(['rev-parse', '--git-dir']);
  } catch {
    throw Object.assign(new Error('Not a git repository.'), { code: 'not_a_repo' });
  }
}

export async function getRepoRoot() {
  const { stdout } = await execGit(['rev-parse', '--show-toplevel']);
  return stdout.trim();
}

export async function getDiff(providerConfig) {
  await ensureRepo();

  let diff = '';
  let source = 'staged';
  let stagePaths = [];

  try {
    const result = await execGit(['diff', '--cached', '--find-renames']);
    diff = result.stdout;
  } catch {
    diff = '';
  }

  if (!diff.trim()) {
    try {
      const changes = await getTemporaryIndexChanges({ includeUntracked: false });
      diff = changes.diff;
      stagePaths = changes.files.flatMap(file => file.stagePaths);
      source = 'unstaged';
    } catch {
      diff = '';
    }
  }

  if (!diff.trim()) {
    throw Object.assign(new Error('No changes detected to commit.'), { code: 'no_changes' });
  }

  const maxDiffLength = providerConfig.maxDiffLength || 12000;
  const { truncatedDiff, truncated } = truncateDiff(diff, maxDiffLength);

  return {
    diff: truncatedDiff,
    truncated,
    source,
    stagePaths
  };
}

export async function getAllChanges(providerConfig) {
  await ensureRepo();

  const { diff, files } = await getTemporaryIndexChanges({ includeUntracked: true });
  if (files.length === 0) {
    throw Object.assign(new Error('No changes detected to commit.'), { code: 'no_changes' });
  }

  const maxDiffLength = providerConfig.maxDiffLength || 12000;
  const { truncatedDiff, truncated } = truncateDiff(diff, maxDiffLength);

  return {
    diff: truncatedDiff,
    truncated,
    files
  };
}

async function getTemporaryIndexChanges({ includeUntracked }) {
  return withTemporaryIndex(async options => {
    const [{ stdout: statusOutput }, untrackedPaths] = await Promise.all([
      execGit(['diff', '--cached', '--name-status', '-z', '--find-renames'], options),
      getUntrackedPaths()
    ]);
    const allFiles = parseNameStatus(statusOutput, untrackedPaths);
    const files = includeUntracked ? allFiles : allFiles.filter(file => file.changeType !== 'A');
    const stagePaths = files.flatMap(file => file.stagePaths);

    if (stagePaths.length === 0) {
      return { diff: '', files };
    }

    const { stdout: diff } = await execGit([
      'diff',
      '--cached',
      '--find-renames',
      '--',
      ...stagePaths.map(toLiteralPathspec)
    ], options);

    return { diff, files };
  });
}

// Let Git detect working-tree renames without changing the user's real index.
async function withTemporaryIndex(callback) {
  const { stdout } = await execGit(['rev-parse', '--git-path', 'index']);
  const indexPath = resolve(stdout.trim());
  const directory = await mkdtemp(join(tmpdir(), 'kommit-index-'));
  const temporaryIndex = join(directory, 'index');

  try {
    try {
      await copyFile(indexPath, temporaryIndex);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const options = {
      env: { ...process.env, GIT_INDEX_FILE: temporaryIndex }
    };
    await execGit(['add', '-A'], options);
    return await callback(options);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function getUntrackedPaths() {
  const { stdout } = await execGit(['status', '--porcelain=v1', '-z']);
  const paths = new Set();
  const entries = stdout.split('\0');

  for (const entry of entries) {
    if (entry.startsWith('?? ')) {
      paths.add(entry.slice(3));
    }
  }

  return paths;
}

function parseNameStatus(output, untrackedPaths) {
  const entries = output.split('\0');
  const files = [];

  for (let index = 0; index < entries.length - 1;) {
    const status = entries[index++];
    const changeType = status[0];
    const oldPath = entries[index++];

    if (changeType === 'R' || changeType === 'C') {
      const newPath = entries[index++];
      files.push({
        status: 'R ',
        changeType,
        path: newPath,
        displayPath: `${oldPath} -> ${newPath}`,
        stagePaths: [oldPath, newPath]
      });
      continue;
    }

    files.push({
      status: changeType === 'A' && untrackedPaths.has(oldPath) ? '??' : `${changeType} `,
      changeType,
      path: oldPath,
      displayPath: oldPath,
      stagePaths: [oldPath]
    });
  }

  return files;
}

function toLiteralPathspec(path) {
  return `:(literal)${path}`;
}

function truncateDiff(diff, maxLength) {
  if (diff.length <= maxLength) {
    return { truncatedDiff: diff, truncated: false };
  }

  const lines = diff.split('\n');
  const sections = [];
  let currentSection = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ') || line.startsWith('Submodule ')) {
      if (currentSection) sections.push(currentSection);
      currentSection = { header: [line], hunks: [] };
    } else if (currentSection) {
      if (line.startsWith('@@ ')) {
        currentSection.hunks.push({ lines: [line] });
      } else if (currentSection.hunks.length > 0) {
        currentSection.hunks[currentSection.hunks.length - 1].lines.push(line);
      } else {
        currentSection.header.push(line);
      }
    }
  }

  if (currentSection) sections.push(currentSection);

  const result = [];
  let currentLength = 0;

  for (const section of sections) {
    const headerText = section.header.join('\n') + '\n';
    result.push(headerText);
    currentLength += headerText.length;

    for (const hunk of section.hunks) {
      const hunkText = hunk.lines.join('\n') + '\n';
      if (currentLength + hunkText.length > maxLength) {
        const truncatedDiff = result.join('').trimEnd() + '\n\n[diff truncated...]';
        return { truncatedDiff, truncated: true };
      }
      result.push(hunkText);
      currentLength += hunkText.length;
    }
  }

  return { truncatedDiff: diff, truncated: false };
}

export async function stageTracked(renamePaths = []) {
  try {
    if (renamePaths.length > 0) {
      await execGit(['add', '-A', '--', ...renamePaths.map(toLiteralPathspec)]);
    }
    await execGit(['add', '-u']);
  } catch (err) {
    throw Object.assign(
      new Error(`git add failed:\n${err.stderr || err.message}`),
      { code: 'stage_failed' }
    );
  }
}

export async function unstageAll() {
  try {
    await execGit(['reset']);
  } catch (err) {
    throw Object.assign(
      new Error(`git reset failed:\n${err.stderr || err.message}`),
      { code: 'unstage_failed' }
    );
  }
}

export async function stageFiles(files) {
  try {
    await execGit(['add', '-A', '--', ...files.map(toLiteralPathspec)]);
  } catch (err) {
    throw Object.assign(
      new Error(`git add failed:\n${err.stderr || err.message}`),
      { code: 'stage_failed' }
    );
  }
}

export async function commit(messagePath) {
  try {
    await execGit(['commit', '-F', messagePath]);
    const { stdout } = await execGit(['rev-parse', 'HEAD']);
    return { hash: stdout.trim() };
  } catch (err) {
    throw Object.assign(
      new Error(`git commit failed:\n${err.stderr || err.message}`),
      { code: 'commit_failed', exitCode: err.code || 1 }
    );
  }
}

export async function getLastCommits(count) {
  try {
    const { stdout } = await execGit([
      'log', 
      `-${count}`, 
      '--format=%H%x01%h%x01%s%x01%b%x01%P%x00'
    ]);
    
    const records = stdout.split('\0').filter(r => r.trim());
    
    return records.map(record => {
      const [hash, shortHash, subject, body, parents] = record.trim().split('\x01');
      return {
        hash,
        shortHash,
        subject,
        body: body || '',
        parents: parents ? parents.trim().split(' ').filter(Boolean) : []
      };
    });
  } catch (err) {
    throw Object.assign(
      new Error(`Failed to get commit history: ${err.stderr || err.message}`),
      { code: 'history_failed' }
    );
  }
}

export async function isMergeCommit(hash) {
  try {
    await execGit(['rev-parse', `${hash}^2`]);
    return true;
  } catch {
    return false;
  }
}

export async function isCommitPushed(commitHash) {
  try {
    const { stdout } = await execGit(['branch', '-r', '--contains', commitHash]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function undoCommits(count) {
  try {
    const { stdout: previousHead } = await execGit(['rev-parse', 'HEAD']);
    await execGit(['reset', '--soft', `HEAD~${count}`]);
    const { stdout: newHead } = await execGit(['rev-parse', 'HEAD']);
    
    return {
      previousHead: previousHead.trim(),
      newHead: newHead.trim(),
      commitCount: count
    };
  } catch (err) {
    if (err.stderr && err.stderr.includes('fatal: ambiguous argument')) {
      throw Object.assign(
        new Error(`Cannot undo ${count} commits. Not enough commits in history.`),
        { code: 'undo_failed' }
      );
    }
    throw Object.assign(
      new Error(`git reset failed:\n${err.stderr || err.message}`),
      { code: 'undo_failed' }
    );
  }
}
