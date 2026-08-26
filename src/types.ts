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
  /** Set by main() after skill resolution; read by the prompt builders. Never persisted. */
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

/** Covers both the Object.assign(new Error, { code }) pattern and execFile rejections. */
export type NodeError = Error & {
  code?: string | number;
  stderr?: string;
  exitCode?: number;
  status?: number;
  raw?: string;
};
