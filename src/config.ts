import { homedir } from 'os';
import { mkdir, readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';
import * as prompts from '@clack/prompts';
import type { ConfirmOptions, PasswordOptions, SelectOptions, TextOptions } from '@clack/prompts';
import type { Auth, Config, Flags } from './types.ts';

// Test seam for the wizards. Every @clack call and every exit routes through here, so a
// test can drive a wizard end to end. `exit` is typed `never`: a stub must throw, which is
// what production's process.exit does to control flow, so no test can run past an exit.
interface PromptOverrides {
  // intro/outro are decorative, but they write raw ANSI cursor sequences to stdout, which
  // corrupts the node:test runner's serialized IPC on that same stream. They must be stubbable.
  intro?: (title?: string) => void;
  outro?: (message?: string) => void;
  select?: <Value>(opts: SelectOptions<Value>) => Promise<Value | symbol>;
  confirm?: (opts: ConfirmOptions) => Promise<boolean | symbol>;
  password?: (opts: PasswordOptions) => Promise<string | symbol>;
  text?: (opts: TextOptions) => Promise<string | symbol>;
  isCancel?: (value: unknown) => value is symbol;
  exit?: (code: number) => never;
}

let _overrides: PromptOverrides = {};

export function setPromptsForTesting(overrides: PromptOverrides | null): void {
  _overrides = overrides || {};
}

function _intro(title: string): void {
  (_overrides.intro || prompts.intro)(title);
}

function _outro(message: string): void {
  (_overrides.outro || prompts.outro)(message);
}

function _select<Value>(opts: SelectOptions<Value>): Promise<Value | symbol> {
  return (_overrides.select || prompts.select)(opts);
}

function _confirm(opts: ConfirmOptions): Promise<boolean | symbol> {
  return (_overrides.confirm || prompts.confirm)(opts);
}

function _password(opts: PasswordOptions): Promise<string | symbol> {
  return (_overrides.password || prompts.password)(opts);
}

function _text(opts: TextOptions): Promise<string | symbol> {
  return (_overrides.text || prompts.text)(opts);
}

function _isCancel(value: unknown): value is symbol {
  return (_overrides.isCancel || prompts.isCancel)(value);
}

function _exit(code: number): never {
  return (_overrides.exit || process.exit)(code);
}

const CURRENT_CONFIG_VERSION = 2;

const MIGRATION_NOTES: Record<number, string> = {
  2: "Google default model is now 'gemini-3.1-flash-lite' (replaces the -lite-preview)."
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  openrouter: 'OpenRouter',
  ollama: 'Ollama (local)',
  lmstudio: 'LM Studio (local)'
};

function getConfigDir() {
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, 'kommit')
    : join(homedir(), '.config', 'kommit');
}

function getDataDir() {
  return process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, 'kommit')
    : join(homedir(), '.local', 'share', 'kommit');
}

function getConfigPath() {
  return join(getConfigDir(), 'config.json');
}

function getAuthPath() {
  return join(getDataDir(), 'auth.json');
}

