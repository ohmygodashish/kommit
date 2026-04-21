![Banner](images/kommit.png)

## Installation

```bash
npm install -g kommit-cli
```

Requires Node.js **24+**.

## Quick Start

```bash
# On first run (no config found), kommit will automatically launch the setup wizard.
# This generates ~/.config/kommit/config.json and ~/.local/share/kommit/auth.json
kommit

# Add API keys for additional providers (merges into existing auth.json)
kommit --init

# Configure default provider, model, or skill without touching auth
kommit --set

# Generate a commit message from your staged (or unstaged) changes
kommit
```

## Supported Providers

- **Cloud Providers:** OpenAI, Anthropic, Google, OpenRouter
- **Local Providers:** Ollama, LM Studio


## Usage

```bash
kommit [options]
```

| Option | Description |
|--------|-------------|
| `--init` | Run the interactive setup wizard (creates config if missing, merges auth keys) |
| `--set` | Configure default provider, model, or skill name |
| `--provider <name>` | Override the default provider for this run |
| `--skill <name>` | Override skill for this run |
| `--dry-run` | Generate and show the message without committing |
| `--verbose` | Print raw prompts, responses, and git commands |

## Interactive Flow

After generating a message, you'll see:

**Staged changes:**
```
Suggested commit message:
─────────────────────────
feat(auth): add JWT validation middleware
─────────────────────────

[u] Use this message
[e] Edit inline
[r] Regenerate
[c] Cancel
```

**Unstaged changes:**
```
No staged changes found. Using unstaged diff.

Suggested commit message:
─────────────────────────
feat(auth): add JWT validation middleware
─────────────────────────

[s] Stage all and use
[e] Edit inline
[r] Regenerate
[c] Cancel
```

**All options:**
- **[u]** — Commit with the suggested message (staged diff only)
- **[s]** — Stage all tracked changes and commit (unstaged diff only)
- **[e]** — Edit the subject and body inline
- **[r]** — Regenerate with a variation hint
- **[c]** — Cancel

## Configuration

Config lives in `~/.config/kommit/config.json`.
API keys are stored separately in `~/.local/share/kommit/auth.json` so you can version-control your preferences without leaking secrets.

Kommit follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html):
- Config: `$XDG_CONFIG_HOME/kommit/` (falls back to `~/.config/kommit/`)
- Auth keys: `$XDG_DATA_HOME/kommit/` (falls back to `~/.local/share/kommit/`)

### Default Provider

Set your default LLM provider in `~/.config/kommit/config.json`:

```json
{
  "defaultProvider": "openai"
}
```

Supported values: `openai`, `anthropic`, `google`, `openrouter`, `ollama`, `lmstudio`.

Override the default for a single run with the `--provider` flag:

```bash
kommit --provider anthropic
```

The provider selection follows this priority (highest to lowest):
1. `--provider <name>` CLI flag
2. `KOMMIT_PROVIDER` environment variable
3. `defaultProvider` in `~/.config/kommit/config.json`

Skill selection follows the same pattern:
1. `--skill <name>` CLI flag
2. `KOMMIT_SKILL` environment variable
3. `skillName` in `~/.config/kommit/config.json`

### Environment Variables

You can also set API keys via environment variables (they take precedence over file-based auth):

```bash
export KOMMIT_PROVIDER=openai
export KOMMIT_SKILL=my-team
export KOMMIT_OPENAI_API_KEY=sk-...
export KOMMIT_ANTHROPIC_API_KEY=sk-ant-...
export KOMMIT_GOOGLE_API_KEY=...
export KOMMIT_OPENROUTER_API_KEY=sk-or-...
```

### Skills

Kommit supports modular skills stored in `~/.agents/skills/{skillName}/SKILL.md`. Skills let you teach kommit your team's commit style, conventions, and preferences.

**Example skill layout:**
```
~/.agents/skills/
├── my-team/
│   └── SKILL.md
└── personal/
    └── SKILL.md
```

**Example `~/.agents/skills/my-team/SKILL.md`:**

```markdown
# My Team's Commit Style

- Always include a body explaining the motivation.
- Use emojis in the subject line when appropriate.
- For breaking changes, add "BREAKING CHANGE:" in the body.
- Keep subjects under 50 characters when possible.
```

**Enable it in config:**

```json
{
  "skillName": "my-team"
}
```

If the skill file is missing, kommit prints a warning and falls back to the base prompt.

### Changing Settings with `--set`

Use `kommit --set` to modify your configuration without touching auth keys:

```bash
# Change default provider and model
kommit --set

# This opens an interactive wizard where you can:
# - Select a new default provider (from providers with API keys + local ones)
# - Update the model name for that provider
# - Change or clear your skill name
```

This is useful when you want to switch providers or models without re-entering API keys.

### Sample Config Files

> **Note:** `kommit --init` generates these files for you automatically. You only need to edit them manually if you want to tweak advanced settings.

`~/.config/kommit/config.json`:

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

`~/.local/share/kommit/auth.json`:

```json
{
  "openai": "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "anthropic": "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "google": "AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "openrouter": "sk-or-v1-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

## How It Works

1. Reads your `git diff --cached` (falls back to unstaged if empty)
2. Intelligently truncates large diffs at hunk boundaries
3. Sends the diff to your chosen LLM with a structured prompt
4. Parses the JSON response into a Conventional Commit
5. Lets you review, edit, regenerate, or commit
6. For unstaged diffs, offers to stage all tracked changes before committing

## License

MIT
