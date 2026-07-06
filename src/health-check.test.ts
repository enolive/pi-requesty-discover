import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import fs from 'node:fs/promises'
import { delay, http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkModels,
  formatHealthSummary,
  postChatCompletion,
  writeHealthCheckLog,
  type HealthCheckResult,
  type Provider,
  HealthCheckProgress,
} from './health-check'
import { createTempDirectory, type TempDirectory } from '../test/helpers/temp-agent'
import { server } from '../test/setup'

const PROVIDER: Provider = {
  baseUrl: 'https://router.requesty.ai/v1',
  apiKey: 'test-key',
}

const completionsEndpoint = 'https://router.requesty.ai/v1/chat/completions'

const CHAT_BODY = {
  model: 'requesty/test-model',
  messages: [{ role: 'user', content: 'Say OK' }],
}

const positiveResponse = { choices: [{ message: { role: 'assistant', content: 'OK' } }] }

describe('postChatCompletion', () => {
  it('returns ok for response with non-empty choices', async () => {
    server.use(
      http.post(completionsEndpoint, () => {
        return HttpResponse.json(positiveResponse)
      }),
    )

    const result = await postChatCompletion(PROVIDER, CHAT_BODY)

    expect(result.ok).toBe(true)
  })

  it('returns failure for HTTP error', async () => {
    server.use(
      http.post(completionsEndpoint, () => {
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
      http.post(completionsEndpoint, () => {
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
      http.post(completionsEndpoint, () => {
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
      http.post(completionsEndpoint, ({ request }) => {
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
      http.post(completionsEndpoint, async ({ request }) => {
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
      http.post(completionsEndpoint, async () => {
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
      http.post(completionsEndpoint, async () => {
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
  it('calls basic completion check once per model', async () => {
    const requestBodies: unknown[] = []
    server.use(
      http.post(completionsEndpoint, async ({ request }) => {
        requestBodies.push(await request.json())
        return HttpResponse.json(positiveResponse)
      }),
    )
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]

    await checkModels(PROVIDER, models, false)

    expect(requestBodies).toMatchSnapshot()
  })

  it('calls basic and reasoning/tool check for reasoning models', async () => {
    const requestBodies: unknown[] = []
    server.use(
      http.post(completionsEndpoint, async ({ request }) => {
        requestBodies.push(await request.json())
        return HttpResponse.json(positiveResponse)
      }),
    )
    const models = [createModel({ id: 'requesty/reasoning-model', reasoning: true })]

    await checkModels(PROVIDER, models, true)

    expect(requestBodies).toMatchSnapshot()
  })

  it('returns expected response for failed reasoning/tool check', async () => {
    let requestNumber = 0
    server.use(
      http.post(completionsEndpoint, () => {
        requestNumber++
        if (requestNumber > 1) {
          return HttpResponse.text('BAM', { status: 418 })
        }
        return HttpResponse.json(positiveResponse)
      }),
    )
    const models = [createModel({ id: 'requesty/reasoning-model', reasoning: true })]

    const results = await checkModels(PROVIDER, models, true)

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: "Reasoning/tool check failed: HTTP 418 I'm a Teapot: BAM",
          modelId: 'requesty/reasoning-model',
          ok: false,
        }),
      ]),
    )
  })

  it('does not call reasoning/tool check for non-reasoning models', async () => {
    const requestBodies: unknown[] = []
    server.use(
      http.post(completionsEndpoint, async ({ request }) => {
        requestBodies.push(await request.json())
        return HttpResponse.json(positiveResponse)
      }),
    )
    const models = [createModel({ id: 'requesty/non-reasoning-model', reasoning: false })]

    await checkModels(PROVIDER, models, true)

    expect(requestBodies).toHaveLength(1)
    expect(requestBodies[0]).toMatchObject({ model: 'requesty/non-reasoning-model' })
  })

  it('does not call reasoning/tool check when basic check fails', async () => {
    const requestBodies: unknown[] = []
    server.use(
      http.post(completionsEndpoint, async ({ request }) => {
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
      http.post(completionsEndpoint, () => {
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

  it('reports progress after each model finishes', async () => {
    server.use(
      http.post(completionsEndpoint, async ({ request }) => {
        const body = (await request.json()) as { model: string }
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
    ]
    const progressEvents: HealthCheckProgress[] = []

    await checkModels(PROVIDER, models, false, {
      concurrency: 1,
      onProgress: progress => progressEvents.push(progress),
    })

    expect(progressEvents).toEqual([
      {
        completed: 1,
        total: 3,
        modelId: 'requesty/model-a',
      },
      {
        completed: 2,
        total: 3,
        modelId: 'requesty/model-b',
      },
      {
        completed: 3,
        total: 3,
        modelId: 'requesty/model-c',
      },
    ])
  })

  it('does not report progress when there are no models', async () => {
    const progressEvents: Array<unknown> = []

    await checkModels(PROVIDER, [], false, { onProgress: progress => progressEvents.push(progress) })

    expect(progressEvents).toEqual([])
  })

  it('respects parameterized concurrency', async () => {
    let activeRequests = 0
    let maxActiveRequests = 0
    server.use(
      http.post(completionsEndpoint, async () => {
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
      http.post(completionsEndpoint, async ({ request }) => {
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

describe('health summary and log output', () => {
  let tempDirectory: TempDirectory

  beforeEach(async () => {
    tempDirectory = await createTempDirectory()
  })

  afterEach(async () => {
    await tempDirectory.clean()
  })

  it('formats summaries', () => {
    const allPassedResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', ok: true }),
      createHealthCheckResult({ modelId: 'requesty/model-b', ok: true }),
    ]
    const partialFailureResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', ok: true }),
      createHealthCheckResult({
        modelId: 'requesty/failing-model',
        ok: false,
        error: 'HTTP 500 Internal Server Error',
      }),
    ]
    const allFailedResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', ok: false, error: 'first failure' }),
      createHealthCheckResult({ modelId: 'requesty/model-b', ok: false, error: 'second failure' }),
    ]

    const summaries = {
      allPassed: formatHealthSummary(allPassedResults),
      partialFailure: formatHealthSummary(partialFailureResults),
      allFailed: formatHealthSummary(allFailedResults),
    }

    expect(summaries).toMatchSnapshot()
  })

  it('writes log file', async () => {
    const partialFailureResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', ok: true }),
      createHealthCheckResult({
        modelId: 'requesty/failing-model',
        ok: false,
        error: 'HTTP 500 Internal Server Error',
      }),
    ]

    writeHealthCheckLog(tempDirectory.healthCheckLogPath, PROVIDER, partialFailureResults)

    const log = await fs.readFile(tempDirectory.healthCheckLogPath, 'utf8')
    expect(normalizeHealthCheckLog(log)).toMatchSnapshot()
  })

  it('writes log file without any errors', async () => {
    const partialFailureResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', ok: true }),
      createHealthCheckResult({ modelId: 'requesty/model-b', ok: true }),
    ]

    writeHealthCheckLog(tempDirectory.healthCheckLogPath, PROVIDER, partialFailureResults)

    const log = await fs.readFile(tempDirectory.healthCheckLogPath, 'utf8')
    expect(normalizeHealthCheckLog(log)).toMatchSnapshot()
  })
})

function createHealthCheckResult(overrides: Partial<HealthCheckResult> = {}): HealthCheckResult {
  return {
    modelId: 'requesty/model',
    ok: true,
    latencyMs: 123,
    ...overrides,
  }
}

function normalizeHealthCheckLog(log: string): string {
  return log.replace(/^Timestamp: .+$/m, 'Timestamp: <timestamp>')
}

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
