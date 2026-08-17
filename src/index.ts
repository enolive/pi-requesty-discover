import {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ProviderModelConfig,
} from '@earendil-works/pi-coding-agent'
import { type Env, getEnv } from './env'
import {
  diffModels,
  formatModelsDiffSummary,
  getRequestyConfig,
  type ModelsDiff,
  updateModelsJson,
} from './models-json'
import { type ApiKeyInfo, discoverModels, fetchApiKeyInfo } from './requesty-api'
import { checkModels, formatHealthSummary, writeHealthCheckLog } from './health-check'
import { RequestyStatusLoader } from './ui/requesty-status-loader.ts'

const COMMAND_NAME = 'requesty-discover'
const DRY_RUN_ARG = '--dry-run'
export const USAGE_STATUS_KEY = 'requesty-usage'

interface AutocompleteItem {
  value: string
  label: string
  description: string
}

export type NotificationLevel = 'info' | 'warning' | 'error'

export type Notifier = {
  notify(message: string, level: NotificationLevel): void
}

export type Confirmer = {
  confirm(title: string, message: string): Promise<boolean>
}

export type StatusReporter = {
  set(message: string): void
}

type ModelsJsonData = ReturnType<typeof getRequestyConfig>['data']

type DiscoveryEvaluation = {
  dryRun: boolean
  modelCount: number
  failedCount: number
  passing: ProviderModelConfig[]
  diff: ModelsDiff
  healthCheckSummary: string
  logNote: string
  data: ModelsJsonData
  env: Env
}

type EvaluationResult =
  | {
      ok: true
      value: DiscoveryEvaluation
    }
  | { ok: false; error: unknown }

// noinspection JSUnusedGlobalSymbols
export default function (pi: ExtensionAPI) {
  pi.registerCommand(COMMAND_NAME, {
    description: 'Dynamically discover Requesty models, run health checks, and update the local models.json.',
    getArgumentCompletions,
    handler: async (args, ctx) => {
      await runDiscoveryWorkflow(ctx, args)
    },
  })

  pi.on('turn_end', async (_event, ctx) => {
    await updateUsageStatus(ctx)
  })
}

export async function runDiscoveryWorkflow(ctx: ExtensionCommandContext, args: string) {
  // Interactive TUI command; no print/json/rpc path.
  if (ctx.mode !== 'tui') {
    return
  }

  const notifier = createUiNotifier(ctx)
  const confirmer = createUiConfirmer(ctx)

  // Phase A: progress UI only. Loader must close before confirm (Phase B).
  // Errors are wrapped because ctx.ui.custom resolves via done() and does not reject.
  const evaluationResult: EvaluationResult = await runWithStatusUi(ctx, 'Discovering models...', async status => {
    try {
      const evaluation = await evaluateDiscovery(args, status)
      return { ok: true, value: evaluation }
    } catch (error) {
      return { ok: false, error }
    }
  })

  if (!evaluationResult.ok) {
    notifier.notify(formatDiscoveryFailure(evaluationResult.error), 'error')
    return
  }

  // Phases B + C: decide, optional write, final notify — outside the loader.
  await finalizeDiscovery(evaluationResult.value, confirmer, notifier)
}

async function runWithStatusUi<T>(
  ctx: ExtensionCommandContext,
  initialMessage: string,
  fn: (status: StatusReporter) => Promise<T>,
): Promise<T> {
  return ctx.ui.custom<T>((_tui, theme, _kb, done) => {
    const loader = new RequestyStatusLoader(_tui, theme, initialMessage)
    const status = createLoaderStatusReporter(loader)
    void Promise.resolve()
      .then(() => fn(status))
      .then(done)
      .catch(done)
    return loader
  })
}

function formatDiscoveryFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `Discovery failed: ${detail}`
}

async function evaluateDiscovery(args: string, status: StatusReporter): Promise<DiscoveryEvaluation> {
  status.set('Discovering Requesty models...')
  const dryRun = args.split(' ').includes(DRY_RUN_ARG)

  const env = getEnv()
  const { data, provider, existingModelIds } = getRequestyConfig(env)
  const models = await discoverModels(provider)
  const modelsMap = new Map(models.map(m => [m.id, m]))

  let diff: ModelsDiff
  let failedCount = 0
  let passing: ProviderModelConfig[]
  let logNote = ''
  let healthCheckSummary = ''

  if (env.health_check_mode !== 'off') {
    status.set(`Checking models 0/${models.length}...`)
    const healthResults = await checkModels(provider, models, env.health_check_mode === 'full', {
      onProgress: ({ completed, total }) => {
        status.set(`Checking models ${completed}/${total}...`)
      },
    })
    const sortedResults = healthResults.toSorted((a, b) => a.modelId.localeCompare(b.modelId))
    failedCount = sortedResults.filter(r => !r.ok).length
    passing = sortedResults.flatMap(r => {
      const model = modelsMap.get(r.modelId)
      return r.ok && model ? [model] : []
    })
    diff = diffModels(existingModelIds, passing)
    healthCheckSummary = formatHealthSummary(sortedResults)
    writeHealthCheckLog(provider, sortedResults, diff, env)
    logNote = `Full health check log: ${env.health_check_log_path}\n`
  } else {
    passing = models
    diff = diffModels(existingModelIds, passing)
  }

  return {
    dryRun,
    modelCount: models.length,
    failedCount,
    passing,
    diff,
    healthCheckSummary,
    logNote,
    data,
    env,
  }
}

