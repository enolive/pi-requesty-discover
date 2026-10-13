import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { type Env, getEnv } from './env'
import { type GetApiKey, getRequestyConfig } from './models-json'
import { type ApiKeyInfo, fetchApiUsage } from './requesty-api'
import { RequestyStatusLoader } from './ui/requesty-status-loader'
import {
  type DiscoveryEvaluation,
  type DiscoveryUi,
  type RefreshModelsRegistry,
  evaluateDiscovery,
  finalizeDiscovery,
  formatDiscoveryFailure,
  getArgumentCompletions,
} from './discovery'
import { type DiscoverySettings, readDiscoverySettings } from './settings'
import { checkThinkingModes, formatThinkingCheckReport, type ProbePromptType } from './thinking-check'
import { runCatching, runCatchingAsync, type Try } from './utils'

const COMMAND_NAME = 'requesty-discover'
export const THINKING_CHECK_COMMAND_NAME = 'requesty-thinking-check'
export const USAGE_STATUS_KEY = 'requesty-usage'

// token suppresses stale writes when turns overlap
let latestToken: object = {}

// noinspection JSUnusedGlobalSymbols
export default function (pi: ExtensionAPI) {
  const env = runCatching(() => getEnv())
  if (!env.ok) {
    console.error('env loading failed', env.error)
    return
  }
  const settings = runCatching(() => readDiscoverySettings(env.value))
  if (!settings.ok) {
    console.error('settings loading failed', settings.error)
    return
  }

  pi.registerCommand(COMMAND_NAME, {
    description: 'Dynamically discover Requesty models, run health checks, and update the local models.json.',
    getArgumentCompletions,
    handler: async (args, ctx) => {
      await runDiscoveryWorkflow(ctx, settings.value, env.value, args)
    },
  })

  pi.registerCommand(THINKING_CHECK_COMMAND_NAME, {
    description: 'Probe each pi thinking level of the current model against Requesty.',
    getArgumentCompletions: (prefix: string) => {
      const options = [
        { label: 'base', value: 'base', description: 'simple prime question (default)' },
        { label: 'troll', value: 'troll', description: 'Y-combinator bad-factorial trap' },
      ]
      if (!prefix) return options
      return options.filter(o => o.value.toLowerCase().startsWith(prefix.toLowerCase()))
    },
    handler: async (args, ctx) => {
      const promptType = (args.trim() || 'base') as ProbePromptType
      await runThinkingCheck(ctx, settings.value, env.value, promptType)
    },
  })

  pi.on('turn_end', (_event, ctx) => {
    void updateUsageStatus(ctx, settings.value, env.value)
  })

  pi.on('session_start', (_event, ctx) => {
    void updateUsageStatus(ctx, settings.value, env.value)
  })

  pi.on('model_select', (_event, ctx) => {
    void updateUsageStatus(ctx, settings.value, env.value)
  })
}

export async function runDiscoveryWorkflow(
  ctx: ExtensionCommandContext,
  settings: DiscoverySettings,
  env: Env,
  args: string,
) {
  const ui = ctx.mode === 'tui' ? createTuiUi(ctx) : createConsoleUi()
  if (ctx.mode !== 'tui') {
    return runSilentDiscoveryWorkflow(ctx, settings, env, args, ui)
  } else {
    return runInteractiveDiscoverWorkflow(ctx, settings, env, args, ui)
  }
}

async function runSilentDiscoveryWorkflow(
  ctx: ExtensionCommandContext,
  settings: DiscoverySettings,
  env: Env,
  args: string,
  ui: DiscoveryUi,
): Promise<void> {
  const evaluationResult = await runCatchingAsync(() =>
    evaluateDiscovery(args, settings, env, ui, createGetApiKey(ctx)),
  )
  if (!evaluationResult.ok) {
    ui.notify(formatDiscoveryFailure(evaluationResult.error), 'error')
    return
  }

  await finalizeDiscovery(evaluationResult.value, settings, env, ui)
}

async function runInteractiveDiscoverWorkflow(
  ctx: ExtensionCommandContext,
  settings: DiscoverySettings,
  env: Env,
  args: string,
  ui: DiscoveryUi,
) {
  const evaluationResult: Try<DiscoveryEvaluation> = await runWithStatusUi(
    ctx,
    'Discovering models...',
    async statusUi =>
      await runCatchingAsync(() => evaluateDiscovery(args, settings, env, statusUi, createGetApiKey(ctx))),
  )

  if (!evaluationResult.ok) {
    ui.notify(formatDiscoveryFailure(evaluationResult.error), 'error')
    return
  }

  await finalizeDiscovery(evaluationResult.value, settings, env, ui, createRefreshRegistry(ctx))
  await updateUsageStatus(ctx, settings, env)
}

async function runWithStatusUi<T>(
  ctx: ExtensionCommandContext,
  initialMessage: string,
  fn: (statusUi: DiscoveryUi) => Promise<T>,
): Promise<T> {
  return ctx.ui.custom<T>((tui, theme, _kb, done) => {
    const loader = new RequestyStatusLoader(tui, theme, initialMessage)
    void Promise.resolve()
      .then(() => fn(createTuiUi(ctx, loader)))
      .then(done)
      .catch(done)
    return loader
  })
}

