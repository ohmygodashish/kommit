import type { Auth, Flags } from './types.ts';

const KNOWN_OPTIONS = [
  '--init', '--set', '--multi', '--undo', '--provider', '--skill',
  '--dry-run', '--verbose', '--help', '-h', '--version', '-v'
];

// Misplaced hyphens are the realistic typo ('--dryrun' for '--dry-run'), so normalise
// them away instead of pulling in an edit-distance implementation for the rest.
const normalize = (s: string): string => s.replace(/-/g, '').toLowerCase();

function unknownOption(arg: string): Error {
  const match = KNOWN_OPTIONS.find((opt) => normalize(opt) === normalize(arg));
  return new Error(
    `unknown option '${arg}'\n` +
    (match ? `Did you mean '${match}'?` : "Run 'kommit --help' to see available options.")
  );
}

// Every value-taking option names a provider or a skill, so a '-' prefix always means
// the value is missing and we swallowed the next flag.
function requireValue(argv: string[], i: number, name: string): string {
  const value = argv[i];
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`'${name}' requires a value`);
  }
  return value;
}

export function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
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
      case '--undo':
        flags.undo = true;
        if (argv[i + 1] && /^\d+$/.test(argv[i + 1])) {
          flags.undoCount = parseInt(argv[++i], 10);
        }
        break;
      case '--provider':
        flags.provider = requireValue(argv, ++i, '--provider');
        break;
      case '--skill':
        flags.skill = requireValue(argv, ++i, '--skill');
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
      default:
        // kommit takes no positional arguments, so anything unmatched is a mistake.
        // Silently ignoring it meant a typo'd '--dry-run' made a real commit.
        throw arg.startsWith('-')
          ? unknownOption(arg)
          : new Error(`unexpected argument '${arg}'`);
    }
  }

  return flags;
}

export function printHelp(): void {
  console.log(`kommit — AI-powered Conventional Commit message generator

Usage:
  kommit [options]

Options:
  --init            Run the interactive setup wizard
  --set             Configure default provider, model, or skill
  --multi           Split changes into multiple logical commits
  --undo [count]    Undo the last N commits (default: 1), leaving changes staged
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

export async function getVersion(): Promise<string> {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json');
  return pkg.version;
}

export function getApiKey(provider: string, auth: Auth, env: NodeJS.ProcessEnv): string {
  const envMap: Record<string, string> = {
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
