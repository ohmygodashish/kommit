# Kommit — Technical Specification

## Overview
A lightweight Node.js CLI utility that generates commit messages from git diffs using LLMs, enforces Conventional Commits, and provides an interactive workflow to review, edit, and commit.

## Core Requirements
- LLM-powered message generation (OpenAI, Anthropic, Google, OpenRouter, Ollama, LM Studio)
- Conventional Commits enforcement (`feat:`, `fix:`, `chore:`, etc.)
- Staged diff analysis with unstaged fallback
- Intelligent diff truncation for large changesets
- Inline editing of suggested messages
- Copy message to clipboard (`[y]`) with cross-platform support (macOS, Windows, Linux)
- Interactive first-run setup wizard (`--init`)
- Optional skill file (`SKILL.md`) for user-defined prompt customization
- Minimal, focused CLI with small dependencies allowed

---

## Directory Structure

### Project Layout
```
kommit/
├── bin/
│   └── kommit              # Executable entry point (shebang node)
├── src/
│   ├── index.js            # Main entry: orchestrates flow, handles flags
│   ├── args.js             # Manual CLI argument parsing
│   ├── config.js           # Config & auth read/write, migration, env overrides
│   ├── git.js              # Diff extraction, hunk parsing, intelligent truncation
│   ├── llm.js              # Provider routing, API calls, timeouts, retries
│   ├── prompt.js           # Prompt template engineering + skill loading
│   ├── ui.js               # Interactive prompts & inline editing
│   └── clipboard.js        # Cross-platform clipboard support (pbcopy, xclip, wl-copy, etc.)
├── tests/
│   ├── clipboard.test.js
│   ├── config.test.js
│   ├── git.test.js
│   ├── index.test.js
│   ├── llm.test.js
│   ├── prompt.test.js
│   └── ui.test.js
├── package.json
├── README.md
└── SPEC.md                 # This file
```

### User Config Layout (XDG Base Directory)
| File | Purpose | Permissions |
|------|---------|-------------|
| `~/.config/kommit/config.json` | User preferences, provider settings | `0o600` |

| `~/.local/share/kommit/auth.json` | API keys only | `0o600` |

We follow the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html):
- Config goes in `$XDG_CONFIG_HOME/kommit/` (falls back to `~/.config/kommit/`)
- Auth keys go in `$XDG_DATA_HOME/kommit/` (falls back to `~/.local/share/kommit/`)

Separating keys from config allows users to version-control or sync `config.json` without leaking credentials.

---

## Configuration

### Config Schema (`~/.config/kommit/config.json`)
```json
{
  "version": 1,
  "defaultProvider": "openrouter",
  "skillName": null,
  "providers": {
    "openai": {
      "model": "gpt-5.4-nano",
      "endpoint": "https://api.openai.com/v1/chat/completions",
      "maxDiffLength": 12000,
      "timeout": 30000
    },
    "anthropic": {
      "model": "claude-haiku-4-5",
      "endpoint": "https://api.anthropic.com/v1/messages",
      "maxDiffLength": 12000,
      "timeout": 30000
    },
    "google": {
      "model": "gemini-3.1-flash-lite-preview",
      "endpoint": "https://generativelanguage.googleapis.com/v1beta/models",
      "maxDiffLength": 12000,
      "timeout": 30000
    },
    "openrouter": {
      "model": "openai/gpt-5.4-nano",
      "endpoint": "https://openrouter.ai/api/v1/chat/completions",
      "maxDiffLength": 12000,
      "timeout": 30000
    },
    "ollama": {
      "model": "default",
      "endpoint": "http://localhost:11434/v1/chat/completions",
      "maxDiffLength": 4000,
      "timeout": 30000
    },
    "lmstudio": {
      "model": "default",
      "endpoint": "http://localhost:1234/v1/chat/completions",
      "maxDiffLength": 4000,
      "timeout": 30000
    }
  }
}
```

### Auth Schema (`~/.local/share/kommit/auth.json`)
```json
{
  "openai": "sk-...",
  "anthropic": "sk-ant-...",
  "google": "...",
  "openrouter": "sk-or-..."
}
```
Note: `ollama` and `lmstudio` do not require API keys and are omitted.

