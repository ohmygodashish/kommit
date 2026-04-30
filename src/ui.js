import * as prompts from '@clack/prompts';

let _selectOverride = null;
let _isCancelOverride = null;
let _multiselectOverride = null;
let _textOverride = null;

export function setSelectForTesting(selectFn, isCancelFn, multiselectFn, textFn) {
  _selectOverride = selectFn || null;
  _isCancelOverride = isCancelFn || null;
  _multiselectOverride = multiselectFn || null;
  _textOverride = textFn || null;
}

function _select(options) {
  if (_selectOverride) {
    return _selectOverride(options);
  }
  return prompts.select(options);
}

function _isCancel(value) {
  if (_isCancelOverride) {
    return _isCancelOverride(value);
  }
  return prompts.isCancel(value);
}

function _multiselect(options) {
  if (_multiselectOverride) {
    return _multiselectOverride(options);
  }
  return prompts.multiselect(options);
}

function _text(options) {
  if (_textOverride) {
    return _textOverride(options);
  }
  return prompts.text(options);
}

export async function promptAction(message, truncated, source) {
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

  const useOption = source === 'unstaged'
    ? { value: 'stageAndUse', label: '[s] Stage all and use' }
    : { value: 'use', label: '[u] Use this message' };

  const action = await _select({
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

export async function editMessage(message) {
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

export async function promptError(error, canRetry, availableProviders = []) {
  const options = [
    ...(canRetry ? [{ value: 'retry', label: '[r] Retry' }] : []),
    ...(availableProviders.length > 0 ? [{ value: 'switch', label: '[f] Retry with another provider' }] : []),
    { value: 'cancel', label: '[c] Cancel' }
  ];

  const action = await _select({
    message: `Error: ${error.message}`,
    options
  });

  if (_isCancel(action)) {
    return 'cancel';
  }

  return action;
}

export async function promptSelectProvider(providers) {
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

export async function promptMultiCommitPlan(commits, truncated) {
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

  const action = await _select({
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

export async function promptSelectCommits(commits) {
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

export async function promptSelectCommitToEdit(commits) {
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

export async function withSpinner(promise, message) {
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
