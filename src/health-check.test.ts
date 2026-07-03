import { delay, http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { postChatCompletion, type Provider } from './health-check'
import { server } from '../test/setup'

const PROVIDER: Provider = {
  baseUrl: 'https://router.requesty.ai/v1',
  apiKey: 'test-key',
}

const CHAT_BODY = {
  model: 'requesty/test-model',
  messages: [{ role: 'user', content: 'Say OK' }],
}

describe('postChatCompletion', () => {
  it('returns ok for response with non-empty choices', async () => {
    server.use(
      http.post('https://router.requesty.ai/v1/chat/completions', () => {
        return HttpResponse.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
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
        return HttpResponse.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
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
        return HttpResponse.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
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
        return HttpResponse.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
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