### Skill File (`~/.agents/skills/{skillName}/SKILL.md`)
An optional Markdown file that is appended to the system prompt when `skillName` is set. Skills are stored in `~/.agents/skills/{skillName}/SKILL.md` as modular, shareable prompt additions. This replaces the previous `customSystemPrompt` string field and the `useSkill` boolean with a composable skill system.

**Example skill layout:**
```
~/.agents/skills/
├── my-team/
│   └── SKILL.md
└── personal/
    └── SKILL.md
```

**Behavior:**
- If `skillName` is `null`, the base system prompt is used unchanged.
- If `skillName` is set but the file does not exist, print a warning and fall back to the base prompt:
  ```
  kommit: Skill 'my-team' not found at ~/.agents/skills/my-team/SKILL.md. Using base prompt.
  ```
- If `skillName` is set and the file exists with content, its text is appended to the base system prompt wrapped in `<skill>` tags.

### Provider API Abstraction
Group providers by API shape to minimize custom code:

| Group | Providers | Implementation |
|-------|-----------|----------------|
| OpenAI-compatible | OpenAI, OpenRouter, Ollama, LM Studio | Standard `/v1/chat/completions` with configurable `endpoint` |
| Anthropic | Claude | Native Messages API (`anthropic-version`, `x-api-key`) |
| Google | Gemini | Generative Language API (`/models/{model}:generateContent`) |

All API calls use native `fetch` (Node 24+). No HTTP client dependencies.

### Config Versioning & Migration
- `version` starts at `1`.
- On every read, if `version` is missing or `< CURRENT_VERSION`, run a migration that fills defaults for new fields and bumps the version.
- Save the migrated config immediately so the user does not see migration prompts on every run.

### Environment Variable Overrides
Env vars take precedence over file-based config. Naming convention:

| Env Var | Overrides |
|---------|-----------|
| `KOMMIT_PROVIDER` | `defaultProvider` |
| `KOMMIT_SKILL` | `skillName` |
| `KOMMIT_OPENAI_API_KEY` | `auth.json["openai"]` |
| `KOMMIT_ANTHROPIC_API_KEY` | `auth.json["anthropic"]` |
| `KOMMIT_GOOGLE_API_KEY` | `auth.json["google"]` |
| `KOMMIT_OPENROUTER_API_KEY` | `auth.json["openrouter"]` |

On `--init`, if an env var is detected, pre-fill the prompt and allow the user to accept or override it.

### `--init` Behavior
- **config.json**: Created only if it does not already exist. If present, it is **not modified** in any way.
- **auth.json**: Created if missing. If it already exists, the selected provider's API key is **merged** into the existing file (other provider keys are preserved). This allows adding keys for multiple providers over multiple `--init` runs.

### `--set` — Configuration Wizard
A separate interactive wizard for modifying `config.json` without touching `auth.json`. Requires an existing config file.

```
kommit --set
```

**Flow:**
1. Prompt: "What would you like to configure?"
   - `defaultProvider`
   - `skillName`
2. **If `defaultProvider`**:
   - Show all providers with API keys in `auth.json`, plus `ollama` and `lmstudio` (always included)
   - After selecting a provider, prompt for model name (pre-filled with current model)
   - Updates `config.defaultProvider` and `config.providers[<selected>].model`
3. **If `skillName`**:
   - Text input pre-filled with current `skillName` (empty string clears it to `null`)
   - Updates `config.skillName`

**Errors:**
- Missing `config.json` → `kommit: Config not found. Run 'kommit --init' first.` (exit 1)
- No available providers → `No providers available. Add API keys with 'kommit --init'.` (exit 1)

### Provider Resolution
The active provider is resolved at runtime using the following priority (highest to lowest):

1. **`--provider <name>` CLI flag** — overrides everything for a single run
2. **`KOMMIT_PROVIDER` environment variable** — useful for CI or shell profiles
3. **`defaultProvider` in `~/.config/kommit/config.json`** — the persistent user preference

If no provider is specified at any level, the tool falls back to the first configured provider with a valid API key, or exits with an error if none are configured.

### Skill Resolution
The active skill is resolved using the same priority pattern:

1. **`--skill <name>` CLI flag**
2. **`KOMMIT_SKILL` environment variable**
3. **`skillName` in `~/.config/kommit/config.json`**

If `skillName` is `null` at all levels, no skill is loaded.

