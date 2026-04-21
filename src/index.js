import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import process from 'process';

import { loadConfig, runInitWizard, runSetWizard, resolveProvider, resolveSkill } from './config.js';
import { getDiff, commit, stageTracked } from './git.js';
import { generateMessage, isRetryable } from './llm.js';
import { buildPrompt, parseResponse, validateSubject } from './prompt.js';
import { promptAction, editMessage, promptError, withSpinner } from './ui.js';

function parseArgs(argv) {
  const flags = {
    init: false,
    set: false,
    provider: undefined,
    skill: undefined,
    dryRun: false,
    verbose: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--init':
        flags.init = true;
        break;
      case '--set':
        flags.set = true;
        break;
      case '--provider':
        flags.provider = argv[++i];
        break;
      case '--skill':
        flags.skill = argv[++i];
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--verbose':
        flags.verbose = true;
        break;
    }
  }

  return flags;
}

function getApiKey(provider, auth, env) {
  const envMap = {
    openai: 'KOMMIT_OPENAI_API_KEY',
    anthropic: 'KOMMIT_ANTHROPIC_API_KEY',
    google: 'KOMMIT_GOOGLE_API_KEY',
    openrouter: 'KOMMIT_OPENROUTER_API_KEY'
  };
  const envVar = envMap[provider];
  if (envVar && env[envVar]) {
    return env[envVar];
  }
  return auth[provider] || '';
}

