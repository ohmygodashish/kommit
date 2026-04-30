import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function normalizeGitPath(path) {
  if (!path) return path;
  return path.startsWith('"') && path.endsWith('"') ? JSON.parse(path) : path;
}

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

export async function getDiff(providerConfig) {
  await ensureRepo();

  let diff = '';
  let source = 'staged';

  try {
    const result = await execGit(['diff', '--cached']);
    diff = result.stdout;
  } catch {
    diff = '';
  }

  if (!diff.trim()) {
    try {
      const result = await execGit(['diff']);
      diff = result.stdout;
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
    source
  };
}

export async function getAllChanges(providerConfig) {
  await ensureRepo();

  const files = await getChangedFiles();
  if (files.length === 0) {
    throw Object.assign(new Error('No changes detected to commit.'), { code: 'no_changes' });
  }

  let trackedDiff = '';
  try {
    const result = await execGit(['diff', 'HEAD']);
    trackedDiff = result.stdout;
  } catch {
    // HEAD may be unborn (no commits yet). Fall back to staged + unstaged separately.
    const parts = [];
    try {
      const staged = await execGit(['diff', '--cached']);
      if (staged.stdout) parts.push(staged.stdout);
    } catch {
      // no staged diff
    }
    try {
      const unstaged = await execGit(['diff']);
      if (unstaged.stdout) parts.push(unstaged.stdout);
    } catch {
      // no unstaged diff
    }
    trackedDiff = parts.join('\n');
  }

  const untrackedDiffs = [];
  for (const file of files) {
    if (file.status !== '??') continue;
    try {
      const result = await execGit(['diff', '--no-index', '--', '/dev/null', file.path]);
      untrackedDiffs.push(result.stdout);
    } catch (err) {
      if (typeof err.stdout === 'string' && err.stdout) {
        untrackedDiffs.push(err.stdout);
        continue;
      }
      throw Object.assign(
        new Error(`Failed to diff untracked file '${file.path}': ${err.stderr || err.message}`),
        { code: 'diff_failed' }
      );
    }
  }

  const combinedDiff = [trackedDiff.trimEnd(), ...untrackedDiffs.map(diff => diff.trimEnd())]
    .filter(Boolean)
    .join('\n');

  const maxDiffLength = providerConfig.maxDiffLength || 12000;
  const { truncatedDiff, truncated } = truncateDiff(combinedDiff, maxDiffLength);

  return {
    diff: truncatedDiff,
    truncated,
    files
  };
}

async function getChangedFiles() {
  const { stdout } = await execGit(['status', '--porcelain']);
  const files = [];

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;

    const status = line.slice(0, 2);
    const rawPath = line.slice(3);

    if (status === '??') {
      const path = normalizeGitPath(rawPath);
      files.push({
        status,
        path,
        displayPath: path,
        stagePaths: [path]
      });
      continue;
    }

    if (status.includes('R') && rawPath.includes(' -> ')) {
      const [oldPathRaw, newPathRaw] = rawPath.split(' -> ');
      const oldPath = normalizeGitPath(oldPathRaw);
      const newPath = normalizeGitPath(newPathRaw);
      files.push({
        status,
        path: newPath,
        displayPath: `${oldPath} -> ${newPath}`,
        stagePaths: [oldPath, newPath]
      });
      continue;
    }

    const path = normalizeGitPath(rawPath);
    files.push({
      status,
      path,
      displayPath: path,
      stagePaths: [path]
    });
  }

  return files;
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

export async function stageTracked() {
  try {
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
    await execGit(['add', '--', ...files]);
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