### Sample Config Files

> **Note:** `kommit --init` generates these files automatically. Manual editing is only required for advanced customization.

Complete example of `~/.config/kommit/config.json`:

```json
{
  "version": 1,
  "defaultProvider": "openrouter",
  "skillName": "my-team",
  "providers": {
    "openai": {
      "model": "gpt-5.4-nano",
      "endpoint": "https://api.openai.com/v1/chat/completions",
      "maxDiffLength": 12000,
      "timeout": 30000
    },
    "anthropic": {
      "model": "claude-haiku-4-5",
      "endpoint": "https://api.anthropic.com/v1/messages",
      "maxDiffLength": 12000,
      "timeout": 30000
    },
    "google": {
      "model": "gemini-3.1-flash-lite-preview",
      "endpoint": "https://generativelanguage.googleapis.com/v1beta/models",
      "maxDiffLength": 12000,
      "timeout": 30000
    },
    "openrouter": {
      "model": "openai/gpt-5.4-nano",
      "endpoint": "https://openrouter.ai/api/v1/chat/completions",
      "maxDiffLength": 12000,
      "timeout": 30000
    },
    "ollama": {
      "model": "default",
      "endpoint": "http://localhost:11434/v1/chat/completions",
      "maxDiffLength": 4000,
      "timeout": 30000
    },
    "lmstudio": {
      "model": "default",
      "endpoint": "http://localhost:1234/v1/chat/completions",
      "maxDiffLength": 4000,
      "timeout": 30000
    }
  }
}
```

Complete example of `~/.local/share/kommit/auth.json`:

```json
{
  "openai": "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "anthropic": "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "google": "AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "openrouter": "sk-or-v1-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

---

## Data Flow

```
+-----------+     +-----------+     +-----------+
|  git.js   |---->| prompt.js |---->|  llm.js   |
| getDiff() |     |buildPrompt|     | generate()|
+-----------+     +-----------+     +-----+-----+
                                          |
                                          v
+-----------+     +-----------+     +-----+-----+
|git commit |<----|  git.js   |<----|   ui.js   |
| -F tmpfile|     |  commit() |     | show/edit |
+-----------+     +-----------+     +-----+-----+
                                          |
                                          v
                                   +-----+------+
                                   | clipboard.js|
                                   | copyToClip  |
                                   +------------+
```

Orchestration in `src/index.js`:
1. Parse CLI flags
2. Load config + auth (or run `--init`)
3. Resolve provider
4. `git.getDiff()` → `prompt.buildPrompt()` → `llm.generate()` → `ui.show()`
5. On `[u]`, write to temp file → `git.commit(tmpfile)`
6. On `[y]`, `clipboard.copyToClipboard(message)`

---

## Module Interfaces

### `src/config.js`
```js
/**
 * Loads config from XDG config dir and auth from XDG data dir.
 * Runs migration if needed.
 * @returns {Promise<{config: object, auth: object}>}
 * @throws {ConfigError} on parse failure or missing required fields
 */
export async function loadConfig()

/**
 * Saves config to ~/.config/kommit/config.json with 0o600.
 * @param {object} config
 * @returns {Promise<void>}
 */
export async function saveConfig(config)

/**
 * Saves auth to ~/.local/share/kommit/auth.json with 0o600.
 * @param {object} auth
 * @returns {Promise<void>}
 */
export async function saveAuth(auth)

/**
 * Runs interactive --init wizard. Creates config if missing; merges auth keys.
 * @returns {Promise<void>}
 */
export async function runInitWizard()

/**
 * Runs interactive --set wizard. Modifies config without touching auth.
 * @param {object} config
 * @param {object} auth
 * @returns {Promise<void>}
 */
export async function runSetWizard(config, auth)

/**
 * Resolves active provider from flags, env, and config.
 * @param {object} config
 * @param {object} flags — parsed CLI args
 * @param {object} env — process.env
 * @returns {string} provider name
 */
export function resolveProvider(config, flags, env, auth)

/**
 * Resolves active skill from flags, env, and config.
 * @param {object} config
 * @param {object} flags — parsed CLI args
 * @param {object} env — process.env
 * @returns {string|null} skill name or null
 */
export function resolveSkill(config, flags, env)

