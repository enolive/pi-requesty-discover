import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import { delay, http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { checkModels, postChatCompletion, type Provider } from './health-check'
import { server } from '../test/setup'

const PROVIDER: Provider = {
  baseUrl: 'https://router.requesty.ai/v1',
  apiKey: 'test-key',
}

const CHAT_BODY = {
  model: 'requesty/test-model',
  messages: [{ role: 'user', content: 'Say OK' }],
}

const positiveResponse = { choices: [{ message: { role: 'assistant', content: 'OK' } }] }

describe('postChatCompletion', () => {
  it('returns ok for response with non-empty choices', async () => {
    server.use(
      http.post('https://router.requesty.ai/v1/chat/completions', () => {
        return HttpResponse.json(positiveResponse)
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result.ok).toBe(true)
  })

  it('returns failure for HTTP error', async () => {
    server.use(
      http.post('https://router.requesty.ai/v1/chat/completions', () => {
        return HttpResponse.text('bad gateway', {
          status: 502,
          statusText: 'Bad Gateway',
        })
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result).toMatchObject({
      ok: false,
      error: 'HTTP 502 Bad Gateway: bad gateway',
    })
  })

  it('returns failure for empty choices', async () => {
    server.use(
      http.post('https://router.requesty.ai/v1/chat/completions', () => {
        return HttpResponse.json({ choices: [] })
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result).toMatchObject({
      ok: false,
      error: 'Empty choices in response',
    })
  })

  it('returns failure for malformed response', async () => {
    server.use(
      http.post('https://router.requesty.ai/v1/chat/completions', () => {
        return HttpResponse.json({ choices: 'not-an-array' })
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result).toMatchObject({
      ok: false,
      error: 'Empty choices in response',
    })
  })

  it('sends bearer token', async () => {
    let authorizationHeader: string | null = null
    server.use(
      http.post('https://router.requesty.ai/v1/chat/completions', ({ request }) => {
        authorizationHeader = request.headers.get('authorization')
        return HttpResponse.json(positiveResponse)
      }),
    )

    await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(authorizationHeader).toBe('Bearer test-key')
  })

  it('sends model in request body', async () => {
    let requestBody: unknown
    server.use(
      http.post('https://router.requesty.ai/v1/chat/completions', async ({ request }) => {
        requestBody = await request.json()
        return HttpResponse.json(positiveResponse)
      }),
    )

    await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(requestBody).toMatchObject({ model: 'requesty/test-model' })
  })

  it('retries timeout failures', async () => {
    let requestCount = 0
    server.use(
      http.post('https://router.requesty.ai/v1/chat/completions', async () => {
        requestCount++
        await delay(50)
        return HttpResponse.json(positiveResponse)
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY, {
      timeoutMs: 1,
      retries: 1,
      retryDelayMs: 3,
    })

    expect(result).toMatchObject({
      ok: false,
      error: 'Timed out after 2 attempt(s); per-attempt timeout is 0.001s',
    })
    expect(requestCount).toBe(2)
  })

  it('retries timeout failures without delay', async () => {
    let requestCount = 0
    server.use(
      http.post('https://router.requesty.ai/v1/chat/completions', async () => {
        requestCount++
        await delay(50)
        return HttpResponse.json(positiveResponse)
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY, {
      timeoutMs: 1,
      retries: 1,
      retryDelayMs: 0,
    })

    expect(result).toMatchObject({
      ok: false,
      error: 'Timed out after 2 attempt(s); per-attempt timeout is 0.001s',
    })
    expect(requestCount).toBe(2)
  })
})

describe('checkModels', () => {
  it('basic check calls chat completion once per model', async () => {
    const requestBodies: unknown[] = []
    server.use(
      http.post('https://router.requesty.ai/v1/chat/completions', async ({ request }) => {
        requestBodies.push(await request.json())
        return HttpResponse.json(positiveResponse)
      }),
    )
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]

    await checkModels(PROVIDER, models, false)

    expect(requestBodies).toMatchSnapshot()
  })

  it('full check calls reasoning/tool check for reasoning models', async () => {
    const requestBodies: unknown[] = []
    server.use(
      http.post('https://router.requesty.ai/v1/chat/completions', async ({ request }) => {
        requestBodies.push(await request.json())
        return HttpResponse.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
      }),
    )
    const models = [createModel({ id: 'requesty/reasoning-model', reasoning: true })]

    await checkModels(PROVIDER, models, true)

    expect(requestBodies).toHaveLength(2)
    expect(requestBodies[1]).toMatchSnapshot()
  })

  it('full check does not call reasoning/tool check for non-reasoning models', async () => {
    const requestBodies: unknown[] = []
    server.use(
      http.post('https://router.requesty.ai/v1/chat/completions', async ({ request }) => {
        requestBodies.push(await request.json())
        return HttpResponse.json(positiveResponse)
      }),
    )
    const models = [createModel({ id: 'requesty/non-reasoning-model', reasoning: false })]

    await checkModels(PROVIDER, models, true)

    expect(requestBodies).toHaveLength(1)
    expect(requestBodies[0]).toMatchObject({ model: 'requesty/non-reasoning-model' })
  })

  it('failed basic check does not run reasoning/tool check', async () => {
    const requestBodies: unknown[] = []
    server.use(
      http.post('https://router.requesty.ai/v1/chat/completions', async ({ request }) => {
        requestBodies.push(await request.json())
        return HttpResponse.text('model failed', { status: 500, statusText: 'Internal Server Error' })
      }),
    )
    const models = [createModel({ id: 'requesty/failing-model', reasoning: true })]

    const results = await checkModels(PROVIDER, models, true)

    expect(requestBodies).toHaveLength(1)
    expect(results[0]).toMatchObject({
      modelId: 'requesty/failing-model',
      ok: false,
    })
  })

  it('returns result objects with modelId', async () => {
    server.use(
      http.post('https://router.requesty.ai/v1/chat/completions', () => {
        return HttpResponse.json(positiveResponse)
      }),
    )
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]

    const results = await checkModels(PROVIDER, models, false)

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: 'requesty/model-a' }),
        expect.objectContaining({ modelId: 'requesty/model-b' }),
      ]),
    )
  })

  it('respects parameterized concurrency', async () => {
    let activeRequests = 0
    let maxActiveRequests = 0
    server.use(
      http.post('https://router.requesty.ai/v1/chat/completions', async () => {
        activeRequests++
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
        await delay(50)
        activeRequests--
        return HttpResponse.json(positiveResponse)
      }),
    )
    const models = [
      createModel({ id: 'requesty/model-a' }),
      createModel({ id: 'requesty/model-b' }),
      createModel({ id: 'requesty/model-c' }),
      createModel({ id: 'requesty/model-d' }),
    ]

    await checkModels(PROVIDER, models, false, { concurrency: 2 })

    expect(maxActiveRequests).toBeLessThanOrEqual(2)
  })

  it('continues processing queued models after failures', async () => {
    server.use(
      http.post('https://router.requesty.ai/v1/chat/completions', async ({ request }) => {
        const body = (await request.json()) as { model: string }
        await delay(50)
        if (body.model === 'requesty/model-b') {
          return HttpResponse.text('model failed', { status: 500, statusText: 'Internal Server Error' })
        }
        return HttpResponse.json(positiveResponse)
      }),
    )
    const models = [
      createModel({ id: 'requesty/model-a' }),
      createModel({ id: 'requesty/model-b' }),
      createModel({ id: 'requesty/model-c' }),
      createModel({ id: 'requesty/model-d' }),
    ]

    const results = await checkModels(PROVIDER, models, false, { concurrency: 2 })

    expect(results).toHaveLength(4)
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: 'requesty/model-a', ok: true }),
        expect.objectContaining({ modelId: 'requesty/model-b', ok: false }),
        expect.objectContaining({ modelId: 'requesty/model-c', ok: true }),
        expect.objectContaining({ modelId: 'requesty/model-d', ok: true }),
      ]),
    )
  })
})

function createModel(overrides: Partial<ProviderModelConfig> = {}): ProviderModelConfig {
  return {
    id: 'requesty/model',
    name: 'Requesty Model',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
    },
    contextWindow: 128000,
    maxTokens: 4096,
    ...overrides,
  }
}
