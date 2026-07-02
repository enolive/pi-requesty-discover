import fs from 'node:fs'
import path from 'node:path'
import env from './env.js'

const HEALTH_CHECK_CONCURRENCY = 10
const HEALTH_CHECK_TIMEOUT_MS = 15_000
const HEALTH_CHECK_TIMEOUT_RETRIES = 2
const HEALTH_CHECK_RETRY_DELAY_MS = 500

export async function checkModels(provider, models, checkReasoning) {
  const results = []
  const queue = [...models]
  let active = 0

  await new Promise(resolve => {
    function next() {
      while (active < HEALTH_CHECK_CONCURRENCY && queue.length > 0) {
        const model = queue.shift()
        active++
        checkModel(provider, model, checkReasoning).then(result => {
          results.push({ modelId: model.id, ...result })
          active--
          if (queue.length === 0 && active === 0) resolve()
          else next()
        })
      }
      if (queue.length === 0 && active === 0) resolve()
    }
    next()
  })

  return results
}

async function checkModel(provider, model, checkReasoning) {
  const basicResult = await postChatCompletion(provider, {
    model: model.id,
    messages: [{ role: 'user', content: 'Say OK' }],
    max_tokens: 16,
  })

  if (!basicResult.ok || !model.reasoning || !checkReasoning) {
    return basicResult
  }

  const reasoningResult = await postChatCompletion(provider, {
    model: model.id,
    messages: [{ role: 'user', content: 'Say OK. Do not call any tools.' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'health_check_noop',
          description: 'A no-op tool used only to verify tool compatibility during model health checks.',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      },
    ],
    reasoning_effort: 'low',
  })

  if (!reasoningResult.ok) {
    return {
      ...reasoningResult,
      error: `Reasoning/tool check failed: ${reasoningResult.error}`,
    }
  }

  return {
    ok: true,
    latencyMs: basicResult.latencyMs + reasoningResult.latencyMs,
  }
}

export function formatHealthSummary(results) {
  const passed = results.filter(r => r.ok)
  const failed = results.filter(r => !r.ok)

  if (failed.length === 0) {
    return `Health check: all ${passed.length} OK.`
  }

  const failedModels = failed.map(r => `- ${r.modelId}`).join('\n')

  return `Health check: ${passed.length} OK, ${failed.length} failed:\n${failedModels}\n`
}

export function writeHealthCheckLog(logPath, provider, results) {
  const passed = results.filter(r => r.ok)
  const failed = results.filter(r => !r.ok)
  const lines = [
    `Requesty health check log`,
    `Timestamp: ${new Date().toISOString()}`,
    `Provider: ${env.provider_id}`,
    `Base URL: ${provider.baseUrl}`,
    `Total: ${results.length}`,
    `Passed: ${passed.length}`,
    `Failed: ${failed.length}`,
    '',
  ]

  if (failed.length === 0) {
    lines.push('No failed models.')
  } else {
    lines.push('Failed models:', '')
    for (const result of failed) {
      lines.push(
        `Model: ${result.modelId}`,
        `Latency: ${result.latencyMs}ms`,
        'Error:',
        result.error || 'Unknown error',
        '',
        '---',
        '',
      )
    }
  }

  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8')
}

export async function postChatCompletion(provider, body) {
  const start = Date.now()
  try {
    const response = await fetchWithTimeoutRetries(
      `${provider.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      {
        timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
        retries: HEALTH_CHECK_TIMEOUT_RETRIES,
        retryDelayMs: HEALTH_CHECK_RETRY_DELAY_MS,
      },
    )

    const latencyMs = Date.now() - start

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, latencyMs, error: `HTTP ${response.status} ${response.statusText}${text ? `: ${text}` : ''}` }
    }

    const payload = await response.json()
    if (!payload?.choices?.length) {
      return { ok: false, latencyMs, error: 'Empty choices in response' }
    }

    return { ok: true, latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - start
    const attempts = HEALTH_CHECK_TIMEOUT_RETRIES + 1
    return {
      ok: false,
      latencyMs,
      error: isTimeoutError(err)
        ? `Timed out after ${attempts} attempt(s); per-attempt timeout is ${HEALTH_CHECK_TIMEOUT_MS / 1000}s`
        : String(err),
    }
  }
}

async function fetchWithTimeoutRetries(url, options, { timeoutMs, retries, retryDelayMs }) {
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  let lastError

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      lastError = error

      if (!isTimeoutError(error) || attempt === retries) {
        throw error
      }

      if (retryDelayMs > 0) {
        await sleep(retryDelayMs)
      }
    }
  }

  throw lastError
}

function isTimeoutError(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}
