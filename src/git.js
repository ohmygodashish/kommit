import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function execGit(args, options = {}) {
  return execFileAsync('git', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...options });
}

export async function getDiff(providerConfig) {
  try {
    await execGit(['rev-parse', '--git-dir']);
  } catch {
    throw Object.assign(new Error('Not a git repository.'), { code: 'not_a_repo' });
  }

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