function getDefaultConfig(): Config {
  return {
    version: CURRENT_CONFIG_VERSION,
    defaultProvider: 'openrouter',
    skillName: null,
    providers: {
      openai: {
        model: 'gpt-5.4-nano',
        endpoint: 'https://api.openai.com/v1/chat/completions',
        maxDiffLength: 12000,
        timeout: 30000
      },
      anthropic: {
        model: 'claude-haiku-4-5',
        endpoint: 'https://api.anthropic.com/v1/messages',
        maxDiffLength: 12000,
        timeout: 30000
      },
      google: {
        model: 'gemini-3.1-flash-lite',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
        maxDiffLength: 12000,
        timeout: 30000
      },
      openrouter: {
        model: 'openai/gpt-5.4-nano',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        maxDiffLength: 12000,
        timeout: 30000
      },
      ollama: {
        model: 'default',
        endpoint: 'http://localhost:11434/v1/chat/completions',
        maxDiffLength: 4000,
        timeout: 30000
      },
      lmstudio: {
        model: 'default',
        endpoint: 'http://localhost:1234/v1/chat/completions',
        maxDiffLength: 4000,
        timeout: 30000
      }
    }
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function buildMigrationWarning(fromVersion: number, toVersion: number): string | null {
  const notes: string[] = [];
  for (let v = fromVersion + 1; v <= toVersion; v++) {
    if (MIGRATION_NOTES[v]) {
      notes.push(MIGRATION_NOTES[v]);
    }
  }
  if (notes.length === 0) return null;
  return `Config migrated v${fromVersion}→v${toVersion}. ${notes.join(' ')} Run 'kommit --set' to switch.`;
}

export function migrateConfig(config: Config): { config: Config; migrated: boolean; warning: string | null } {
  let migrated = false;
  const fromVersion = config.version || 0;

  if (fromVersion < CURRENT_CONFIG_VERSION) {
    const defaults = getDefaultConfig();
    const oldProviders = config.providers || {};
    config = {
      ...defaults,
      ...config,
      version: CURRENT_CONFIG_VERSION,
      providers: { ...defaults.providers, ...oldProviders }
    };
    migrated = true;
  }

  const warning = migrated ? buildMigrationWarning(fromVersion, config.version) : null;

  return { config, migrated, warning };
}

export async function loadConfig(): Promise<{ config: Config; auth: Auth }> {
  const configPath = getConfigPath();
  const authPath = getAuthPath();

  let config: Config;
  let auth: Auth = {};

  const configExists = await fileExists(configPath);
  if (!configExists) {
    throw Object.assign(new Error('Config not found. Run \'kommit --init\' to set up.'), { code: 'CONFIG_MISSING' });
  }

  try {
    const configRaw = await readFile(configPath, 'utf8');
    config = JSON.parse(configRaw);
  } catch (err) {
    throw Object.assign(new Error(`Failed to parse config: ${err.message}`), { code: 'CONFIG_PARSE_ERROR' });
  }

  const migration = migrateConfig(config);
  config = migration.config;
  if (migration.migrated) {
    await saveConfig(config);
    if (migration.warning) {
      console.warn(`kommit: ${migration.warning}`);
    }
  }

  if (await fileExists(authPath)) {
    try {
      const authRaw = await readFile(authPath, 'utf8');
      auth = JSON.parse(authRaw);
    } catch (err) {
      throw Object.assign(new Error(`Failed to parse auth: ${err.message}`), { code: 'AUTH_PARSE_ERROR' });
    }
  }

  return { config, auth };
}

export async function saveConfig(config: Config): Promise<void> {
  const dir = getConfigDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function saveAuth(auth: Auth): Promise<void> {
  const dir = getDataDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(getAuthPath(), JSON.stringify(auth, null, 2), { mode: 0o600 });
}

export async function runInitWizard(): Promise<void> {
  _intro('Welcome to kommit!');

  const provider = await _select({
    message: 'Choose your default LLM provider:',
    options: [
      { value: 'openai', label: PROVIDER_LABELS.openai },
      { value: 'anthropic', label: PROVIDER_LABELS.anthropic },
      { value: 'google', label: PROVIDER_LABELS.google },
      { value: 'openrouter', label: PROVIDER_LABELS.openrouter },
      { value: 'ollama', label: PROVIDER_LABELS.ollama },
      { value: 'lmstudio', label: PROVIDER_LABELS.lmstudio }
    ]
  });

  if (_isCancel(provider)) {
    _exit(0);
  }

  const needsKey = provider !== 'ollama' && provider !== 'lmstudio';
  const newAuth: Auth = {};

  if (needsKey) {
    const envVarMap: Record<string, string> = {
      openai: 'KOMMIT_OPENAI_API_KEY',
      anthropic: 'KOMMIT_ANTHROPIC_API_KEY',
      google: 'KOMMIT_GOOGLE_API_KEY',
      openrouter: 'KOMMIT_OPENROUTER_API_KEY'
    };
    const envVar = envVarMap[provider];
    const envValue = process.env[envVar];

    let key: string | undefined;
    if (envValue) {
      const useEnv = await _confirm({
        message: `Found ${envVar} in environment. Use it?`,
        initialValue: true
      });
      if (_isCancel(useEnv)) {
        _exit(0);
      }
      if (useEnv) {
        key = envValue;
      }
    }

    if (!key) {
      const entered = await _password({
        message: `Enter your ${provider} API key:`
      });
      if (_isCancel(entered)) {
        _exit(0);
      }
      key = entered;
    }

    newAuth[provider] = key;
  }

  // Config: create only if missing
  const configPath = getConfigPath();
  const configExists = await fileExists(configPath);

  if (!configExists) {
    const config = getDefaultConfig();
    config.defaultProvider = provider;
    await saveConfig(config);
    console.log(`Created config at ${configPath}.`);
  } else {
    console.log(`Config already exists at ${configPath}. Skipping.`);
  }

  // Auth: merge new keys with existing
  const authPath = getAuthPath();
  const authExists = await fileExists(authPath);
  let existingAuth: Auth = {};

  if (authExists) {
    const raw = await readFile(authPath, 'utf8');
    existingAuth = JSON.parse(raw);
  }

  if (needsKey) {
    const mergedAuth = { ...existingAuth, ...newAuth };
    await saveAuth(mergedAuth);
    console.log(authExists ? `Updated auth at ${authPath}.` : `Created auth at ${authPath}.`);
  } else {
    console.log('No API key needed for local providers.');
  }

  _outro('Setup complete! Run `kommit` to generate commit messages.');
}

export async function runSetWizard(config: Config, auth: Auth): Promise<void> {
  _intro('Configure kommit');

  const setting = await _select({
    message: 'What would you like to configure?',
    options: [
      { value: 'defaultProvider', label: 'Default provider' },
      { value: 'skillName', label: 'Skill name' }
    ]
  });

  if (_isCancel(setting)) {
    _exit(0);
  }

  if (setting === 'defaultProvider') {
    const noKeyProviders = ['ollama', 'lmstudio'];
    const availableProviders: string[] = [];

    for (const name of Object.keys(config.providers || {})) {
      const hasKey = auth[name] && auth[name].length > 0;
      const isLocal = noKeyProviders.includes(name);
      if (hasKey || isLocal) {
        availableProviders.push(name);
      }
    }

    if (availableProviders.length === 0) {
      console.log('No providers available. Add API keys with `kommit --init`.');
      _exit(1);
    }

    const providerOptions = availableProviders.map(name => ({
      value: name,
      label: PROVIDER_LABELS[name] || name
    }));

    const selectedProvider = await _select({
      message: 'Choose your default provider:',
      options: providerOptions
    });

    if (_isCancel(selectedProvider)) {
      _exit(0);
    }

    const currentModel = config.providers[selectedProvider]?.model || '';
    const model = await _text({
      message: 'Model name:',
      initialValue: currentModel
    });

    if (_isCancel(model)) {
      _exit(0);
    }

    config.defaultProvider = selectedProvider;
    config.providers[selectedProvider].model = model.trim();
  }

  if (setting === 'skillName') {
    const currentSkill = config.skillName || '';
    const skill = await _text({
      message: 'Skill name (leave empty to clear):',
      initialValue: currentSkill
    });

    if (_isCancel(skill)) {
      _exit(0);
    }

    config.skillName = skill.trim() || null;
  }

  await saveConfig(config);
  _outro('Configuration updated!');
}

export function resolveProvider(config: Config, flags: Flags, env: NodeJS.ProcessEnv, auth: Auth = {}): string | null {
  if (flags.provider) return flags.provider;
  if (env.KOMMIT_PROVIDER) return env.KOMMIT_PROVIDER;
  if (config.defaultProvider) return config.defaultProvider;

  const noKeyProviders = ['ollama', 'lmstudio'];
  for (const name of Object.keys(config.providers || {})) {
    const hasKey = auth[name] && auth[name].length > 0;
    const needsNoKey = noKeyProviders.includes(name);
    if (hasKey || needsNoKey) {
      return name;
    }
  }

  return null;
}

export function resolveSkill(config: Config, flags: Flags, env: NodeJS.ProcessEnv): string | null {
  if (flags.skill !== undefined) return flags.skill || null;
  if (env.KOMMIT_SKILL !== undefined) return env.KOMMIT_SKILL || null;
  if (config.skillName !== undefined) return config.skillName;
  return null;
}

export function getAvailableProviders(config: Config, auth: Auth, env: NodeJS.ProcessEnv = {}): string[] {
  const noKeyProviders = ['ollama', 'lmstudio'];
  const envMap: Record<string, string> = {
    openai: 'KOMMIT_OPENAI_API_KEY',
    anthropic: 'KOMMIT_ANTHROPIC_API_KEY',
    google: 'KOMMIT_GOOGLE_API_KEY',
    openrouter: 'KOMMIT_OPENROUTER_API_KEY'
  };
  const available: string[] = [];

  for (const name of Object.keys(config.providers || {})) {
    const envVar = envMap[name];
    const hasKey = (auth[name] && auth[name].length > 0) ||
                    (envVar && env[envVar] && env[envVar].length > 0);
    const isLocal = noKeyProviders.includes(name);
    if (hasKey || isLocal) {
      available.push(name);
    }
  }

  return available;
}