/**
 * Returns all configured providers that have API keys or are local (no key needed).
 * @param {object} config
 * @param {object} auth
 * @param {object} env — process.env
 * @returns {string[]}
 */
export function getAvailableProviders(config, auth, env)
```

### `src/git.js`
```js
/**
 * Gets diff from git. Prefers staged, falls back to unstaged.
 * Intelligently truncates at hunk boundaries.
 * @param {object} providerConfig — contains maxDiffLength
 * @returns {Promise<{diff: string, truncated: boolean, source: 'staged'|'unstaged'}>}
 * @throws {GitError} code: 'not_a_repo' | 'no_changes'
 */
export async function getDiff(providerConfig)

/**
 * Gets the combined working-tree diff against HEAD, including untracked files,
 * and returns file metadata for multi-commit planning.
 * @param {object} providerConfig — contains maxDiffLength
 * @returns {Promise<{diff: string, truncated: boolean, files: Array<{status: string, path: string, displayPath: string, stagePaths: string[]}>}>}
 */
export async function getAllChanges(providerConfig)

/**
 * Stages all tracked file modifications using git add -u.
 * @returns {Promise<void>}
 * @throws {GitError} code: 'stage_failed', includes stderr
 */
export async function stageTracked()

/**
 * Unstages all currently staged changes.
 * @returns {Promise<void>}
 */
export async function unstageAll()

/**
 * Stages the provided files for the next commit.
 * @param {string[]} files
 * @returns {Promise<void>}
 */
export async function stageFiles(files)

/**
 * Commits using a temp file with git commit -F.
 * @param {string} messagePath — path to temp file containing commit message
 * @returns {Promise<{hash: string}>}
 * @throws {GitError} code: 'commit_failed', includes stderr
 */
export async function commit(messagePath)
```

### `src/llm.js`
```js
/**
 * Generates commit message via LLM.
 * @param {string} providerName
 * @param {object} providerConfig
 * @param {string} apiKey — may be empty for local providers
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<string>} raw LLM response content
 * @throws {LLMError} code: 'api_error' | 'timeout' | 'invalid_response'
 */
export async function generateMessage(providerName, providerConfig, apiKey, systemPrompt, userPrompt)

/**
 * Returns true if the error is retryable (5xx, network, timeout).
 * @param {LLMError} error
 * @returns {boolean}
 */
export function isRetryable(error)
```

### `src/prompt.js`
```js
/**
 * Builds the complete prompt. Loads skill from ~/.agents/skills/{skillName}/SKILL.md if skillName is set.
 * @param {string} diff — git diff output
 * @param {object} config
 * @returns {Promise<{system: string, user: string, warning: string|null}>}
 */
export async function buildPrompt(diff, config)

/**
 * Builds the prompt for file-level multi-commit planning.
 * @param {string} diff
 * @param {Array<{status: string, displayPath: string}>} files
 * @param {object} config
 * @returns {Promise<{system: string, user: string, warning: string|null}>}
 */
export async function buildMultiCommitPrompt(diff, files, config)

/**
 * Parses raw LLM response into structured message.
 * @param {string} raw
 * @returns {{subject: string, body: string}}
 * @throws {ParseError} if JSON is invalid or shape is wrong
 */
export function parseResponse(raw)

/**
 * Parses raw LLM response into a multi-commit plan.
 * @param {string} raw
 * @param {string[]|null} allowedFiles
 * @returns {Array<{files: string[], subject: string, body: string}>}
 */
export function parseMultiResponse(raw, allowedFiles)

/**
 * Validates subject against Conventional Commit format.
 * @param {string} subject
 * @returns {boolean}
 */
export function validateSubject(subject)
```

### `src/ui.js`
```js
/**
 * Displays the suggested message and prompts for action.
 * @param {{subject: string, body: string}} message
 * @param {boolean} truncated — whether diff was truncated
 * @param {'staged'|'unstaged'} source — where the diff came from
 * @returns {Promise<'use'|'stageAndUse'|'copy'|'edit'|'regenerate'|'cancel'>}
 */
export async function promptAction(message, truncated, source)

/**
 * Inline editing of subject and body.
 * @param {{subject: string, body: string}} message
 * @returns {Promise<{subject: string, body: string}>}
 */
export async function editMessage(message)