async function updateUsageStatus(ctx: ExtensionContext, settings: DiscoverySettings, env: Env): Promise<void> {
  if (!ctx.hasUI) return // no footer to write to (print/json mode): skip the wasted fetch
  const token: object = {}
  latestToken = token
  const shouldClear = ctx.model?.provider !== settings.providerId
  try {
    if (shouldClear) {
      ctx.ui.setStatus(USAGE_STATUS_KEY, undefined)
      return
    }
    const info = await fetchUsageStatus(createGetApiKey(ctx), settings, env)
    if (latestToken !== token) return
    ctx.ui.setStatus(USAGE_STATUS_KEY, formatUsageStatus(info))
  } catch {
    // best-effort footer update: swallow fetch errors and stale-ctx throws (e.g. after /reload)
  }
}

/** Prototype: probe the thinking levels of the current model. */
export async function runThinkingCheck(
  ctx: ExtensionCommandContext,
  settings: DiscoverySettings,
  env: Env,
  promptType: ProbePromptType = 'base',
): Promise<void> {
  const notify = (message: string) => {
    if (ctx.hasUI) ctx.ui.notify(message, 'info')
    else console.log(message)
  }

  const model = ctx.model
  if (!model) {
    notify('No model selected.')
    return
  }
  if (model.provider !== settings.providerId) {
    notify(`Current model is from provider "${model.provider}", not "${settings.providerId}". Skipping.`)
    return
  }
  if (!model.reasoning) {
    notify(`${model.id} does not support reasoning. There is nothing to probe.`)
    return
  }

  if (promptType !== 'base' && promptType !== 'troll') {
    notify(`Unknown probe type. Use "base" or "troll".`)
    return
  }

  notify(
    `Probing thinking levels of ${model.id} (${Object.keys(model.thinkingLevelMap ?? {}).length} mapped levels, ${promptType} prompt)...`,
  )
  const { provider } = await getRequestyConfig(createGetApiKey(ctx), settings, env)
  const result = await checkThinkingModes(provider, model, promptType, progress => {
    const extra = progress.error ? `: ${progress.error}` : ''
    notify(`  ${progress.level} -> ${progress.mappedValue}: ${progress.status}${extra}`)
    if (progress.reasoningText) {
      notify(`    reasoning: ${progress.reasoningText}`)
    }
    if (!progress.sawReasoning && progress.rawDeltas) {
      for (const raw of progress.rawDeltas.slice(0, 3)) {
        notify(`    raw delta: ${raw}`)
      }
    }
  })
  notify(formatThinkingCheckReport(result))
}

export function formatUsageStatus(info: ApiKeyInfo): string {
  const spend = `$${info.monthlySpend.toFixed(2)}`
  if (info.monthlyLimit <= 0) {
    return `${info.name}: ${spend} (unlimited)`
  }
  const limit = `$${info.monthlyLimit.toFixed(2)}`
  const percent = Math.floor((info.monthlySpend / info.monthlyLimit) * 100)
  return `${info.name}: ${spend}/${limit} (${percent}%)`
}

let lastFetched: { value: ApiKeyInfo; time: Date } | undefined

async function fetchUsageStatus(getApiKey: GetApiKey, settings: DiscoverySettings, env: Env): Promise<ApiKeyInfo> {
  const now = new Date()
  if (lastFetched?.time && now.getTime() - lastFetched.time.getTime() < 2000) {
    return lastFetched.value
  }
  const { provider } = await getRequestyConfig(getApiKey, settings, env)
  const value = await fetchApiUsage(provider)
  lastFetched = { value, time: new Date() }
  return value
}

/**
 * For testing purposes, reset the cache after each run
 */
export function resetUsageStatusCache(): void {
  lastFetched = undefined
}

/** TUI adapter: routes the workflow's UI needs to Pi's ctx.ui. */
export function createTuiUi(ctx: ExtensionContext, loader?: RequestyStatusLoader): DiscoveryUi {
  return {
    notify: (message, level) => ctx.ui.notify(`${COMMAND_NAME}: ${message}`, level),
    confirm: (title, message) => ctx.ui.confirm(title, message),
    setStatus: message => loader?.setMessage(message),
  }
}

/**
 * Console adapter for non-interactive modes. Always confirms: print mode is
 * non-interactive, so the write proceeds without a confirmation dialog.
 */
export function createConsoleUi(): DiscoveryUi {
  return {
    notify: (message, level) => console.log(`[${level}] ${message}`),
    // eslint-disable-next-line @typescript-eslint/require-await -- must match the DiscoveryUi promise signature
    confirm: async () => true,
    setStatus: message => console.log(message),
  }
}

/** Re-reads models.json through Pi's model registry so new models are usable without /reload. */
export function createRefreshRegistry(ctx: ExtensionContext): RefreshModelsRegistry {
  return () =>
    ctx.modelRegistry.refresh({ allowNetwork: false }).then(result => {
      if (result.aborted || result.errors.size > 0) {
        const detail = [...result.errors.entries()].map(([id, error]) => `${id}: ${error.message}`).join(', ')
        throw new Error(detail || 'refresh aborted')
      }
    })
}

function createGetApiKey(ctx: ExtensionContext): GetApiKey {
  return providerId => ctx.modelRegistry.getApiKeyForProvider(providerId)
}
