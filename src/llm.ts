import type { ProviderConfig, NodeError } from './types.ts';

interface OpenAIResponse {
  choices?: { message?: { content?: string } }[];
}

interface AnthropicResponse {
  content?: { text?: string }[];
}

interface GoogleResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

export class LLMError extends Error {
  code?: string;
  status?: number | null;
  body?: string | null;

  constructor(message: string, code?: string, status?: number | null, body?: string | null) {
    super(message);
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

export function isRetryable(error: NodeError | LLMError): boolean {
  if (error.code === 'timeout') return true;
  if (error.code === 'network') return true;
  if (error.status && error.status >= 500 && error.status < 600) return true;
  return false;
}

export async function generateMessage(
  providerName: string,
  providerConfig: ProviderConfig,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const timeout = providerConfig.timeout || 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const result = await callProvider(providerName, providerConfig, apiKey, systemPrompt, userPrompt, controller.signal);
    return result;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new LLMError(`LLM request timed out after ${timeout}ms`, 'timeout', null, null);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callProvider(
  providerName: string,
  providerConfig: ProviderConfig,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal
): Promise<string> {
  const group = getProviderGroup(providerName);

  if (group === 'openai') {
    return callOpenAICompatible(providerConfig, apiKey, systemPrompt, userPrompt, signal);
  } else if (group === 'anthropic') {
    return callAnthropic(providerConfig, apiKey, systemPrompt, userPrompt, signal);
  } else if (group === 'google') {
    return callGoogle(providerConfig, apiKey, systemPrompt, userPrompt, signal);
  }

  throw new LLMError(`Unknown provider: ${providerName}`, 'unknown_provider');
}

function getProviderGroup(providerName: string): 'openai' | 'anthropic' | 'google' | null {
  const openaiCompatible = ['openai', 'openrouter', 'ollama', 'lmstudio'];
  if (openaiCompatible.includes(providerName)) return 'openai';
  if (providerName === 'anthropic') return 'anthropic';
  if (providerName === 'google') return 'google';
  return null;
}

async function callOpenAICompatible(
  providerConfig: ProviderConfig,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal
): Promise<string> {
  const body = {
    model: providerConfig.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.2
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  let res;
  try {
    res = await fetch(providerConfig.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw err;
    }
    throw new LLMError(`Network error: ${err.message}`, 'network');
  }

  if (!res.ok) {
    const text = await res.text();
    throw new LLMError(`LLM API error (${res.status}): ${text}`, 'api_error', res.status, text);
  }

  const data = await res.json() as OpenAIResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new LLMError('Invalid response shape from LLM', 'invalid_response');
  }

  return content;
}

async function callAnthropic(
  providerConfig: ProviderConfig,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal
): Promise<string> {
  const body = {
    model: providerConfig.model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.2
  };

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };

  let res;
  try {
    res = await fetch(providerConfig.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw err;
    }
    throw new LLMError(`Network error: ${err.message}`, 'network');
  }

  if (!res.ok) {
    const text = await res.text();
    throw new LLMError(`LLM API error (${res.status}): ${text}`, 'api_error', res.status, text);
  }

  const data = await res.json() as AnthropicResponse;
  const content = data.content?.[0]?.text;
  if (!content) {
    throw new LLMError('Invalid response shape from LLM', 'invalid_response');
  }

  return content;
}

async function callGoogle(
  providerConfig: ProviderConfig,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal
): Promise<string> {
  const model = providerConfig.model;
  const baseUrl = providerConfig.endpoint.replace(/\/$/, '');
  const url = `${baseUrl}/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: `${systemPrompt}\n\n${userPrompt}` }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2
    }
  };

  const headers = {
    'Content-Type': 'application/json'
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw err;
    }
    throw new LLMError(`Network error: ${err.message}`, 'network');
  }

  if (!res.ok) {
    const text = await res.text();
    throw new LLMError(`LLM API error (${res.status}): ${text}`, 'api_error', res.status, text);
  }

  const data = await res.json() as GoogleResponse;
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) {
    throw new LLMError('Invalid response shape from LLM', 'invalid_response');
  }

  return content;
}