/**
 * Shows an error and prompts for retry or cancel.
 * @param {Error} error
 * @param {boolean} canRetry
 * @param {string[]} availableProviders
 * @returns {Promise<'retry'|'switch'|'cancel'>}
 */
export async function promptError(error, canRetry, availableProviders)

/**
 * Prompts user to select a fallback provider from a list.
 * @param {string[]} providers
 * @returns {Promise<string|null>} selected provider or null if cancelled
 */
export async function promptSelectProvider(providers)

/**
 * Displays a proposed multi-commit plan and returns the next action.
 * @param {Array<{files: string[], subject: string, body: string}>} commits
 * @param {boolean} truncated
 * @returns {Promise<'acceptAll'|'select'|'edit'|'regenerate'|'cancel'>}
 */
export async function promptMultiCommitPlan(commits, truncated)

/**
 * Lets the user choose which proposed commits to execute.
 * @param {Array<{subject: string, files: string[]}>} commits
 * @returns {Promise<number[]|null>}
 */
export async function promptSelectCommits(commits)

/**
 * Lets the user choose one proposed commit to edit.
 * @param {Array<{subject: string, files: string[]}>} commits
 * @returns {Promise<number|null>}
 */
export async function promptSelectCommitToEdit(commits)

/**
 * Wraps a promise in a loading spinner.
 * @param {Promise<T>} promise
 * @param {string} message
 * @returns {Promise<T>}
 */
export async function withSpinner(promise, message)
```

### `src/args.js`
```js
/**
 * Parses process.argv into flags object.
 * @param {string[]} argv
 * @returns {{init: boolean, set: boolean, multi: boolean, provider?: string, skill?: string, dryRun: boolean, verbose: boolean, help: boolean, version: boolean}}
 */
export function parseArgs(argv)

/**
 * Prints compact help text to stdout.
 */
export function printHelp()

/**
 * Returns version string from package.json.
 * @returns {Promise<string>}
 */
export async function getVersion()

/**
 * Resolves API key from env var or auth file.
 * @param {string} provider
 * @param {object} auth
 * @param {object} env
 * @returns {string}
 */
export function getApiKey(provider, auth, env)
```

### `src/clipboard.js`
```js
/**
 * Copies text to the system clipboard.
 * @param {string} text — text to copy
 * @param {string} _platform — optional platform override (for testing)
 * @returns {Promise<void>}
 * @throws {Error} if no clipboard utility is available
 */
export async function copyToClipboard(text, _platform)

/**
 * Sets a mock spawn function for testing.
 * Pass null to reset to real spawn.
 * @param {Function|null} spawnFn
 */
export function setSpawnForTesting(spawnFn)
```

Cross-platform clipboard support:
- **macOS** — Uses built-in `pbcopy`
- **Windows** — Uses built-in `clip.exe`
- **Linux** — Tries `xclip`, then `xsel`, then `wl-copy` in order. Collects all errors and continues to the next tool on any failure (ENOENT, non-zero exit, etc.). If all three fail, throws a descriptive error with diagnostic details.```

---

## Git Diff Handling

### Flow
1. Run `git diff --cached`
2. If empty → print: `"No staged changes found. Using unstaged diff."` and run `git diff`
3. If still empty → exit: `"kommit: No changes detected to commit."`
4. Parse diff into logical units: file headers + hunks
5. Accumulate character count. Keep all file headers (high signal, low cost) and hunks in order.
6. When adding the next complete hunk would exceed the provider's `maxDiffLength`, stop at the hunk boundary.
7. If truncated → append `"\n\n[diff truncated...]"`
8. Return `{ diff: string, truncated: boolean, source: 'staged' | 'unstaged' }`

### Intelligent Hunk Truncation Algorithm
- **Never truncate mid-hunk.** A partial hunk is meaningless to both humans and LLMs.
- Always preserve **all file headers** (`diff --git a/... b/...`) — they tell the model which files changed.
- Preserve hunks in their original order.
- If the diff is truncated, the `truncated` flag is passed to the UI layer so a warning can be shown.

### Edge Cases
| Scenario | Behavior |
|----------|----------|
| Binary files in diff | `git diff` emits `Binary files differ` — include these lines as they signal file changes without content |
| Diff exactly equals `maxDiffLength` | Do **not** append `[diff truncated...]` if the full diff fits exactly |
| Empty hunk (whitespace-only change) | Include it; the LLM can infer `style:` or `refactor:` from context |
| Submodules | `git diff` includes submodule summary lines — treat as file headers, preserve them |

