import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { getEnv, type Env } from './env'

const HEALTH_CHECK_CONCURRENCY = 10
const HEALTH_CHECK_TIMEOUT_MS = 15_000
const HEALTH_CHECK_TIMEOUT_RETRIES = 2
const HEALTH_CHECK_RETRY_DELAY_MS = 500

const defaultHealthCheckOptions = {
  concurrency: HEALTH_CHECK_CONCURRENCY,
  timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
  retries: HEALTH_CHECK_TIMEOUT_RETRIES,
  retryDelayMs: HEALTH_CHECK_RETRY_DELAY_MS,
}

const ChatCompletionResponseSchema = z.object({
  choices: z.array(z.unknown()).min(1),
})

export type Provider = {
  baseUrl: string
  apiKey: string
}

export type HealthCheckResult = {
  modelId: string
  ok: boolean
  latencyMs: number
  error?: string
}

type ModelCheckResult = Omit<HealthCheckResult, 'modelId'>

export type HealthCheckProgress = {
  completed: number
  total: number
  modelId: string
}

export type HealthCheckOptions = {
  concurrency?: number
  timeoutMs?: number
  retries?: number
  retryDelayMs?: number
  onProgress?: (progress: HealthCheckProgress) => void
}

type ResolvedHealthCheckOptions = Required<Omit<HealthCheckOptions, 'onProgress'>> &
  Pick<HealthCheckOptions, 'onProgress'>

export async function checkModels(
  provider: Provider,
  models: ProviderModelConfig[],
  checkReasoning: boolean,
  options: HealthCheckOptions = {},
): Promise<HealthCheckResult[]> {
  const healthCheckOptions = resolveHealthCheckOptions(options)
  const results: HealthCheckResult[] = []
  const queue = [...models]
  const total = models.length
  let active = 0
  let completed = 0

  await new Promise<void>(resolve => {
    function next() {
      while (active < healthCheckOptions.concurrency && queue.length > 0) {
        const model = queue.shift()
        if (!model) continue

        active++
        void checkModel(provider, model, checkReasoning, healthCheckOptions).then(result => {
          const healthCheckResult = { modelId: model.id, ...result }
          results.push(healthCheckResult)
          completed++
          healthCheckOptions.onProgress?.({ completed, total, modelId: model.id })
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

async function checkModel(
  provider: Provider,
  model: ProviderModelConfig,
  checkReasoning: boolean,
  options: ResolvedHealthCheckOptions,
): Promise<ModelCheckResult> {
  const basicResult = await postChatCompletion(
    provider,
    {
      model: model.id,
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 16,
    },
    options,
  )

  if (!basicResult.ok || !model.reasoning || !checkReasoning) {
    return basicResult
  }

  const reasoningResult = await postChatCompletion(
    provider,
    {
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
    },
    options,
  )

  if (!reasoningResult.ok) {
    return {
      ok: false,
      latencyMs: reasoningResult.latencyMs,
      error: `Reasoning/tool check failed: ${reasoningResult.error}`,
    }
  }

  return {
    ok: true,
    latencyMs: basicResult.latencyMs + reasoningResult.latencyMs,
  }
}

export function formatHealthSummary(results: HealthCheckResult[]): string {
  const passed = results.filter(r => r.ok)
  const failed = results.filter(r => !r.ok)

  if (failed.length === 0) {
    return `Health check: all ${passed.length} OK.`
  }

  const failedModels = failed.map(r => `- ${r.modelId}`).join('\n')

  return `Health check: ${passed.length} OK, ${failed.length} failed:\n${failedModels}\n`
}

export function writeHealthCheckLog(
  logPath: string,
  provider: Provider,
  results: HealthCheckResult[],
  envConfig: Env = getEnv(),
): void {
  const passed = results.filter(r => r.ok)
  const failed = results.filter(r => !r.ok)
  const lines = [
    `Requesty health check log`,
    `Timestamp: ${new Date().toISOString()}`,
    `Provider: ${envConfig.provider_id}`,
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

export async function postChatCompletion(
  provider: Provider,
  body: unknown,
  options: HealthCheckOptions = {},
): Promise<ModelCheckResult> {
  const healthCheckOptions = resolveHealthCheckOptions(options)
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
      healthCheckOptions,
    )

    const latencyMs = Date.now() - start

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, latencyMs, error: `HTTP ${response.status} ${response.statusText}${text ? `: ${text}` : ''}` }
    }

    const result = ChatCompletionResponseSchema.safeParse(await response.json())
    if (!result.success) {
      return { ok: false, latencyMs, error: 'Empty choices in response' }
    }

    return { ok: true, latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - start
    const attempts = healthCheckOptions.retries + 1
    return {
      ok: false,
      latencyMs,
      error: isTimeoutError(err)
        ? `Timed out after ${attempts} attempt(s); per-attempt timeout is ${healthCheckOptions.timeoutMs / 1000}s`
        : String(err),
    }
  }
}

function resolveHealthCheckOptions(options: HealthCheckOptions): ResolvedHealthCheckOptions {
  return {
    ...defaultHealthCheckOptions,
    ...options,
  }
}

async function fetchWithTimeoutRetries(
  url: string,
  options: RequestInit,
  { timeoutMs, retries, retryDelayMs }: ResolvedHealthCheckOptions,
) {
  function sleep(ms: number) {
    if (ms <= 0) {
      return
    }
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (!isTimeoutError(error) || attempt >= retries) {
        throw error
      }

      await sleep(retryDelayMs)
    }
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}
