import type { ChangeResult, CommitPlan, Config, DiffResult, FileChange, Flags, LogEntry, ProviderConfig } from '../src/types.ts';

// Builders for the cross-module shapes. Tests supply only the fields the code under test
// actually reads; these fill in the rest so the argument still satisfies its type.
// Not a *.test.ts file, so the runner's glob skips it while tsconfig still checks it.

export function providerConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    model: 'test-model',
    endpoint: 'https://example.test/v1/chat/completions',
    maxDiffLength: 12000,
    timeout: 30000,
    ...overrides
  };
}

export function config(overrides: Partial<Config> = {}): Config {
  return {
    version: 2,
    defaultProvider: 'openai',
    skillName: null,
    providers: { openai: providerConfig() },
    ...overrides
  };
}

export function flags(overrides: Partial<Flags> = {}): Flags {
  return {
    init: false,
    set: false,
    multi: false,
    undo: false,
    undoCount: 1,
    provider: undefined,
    skill: undefined,
    dryRun: false,
    verbose: false,
    help: false,
    version: false,
    ...overrides
  };
}

export function fileChange(overrides: Partial<FileChange> = {}): FileChange {
  const path = overrides.path ?? overrides.displayPath ?? 'src/file.js';
  return {
    status: 'M ',
    changeType: 'M',
    path,
    displayPath: path,
    stagePaths: [path],
    ...overrides
  };
}

export function commitPlan(overrides: Partial<CommitPlan> = {}): CommitPlan {
  return {
    subject: 'feat: change',
    body: '',
    files: ['src/file.js'],
    ...overrides
  };
}

export function diffResult(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    diff: '',
    truncated: false,
    source: 'staged',
    stagePaths: [],
    ...overrides
  };
}

export function changeResult(overrides: Partial<ChangeResult> = {}): ChangeResult {
  return {
    diff: '',
    truncated: false,
    files: [],
    ...overrides
  };
}

export function logEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    hash: 'a'.repeat(40),
    shortHash: 'aaaaaaa',
    subject: 'feat: change',
    body: '',
    parents: [],
    ...overrides
  };
}

/** Builds a providers map from names alone, for tests that only care which keys exist. */
export function providers(...names: string[]): Record<string, ProviderConfig> {
  return Object.fromEntries(names.map(name => [name, providerConfig()]));
}

// The exit seams (`setExitForTesting`, the wizards' `exit`) are typed `never`, so a stub
// has to throw. That is what process.exit does to control flow in production, and it means
// no test can silently run past an exit.
export class ExitSignal extends Error {
  code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}
