import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import process from 'process';

import { loadConfig, runInitWizard, runSetWizard, resolveProvider, resolveSkill, getAvailableProviders } from './config.js';
import { getDiff, getAllChanges, commit, stageTracked, stageFiles, unstageAll } from './git.js';
import { generateMessage, isRetryable } from './llm.js';
import { buildPrompt, buildMultiCommitPrompt, parseResponse, parseMultiResponse, validateSubject } from './prompt.js';
import { promptAction, editMessage, promptError, promptSelectProvider, promptMultiCommitPlan, promptSelectCommits, promptSelectCommitToEdit, withSpinner } from './ui.js';
import { parseArgs, getApiKey, printHelp, getVersion } from './args.js';
import { copyToClipboard } from './clipboard.js';

let _exitFn = (code) => process.exit(code);

export function setExitForTesting(fn) {
  _exitFn = fn || ((code) => process.exit(code));
}

function _exit(code) {
  _exitFn(code);
}

export function printVerbose(label, content) {
  console.error(`\n=== ${label} ===\n${content}\n=== END ${label} ===\n`);
}

export function buildFullMessage(message) {
  return message.body
    ? `${message.subject}\n\n${message.body}`
    : message.subject;
}

export function getVariationHint(count) {
  const hints = [
    'Try to be more concise.',
    'Focus on the \'why\' rather than the \'what\'.',
    'Use a broader scope if appropriate.'
  ];
  return hints[Math.min(count - 1, hints.length - 1)];
}

export async function commitMessage(message) {
  const tmpFile = join(tmpdir(), `kommit-msg-${Date.now()}-${process.pid}.txt`);

  try {
    await writeFile(tmpFile, buildFullMessage(message), 'utf8');
  } catch (err) {
    throw Object.assign(new Error(`Failed to write temp file: ${err.message}`), { exitCode: 1 });
  }

  const cleanup = () => {
    unlink(tmpFile).catch(() => {});
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    return await commit(tmpFile);
  } finally {
    cleanup();
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);
  }
}

export async function generateWithFallback({
  config,
  auth,
  flags,
  systemPrompt,
  userPrompt,
  originalProvider,
  originalProviderConfig,
  originalApiKey,
  spinnerMessage,
  parse,
  resetToOriginalOnRetry = false,
  allowRawFallback = false
}) {
  let currentProvider = originalProvider;
  let currentProviderConfig = originalProviderConfig;
  let currentApiKey = originalApiKey;
  let retryCount = 0;

  while (true) {
    try {
      const rawResponse = await withSpinner(
        generateMessage(currentProvider, currentProviderConfig, currentApiKey, systemPrompt, userPrompt),
        spinnerMessage
      );

      if (flags.verbose) {
        printVerbose('LLM RAW RESPONSE', rawResponse);
      }

      try {
        return parse(rawResponse);
      } catch (parseErr) {
        console.error(`kommit: ${parseErr.message}`);
        if (flags.verbose && parseErr.raw) {
          console.error(`Raw output:\n${parseErr.raw}`);
        }
        if (allowRawFallback) {
          return { subject: rawResponse.trim(), body: '' };
        }

        const available = getAvailableProviders(config, auth, process.env).filter(p => p !== currentProvider);
        const action = await promptError(parseErr, retryCount < 2, available);

        if (action === 'cancel') {
          return null;
        }

        if (action === 'switch') {
          const selected = await promptSelectProvider(available);
          if (!selected) {
            return null;
          }
          currentProvider = selected;
          currentProviderConfig = config.providers[selected];
          currentApiKey = getApiKey(selected, auth, process.env);
          retryCount = 0;
          continue;
        }

        if (resetToOriginalOnRetry) {
          currentProvider = originalProvider;
          currentProviderConfig = originalProviderConfig;
          currentApiKey = originalApiKey;
        }
        retryCount++;
      }
    } catch (err) {
      const canRetry = isRetryable(err) && retryCount < 2;
      const available = getAvailableProviders(config, auth, process.env).filter(p => p !== currentProvider);
      const action = await promptError(err, canRetry, available);

      if (action === 'cancel') {
        return null;
      }

      if (action === 'switch') {
        const selected = await promptSelectProvider(available);
        if (!selected) {
          return null;
        }
        currentProvider = selected;
        currentProviderConfig = config.providers[selected];
        currentApiKey = getApiKey(selected, auth, process.env);
        retryCount = 0;
        continue;
      }

      if (resetToOriginalOnRetry) {
        currentProvider = originalProvider;
        currentProviderConfig = originalProviderConfig;
        currentApiKey = originalApiKey;
      }
      retryCount++;
    }
  }
}

