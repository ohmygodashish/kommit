import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { generateWithFallback } from '../src/index.ts';
import { setSelectForTesting, setSpinnerForTesting } from '../src/ui.ts';
import { LLMError } from '../src/llm.ts';
import { config as makeConfig, providerConfig, flags as makeFlags } from './fixtures.ts';
import type { Auth, Config } from '../src/types.ts';

// A spinner that renders nothing. Unstubbed, @clack writes ANSI to the same stdout the test
// runner uses for IPC.
const silentSpinner = (() => ({
  start() {}, stop() {}, message() {}
})) as unknown as Parameters<typeof setSpinnerForTesting>[0];

/** Answers each prompt in order and refuses to invent an answer nobody scripted. */
function queue(values: unknown[]) {
  const remaining = [...values];
  const fn = async (opts: any) => {
    fn.calls.push(opts);
    if (remaining.length === 0) {
      throw new Error('select called more times than the test scripted');
    }
    return remaining.shift();
  };
  fn.calls = [] as any[];
  return fn;
}

/**
 * A fetch stub yielding the given outcomes in order, repeating the last one.
 * A string succeeds, an Error rejects (llm.ts turns that into a retryable network error),
 * and a number resolves as that HTTP status so real api_error classification applies.
 */
function respondWith(outcomes: (string | Error | number)[]) {
  let i = 0;
  const fn = async () => {
    const outcome = outcomes[Math.min(i, outcomes.length - 1)];
    i++;
    fn.callCount = i;
    if (outcome instanceof Error) throw outcome;
    if (typeof outcome === 'number') {
      return { ok: false, status: outcome, text: async () => 'upstream said no' } as any;
    }
    // Carries all three provider shapes at once, so a test that switches providers mid-run
    // does not have to restub for the new provider's parser.
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: outcome } }],
        content: [{ text: outcome }],
        candidates: [{ content: { parts: [{ text: outcome }] } }]
      })
    } as any;
  };
  fn.callCount = 0;
  return fn;
}

function options(overrides: Record<string, unknown> = {}) {
  const config: Config = makeConfig({
    defaultProvider: 'openai',
    providers: { openai: providerConfig(), anthropic: providerConfig() }
  });
  const auth: Auth = { openai: 'sk-a', anthropic: 'sk-b' };
  return {
    config,
    auth,
    flags: makeFlags(),
    systemPrompt: 'sys',
    userPrompt: 'usr',
    originalProvider: 'openai',
    originalProviderConfig: config.providers.openai,
    originalApiKey: 'sk-a',
    spinnerMessage: 'Generating',
    parse: (raw: string) => ({ subject: raw.trim(), body: '' }),
    ...overrides
  } as any;
}

describe('index.ts generateWithFallback', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setSpinnerForTesting(silentSpinner);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSelectForTesting(null, null, null, null);
    setSpinnerForTesting(null);
  });

  it('returns the parsed result when the first call succeeds', async () => {
    globalThis.fetch = respondWith(['feat: add thing']) as any;

    const result = await generateWithFallback(options());
    assert.deepStrictEqual(result, { subject: 'feat: add thing', body: '' });
  });

  it('returns null when the user cancels after an error', async () => {
    globalThis.fetch = respondWith([new LLMError('boom', 'network')]) as any;
    setSelectForTesting(queue(['cancel']), () => false);

    assert.strictEqual(await generateWithFallback(options()), null);
  });

  it('retries the same provider and succeeds on the second attempt', async () => {
    const fetchStub = respondWith([new LLMError('boom', 'network'), 'fix: retried']);
    globalThis.fetch = fetchStub as any;
    setSelectForTesting(queue(['retry']), () => false);

    const result = await generateWithFallback(options());
    assert.deepStrictEqual(result, { subject: 'fix: retried', body: '' });
    assert.strictEqual(fetchStub.callCount, 2);
  });

  it('stops offering retry once the retry budget is spent', async () => {
    globalThis.fetch = respondWith([new LLMError('boom', 'network')]) as any;
    const select = queue(['retry', 'retry', 'cancel']);
    setSelectForTesting(select, () => false);

    assert.strictEqual(await generateWithFallback(options()), null);
    // Third prompt is past the budget, so 'retry' is no longer on offer.
    const lastOptions = select.calls[2].options.map((o: any) => o.value);
    assert.ok(!lastOptions.includes('retry'), `retry still offered: ${lastOptions}`);
  });

  it('switches provider and resets the retry budget', async () => {
    globalThis.fetch = respondWith([
      new LLMError('boom', 'network'),
      new LLMError('boom', 'network'),
      'feat: from anthropic'
    ]) as any;
    // error -> switch, pick anthropic, error again -> retry is offered because the switch
    // reset the counter, then it succeeds.
    const select = queue(['switch', 'anthropic', 'retry']);
    setSelectForTesting(select, () => false);

    const result = await generateWithFallback(options());
    assert.deepStrictEqual(result, { subject: 'feat: from anthropic', body: '' });
    assert.ok(select.calls[2].options.some((o: any) => o.value === 'retry'));
  });

  it('does not offer the current provider as a fallback target', async () => {
    globalThis.fetch = respondWith([new LLMError('boom', 'network')]) as any;
    const select = queue(['cancel']);
    setSelectForTesting(select, () => false);

    await generateWithFallback(options());
    const offered = select.calls[0].options.map((o: any) => o.value);
    assert.ok(offered.includes('switch'), 'anthropic is configured, so switch should be offered');
  });

  it('returns null when the user cancels the provider picker', async () => {
    globalThis.fetch = respondWith([new LLMError('boom', 'network')]) as any;
    // isCancel reports true for the picker's answer, so promptSelectProvider returns null.
    setSelectForTesting(queue(['switch', Symbol('cancel')]), (v: unknown) => typeof v === 'symbol');

    assert.strictEqual(await generateWithFallback(options()), null);
  });

  it('does not retry a non-retryable error', async () => {
    globalThis.fetch = respondWith([401]) as any;
    const select = queue(['cancel']);
    setSelectForTesting(select, () => false);

    await generateWithFallback(options());
    const offered = select.calls[0].options.map((o: any) => o.value);
    assert.ok(!offered.includes('retry'), `retry offered for a 401: ${offered}`);
  });

  describe('parse failures', () => {
    const failingParse = () => { throw new Error('could not parse'); };

    it('falls back to the raw response when allowed', async () => {
      globalThis.fetch = respondWith(['  just a subject  ']) as any;

      const result = await generateWithFallback(
        options({ parse: failingParse, allowRawFallback: true })
      );
      assert.deepStrictEqual(result, { subject: 'just a subject', body: '' });
    });

    it('prompts when a raw fallback is not allowed', async () => {
      globalThis.fetch = respondWith(['garbage']) as any;
      const select = queue(['cancel']);
      setSelectForTesting(select, () => false);

      const result = await generateWithFallback(options({ parse: failingParse }));
      assert.strictEqual(result, null);
      assert.match(select.calls[0].message, /could not parse/);
    });

    it('resetToOriginalOnRetry sends the retry back to the original provider', async () => {
      let parsed = 0;
      globalThis.fetch = respondWith(['garbage', 'feat: ok']) as any;
      setSelectForTesting(queue(['retry']), () => false);

      const result = await generateWithFallback(options({
        resetToOriginalOnRetry: true,
        parse: (raw: string) => {
          if (parsed++ === 0) throw new Error('could not parse');
          return { subject: raw.trim(), body: '' };
        }
      }));
      assert.deepStrictEqual(result, { subject: 'feat: ok', body: '' });
    });
  });
});
