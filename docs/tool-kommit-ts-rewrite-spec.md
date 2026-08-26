# Kommit — TypeScript Rewrite Specification

## Overview
This document specifies the migration of kommit from plain ESM JavaScript to TypeScript, shipped as **v1.0.0**.

It is a delta against [`tool-kommit-spec.md`](./tool-kommit-spec.md), which remains the authoritative description of what kommit does. Anything not listed here is unchanged: every flag, prompt, error message, exit code, provider integration, config schema, and algorithm behaves exactly as the main specification describes. Where this document and the main specification disagree on file extensions, module paths, or packaging, this document wins for v1.0.0 and above.

## Scope

### In scope
- Convert all 8 source modules and all 11 test files to TypeScript
- Introduce `src/types.ts` as the single home for cross-module data shapes
- Replace `bin/kommit` with `src/cli.ts`
- Add a build that runs only at publish time
- Bump the package version to 1.0.0

### Out of scope
- Any change to CLI behavior, output text, or exit codes
- Any change to the config or auth schema
- Any new runtime dependency
- Restructuring of module boundaries or responsibilities

One exception to "no behavior change" is documented under [Bug Fixed in Passing](#bug-fixed-in-passing).

---

## Version Bump: v0.4.1 to v1.0.0

The major bump reflects the packaging change and declares the CLI surface stable. From v1.0.0 onward, breaking changes require a major bump.

| | v0.4.1 | v1.0.0 |
|---|---|---|
| Language | JavaScript (ESM) | TypeScript |
| Entry point | `bin/kommit` | `src/cli.ts` compiled to `dist/cli.js` |
| Published files | `bin/`, `src/` | `dist/` |
| `main` | `./src/index.js` | `./dist/index.js` |
| Build step | none | `tsc`, at publish time only |
| Dev dependencies | none | `typescript`, `@types/node` |
| Runtime dependencies | `@clack/prompts` | `@clack/prompts` (unchanged) |

### Package version vs config schema version
These are independent and must not be conflated. The config schema `version` field stays at `2`. The rewrite triggers no config migration, and upgrading users see no migration warning.

---

## Language, Build & Runtime

### Hybrid model
Source is TypeScript. There is **no build step for development, testing, or CI**. Node 24 strips types natively, so `node src/cli.ts` and `node --test tests/*.test.ts` run the source directly. `tsc` runs only to produce the published artifact.

| Context | What runs | Build required |
|---------|-----------|----------------|
| Development | `node src/cli.ts` | No (native type stripping) |
| Tests | `node --test tests/*.test.ts` | No |
| CI | `npm run typecheck` + `npm test` | No |
| Published package | `dist/cli.js` | Yes (`prepublishOnly`) |

The published package ships compiled JavaScript rather than TypeScript. This is not a preference, and not a concession to old Node versions — **Node refuses to strip types from any file under `node_modules`, on every version and behind every flag.** See [Why the published package cannot be TypeScript](#why-the-published-package-cannot-be-typescript).

### `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "useUnknownInCatchVariables": false,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "outDir": "dist",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

Three options carry the design:

- **`erasableSyntaxOnly`** keeps the source runnable by Node's type stripper. It forbids enums, parameter properties, and namespaces, none of which the codebase uses. It also prevents them being reintroduced, which would silently break the no-build development path.
- **`rewriteRelativeImportExtensions`** (with `allowImportingTsExtensions`) is what makes the hybrid work. Source is written `import { getDiff } from './git.ts'`, which Node's stripper requires since it does not remap `.js` to `.ts`; `tsc` emits `'./git.js'` into `dist/`.
- **`useUnknownInCatchVariables: false`** keeps the 66 existing `catch` blocks unchanged. They read `.message`, `.stderr`, and `.code` off `execFile` and `fetch` rejections and turn them straight into console output, so narrowing each one buys nothing.

### Error typing
The existing `Object.assign(new Error(...), { code })` pattern is retained rather than replaced with an error class hierarchy. It is described by the `NodeError` type alias, which covers both that pattern and raw `execFile` rejections.

---

## Directory Structure After Rewrite

```
kommit/
├── src/
│   ├── cli.ts              # Executable entry point (shebang node)
│   ├── index.ts            # Main entry: orchestrates flow, handles flags
│   ├── types.ts            # Shared interfaces used across modules
│   ├── args.ts             # Manual CLI argument parsing
│   ├── config.ts           # Config & auth read/write, migration, env overrides
│   ├── git.ts              # Diff extraction, rename detection, hunk truncation
│   ├── llm.ts              # Provider routing, API calls, timeouts, retries
│   ├── prompt.ts           # Prompt template engineering + skill loading
│   ├── ui.ts               # Interactive prompts & inline editing
│   └── clipboard.ts        # Cross-platform clipboard support
├── docs/
│   ├── tool-kommit-spec.md            # Authoritative behavior specification
│   └── tool-kommit-ts-rewrite-spec.md # This file
├── tests/
│   └── *.test.ts           # The 11 renamed files, plus config-wizard.test.ts
├── dist/                   # tsc output; gitignored, generated at build/publish time
├── tsconfig.json
├── package.json
└── README.md
```

The `bin/` directory is deleted. Its 6-line shebang wrapper moves into `src/cli.ts`, which `tsc` compiles to `dist/cli.js`. Shebangs are preserved by the compiler, and npm sets the executable bit on `bin` targets at install time.

This removes a dual-path problem: a checked-in wrapper would have to import from `src/` during development and from `dist/` once published, and it cannot do both.

---

## Core Types (`src/types.ts`)

Every shape passed between modules is declared once here. Modules import types from this file only; no module re-exports another's types.

```ts
export interface ProviderConfig {
  model: string;
  endpoint: string;
  maxDiffLength: number;
  timeout: number;
}

export interface Config {
  version: number;
  defaultProvider: string;
  skillName: string | null;
  providers: Record<string, ProviderConfig>;
  /** Set by main() after skill resolution; read by the prompt builders. */
  _resolvedSkill?: string | null;
}

export type Auth = Record<string, string>;

export interface Flags {
  init: boolean;
  set: boolean;
  multi: boolean;
  undo: boolean;
  undoCount: number;
  provider?: string;
  skill?: string;
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
}

export interface CommitMessage {
  subject: string;
  body: string;
}

export interface CommitPlan extends CommitMessage {
  files: string[];
}

export interface FileChange {
  status: string;
  changeType: string;
  path: string;
  displayPath: string;
  stagePaths: string[];
}

export interface DiffResult {
  diff: string;
  truncated: boolean;
  source: 'staged' | 'unstaged';
  stagePaths: string[];
}

export interface ChangeResult {
  diff: string;
  truncated: boolean;
  files: FileChange[];
}

export interface LogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  parents: string[];
}

export interface PromptResult {
  system: string;
  user: string;
  warning: string | null;
}

export interface UndoResult {
  previousHead: string;
  newHead: string;
  commitCount: number;
}

/** Covers both the Object.assign(new Error, {code}) pattern and execFile rejections. */
export type NodeError = Error & {
  code?: string | number;
  stderr?: string;
  exitCode?: number;
  status?: number;
  raw?: string;
};
```

`Config._resolvedSkill` is the one field that exists for cross-module plumbing rather than persistence. `main()` writes it after skill resolution and the prompt builders read it; it is never written to `config.json`.

---

## Module Interfaces

These are the TypeScript signatures for the exports already described in the main specification. Behavioral contracts and error semantics are documented there and are unchanged.

### `src/config.ts`
```ts
export async function loadConfig(): Promise<{ config: Config; auth: Auth }>
// throws: code 'CONFIG_MISSING' | 'CONFIG_PARSE_ERROR' | 'AUTH_PARSE_ERROR'

export async function saveConfig(config: Config): Promise<void>
export async function saveAuth(auth: Auth): Promise<void>

export function migrateConfig(
  config: Config
): { config: Config; migrated: boolean; warning: string | null }

export async function runInitWizard(): Promise<void>
export async function runSetWizard(config: Config, auth: Auth): Promise<void>

export function resolveProvider(
  config: Config,
  flags: Flags,
  env: NodeJS.ProcessEnv,
  auth?: Auth
): string | null

export function resolveSkill(
  config: Config,
  flags: Flags,
  env: NodeJS.ProcessEnv
): string | null

export function getAvailableProviders(
  config: Config,
  auth: Auth,
  env?: NodeJS.ProcessEnv
): string[]

/** Test seam for the wizards. Pass null to restore the real @clack functions and process.exit. */
export function setPromptsForTesting(overrides: PromptOverrides | null): void

interface PromptOverrides {
  intro?: (title?: string) => void;
  outro?: (message?: string) => void;
  select?: <Value>(opts: SelectOptions<Value>) => Promise<Value | symbol>;
  confirm?: (opts: ConfirmOptions) => Promise<boolean | symbol>;
  password?: (opts: PasswordOptions) => Promise<string | symbol>;
  text?: (opts: TextOptions) => Promise<string | symbol>;
  isCancel?: (value: unknown) => value is symbol;
  exit?: (code: number) => never;
}
```

`MIGRATION_NOTES` and `PROVIDER_LABELS` are declared `Record<number, string>` and `Record<string, string>` so their dynamic lookups typecheck.

`runInitWizard` and `runSetWizard` route **every** `@clack` call and every exit through `setPromptsForTesting`, which is what makes them testable — before it they called `prompts.*` and `process.exit` directly and had no coverage at all. A single options object is used rather than `ui.ts`'s positional arguments because eight nullable positional parameters would be unreadable.

`intro` and `outro` are purely decorative but **must** be included, which was found the hard way. They write raw ANSI cursor sequences to `process.stdout`, and `node --test` uses that same stream for its serialized IPC with each test child. Left unstubbed they corrupt the framing, and the file dies with:

```
Error: Unable to deserialize cloned data due to invalid or unsupported version.
    at #processRawBuffer (node:internal/test_runner/runner:410:20)
```

The failure is load-dependent, so it presents as a flake rather than a clean error: with them unstubbed the full suite failed 5 runs out of 8, with a different test count each time; with them stubbed, 10 out of 10 clean. `tests/config-wizard.test.ts` funnels every case through one `overrides()` helper that always supplies them, so no future test can reintroduce it.

`exit` is typed `(code: number) => never`, so a test stub **must throw**. That mirrors what `process.exit` does to control flow and makes it impossible for a test to run past an exit and assert against state the real CLI would never have reached.

### `src/git.ts`
```ts
export async function getDiff(providerConfig: ProviderConfig): Promise<DiffResult>
// throws: code 'not_a_repo' | 'no_changes'

export async function getAllChanges(providerConfig: ProviderConfig): Promise<ChangeResult>
// throws: code 'no_changes'

export async function stageTracked(renamePaths?: string[]): Promise<void>
// throws: code 'stage_failed', includes stderr

export async function unstageAll(): Promise<void>
// throws: code 'unstage_failed'

export async function stageFiles(files: string[]): Promise<void>
// throws: code 'stage_failed'

export async function commit(messagePath: string): Promise<{ hash: string }>
// throws: code 'commit_failed', includes stderr and git's numeric exit code

export async function getRepoRoot(): Promise<string>

export async function getLastCommits(count: number): Promise<LogEntry[]>
// throws: code 'history_failed'

export async function isMergeCommit(hash: string): Promise<boolean>
export async function isCommitPushed(commitHash: string): Promise<boolean>

export async function undoCommits(count: number): Promise<UndoResult>
// throws: code 'undo_failed'
```

The internal `withTemporaryIndex` helper is generic over its callback's result. The options shape is a named alias, shared with `execGit`'s parameter rather than written inline twice:
```ts
interface GitOptions {
  env?: NodeJS.ProcessEnv;
}

function withTemporaryIndex<T>(callback: (options: GitOptions) => Promise<T>): Promise<T>
```

### `src/llm.ts`
```ts
export class LLMError extends Error {
  code?: string;
  status?: number | null;
  body?: string | null;
  constructor(message: string, code?: string, status?: number | null, body?: string | null);
}

export async function generateMessage(
  providerName: string,
  providerConfig: ProviderConfig,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string>
// throws LLMError: code 'api_error' | 'timeout' | 'network' | 'invalid_response' | 'unknown_provider'

export function isRetryable(error: NodeError | LLMError): boolean
```

Each provider group declares a minimal response interface (`OpenAIResponse`, `AnthropicResponse`, `GoogleResponse`) that `await res.json()` is cast to. These describe only the fields actually read. The existing optional-chaining checks remain the real validation, since a cast asserts nothing at runtime.

### `src/prompt.ts`
```ts
export async function buildPrompt(diff: string, config: Config): Promise<PromptResult>

export async function buildMultiCommitPrompt(
  diff: string,
  files: FileChange[],
  config: Config
): Promise<PromptResult>

export function parseResponse(raw: string): CommitMessage
// throws: code 'PARSE_ERROR', carries the raw output

/**
 * allowedFiles accepts either a flat list of canonical identifiers, or an
 * alias -> canonical map from buildFileAliases(). Every referenced file is
 * resolved through it, so the returned plans always carry canonical ids.
 */
export function parseMultiResponse(
  raw: string,
  allowedFiles?: string[] | Map<string, string> | null
): CommitPlan[]
// throws: code 'PARSE_ERROR', carries the raw output

export function validateSubject(subject: string): boolean
```

`JSON.parse` returns `any`, so the runtime shape checks in both parsers are unchanged. Types do not replace them: the LLM response is untrusted input and validation stays a runtime concern.

The `Map` form of `allowedFiles` exists because a rename is identified to the model as
the display string `old -> new`, which is not a path, so the model answers with a real
path from one side or the other. `parseMultiResponse` canonicalises before validating,
collapses aliases of the same file named twice within one commit group, and still
rejects the same file appearing in two different commits. The `string[]` form is
retained as identity aliasing, which is what every existing test passes.

### `src/ui.ts`
```ts
export type MessageAction = 'use' | 'stageAndUse' | 'copy' | 'edit' | 'regenerate' | 'cancel';
export type PlanAction = 'acceptAll' | 'select' | 'edit' | 'regenerate' | 'cancel';
export type ErrorAction = 'retry' | 'switch' | 'cancel';
export type UndoAction = 'regenerate' | 'edit' | 'cancel';

export async function promptAction(
  message: CommitMessage,
  truncated: boolean,
  source: 'staged' | 'unstaged'
): Promise<MessageAction>

export async function editMessage(message: CommitMessage): Promise<CommitMessage>

export async function promptError(
  error: Error,
  canRetry: boolean,
  availableProviders?: string[]
): Promise<ErrorAction>

export async function promptSelectProvider(providers: string[]): Promise<string | null>

export async function promptMultiCommitPlan(
  commits: CommitPlan[],
  truncated: boolean
): Promise<PlanAction>

export async function promptSelectCommits(commits: CommitPlan[]): Promise<number[] | null>
export async function promptSelectCommitToEdit(commits: CommitPlan[]): Promise<number | null>

export async function withSpinner<T>(promise: Promise<T>, message: string): Promise<T>

export async function promptUndoConfirmation(
  commits: LogEntry[],
  pushedCommits: Set<string>
): Promise<'yes' | 'cancel'>

export async function promptUndoAction(count: number): Promise<UndoAction>

/** Test seam: pass null for any argument to restore the real @clack function. */
export function setSelectForTesting(
  selectFn: SelectFn | null,
  isCancelFn: IsCancelFn | null,
  multiselectFn: MultiselectFn | null,
  textFn: TextFn | null
): void
```

The action union types give `index.ts` exhaustiveness checking on its action branches.

`@clack/prompts` returns `T | symbol`, where the symbol signals cancellation. Because the module routes every call through an override wrapper for testability, the narrowing that `isCancel` normally provides is lost across that indirection. The wrappers are therefore generic pass-throughs, and the local `_isCancel` is declared as a type predicate:
```ts
function _isCancel(value: unknown): value is symbol
```

### `src/args.ts`
```ts
export function parseArgs(argv: string[]): Flags
export function printHelp(): void

/** Reads version from package.json via createRequire; resolves from both src/ and dist/. */
export async function getVersion(): Promise<string>

export function getApiKey(provider: string, auth: Auth, env: NodeJS.ProcessEnv): string
```

The `envMap` lookup tables are annotated `Record<string, string>` so indexing by an arbitrary provider name typechecks.

### `src/clipboard.ts`
```ts
/** _platform is a test-only override of process.platform. */
export async function copyToClipboard(text: string, _platform?: NodeJS.Platform): Promise<void>

/** Test seam: pass null to restore the real child_process.spawn. */
export function setSpawnForTesting(spawnFn: typeof spawn | null): void
```

### `src/index.ts`
```ts
/** Generic over the parse result, covering both the single- and multi-commit call sites. */
interface GenerateOptions<T> {
  config: Config;
  auth: Auth;
  flags: Flags;
  systemPrompt: string;
  userPrompt: string;
  originalProvider: string;
  originalProviderConfig: ProviderConfig;
  originalApiKey: string;
  spinnerMessage: string;
  parse: (raw: string) => T;
  resetToOriginalOnRetry?: boolean;
  allowRawFallback?: boolean;
}

export async function generateWithFallback<T>(options: GenerateOptions<T>): Promise<T | null>

export function buildFullMessage(message: CommitMessage): string
export function getVariationHint(count: number): string
export async function commitMessage(message: CommitMessage): Promise<{ hash: string }>
/**
 * Maps a file's displayPath, path, and both stagePaths to one canonical displayPath,
 * so a rename can be referenced by either real path. An entry's own displayPath always
 * wins, and genuinely ambiguous aliases are dropped rather than guessed, so no alias
 * can shadow a real file and cause the wrong file to be staged.
 */
export function buildFileAliases(files: FileChange[]): Map<string, string>

export async function executeMultiCommits(
  commits: CommitPlan[],
  changeMap: Map<string, FileChange>
): Promise<void>

export async function main(): Promise<void>

/** Test seam: pass null to restore the real process.exit. An override must throw. */
export function setExitForTesting(fn: ((code: number) => never) | null): void

/** Shared by runSingleCommitFlow, runMultiCommitFlow and runUndoFlow. */
interface FlowOptions {
  flags: Flags;
  config: Config;
  auth: Auth;
  provider: string;
  providerConfig: ProviderConfig;
  apiKey: string;
}
```

The flow functions are written on the assumption that `_exit()` terminates: they read values assigned inside a `try` whose `catch` exits, and treat `if (!plan) _exit(1)` as a narrowing. `process.exit` is already typed `never`, so the whole seam is typed `never` and no cast is needed:

```ts
let _exitFn: (code: number) => never = (code: number) => process.exit(code);

export function setExitForTesting(fn: ((code: number) => never) | null): void {
  _exitFn = fn || ((code: number) => process.exit(code));
}
```

A test override must therefore **throw**, matching what `process.exit` does to control flow. A non-throwing stub would let a test run past an exit and assert against a state the real CLI can never reach — sometimes crashing on an unassigned value, but sometimes passing while asserting a fiction, which is worse. `tests/config-wizard.test.ts` shows the pattern with its `ExitSignal` class.

**Enforcement caveat.** `npm run typecheck` will *not* catch a non-throwing stub, because `tsconfig.json` includes `src/**/*.ts` only — tests are deliberately excluded so they never land in `dist/`. The constraint is enforced by editors (the TypeScript language server checks the open file) and by any `tsc` run that includes `tests/`; it is not enforced in CI. Adding tests to a typecheck-only project would close that gap, but they are written in an untyped JavaScript style and currently produce ~308 errors, mostly implicit `any`. That is its own piece of work, not a precondition for this seam.

### `src/cli.ts`
```ts
#!/usr/bin/env node
import { main } from './index.ts';

main().catch((err: NodeError) => {
  console.error(`kommit: ${err.message}`);
  process.exit(1);
});
```

---

## Packaging

```json
{
  "name": "kommit-cli",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "bin": {
    "kommit": "./dist/cli.js"
  },
  "files": ["dist/", "README.md", "LICENSE"],
  "engines": {
    "node": ">=24.0.0"
  },
  "dependencies": {
    "@clack/prompts": "^1.2.0"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "@types/node": "^24.0.0"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "node --test tests/*.test.ts",
    "prepublishOnly": "npm run build"
  }
}
```

- `"files"` whitelists `dist/` only. `src/` is no longer published, and `bin/` no longer exists.
- `"build"` exists as a standalone script, not only inside `prepublishOnly`, because `npm link` needs `dist/` to exist before the linked `kommit` binary resolves.
- `dist/` is gitignored. It is a generated artifact and is never committed.

### Why the published package cannot be TypeScript

Shipping `src/*.ts` and dropping `tsc` entirely was tried and **does not work**. Node declines to strip types for any file resolved under `node_modules`:

```
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently
unsupported for files under node_modules, for ".../node_modules/kommit-cli/src/cli.ts"
```

Measured on Node 24 with `bin` pointed at `./src/cli.ts` and `files: ["src/"]`:

| Scenario | Result |
|---|---|
| `npm pack` | clean tarball, `src/*.ts` only |
| `npm install -g <tarball>` | **exits 0** — the failure is silent |
| running the installed `kommit` | `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` |
| `--experimental-strip-types` / `--experimental-transform-types` | same error |
| the identical file copied outside `node_modules` | runs fine |

It is a path-based restriction, deliberate on Node's part: a package author may not push transpilation cost onto every consumer. No Node version or flag lifts it.

**`npm link` does not reproduce this.** The link is a symlink pointing out of `node_modules` to the working copy, so the resolved path never contains `node_modules` and the linked binary works perfectly. Linking would keep passing indefinitely while every published install was broken — which is why CI installs a packed tarball rather than linking. See [Build verification](#build-verification).

### Dependencies
- **Runtime**: unchanged. `@clack/prompts` only, which ships its own `index.d.mts`, so no `@types` package is needed for it.
- **Dev**: `typescript` (^5.9, required at 5.7+ for `rewriteRelativeImportExtensions`) and `@types/node` (^24). Neither is needed to run the published package.

### Local development
```sh
node src/cli.ts            # Run directly, no build
npm run typecheck          # tsc --noEmit
npm test                   # node --test tests/*.test.ts
npm run build && npm link  # Build first: the linked binary resolves to dist/cli.js
```

---

## Testing & Type Checking

### Type checking
`npm run typecheck` (`tsc --noEmit`) covers every file under `src/`, including `src/cli.ts`. In CI it replaces the `node --check bin/kommit` step, which existed only because that entry point was never imported by a test.

### Unit tests
Test files are renamed to `.ts` and run directly under Node's type stripping. Assertions are unchanged from the JavaScript suite; the migration is a rename plus import-specifier updates.

Coverage gained one file the JavaScript suite never had. `tests/config-wizard.test.ts` covers `runInitWizard` and `runSetWizard`, which previously called `prompts.*` and `process.exit` directly and so had no tests at all — the gap that let the unreachable branch in [Unreachable branch removed from `runSetWizard`](#unreachable-branch-removed-from-runsetwizard) survive unnoticed. Coverage of every other module is unchanged from the main specification.

Types are not a substitute for the suite. Its value is concentrated in runtime behavior the compiler cannot see: real git repositories in temp dirs, malformed LLM output, and missing clipboard binaries.

### Build verification
The published path needs its own check, since no unit test exercises `tsc` output:
- `npm run build && node dist/cli.js --help` and `--version`, confirming `rewriteRelativeImportExtensions` emitted resolvable specifiers
- `npm pack --dry-run`, confirming the tarball contains `dist/` and no longer references `bin/`

CI carries this as a dedicated `package` job, which builds, packs, installs the tarball globally, and runs the installed binary. It must **install the tarball**, never `npm link` — for the reason in [Why the published package cannot be TypeScript](#why-the-published-package-cannot-be-typescript), a link resolves out of `node_modules` and would pass even when the published package is completely broken. `npm pack` does not run `prepublishOnly`, so the job builds explicitly.

---

## Bug Fixed in Passing

`commit()` in `src/git.ts` assigned `err.code` from an `execFile` rejection, a numeric exit code, into the same `code` field that every other error in the codebase uses for string tags such as `'commit_failed'` and `'not_a_repo'`:

```js
// before
{ code: 'commit_failed', exitCode: err.code || 1 }
```

`err.code` on an `execFile` rejection is the process exit code, so `exitCode` was correct only by accident and `code` was inconsistent with the rest of the codebase. After the rewrite the numeric exit code populates `exitCode` only when it is actually a number, and `code` is consistently a string tag. User-visible behavior is unchanged: `kommit` still exits with git's exit code when a commit fails.

### Unreachable branch removed from `runSetWizard`

Typing `config.providers` as `Record<string, ProviderConfig>` surfaced a guard that could never fire:

```js
// before
if (!config.providers[selectedProvider]) {
  config.providers[selectedProvider] = {};   // missing every ProviderConfig field
}
```

`selectedProvider` is chosen from `availableProviders`, which is built by iterating `Object.keys(config.providers)` — and when that list is empty the function has already exited. The key therefore always exists. Had the branch ever run it would have built a provider with no `endpoint`, surfacing later inside `generateMessage` as an unrelated-looking error. Casting to `ProviderConfig` would have asserted a shape the branch demonstrably does not build, so the branch was deleted instead. Unreachable code has no behavior, so nothing user-visible changed.

---

## Rewrite Order

Ported leaf-first so no module is converted before its imports. The full test suite and `tsc --noEmit` run after each step, keeping every commit green.

1. Tooling: `tsconfig.json`, dev dependencies, `package.json` scripts and version bump, `dist/` in `.gitignore`
2. `src/types.ts`, written before any module consumes it
3. `src/args.ts` + `tests/args.test.ts`
4. `src/clipboard.ts` + `tests/clipboard.test.ts`
5. `src/prompt.ts` + `tests/prompt.test.ts`, `tests/prompt-edge.test.ts`
6. `src/llm.ts` + `tests/llm.test.ts`
7. `src/git.ts` + `tests/git.test.ts`, `tests/git-edge.test.ts`
8. `src/config.ts` + `tests/config.test.ts`, `tests/config-io.test.ts`
9. `src/ui.ts` + `tests/ui.test.ts`, `tests/ui-more.test.ts`
10. `src/index.ts` + `tests/index.test.ts`
11. `src/cli.ts` replaces `bin/kommit`; delete `bin/`
12. CI: replace the `node --check bin/kommit` step with `npm run typecheck`
13. Verify the published path

---

## Acceptance

The rewrite is complete when all of the following hold:

- [ ] `npm test` passes with the same assertions as v0.4.1, on ubuntu-latest and macos-latest
- [ ] `npm run typecheck` is clean
- [ ] No `.js` files remain under `src/` or `tests/`, and `bin/` is deleted
- [ ] `npm run build` succeeds and `node dist/cli.js --help` and `--version` work
- [ ] `npm pack --dry-run` lists `dist/` and no `src/` or `bin/`
- [ ] End to end in a scratch repo: `node src/cli.ts --dry-run` and `node dist/cli.js --dry-run` both produce a message without committing
- [ ] `node src/cli.ts --multi --dry-run` produces a valid plan, exercising temporary-index rename detection and the multi-commit parser
- [ ] An existing v0.4.1 user's `config.json` loads with no migration warning

---

## Related Documents

- [`tool-kommit-spec.md`](./tool-kommit-spec.md) — authoritative behavior specification, unchanged by this rewrite
