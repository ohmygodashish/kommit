import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const BASE_SYSTEM_PROMPT = `You are a commit message generator. Analyze the provided git diff and produce a concise, accurate commit message following the Conventional Commits specification.

Rules:
- Format: <type>[optional scope]: <description>
- Allowed types: feat, fix, docs, style, refactor, perf, test, chore, ci, build
- Use imperative mood, present tense ("add" not "added" or "adding")
- Subject line must be ≤ 72 characters
- If the change warrants explanation, add a blank line followed by a body explaining the motivation and context
- Body lines should wrap at 72 characters
- Return ONLY a raw JSON object with exactly two keys: "subject" and "body".
- "subject" contains the full subject line (including type and scope).
- "body" contains the commit body, or an empty string if no body is needed.
- Do not wrap the JSON in markdown code fences. Do not include any other text, explanations, or preamble.
- If a <skill> section is present in the prompt, use the instructions within it to customize your output style, tone, and conventions. The skill instructions override default behavior where they conflict.`;

const CONVENTIONAL_COMMIT_RE = /^(feat|fix|docs|style|refactor|perf|test|chore|ci|build)(\([a-z0-9-]+\))?!?: .{1,72}$/;

function stripCodeFences(raw) {
  const trimmed = raw.trim();

  let cleaned = trimmed;
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  return cleaned.trim();
}

async function loadSkillContent(config) {
  let warning = null;
  let skillContent = '';

  const skillName = config._resolvedSkill || null;
  if (!skillName) {
    return { skillContent, warning };
  }

  const skillPath = join(homedir(), '.agents', 'skills', skillName, 'SKILL.md');
  try {
    const raw = await readFile(skillPath, 'utf8');
    skillContent = raw.trim();
  } catch {
    warning = `Skill '${skillName}' not found at ${skillPath}. Using base prompt.`;
  }

  return { skillContent, warning };
}

async function buildSystemPrompt(config, extraRules = '') {
  let systemPrompt = BASE_SYSTEM_PROMPT;
  if (extraRules) {
    systemPrompt += `\n${extraRules}`;
  }

  const { skillContent, warning } = await loadSkillContent(config);
  if (skillContent) {
    systemPrompt += `\n\n---\n<skill>\n${skillContent}\n</skill>`;
  }

  return { systemPrompt, warning };
}

export async function buildPrompt(diff, config) {
  const { systemPrompt, warning } = await buildSystemPrompt(config);

  const userPrompt = `--- BEGIN GIT DIFF ---\n${diff}\n--- END GIT DIFF ---\n\nGenerate a commit message for the changes above.`;

  return { system: systemPrompt, user: userPrompt, warning };
}

export async function buildMultiCommitPrompt(diff, files, config) {
  const fileList = files
    .map(file => `- [${file.status}] ${file.displayPath}`)
    .join('\n');

  const extraRules = `

Additional rules for this response:
- Split the changes into multiple logical commits at file granularity.
- Group files by logical change, not by file type or directory alone.
- Every changed file must appear in exactly one commit group.
- Use the exact file identifiers from the provided file list.
- Return ONLY a raw JSON object with this shape: {"commits":[{"files":["path"],"subject":"type: description","body":""}]}.`;

  const { systemPrompt, warning } = await buildSystemPrompt(config, extraRules);
  const userPrompt = `--- BEGIN FILE LIST ---\n${fileList}\n--- END FILE LIST ---\n\n--- BEGIN GIT DIFF ---\n${diff}\n--- END GIT DIFF ---\n\nGenerate a multi-commit plan for the changes above.`;

  return { system: systemPrompt, user: userPrompt, warning };
}

export function parseResponse(raw) {
  const cleaned = stripCodeFences(raw);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw Object.assign(new Error('Failed to parse LLM response as JSON'), { raw, code: 'PARSE_ERROR' });
  }

  if (typeof parsed.subject !== 'string' || typeof parsed.body !== 'string') {
    throw Object.assign(new Error('LLM response missing subject or body fields'), { raw, code: 'PARSE_ERROR' });
  }

  return { subject: parsed.subject, body: parsed.body };
}

export function parseMultiResponse(raw, allowedFiles = null) {
  const cleaned = stripCodeFences(raw);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw Object.assign(new Error('Failed to parse LLM response as JSON'), { raw, code: 'PARSE_ERROR' });
  }

  if (!parsed || !Array.isArray(parsed.commits) || parsed.commits.length === 0) {
    throw Object.assign(new Error('LLM response missing commits array'), { raw, code: 'PARSE_ERROR' });
  }

  const allowed = allowedFiles ? new Set(allowedFiles) : null;
  const expectedFileCount = allowed ? allowed.size : null;
  const seenFiles = new Set();

  const commits = parsed.commits.map(commit => {
    if (!commit || !Array.isArray(commit.files) || typeof commit.subject !== 'string' || typeof commit.body !== 'string') {
      throw Object.assign(new Error('LLM response has invalid commit group shape'), { raw, code: 'PARSE_ERROR' });
    }

    if (commit.files.length === 0 || commit.files.some(file => typeof file !== 'string' || !file.trim())) {
      throw Object.assign(new Error('LLM response includes an empty file entry'), { raw, code: 'PARSE_ERROR' });
    }

    for (const file of commit.files) {
      if (allowed && !allowed.has(file)) {
        throw Object.assign(new Error(`LLM response referenced unknown file '${file}'`), { raw, code: 'PARSE_ERROR' });
      }
      if (seenFiles.has(file)) {
        throw Object.assign(new Error(`LLM response duplicated file '${file}' across commits`), { raw, code: 'PARSE_ERROR' });
      }
      seenFiles.add(file);
    }

    return {
      files: commit.files,
      subject: commit.subject,
      body: commit.body
    };
  });

  if (expectedFileCount !== null && seenFiles.size !== expectedFileCount) {
    throw Object.assign(new Error('LLM response did not include every changed file'), { raw, code: 'PARSE_ERROR' });
  }

  return commits;
}

export function validateSubject(subject) {
  return CONVENTIONAL_COMMIT_RE.test(subject);
}
