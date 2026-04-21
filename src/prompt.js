import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const BASE_SYSTEM_PROMPT = `You are a commit message generator. Analyze the provided git diff and produce a concise, accurate commit message following the Conventional Commits specification.

Rules:
- Format: <type>[mandatory scope]: <description>
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

export async function buildPrompt(diff, config) {
  let systemPrompt = BASE_SYSTEM_PROMPT;
  let warning = null;

  const skillName = config._resolvedSkill || null;

  if (skillName) {
    const skillPath = join(homedir(), '.agents', 'skills', skillName, 'SKILL.md');
    try {
      const skillContent = await readFile(skillPath, 'utf8');
      if (skillContent.trim()) {
        systemPrompt += `\n\n---\n<skill>\n${skillContent.trim()}\n</skill>`;
      }
    } catch {
      warning = `Skill '${skillName}' not found at ${skillPath}. Using base prompt.`;
    }
  }

  const userPrompt = `--- BEGIN GIT DIFF ---\n${diff}\n--- END GIT DIFF ---\n\nGenerate a commit message for the changes above.`;

  return { system: systemPrompt, user: userPrompt, warning };
}

export function parseResponse(raw) {
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
  cleaned = cleaned.trim();

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

export function validateSubject(subject) {
  return CONVENTIONAL_COMMIT_RE.test(subject);
}