function printVerbose(label, content) {
  console.error(`\n=== ${label} ===\n${content}\n=== END ${label} ===\n`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.init) {
    await runInitWizard();
    process.exit(0);
  }

  if (flags.set) {
    let config, auth;
    try {
      ({ config, auth } = await loadConfig());
    } catch (err) {
      console.error(`kommit: ${err.message}`);
      process.exit(1);
    }
    await runSetWizard(config, auth);
    process.exit(0);
  }

  let config, auth;
  try {
    ({ config, auth } = await loadConfig());
  } catch (err) {
    if (err.code === 'CONFIG_MISSING') {
      console.log('Welcome to kommit! Let\'s set up your LLM provider.');
      await runInitWizard();
      ({ config, auth } = await loadConfig());
    } else {
      console.error(`kommit: ${err.message}`);
      process.exit(1);
    }
  }

  const provider = resolveProvider(config, flags, process.env, auth);
  if (!provider) {
    console.error('kommit: No provider configured. Run \'kommit --init\' to set up.');
    process.exit(1);
  }

  if (!config.providers[provider]) {
    console.error(`kommit: Unknown provider '${provider}'.`);
    process.exit(1);
  }

  const providerConfig = config.providers[provider];
  const apiKey = getApiKey(provider, auth, process.env);

  const needsKey = provider !== 'ollama' && provider !== 'lmstudio';
  if (needsKey && !apiKey) {
    console.error(`kommit: No API key found for provider '${provider}'. Run 'kommit --init' to configure.`);
    process.exit(1);
  }

  const skillName = resolveSkill(config, flags, process.env);
  config._resolvedSkill = skillName;

  let diffResult;
  try {
    diffResult = await getDiff(providerConfig);
  } catch (err) {
    console.error(`kommit: ${err.message}`);
    process.exit(1);
  }

  if (diffResult.source === 'unstaged') {
    console.log('No staged changes found. Using unstaged diff.');
  }

  if (flags.verbose) {
    printVerbose('GIT DIFF', diffResult.diff);
  }

  const { system: systemPrompt, user: userPrompt, warning } = await buildPrompt(diffResult.diff, config);
  if (warning) {
    console.warn(`kommit: ${warning}`);
  }

  if (flags.verbose) {
    printVerbose('SYSTEM PROMPT', systemPrompt);
    printVerbose('USER PROMPT', userPrompt);
  }

  let retryCount = 0;
  let message = null;

  while (true) {
    try {
      const rawResponse = await withSpinner(
        generateMessage(provider, providerConfig, apiKey, systemPrompt, userPrompt),
        'Generating commit message...'
      );

      if (flags.verbose) {
        printVerbose('LLM RAW RESPONSE', rawResponse);
      }

      try {
        message = parseResponse(rawResponse);
      } catch (parseErr) {
        console.error(`kommit: ${parseErr.message}`);
        if (flags.verbose) {
          console.error(`Raw output:\n${parseErr.raw}`);
        }
        message = { subject: rawResponse.trim(), body: '' };
      }

      if (!validateSubject(message.subject)) {
        console.warn(`kommit: Warning: subject does not match Conventional Commit format: "${message.subject}"`);
      }

      break;
    } catch (err) {
      const canRetry = isRetryable(err) && retryCount < 2;
      const action = await promptError(err, canRetry);
      if (action === 'cancel') {
        process.exit(1);
      }
      retryCount++;
    }
  }

  let currentMessage = message;
  let regenerateCount = 0;

  while (true) {
    const action = await promptAction(currentMessage, diffResult.truncated, diffResult.source);

    if (action === 'cancel') {
      process.exit(0);
    }

    if (action === 'use' || action === 'stageAndUse') {
      if (flags.dryRun) {
        console.log('\n(Dry run — not committing)\n');
        process.exit(0);
      }

      if (action === 'stageAndUse') {
        try {
          await stageTracked();
        } catch (err) {
          console.error(`kommit: ${err.message}`);
          process.exit(1);
        }
      }

      const tmpFile = join(tmpdir(), `kommit-msg-${Date.now()}-${process.pid}.txt`);
      const fullMessage = currentMessage.body
        ? `${currentMessage.subject}\n\n${currentMessage.body}`
        : currentMessage.subject;

      try {
        await writeFile(tmpFile, fullMessage, 'utf8');
      } catch (err) {
        console.error(`kommit: Failed to write temp file: ${err.message}`);
        process.exit(1);
      }

      const cleanup = () => {
        unlink(tmpFile).catch(() => {});
      };
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);

      try {
        const result = await commit(tmpFile);
        console.log(`Committed: ${result.hash}`);
      } catch (err) {
        console.error(`kommit: ${err.message}`);
        process.exit(err.exitCode || 1);
      } finally {
        cleanup();
        process.off('SIGINT', cleanup);
        process.off('SIGTERM', cleanup);
      }

      process.exit(0);
    }

    if (action === 'edit') {
      currentMessage = await editMessage(currentMessage);
      continue;
    }

    if (action === 'regenerate') {
      regenerateCount++;
      const hints = [
        'Try to be more concise.',
        'Focus on the \'why\' rather than the \'what\'.',
        'Use a broader scope if appropriate.'
      ];
      const hint = hints[Math.min(regenerateCount - 1, hints.length - 1)];
      const modifiedUserPrompt = `${userPrompt}\n\nHint: ${hint}`;

      let regenRetryCount = 0;
      let regenerated = false;

      while (!regenerated) {
        try {
          const rawResponse = await withSpinner(
            generateMessage(provider, providerConfig, apiKey, systemPrompt, modifiedUserPrompt),
            'Regenerating commit message...'
          );

          if (flags.verbose) {
            printVerbose('LLM RAW RESPONSE', rawResponse);
          }

          try {
            currentMessage = parseResponse(rawResponse);
          } catch (parseErr) {
            console.error(`kommit: ${parseErr.message}`);
            currentMessage = { subject: rawResponse.trim(), body: '' };
          }

          if (!validateSubject(currentMessage.subject)) {
            console.warn(`kommit: Warning: subject does not match Conventional Commit format: "${currentMessage.subject}"`);
          }

          regenerated = true;
        } catch (err) {
          const canRetry = isRetryable(err) && regenRetryCount < 2;
          const errorAction = await promptError(err, canRetry);
          if (errorAction === 'cancel') {
            break;
          }
          regenRetryCount++;
        }
      }
    }
  }
}

main().catch(err => {
  console.error(`kommit: ${err.message}`);
  process.exit(1);
});
