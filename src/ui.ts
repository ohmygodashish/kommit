import * as prompts from '@clack/prompts';
import type { MultiSelectOptions, Option, SelectOptions, TextOptions } from '@clack/prompts';
import type { CommitMessage, CommitPlan, LogEntry } from './types.ts';

export type MessageAction = 'use' | 'stageAndUse' | 'copy' | 'edit' | 'regenerate' | 'cancel';
export type PlanAction = 'acceptAll' | 'select' | 'edit' | 'regenerate' | 'cancel';
export type ErrorAction = 'retry' | 'switch' | 'cancel';
export type UndoAction = 'regenerate' | 'edit' | 'cancel';

// Every call routes through an override wrapper for testability, which would drop @clack's
// `T | symbol` narrowing. Generic pass-throughs plus a predicate _isCancel keep it.
type SelectFn = <Value>(opts: SelectOptions<Value>) => Promise<Value | symbol>;
type IsCancelFn = (value: unknown) => value is symbol;
type MultiselectFn = <Value>(opts: MultiSelectOptions<Value>) => Promise<Value[] | symbol>;
type TextFn = (opts: TextOptions) => Promise<string | symbol>;

let _selectOverride: SelectFn | null = null;
let _isCancelOverride: IsCancelFn | null = null;
let _multiselectOverride: MultiselectFn | null = null;
let _textOverride: TextFn | null = null;

export function setSelectForTesting(
  selectFn: SelectFn | null,
  isCancelFn: IsCancelFn | null,
  multiselectFn: MultiselectFn | null,
  textFn: TextFn | null
): void {
  _selectOverride = selectFn || null;
  _isCancelOverride = isCancelFn || null;
  _multiselectOverride = multiselectFn || null;
  _textOverride = textFn || null;
}

function _select<Value>(options: SelectOptions<Value>): Promise<Value | symbol> {
  if (_selectOverride) {
    return _selectOverride(options);
  }
  return prompts.select(options);
}

function _isCancel(value: unknown): value is symbol {
  if (_isCancelOverride) {
    return _isCancelOverride(value);
  }
  return prompts.isCancel(value);
}

function _multiselect<Value>(options: MultiSelectOptions<Value>): Promise<Value[] | symbol> {
  if (_multiselectOverride) {
    return _multiselectOverride(options);
  }
  return prompts.multiselect(options);
}

function _text(options: TextOptions): Promise<string | symbol> {
  if (_textOverride) {
    return _textOverride(options);
  }
  return prompts.text(options);
}

export async function promptAction(message: CommitMessage, truncated: boolean, source: 'staged' | 'unstaged'): Promise<MessageAction> {
  console.log('');
  console.log('Suggested commit message:');
  console.log('─────────────────────────');
  console.log(message.subject);
  if (message.body) {
    console.log('');
    console.log(message.body);
  }
  console.log('─────────────────────────');
  if (truncated) {
    console.log('⚠️  Warning: diff was truncated. Message may be incomplete.');
  }
  console.log('');

  const useOption: Option<MessageAction> = source === 'unstaged'
    ? { value: 'stageAndUse', label: '[s] Stage all and use' }
    : { value: 'use', label: '[u] Use this message' };

  const action = await _select<MessageAction>({
    message: 'What would you like to do?',
    options: [
      useOption,
      { value: 'copy', label: '[y] Copy to clipboard' },
      { value: 'edit', label: '[e] Edit inline' },
      { value: 'regenerate', label: '[r] Regenerate' },
      { value: 'cancel', label: '[c] Cancel' }
    ]
  });

  if (_isCancel(action)) {
    return 'cancel';
  }

  return action;
}

export async function editMessage(message: CommitMessage): Promise<CommitMessage> {
  const subject = await _text({
    message: 'Edit subject line:',
    initialValue: message.subject
  });

  if (_isCancel(subject)) {
    return message;
  }

  const body = await _text({
    message: 'Edit body (use \\n for newlines, leave empty for no body):',
    initialValue: message.body
  });

  if (_isCancel(body)) {
    return { subject, body: message.body };
  }

  return {
    subject: subject.trim(),
    body: body.trim().replace(/\\n/g, '\n')
  };
}

export async function promptError(error: Error, canRetry: boolean, availableProviders: string[] = []): Promise<ErrorAction> {
  const options: Option<ErrorAction>[] = [
    ...(canRetry ? [{ value: 'retry' as const, label: '[r] Retry' }] : []),
    ...(availableProviders.length > 0 ? [{ value: 'switch' as const, label: '[f] Retry with another provider' }] : []),
    { value: 'cancel' as const, label: '[c] Cancel' }
  ];

  const action = await _select<ErrorAction>({
    message: `Error: ${error.message}`,
    options
  });

  if (_isCancel(action)) {
    return 'cancel';
  }

  return action;
}

