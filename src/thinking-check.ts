import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import type OpenAI from 'openai'
import type { Provider } from './health-check'
import { postChatCompletion } from './health-check'

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ThinkingModeStatus = 'ok' | 'warning' | 'error' | 'unsupported'

export type ThinkingModeResult = {
  level: ThinkingLevel
  mappedValue: string
  status: ThinkingModeStatus
  latencyMs: number
  sawReasoning: boolean
  reasoningText?: string
  contentText?: string
  rawDeltas?: string[]
  error?: string
  note?: string
}

export type ThinkingCheckResult = {
  modelId: string
  results: ThinkingModeResult[]
}

// Default mapping used when a reasoning model has no thinkingLevelMap: probe the
// standard OpenAI-style effort values for the levels that could map to anything.
const DEFAULT_LEVEL_MAP: Partial<Record<ThinkingLevel, string>> = {
  off: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

export type ThinkingCheckProgress = {
  level: ThinkingLevel
  mappedValue: string
  status: ThinkingModeStatus
  latencyMs: number
  sawReasoning: boolean
  reasoningText?: string
  contentText?: string
  rawDeltas?: string[]
  error?: string
}

export async function checkThinkingModes(
  provider: Provider,
  model: ProviderModelConfig,
  onProgress?: (progress: ThinkingCheckProgress) => void,
): Promise<ThinkingCheckResult> {
  const configured = (model.thinkingLevelMap ?? {}) as Partial<Record<ThinkingLevel, string | null>>
  const map: Partial<Record<ThinkingLevel, string | null>> =
    model.reasoning && Object.values(configured).every(v => v === undefined) ? DEFAULT_LEVEL_MAP : configured
  const levels: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

  const results: ThinkingModeResult[] = []
  for (const level of levels) {
    const mappedValue = map[level]
    if (mappedValue === null || mappedValue === undefined) {
      const skipped: ThinkingModeResult = {
        level,
        mappedValue: '(none)',
        status: 'unsupported',
        note: 'not mapped by model',
        latencyMs: 0,
        sawReasoning: false,
      }
      onProgress?.(skipped)
      results.push(skipped)
      continue
    }

    // no max_tokens: collides with thinking budgets on some providers
    const trollPrompt = `
      Does this JavaScript function terminate for n=0? Take everything about it into account, especially the execution environment. 
      Answer with a simple either \`yes\` or \`no\` followed with a brief why: 
      \`function f(n){ return n ? f(n-1) : f(n) }\`
      `
    const check = await postChatCompletion(provider, {
      model: model.id,
      messages: [
        {
          role: 'user',
          content: trollPrompt,
        },
      ],
      reasoning_effort: (level === 'off'
        ? undefined
        : mappedValue) as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming['reasoning_effort'],
    })

    if (check.status !== 'ok') {
      const failed: ThinkingModeResult = {
        level,
        mappedValue,
        status: 'error',
        latencyMs: check.latencyMs,
        sawReasoning: false,
        error: check.error,
      }
      onProgress?.(failed)
      results.push(failed)
      continue
    }

    const passed: ThinkingModeResult = {
      level,
      mappedValue,
      status: check.sawReasoning || level === 'off' ? 'ok' : 'warning',
      latencyMs: check.latencyMs,
      sawReasoning: check.sawReasoning,
      reasoningText: check.reasoningText,
      contentText: check.contentText,
      rawDeltas: check.rawDeltas,
      error:
        check.sawReasoning || level === 'off'
          ? undefined
          : 'No reasoning delta in stream — level may be silently ignored',
    }
    onProgress?.(passed)
    results.push(passed)
  }

  return { modelId: model.id, results }
}

export function formatThinkingCheckReport(result: ThinkingCheckResult): string {
  const lines = [`Thinking mode check for ${result.modelId}:`, '']
  for (const r of result.results) {
    const extra =
      r.status === 'unsupported'
        ? (r.note ?? 'not supported')
        : `${r.latencyMs}ms${r.sawReasoning ? ', reasoning deltas seen' : r.error ? `, ${r.error}` : ''}`
    lines.push(`${r.level.padEnd(8)} -> ${r.mappedValue.padEnd(12)} ${r.status.padEnd(11)} ${extra}`)
    if (r.contentText) {
      lines.push(`          answer: ${r.contentText}`)
    }
  }
  return lines.join('\n')
}
