import { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import { getEnv } from './env'
import { getRequestyConfig, updateModelsJson } from './models-json'
import { discoverModels } from './requesty-api'
import { checkModels, formatHealthSummary, writeHealthCheckLog } from './health-check'
import { RequestyStatusLoader } from './ui/requesty-status-loader.ts'

const COMMAND_NAME = 'requesty-discover'
const DRY_RUN_ARG = '--dry-run'

interface AutocompleteItem {
  value: string
  label: string
  description: string
}

export type NotificationLevel = 'info' | 'warning' | 'error'

export type Notifier = {
  notify(message: string, level?: NotificationLevel): void
}

export type StatusReporter = {
  set(message: string): void
  clear(): void
}

// noinspection JSUnusedGlobalSymbols
export default function (pi: ExtensionAPI) {
  pi.registerCommand(COMMAND_NAME, {
    description: 'Dynamically discover Requesty models, run health checks, and update the local models.json.',
    getArgumentCompletions,
    handler: async (args, ctx) => {
      await runWithStatusUi(ctx, 'Discovering models...', (status, notifier) => runCommand(args, status, notifier))
    },
  })
}

async function runWithStatusUi<T>(
  ctx: ExtensionCommandContext,
  initialMessage: string,
  fn: (status: StatusReporter, notifier: Notifier) => Promise<T>,
): Promise<T> {
  if (ctx.mode !== 'tui') {
    return fn(createNoopStatusReporter(), createNoopNotifier())
  }

  return ctx.ui.custom<T>((_tui, theme, _kb, done) => {
    const loader = new RequestyStatusLoader(_tui, theme, initialMessage)
    const notifier = createUiNotifier(ctx)
    const status = createLoaderStatusReporter(loader)
    void Promise.resolve()
      .then(() => fn(status, notifier))
      .then(done)
      .catch(done)
    return loader
  })
}

export async function runCommand(args: string, status: StatusReporter, notifier: Notifier): Promise<void> {
  status.set('Discovering Requesty models...')
  const parts = args.split(' ')
  const dryRun = parts.includes(DRY_RUN_ARG)
  if (dryRun) {
    notifier.notify('running in dry mode, no changes will be done', undefined)
  }

  try {
    const env = getEnv()
    const { data, provider } = getRequestyConfig(env)
    const models = await discoverModels(provider)
    const modelsMap = new Map(models.map(m => [m.id, m]))

    let failed = []
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
      failed = sortedResults.filter(r => !r.ok)
      passing = sortedResults.flatMap(r => {
        const model = modelsMap.get(r.modelId)
        return r.ok && model ? [model] : []
      })
      healthCheckSummary = formatHealthSummary(sortedResults)
      writeHealthCheckLog(provider, sortedResults, env)
      logNote = `Full health check log: ${env.health_check_log_path}\n`
    } else {
      passing = models
    }

    const shouldUpdate = passing.length > 0 && !dryRun
    if (shouldUpdate) {
      updateModelsJson(data, passing, env)
    }

    const writeNote = shouldUpdate ? 'Run /reload to use models.json changes.' : 'models.json was not updated.'
    const message = `Discovered ${models.length} Requesty model(s).\n${healthCheckSummary}${logNote}${writeNote}`

    if (failed.length === 0) {
      notifier.notify(message, 'info')
    } else if (failed.length < models.length) {
      notifier.notify(message, 'warning')
    } else {
      notifier.notify(message, 'error')
    }
  } catch (error) {
    notifier.notify(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    status.clear()
  }
}

function getArgumentCompletions(prefix: string): AutocompleteItem[] {
  const options = [
    {
      value: DRY_RUN_ARG,
      label: DRY_RUN_ARG,
      description: 'Preview without writing into the new model.json file',
    },
  ]
  if (!prefix) return options
  return options.filter(o => o.value.toLowerCase().startsWith(prefix.toLowerCase()))
}

function createNoopStatusReporter(): StatusReporter {
  return {
    set() {
      // Status output is only rendered in TUI mode.
    },
    clear() {
      // Status output is only rendered in TUI mode.
    },
  }
}

function createNoopNotifier(): Notifier {
  return {
    notify() {
      // Notifications are only rendered in TUI mode.
    },
  }
}

function createUiNotifier(ctx: ExtensionCommandContext): Notifier {
  return {
    notify(message: string, level?: NotificationLevel) {
      const prefixedMessage = `${COMMAND_NAME}: ${message}`
      ctx.ui.notify(prefixedMessage, level)
    },
  }
}

function createLoaderStatusReporter(loader: RequestyStatusLoader): StatusReporter {
  return {
    set(message: string) {
      loader.setMessage(message)
    },
    clear() {
      // Nothing to clear: the loader closes when ctx.ui.custom() resolves.
    },
  }
}
