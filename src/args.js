export function parseArgs(argv) {
  const flags = {
    init: false,
    set: false,
    multi: false,
    provider: undefined,
    skill: undefined,
    dryRun: false,
    verbose: false,
    help: false,
    version: false
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
      case '--multi':
        flags.multi = true;
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
      case '--help':
      case '-h':
        flags.help = true;
        break;
      case '--version':
      case '-v':
        flags.version = true;
        break;
    }
  }

  return flags;
}

export function printHelp() {
  console.log(`kommit — AI-powered Conventional Commit message generator

Usage:
  kommit [options]

Options:
  --init            Run the interactive setup wizard
  --set             Configure default provider, model, or skill
  --multi           Split changes into multiple logical commits
  --provider <name> Override the default LLM provider for this run
  --skill <name>    Override the skill for this run
  --dry-run         Generate and show the message without committing
  --verbose         Print raw prompts, responses, and git commands
  --help, -h        Show this help message
  --version, -v     Show version number

Environment Variables:
  KOMMIT_PROVIDER    Override default provider
  KOMMIT_SKILL       Override skill
  KOMMIT_*_API_KEY   API keys (see docs)

For more info: https://github.com/ohmygodashish/kommit#readme`);
}

export async function getVersion() {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json');
  return pkg.version;
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