---

## LLM Prompt Engineering

### System Prompt
The base system prompt is baked into `src/prompt.js` as a string literal.

```
You are a commit message generator. Analyze the provided git diff and produce a concise, accurate commit message following the Conventional Commits specification.

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
- If a <skill> section is present in the prompt, use the instructions within it to customize your output style, tone, and conventions. The skill instructions override default behavior where they conflict.
```

If `skillName` is set and `~/.agents/skills/{skillName}/SKILL.md` exists with content, append it after the base rules:

```
---
<skill>
{skillContent}
</skill>
```

### User Prompt
```
--- BEGIN GIT DIFF ---
{diff}
--- END GIT DIFF ---

Generate a commit message for the changes above.
```

The `--- BEGIN/END GIT DIFF ---` delimiters reduce the risk of prompt injection from diff contents.

### Response Parsing
1. Trim whitespace.
2. Defensively strip markdown code fences if present.
3. Parse as JSON. Expected shape: `{"subject": "feat(auth): add JWT validation", "body": "..."}`
4. Wrap `JSON.parse` in `try/catch`. On failure, show the raw LLM output with a warning and allow the user to edit it.
5. Validate `subject` against Conventional Commit regex:
   ```
   /^(feat|fix|docs|style|refactor|perf|test|chore|ci|build)(\([a-z0-9-]+\))?!?: .{1,72}$/
   ```
6. If validation fails, show the message with a warning and allow editing.

---

## CLI Interface & Flow

### Commands
| Command | Behavior |
|---------|----------|
| `kommit` | Main flow: diff → generate → interactive prompt |
| `kommit --init` | Run interactive setup wizard. Creates config if missing; merges auth keys |
| `kommit --set` | Configure default provider, model, or skill name without touching auth |
| `kommit --provider <name>` | Override default provider for this run |
| `kommit --skill <name>` | Override skill for this run |
| `kommit --dry-run` | Generate and show message; do not invoke `git commit` |
| `kommit --verbose` | Print raw prompt, raw response, and exact git commands to stderr |
| `kommit --help`, `-h` | Show help message and exit |
| `kommit --version`, `-v` | Show version number and exit |

### Argument Parsing
Manually parse `process.argv.slice(2)`. No argument parsing dependency. Supported flags:
- `--init`
- `--set`
- `--provider <name>`
- `--skill <name>`
- `--dry-run`
- `--verbose`
- `--help`, `-h`
- `--version`, `-v`

`--help` and `--version` are handled before any config loading or git operations, so they work even when `config.json` is missing.

### First-Run Detection
On startup, check for `~/.config/kommit/config.json`:
- If missing → print: `"Welcome to kommit! Let's set up your LLM provider."` and run the init wizard inline.
- If present but malformed → print parse error and exit with code `1`.

### Main Interactive Flow
After generating the message:

```
Suggested commit message:
─────────────────────────
feat(auth): add JWT validation middleware

Replace session cookies with stateless JWT tokens
 to support API consumption and horizontal scaling.
─────────────────────────

[u] Use this message          (staged diff)
[s] Stage all and use         (unstaged diff)
[y] Copy to clipboard
[e] Edit inline
[r] Regenerate
[c] Cancel
```

#### Options
- **`[u]`** (staged only) — Write the message to a temp file and run `git commit -F <tmpfile>`. On success, print the commit hash. Delete the temp file immediately afterward.
- **`[s]`** (unstaged only) — Run `git add -u` to stage all tracked file modifications, then write the message to a temp file and run `git commit -F <tmpfile>`. This prevents the empty-commit error that occurs when `git commit` is run with no staged changes.
- **`[y]`** — Copy the full message (subject + body) to the system clipboard. Exits with code `0` on success, code `1` on failure. Cross-platform support: macOS (`pbcopy`), Windows (`clip.exe`), Linux (`xclip` → `xsel` → `wl-copy` fallback chain).
- **`[e]`** — Inline editing: use `@clack/prompts` text input to edit the subject line. Then prompt for the body in a second text input (multiline if supported by the library, otherwise single-line with instruction to use `\n` for newlines). After editing, return to the action prompt.
- **`[r]`** — Call the LLM again. Append a subtle variation hint based on a retry counter:
  - 1st retry: `"Try to be more concise."`
  - 2nd retry: `"Focus on the 'why' rather than the 'what'."`
  - 3rd+ retry: `"Use a broader scope if appropriate."`
