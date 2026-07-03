import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { discoverModels, RequestyModel } from './requesty-api'
import { server } from '../test/setup'

const providerConfig = {
  baseUrl: 'https://router.requesty.ai/v1',
  apiKey: 'test-key',
}

function modelsResponse(data: unknown[]) {
  return HttpResponse.json({ data })
}

describe('discoverModels', () => {
  it('calls GET /models', async () => {
    const models: RequestyModel[] = [{ id: 'Provider 1' }, { id: 'Provider 2' }]

    server.use(
      http.get('https://router.requesty.ai/v1/models', () => {
        return modelsResponse(models)
      }),
    )

    const result = await discoverModels(providerConfig)

    const modelIds = models.map(p => p.id)
    const providerIds = result.map(m => m.id)
    expect(providerIds).toEqual(modelIds)
  })

  it('sends bearer token', async () => {
    let authorizationHeader: string | null = null

    server.use(
      http.get('https://router.requesty.ai/v1/models', ({ request }) => {
        authorizationHeader = request.headers.get('authorization')
        return modelsResponse([])
      }),
    )

    await discoverModels(providerConfig)

    expect(authorizationHeader).toBe('Bearer test-key')
  })

  it('throws on HTTP error', async () => {
    server.use(
      http.get('https://router.requesty.ai/v1/models', () => {
        return HttpResponse.json({ error: 'Requesty unavailable' }, { status: 503, statusText: 'Service Unavailable' })
      }),
    )

    const discover = () => discoverModels(providerConfig)

    await expect(discover).rejects.toThrow('HTTP 503 Service Unavailable')
  })

  it('validates malformed response', async () => {
    server.use(
      http.get('https://router.requesty.ai/v1/models', () => {
        return HttpResponse.json({ data: {} })
      }),
    )

    const discover = () => discoverModels(providerConfig)

    await expect(discover).rejects.toThrow()
  })

  it('skips invalid model entries', async () => {
    server.use(
      http.get('https://router.requesty.ai/v1/models', () => {
        return modelsResponse([
          { id: 'requesty/valid-model', name: 'Valid Model' },
          { id: '' },
          { name: 'Missing ID' },
          null,
        ])
      }),
    )

    const models = await discoverModels(providerConfig)

    expect(models).toHaveLength(1)
    expect(models[0]?.id).toBe('requesty/valid-model')
  })

  it('maps Requesty model fields', async () => {
    server.use(
      http.get('https://router.requesty.ai/v1/models', () => {
        return modelsResponse([
          {
            id: 'requesty/mapped-model',
            name: 'Mapped Model',
            supports_reasoning: true,
            supports_vision: true,
            input_price: 0.000001,
            output_price: 0.000002,
            cached_price: 0.0000003,
            caching_price: 0.0000004,
            context_window: 200000,
            max_output_tokens: 8192,
          },
        ])
      }),
    )

    const models = await discoverModels(providerConfig)

    expect(models).toEqual([
      {
        id: 'requesty/mapped-model',
        name: 'Mapped Model',
        reasoning: true,
        input: ['text', 'image'],
        cost: {
          input: 1,
          output: 2,
          cacheRead: 0.3,
          cacheWrite: 0.39999999999999997,
        },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ])
  })

  it('uses defaults for optional Requesty model fields', async () => {
    server.use(
      http.get('https://router.requesty.ai/v1/models', () => {
        return modelsResponse([{ id: 'requesty/default-model' }])
      }),
    )

    const models = await discoverModels(providerConfig)

    expect(models).toEqual([
      {
        id: 'requesty/default-model',
        name: 'requesty/default-model',
        reasoning: false,
        input: ['text'],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ])
  })
})
