import { homedir } from 'os';
import { mkdir, readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';
import * as prompts from '@clack/prompts';

const CURRENT_CONFIG_VERSION = 1;

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

function getDefaultConfig() {
  return {
    version: CURRENT_CONFIG_VERSION,
    defaultProvider: 'openai',
    skillName: null,
    providers: {
      openai: {
        model: 'gpt-5.4-mini',
        endpoint: 'https://api.openai.com/v1/chat/completions',
        maxDiffLength: 12000,
        timeout: 30000
      },
      anthropic: {
        model: 'claude-haiku-4.5',
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
        model: 'anthropic/claude-3.5-sonnet',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        maxDiffLength: 12000,
        timeout: 30000
      },
      ollama: {
        model: 'llama3.1',
        endpoint: 'http://localhost:11434/v1/chat/completions',
        maxDiffLength: 4000,
        timeout: 30000
      },
      lmStudio: {
        model: 'default',
        endpoint: 'http://localhost:1234/v1/chat/completions',
        maxDiffLength: 4000,
        timeout: 30000
      }
    }
  };
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function migrateConfig(config) {
  let migrated = false;

  if (!config.version || config.version < CURRENT_CONFIG_VERSION) {
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

  return { config, migrated };
}

export async function loadConfig() {
  const configPath = getConfigPath();
  const authPath = getAuthPath();

  let config;
  let auth = {};

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

export async function saveConfig(config) {
  const dir = getConfigDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function saveAuth(auth) {
  const dir = getDataDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(getAuthPath(), JSON.stringify(auth, null, 2), { mode: 0o600 });
}

export async function runInitWizard() {
  prompts.intro('Welcome to kommit!');

  const provider = await prompts.select({
    message: 'Choose your default LLM provider:',
    options: [
      { value: 'openai', label: 'OpenAI' },
      { value: 'anthropic', label: 'Anthropic' },
      { value: 'google', label: 'Google' },
      { value: 'openrouter', label: 'OpenRouter' },
      { value: 'ollama', label: 'Ollama (local)' },
      { value: 'lmStudio', label: 'LM Studio (local)' }
    ]
  });

  if (prompts.isCancel(provider)) {
    process.exit(0);
  }

  const config = getDefaultConfig();
  config.defaultProvider = provider;

  const needsKey = provider !== 'ollama' && provider !== 'lmStudio';
  const auth = {};

  if (needsKey) {
    const envVarMap = {
      openai: 'KOMMIT_OPENAI_API_KEY',
      anthropic: 'KOMMIT_ANTHROPIC_API_KEY',
      google: 'KOMMIT_GOOGLE_API_KEY',
      openrouter: 'KOMMIT_OPENROUTER_API_KEY'
    };
    const envVar = envVarMap[provider];
    const envValue = process.env[envVar];

    let key;
    if (envValue) {
      const useEnv = await prompts.confirm({
        message: `Found ${envVar} in environment. Use it?`,
        initialValue: true
      });
      if (prompts.isCancel(useEnv)) {
        process.exit(0);
      }
      if (useEnv) {
        key = envValue;
      }
    }

    if (!key) {
      key = await prompts.password({
        message: `Enter your ${provider} API key:`
      });
      if (prompts.isCancel(key)) {
        process.exit(0);
      }
    }

    auth[provider] = key;
  }

  await saveConfig(config);
  await saveAuth(auth);

  prompts.outro('Setup complete! Run `kommit` to generate commit messages.');
}

export function resolveProvider(config, flags, env, auth = {}) {
  if (flags.provider) return flags.provider;
  if (env.KOMMIT_PROVIDER) return env.KOMMIT_PROVIDER;
  if (config.defaultProvider) return config.defaultProvider;

  const noKeyProviders = ['ollama', 'lmStudio'];
  for (const name of Object.keys(config.providers || {})) {
    const hasKey = auth[name] && auth[name].length > 0;
    const needsNoKey = noKeyProviders.includes(name);
    if (hasKey || needsNoKey) {
      return name;
    }
  }

  return null;
}

export function resolveSkill(config, flags, env) {
  if (flags.skill !== undefined) return flags.skill || null;
  if (env.KOMMIT_SKILL !== undefined) return env.KOMMIT_SKILL || null;
  if (config.skillName !== undefined) return config.skillName;
  return null;
}