- **`[c]`** — Exit cleanly with code `0`.

---

## LLM Calls: Timeouts & Retries

### Timeout
- Every LLM call uses `AbortController` with the provider's `timeout` (default `30000` ms).
- On timeout, print `"kommit: LLM request timed out after {timeout}ms"` and offer `[r]etry` or `[c]ancel`.

### Retry Strategy
- **Max 2 retries** (3 attempts total) per provider.
- Only retry on **transient errors**: network failures (`fetch` throws), HTTP `5xx`, or timeouts.
- **Do not retry** on `4xx` errors (bad key, invalid request) — these will not fix themselves.
- No exponential backoff; immediate retry is sufficient for personal use.
- On transient failure, the user is offered three options:
  - **`[r] Retry`** — Retry with the same provider (up to 2 retries)
  - **`[f] Retry with another provider`** — Switch to a different configured provider with a valid API key. The retry counter resets for the new provider.
  - **`[c] Cancel`** — Exit with code `1`
- **Fallback is temporary** — The original provider remains the default in `config.json`. Subsequent `kommit` runs use the original provider.
- **Regeneration uses original provider** — When the user hits `[r] Regenerate` after a successful fallback, the LLM call uses the original provider, not the fallback. The fallback option is available again if the original provider fails during regeneration.

---

## Dependencies

### Runtime
- **`@clack/prompts`** — Modern, minimal interactive prompts (~20KB, zero transitive deps). Provides spinners, selects, confirms, and text inputs.

No other runtime dependencies. Native `fetch`, `fs/promises`, `path`, `os`, `child_process`, and `process` cover everything else.

### Dev
None required for pure JavaScript.

### `package.json` Requirements
```json
{
  "name": "kommit-cli",
  "version": "0.2.1",
  "description": "AI powered Conventional Commit message generator",
  "type": "module",
  "main": "./src/index.js",
  "bin": {
    "kommit": "./bin/kommit"
  },
  "files": ["bin/", "src/", "README.md", "LICENSE"],
  "engines": {
    "node": ">=24.0.0"
  },
  "keywords": ["git", "commit", "cli", "llm", "ai", "conventional-commits"],
  "author": "ohmygodashish",
  "license": "MIT",
  "dependencies": {
    "@clack/prompts": "^1.2.0"
  },
  "scripts": {
    "test": "node --test tests/*.test.js"
  }
}
```
- `"type": "module"` enforces ESM across the project.
- `"engines"` ensures native `fetch` is available (Node 24+).
- `"files"` whitelists only the files needed at runtime, keeping the published package minimal.

---

## Error Handling

All error messages use the `kommit:` prefix for consistency and discoverability.

| Scenario | Behavior |
|----------|----------|
| No git repository | `kommit: Not a git repository.` |
| No changes (staged or unstaged) | `kommit: No changes detected to commit.` |
| Config missing | `kommit: Config not found. Run 'kommit --init' to set up.` |
| Config malformed | `kommit: Failed to parse config: <parse error>` |
| LLM API error (transient: 5xx, network, timeout) | `kommit: LLM API error (<status>): <message>`. Offer `[r]etry` (up to 2), `[f] Retry with another provider`, or `[c]ancel` |
| LLM API error (4xx / non-retryable) | `kommit: LLM API error (<status>): <message>`. Offer `[c]ancel` only |
| LLM returns invalid JSON | Show raw output with warning; allow edit |
| LLM returns non-conventional subject | Show anyway but warn user; allow edit |
| Git commit fails (e.g., hooks) | `kommit: git commit failed:\n<stderr>`. Exit with git's exit code |
| Skill file not found | `kommit: Skill '{name}' not found at {path}. Using base prompt.` (warning, not fatal) |
| Clipboard copy fails | `kommit: Clipboard not available. Install one of: xclip, xsel, or wl-clipboard.`. Exits with code `1` |

---