async function finalizeDiscovery(
  evaluation: DiscoveryEvaluation,
  confirmer: Confirmer,
  notifier: Notifier,
): Promise<void> {
  const level = notificationLevel(evaluation)
  const summary = buildDiscoverySummary(evaluation)

  // Always surface the discovery result first (toast styling), then decide.
  if (evaluation.dryRun) {
    notifier.notify(
      `${summary}
Dry run: left models.json unchanged.`,
      level,
    )
    return
  }

  if (evaluation.passing.length === 0) {
    notifier.notify(
      `${summary}
Left models.json unchanged.`,
      level,
    )
    return
  }

  notifier.notify(summary, level)
  const { title, message } = buildConfirmPrompt(evaluation)
  const shouldUpdate = await confirmer.confirm(title, message)
  if (shouldUpdate) {
    updateModelsJson(evaluation.data, evaluation.passing, evaluation.env)
    notifier.notify('Updated models.json. Run /reload to use the changes.', 'info')
    return
  }

  notifier.notify('Left models.json unchanged.', 'info')
}

function buildDiscoverySummary(evaluation: DiscoveryEvaluation): string {
  return [
    `Discovered ${evaluation.modelCount} Requesty model(s).`,
    evaluation.healthCheckSummary.trimEnd(),
    formatModelsDiffSummary(evaluation.diff),
    evaluation.logNote.trimEnd(),
  ]
    .filter(part => part.length > 0)
    .join('\n')
}

function buildConfirmPrompt(evaluation: DiscoveryEvaluation): { title: string; message: string } {
  const hasIdChanges = evaluation.diff.added.length > 0 || evaluation.diff.removed.length > 0
  if (hasIdChanges) {
    return {
      title: `Write ${evaluation.passing.length} model(s)?`,
      message: 'Update models.json with the discovery result above.',
    }
  }
  return {
    title: 'Refresh models.json?',
    message: 'No model ID changes. Rewrite the file to refresh metadata anyway?',
  }
}

function notificationLevel(evaluation: DiscoveryEvaluation): NotificationLevel {
  if (evaluation.failedCount === 0) return 'info'
  if (evaluation.failedCount < evaluation.modelCount) return 'warning'
  return 'error'
}

function getArgumentCompletions(prefix: string): AutocompleteItem[] {
  const options = [
    {
      value: DRY_RUN_ARG,
      label: DRY_RUN_ARG,
      description: 'Preview discovery without offering to write models.json',
    },
  ]
  if (!prefix) return options
  return options.filter(o => o.value.toLowerCase().startsWith(prefix.toLowerCase()))
}

function createUiNotifier(ctx: ExtensionCommandContext): Notifier {
  return {
    notify(message: string, level?: NotificationLevel) {
      const prefixedMessage = `${COMMAND_NAME}: ${message}`
      ctx.ui.notify(prefixedMessage, level)
    },
  }
}

function createUiConfirmer(ctx: ExtensionCommandContext): Confirmer {
  return {
    confirm(title, message) {
      return ctx.ui.confirm(title, message)
    },
  }
}

function createLoaderStatusReporter(loader: RequestyStatusLoader): StatusReporter {
  return {
    set(message: string) {
      loader.setMessage(message)
    },
  }
}

async function updateUsageStatus(ctx: ExtensionContext): Promise<void> {
  try {
    const info = await fetchUsageStatus()
    ctx.ui.setStatus(USAGE_STATUS_KEY, formatUsageStatus(info))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    ctx.ui.notify(`${USAGE_STATUS_KEY}: Usage check failed: ${detail}`, 'error')
  }
}

export function formatUsageStatus(info: ApiKeyInfo): string {
  const spend = `$${info.monthlySpend.toFixed(2)}`
  if (info.monthlyLimit <= 0) {
    return `Requesty "${info.name}": ${spend} (unlimited)`
  }
  const limit = `$${info.monthlyLimit.toFixed(2)}`
  const percent = Math.floor((info.monthlySpend / info.monthlyLimit) * 100)
  return `Requesty "${info.name}": ${spend}/${limit} (${percent}%)`
}

async function fetchUsageStatus() {
  const env = getEnv()
  const { provider } = getRequestyConfig(env)
  return await fetchApiKeyInfo(provider)
}