export async function promptSelectProvider(providers: string[]): Promise<string | null> {
  const options = providers.map(name => ({
    value: name,
    label: name
  }));

  const selected = await _select({
    message: 'Choose a fallback provider:',
    options
  });

  if (_isCancel(selected)) {
    return null;
  }

  return selected;
}

export async function promptMultiCommitPlan(commits: CommitPlan[], truncated: boolean): Promise<PlanAction> {
  console.log('');
  console.log('Proposed commits:');
  console.log('─────────────────');
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    console.log(`${i + 1}. ${commit.subject}`);
    console.log(`   → ${commit.files.join(', ')}`);
    if (commit.body) {
      console.log(`   ${commit.body.split('\n')[0]}`);
    }
    console.log('');
  }
  if (truncated) {
    console.log('⚠️  Warning: diff was truncated. Plan may be incomplete.');
    console.log('');
  }

  const action = await _select<PlanAction>({
    message: 'What would you like to do?',
    options: [
      { value: 'acceptAll', label: '[a] Accept all and commit' },
      { value: 'select', label: '[s] Select which to commit' },
      { value: 'edit', label: '[e] Edit a commit message' },
      { value: 'regenerate', label: '[r] Regenerate' },
      { value: 'cancel', label: '[c] Cancel all' }
    ]
  });

  if (_isCancel(action)) {
    return 'cancel';
  }

  return action;
}

export async function promptSelectCommits(commits: CommitPlan[]): Promise<number[] | null> {
  const selected = await _multiselect({
    message: 'Select commits to execute:',
    options: commits.map((commit, index) => ({
      value: index,
      label: `${index + 1}. ${commit.subject}`,
      hint: commit.files.join(', ')
    })),
    required: false
  });

  if (_isCancel(selected)) {
    return null;
  }

  return selected;
}

export async function promptSelectCommitToEdit(commits: CommitPlan[]): Promise<number | null> {
  const selected = await _select({
    message: 'Choose a commit to edit:',
    options: commits.map((commit, index) => ({
      value: index,
      label: `${index + 1}. ${commit.subject}`,
      hint: commit.files.join(', ')
    }))
  });

  if (_isCancel(selected)) {
    return null;
  }

  return selected;
}

export async function withSpinner<T>(promise: Promise<T>, message: string): Promise<T> {
  const s = prompts.spinner();
  s.start(message);
  try {
    const result = await promise;
    s.stop('Done');
    return result;
  } catch (err) {
    s.stop(`Failed: ${err.message}`);
    throw err;
  }
}

export async function promptUndoConfirmation(commits: LogEntry[], pushedCommits: Set<string>): Promise<'yes' | 'cancel'> {
  console.log('');
  console.log(`Would undo ${commits.length} commit${commits.length > 1 ? 's' : ''}:`);
  console.log('─────────────────────────');
  
  for (const commit of commits) {
    const pushedTag = pushedCommits.has(commit.hash) ? ' [pushed]' : '';
    console.log(`${commit.shortHash} ${commit.subject}${pushedTag}`);
    if (commit.body) {
      console.log(`  ${commit.body.split('\n')[0]}`);
    }
  }
  
  console.log('─────────────────────────');
  
  if (pushedCommits.size > 0) {
    console.log(`(${pushedCommits.size} pushed)`);
    console.log('');
    console.log('⚠️  Warning: Some commits have been pushed. Undoing will rewrite local history.');
  }
  
  console.log('');
  
  const action = await _select<'yes' | 'cancel'>({
    message: 'What would you like to do?',
    options: [
      { value: 'yes', label: '[y] Yes, undo these commits' },
      { value: 'cancel', label: '[n] No, cancel' }
    ]
  });
  
  if (_isCancel(action) || action === 'cancel') {
    return 'cancel';
  }
  
  return action;
}

export async function promptUndoAction(count: number): Promise<UndoAction> {
  const action = await _select<UndoAction>({
    message: 'What would you like to do with the staged changes?',
    options: [
      { value: 'regenerate', label: '[r] Regenerate message' + (count > 1 ? ' (single commit for all changes)' : '') },
      { value: 'edit', label: '[e] Edit a message' },
      { value: 'cancel', label: '[c] Cancel (leave staged)' }
    ]
  });
  
  if (_isCancel(action)) {
    return 'cancel';
  }
  
  return action;
}