## Security Considerations
- Both config and auth files are created with `0o600` (read/write owner only).
- API keys are never logged or printed, even with `--verbose`.
- No diff data is cached to disk except temporary commit message files, which are:
  - Written to `os.tmpdir()` with pattern `kommit-msg-{timestamp}-{pid}.txt`
  - Deleted in a `finally` block around the commit operation
  - Deleted via `process.on('SIGINT')` and `process.on('SIGTERM')` handlers if the process is interrupted

---

## Testing Strategy

### Unit Tests (Recommended Framework: `node:test` + `node:assert`)
| Module | Test Cases |
|--------|------------|
| `git.js` | Mock `child_process` output for staged/unstaged/no-changes scenarios; verify hunk truncation boundaries |
| `prompt.js` | Test JSON parsing with/without fences; test Conventional Commit regex against valid and invalid subjects; test skill file loading |
| `config.js` | Test migration logic (v0 → v1); test provider/skill resolution priority; test config/auth file I/O |
| `llm.js` | Mock `fetch` for each provider group; test retry logic; test timeout behavior |
| `clipboard.js` | Mock `spawn` to verify platform-specific commands (pbcopy, clip.exe, xclip/xsel/wl-copy); test Linux fallback chain on ENOENT, non-zero exit, and mixed errors; verify error diagnostics include all tool failures |
| `args.js` | Test flag parsing for all supported options; test API key resolution priority (env > file) |
| `index.js` | Test helper functions (buildFullMessage, getVariationHint, commitMessage); test executeMultiCommits staging logic |
| `ui.js` | Test all prompt functions including promptAction, promptMultiCommitPlan, promptSelectCommits, promptSelectCommitToEdit, withSpinner |

### Integration Tests
- Mock LLM server (local HTTP server returning canned responses)
- End-to-end flow with a temp git repository

### Manual Testing Checklist
- [ ] `--init` creates config and auth with correct permissions
- [ ] `--init` skips existing config, merges new keys into existing auth
- [ ] `--set` modifies defaultProvider and model
- [ ] `--set` modifies skillName (including clearing to null)
- [ ] `--set` fails gracefully when config is missing
- [ ] Staged diff workflow
- [ ] Unstaged fallback workflow with `[s] Stage all and use`
- [ ] Diff truncation on large changesets
- [ ] Each provider group (OpenAI-compatible, Anthropic, Google)
- [ ] `[e]` inline editing
- [ ] `[r]` regeneration with varying hints
- [ ] `--dry-run`
- [ ] `--verbose`
- [ ] `--provider` override
- [ ] `--skill` override
- [ ] `--multi` with staged, unstaged, and untracked files
- [ ] `--multi` select subset of proposed commits
- [ ] `--multi` edit a specific proposed commit before execution
- [ ] `[y]` copy to clipboard (macOS/Linux/Windows)
- [ ] Clipboard fallback chain on Linux (xclip absent, xclip broken, etc.)
- [ ] `[f] Retry with another provider` on transient API error
- [ ] Provider fallback resets to original provider on next `kommit` run
- [ ] Regeneration uses original provider after fallback
- [ ] Skill loading from `~/.agents/skills/{name}/SKILL.md`
- [ ] Error handling: no git repo, no changes, bad API key, timeout, missing skill

---

## Publishing

### npm
```sh
npm install -g kommit-cli
```

### Local development
```sh
npm link        # Symlinks bin/kommit to your global PATH
# or
npm install -g  # Install this directory globally
```

### Requirements
- Node.js >= 24.0.0
- A Git repository

---

## Future Enhancements (Out of Scope for v1)
- `--scope` flag to auto-suggest or enforce scopes per repo
- Learning mode: store accepted messages to fine-tune style over time
- Plugin system for custom prompt templates
- Streaming LLM responses for faster perceived latency

---

## Implementation Order
1. Config module (`src/config.js`) + auth module + `--init` wizard
2. Git module (`src/git.js`) — diff extraction + hunk truncation
3. LLM module (`src/llm.js`) — provider routing + API calls + JSON parsing
4. Prompt module (`src/prompt.js`) — template assembly + skill loading + diff delimiters
5. UI module (`src/ui.js`) — interactive flow + inline editing
6. Main entry (`src/index.js`) — orchestration + manual CLI arg parsing
7. `bin/kommit` executable + `package.json`
8. Test manually against OpenAI + Ollama endpoints
