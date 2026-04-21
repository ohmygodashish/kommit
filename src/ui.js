import * as prompts from '@clack/prompts';

export async function promptAction(message, truncated) {
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

  const action = await prompts.select({
    message: 'What would you like to do?',
    options: [
      { value: 'use', label: '[u] Use this message' },
      { value: 'edit', label: '[e] Edit inline' },
      { value: 'regenerate', label: '[r] Regenerate' },
      { value: 'cancel', label: '[c] Cancel' }
    ]
  });

  if (prompts.isCancel(action)) {
    return 'cancel';
  }

  return action;
}

export async function editMessage(message) {
  const subject = await prompts.text({
    message: 'Edit subject line:',
    initialValue: message.subject
  });

  if (prompts.isCancel(subject)) {
    return message;
  }

  const body = await prompts.text({
    message: 'Edit body (use \\n for newlines, leave empty for no body):',
    initialValue: message.body
  });

  if (prompts.isCancel(body)) {
    return { subject, body: message.body };
  }

  return {
    subject: subject.trim(),
    body: body.trim().replace(/\\n/g, '\n')
  };
}

export async function promptError(error, canRetry) {
  const options = [
    ...(canRetry ? [{ value: 'retry', label: '[r] Retry' }] : []),
    { value: 'cancel', label: '[c] Cancel' }
  ];

  const action = await prompts.select({
    message: `Error: ${error.message}`,
    options
  });

  if (prompts.isCancel(action)) {
    return 'cancel';
  }

  return action;
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
