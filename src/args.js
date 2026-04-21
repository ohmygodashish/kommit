export function parseArgs(argv) {
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

export function getApiKey(provider, auth, env) {
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