export async function runSingleCommitFlow({ flags, config, auth, provider, providerConfig, apiKey }) {
  let diffResult;
  try {
    diffResult = await getDiff(providerConfig);
  } catch (err) {
    console.error(`kommit: ${err.message}`);
    _exit(1);
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

  const originalProvider = provider;
  const originalProviderConfig = providerConfig;
  const originalApiKey = apiKey;

  let currentMessage = await generateWithFallback({
    config,
    auth,
    flags,
    systemPrompt,
    userPrompt,
    originalProvider,
    originalProviderConfig,
    originalApiKey,
    spinnerMessage: 'Generating commit message...',
    parse: rawResponse => {
      const message = parseResponse(rawResponse);
      if (!validateSubject(message.subject)) {
        console.warn(`kommit: Warning: subject does not match Conventional Commit format: "${message.subject}"`);
      }
      return message;
    },
    allowRawFallback: true
  });

  if (!currentMessage) {
    _exit(1);
  }

  let regenerateCount = 0;

  while (true) {
    const action = await promptAction(currentMessage, diffResult.truncated, diffResult.source);

    if (action === 'cancel') {
      _exit(0);
    }

    if (action === 'use' || action === 'stageAndUse') {
      if (flags.dryRun) {
        console.log('\n(Dry run — not committing)\n');
        _exit(0);
      }

      if (action === 'stageAndUse') {
        try {
          await stageTracked();
        } catch (err) {
          console.error(`kommit: ${err.message}`);
          _exit(1);
        }
      }

      try {
        const result = await commitMessage(currentMessage);
        console.log(`Committed: ${result.hash}`);
      } catch (err) {
        console.error(`kommit: ${err.message}`);
        _exit(err.exitCode || 1);
      }

      _exit(0);
    }

    if (action === 'copy') {
      try {
        await copyToClipboard(buildFullMessage(currentMessage));
        console.log('\n📋 Copied to clipboard!\n');
        _exit(0);
      } catch (err) {
        console.error(`\nkommit: ${err.message}\n`);
        _exit(1);
      }
    }

    if (action === 'edit') {
      currentMessage = await editMessage(currentMessage);
      continue;
    }

    if (action === 'regenerate') {
      regenerateCount++;
      const modifiedUserPrompt = `${userPrompt}\n\nHint: ${getVariationHint(regenerateCount)}`;
      const regenerated = await generateWithFallback({
        config,
        auth,
        flags,
        systemPrompt,
        userPrompt: modifiedUserPrompt,
        originalProvider,
        originalProviderConfig,
        originalApiKey,
        spinnerMessage: 'Regenerating commit message...',
        parse: rawResponse => {
          const message = parseResponse(rawResponse);
          if (!validateSubject(message.subject)) {
            console.warn(`kommit: Warning: subject does not match Conventional Commit format: "${message.subject}"`);
          }
          return message;
        },
        resetToOriginalOnRetry: true,
        allowRawFallback: true
      });

      if (regenerated) {
        currentMessage = regenerated;
      }
    }
  }
}

export async function executeMultiCommits(commits, changeMap) {
  await unstageAll();

  for (let i = 0; i < commits.length; i++) {
    const commitPlan = commits[i];
    const stagePathSet = new Set();

    for (const file of commitPlan.files) {
      const change = changeMap.get(file);
      if (!change) {
        throw Object.assign(new Error(`Unknown file in commit plan: ${file}`), { exitCode: 1 });
      }
      for (const path of change.stagePaths) {
        stagePathSet.add(path);
      }
    }

    await stageFiles([...stagePathSet]);
    const result = await commitMessage(commitPlan);
    console.log(`Committed ${i + 1}/${commits.length}: ${result.hash} ${commitPlan.subject}`);
  }
}

export async function runMultiCommitFlow({ flags, config, auth, provider, providerConfig, apiKey }) {
  let changeResult;
  try {
    changeResult = await getAllChanges(providerConfig);
  } catch (err) {
    console.error(`kommit: ${err.message}`);
    _exit(1);
  }

  if (flags.verbose) {
    printVerbose('GIT DIFF', changeResult.diff);
  }

  const { system: systemPrompt, user: userPrompt, warning } = await buildMultiCommitPrompt(changeResult.diff, changeResult.files, config);
  if (warning) {
    console.warn(`kommit: ${warning}`);
  }

  if (flags.verbose) {
    printVerbose('SYSTEM PROMPT', systemPrompt);
    printVerbose('USER PROMPT', userPrompt);
  }

  const allowedFiles = changeResult.files.map(file => file.displayPath);
  const changeMap = new Map(changeResult.files.map(file => [file.displayPath, file]));
  const originalProvider = provider;
  const originalProviderConfig = providerConfig;
  const originalApiKey = apiKey;

  let plan = await generateWithFallback({
    config,
    auth,
    flags,
    systemPrompt,
    userPrompt,
    originalProvider,
    originalProviderConfig,
    originalApiKey,
    spinnerMessage: 'Generating commit messages...',
    parse: rawResponse => {
      const commits = parseMultiResponse(rawResponse, allowedFiles);
      for (const commitPlan of commits) {
        if (!validateSubject(commitPlan.subject)) {
          console.warn(`kommit: Warning: subject does not match Conventional Commit format: "${commitPlan.subject}"`);
        }
      }
      return commits;
    }
  });

  if (!plan) {
    _exit(1);
  }

  let regenerateCount = 0;

  while (true) {
    const action = await promptMultiCommitPlan(plan, changeResult.truncated);

    if (action === 'cancel') {
      _exit(0);
    }

    if (action === 'acceptAll' || action === 'select') {
      let selectedCommits = plan;

      if (action === 'select') {
        const selectedIndexes = await promptSelectCommits(plan);
        if (!selectedIndexes || selectedIndexes.length === 0) {
          continue;
        }
        selectedCommits = selectedIndexes.map(index => plan[index]);
      }

      if (flags.dryRun) {
        console.log('');
        for (const commitPlan of selectedCommits) {
          console.log('Would commit:');
          console.log('─────────────────────────');
          console.log(buildFullMessage(commitPlan));
          console.log('─────────────────────────');
          console.log('');
        }
        _exit(0);
      }

      try {
        await executeMultiCommits(selectedCommits, changeMap);
      } catch (err) {
        console.error(`kommit: ${err.message}`);
        _exit(err.exitCode || 1);
      }

      _exit(0);
    }

    if (action === 'edit') {
      const selectedIndex = await promptSelectCommitToEdit(plan);
      if (selectedIndex === null) {
        continue;
      }

      const edited = await editMessage(plan[selectedIndex]);
      plan[selectedIndex] = { ...plan[selectedIndex], ...edited, files: plan[selectedIndex].files };
      continue;
    }

    if (action === 'regenerate') {
      regenerateCount++;
      const modifiedUserPrompt = `${userPrompt}\n\nHint: ${getVariationHint(regenerateCount)}`;
      const regenerated = await generateWithFallback({
        config,
        auth,
        flags,
        systemPrompt,
        userPrompt: modifiedUserPrompt,
        originalProvider,
        originalProviderConfig,
        originalApiKey,
        spinnerMessage: 'Regenerating commit messages...',
        parse: rawResponse => {
          const commits = parseMultiResponse(rawResponse, allowedFiles);
          for (const commitPlan of commits) {
            if (!validateSubject(commitPlan.subject)) {
              console.warn(`kommit: Warning: subject does not match Conventional Commit format: "${commitPlan.subject}"`);
            }
          }
          return commits;
        },
        resetToOriginalOnRetry: true
      });

      if (regenerated) {
        plan = regenerated;
      }
    }
  }
}

export async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    _exit(0);
  }

  if (flags.version) {
    const version = await getVersion();
    console.log(version);
    _exit(0);
  }

  if (flags.init) {
    await runInitWizard();
    _exit(0);
  }

  if (flags.set) {
    let config, auth;
    try {
      ({ config, auth } = await loadConfig());
    } catch (err) {
      console.error(`kommit: ${err.message}`);
      _exit(1);
    }
    await runSetWizard(config, auth);
    _exit(0);
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
      _exit(1);
    }
  }

  const provider = resolveProvider(config, flags, process.env, auth);
  if (!provider) {
    console.error('kommit: No provider configured. Run \'kommit --init\' to set up.');
    _exit(1);
  }

  if (!config.providers[provider]) {
    console.error(`kommit: Unknown provider '${provider}'.`);
    _exit(1);
  }

  const providerConfig = config.providers[provider];
  const apiKey = getApiKey(provider, auth, process.env);

  const needsKey = provider !== 'ollama' && provider !== 'lmstudio';
  if (needsKey && !apiKey) {
    console.error(`kommit: No API key found for provider '${provider}'. Run 'kommit --init' to configure.`);
    _exit(1);
  }

  const skillName = resolveSkill(config, flags, process.env);
  config._resolvedSkill = skillName;

  if (flags.multi) {
    await runMultiCommitFlow({ flags, config, auth, provider, providerConfig, apiKey });
    return;
  }

  await runSingleCommitFlow({ flags, config, auth, provider, providerConfig, apiKey });
}


