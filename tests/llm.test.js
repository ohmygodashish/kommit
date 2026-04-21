import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { isRetryable, generateMessage, LLMError } from '../src/llm.js';

describe('llm.js', () => {
  describe('isRetryable', () => {
    it('returns true for timeout', () => {
      assert.strictEqual(isRetryable(new LLMError('timeout', 'timeout')), true);
    });

    it('returns true for network errors', () => {
      assert.strictEqual(isRetryable(new LLMError('net', 'network')), true);
    });

    it('returns true for 5xx errors', () => {
      assert.strictEqual(isRetryable(new LLMError('err', 'api_error', 500)), true);
      assert.strictEqual(isRetryable(new LLMError('err', 'api_error', 503)), true);
    });

    it('returns false for 4xx errors', () => {
      assert.strictEqual(isRetryable(new LLMError('err', 'api_error', 401)), false);
      assert.strictEqual(isRetryable(new LLMError('err', 'api_error', 404)), false);
    });

    it('returns false for unknown errors', () => {
      assert.strictEqual(isRetryable(new LLMError('err', 'unknown')), false);
    });
  });

  describe('generateMessage', () => {
    let originalFetch;

    before(() => {
      originalFetch = global.fetch;
    });

    after(() => {
      global.fetch = originalFetch;
    });

    it('calls OpenAI-compatible endpoint with correct payload', async () => {
      let capturedBody;
      global.fetch = async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({
            choices: [{ message: { content: '{"subject":"feat: test","body":""}' } }]
          })
        };
      };

      const result = await generateMessage(
        'openai',
        { model: 'gpt-test', endpoint: 'https://api.test.com/v1/chat/completions', timeout: 5000 },
        'sk-test',
        'system prompt',
        'user prompt'
      );

      assert.strictEqual(result, '{"subject":"feat: test","body":""}');
      assert.strictEqual(capturedBody.model, 'gpt-test');
      assert.strictEqual(capturedBody.messages[0].role, 'system');
      assert.strictEqual(capturedBody.messages[0].content, 'system prompt');
      assert.strictEqual(capturedBody.messages[1].role, 'user');
      assert.strictEqual(capturedBody.messages[1].content, 'user prompt');
    });

    it('calls Anthropic endpoint with correct payload', async () => {
      let capturedBody;
      global.fetch = async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({
            content: [{ text: '{"subject":"fix: bug","body":"details"}' }]
          })
        };
      };

      await generateMessage(
        'anthropic',
        { model: 'claude-test', endpoint: 'https://api.anthropic.com/v1/messages', timeout: 5000 },
        'sk-ant-test',
        'system',
        'user'
      );

      assert.strictEqual(capturedBody.model, 'claude-test');
      assert.strictEqual(capturedBody.system, 'system');
      assert.strictEqual(capturedBody.messages[0].role, 'user');
    });

    it('calls Google endpoint with correct payload', async () => {
      let capturedUrl;
      let capturedBody;
      global.fetch = async (url, options) => {
        capturedUrl = url;
        capturedBody = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({
            candidates: [{ content: { parts: [{ text: '{"subject":"chore: update","body":""}' }] } }]
          })
        };
      };

      await generateMessage(
        'google',
        { model: 'gemini-test', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models', timeout: 5000 },
        'api-key',
        'sys',
        'usr'
      );

      assert.ok(capturedUrl.includes('/gemini-test:generateContent'));
      assert.ok(capturedUrl.includes('key=api-key'));
      assert.strictEqual(capturedBody.contents[0].parts[0].text, 'sys\n\nusr');
    });

    it('throws timeout error on slow response', async () => {
      global.fetch = async (url, options) => {
        if (options.signal?.aborted) {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        }
        await new Promise(r => setTimeout(r, 200));
        if (options.signal?.aborted) {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        }
        return { ok: true, json: async () => ({}) };
      };

      await assert.rejects(
        async () => generateMessage(
          'openai',
          { model: 'x', endpoint: 'http://localhost', timeout: 10 },
          '',
          '',
          ''
        ),
        err => err.code === 'timeout'
      );
    });

    it('throws api_error on 5xx', async () => {
      global.fetch = async () => ({
        ok: false,
        status: 503,
        text: async () => 'server error'
      });

      await assert.rejects(
        async () => generateMessage(
          'openai',
          { model: 'x', endpoint: 'http://localhost', timeout: 5000 },
          '',
          '',
          ''
        ),
        err => err.code === 'api_error' && err.status === 503
      );
    });

    it('throws api_error on 4xx', async () => {
      global.fetch = async () => ({
        ok: false,
        status: 401,
        text: async () => 'unauthorized'
      });

      await assert.rejects(
        async () => generateMessage(
          'openai',
          { model: 'x', endpoint: 'http://localhost', timeout: 5000 },
          '',
          '',
          ''
        ),
        err => err.code === 'api_error' && err.status === 401
      );
    });

    it('throws invalid_response when content missing', async () => {
      global.fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ choices: [] })
      });

      await assert.rejects(
        async () => generateMessage(
          'openai',
          { model: 'x', endpoint: 'http://localhost', timeout: 5000 },
          '',
          '',
          ''
        ),
        err => err.code === 'invalid_response'
      );
    });

    it('throws network error on fetch failure', async () => {
      global.fetch = async () => { throw new Error('ECONNREFUSED'); };

      await assert.rejects(
        async () => generateMessage(
          'openai',
          { model: 'x', endpoint: 'http://localhost', timeout: 5000 },
          '',
          '',
          ''
        ),
        err => err.code === 'network'
      );
    });
  });
});
