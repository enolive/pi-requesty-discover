import {
  BorderedLoader,
  ExtensionAPI,
  ExtensionCommandContext,
  ProviderModelConfig,
} from '@earendil-works/pi-coding-agent'
import { getEnv } from './env'
import { getRequestyConfig, updateModelsJson } from './models-json'
import { discoverModels } from './requesty-api'
import { checkModels, formatHealthSummary, writeHealthCheckLog } from './health-check'

const COMMAND_NAME = 'requesty-discover'
const DRY_RUN_ARG = '--dry-run'

interface AutocompleteItem {
  value: string
  label: string
  description: string
}

type NotificationLevel = 'info' | 'warning' | 'error'

type StatusReporter = {
  set(message: string): void
  clear(): void
}

type LoaderWithMutableMessage = {
  loader?: {
    setMessage(message: string): void
  }
}

// noinspection JSUnusedGlobalSymbols
export default function (pi: ExtensionAPI) {
  pi.registerCommand(COMMAND_NAME, {
    description: 'Dynamically discover Requesty models, run health checks, and update the local models.json.',
    getArgumentCompletions,
    handler: async (args, ctx) => {
      await runWithStatusUi(ctx, 'Discovering models...', status => runCommand(args, ctx, status))
    },
  })
}

async function runWithStatusUi<T>(
  ctx: ExtensionCommandContext,
  initialMessage: string,
  fn: (status: StatusReporter) => Promise<T>,
): Promise<T> {
  if (ctx.mode !== 'tui') {
    return fn(createFooterStatusReporter(ctx))
  }

  return ctx.ui.custom<T>((_tui, theme, _kb, done) => {
    const loader = new BorderedLoader(_tui, theme, initialMessage, { cancellable: false })
    const status = createLoaderStatusReporter(loader)
    fn(status).then(done).catch(done)
    return loader
  })
}

function createFooterStatusReporter(ctx: ExtensionCommandContext): StatusReporter {
  return {
    set(message: string) {
      ctx.ui.setStatus(COMMAND_NAME, message)
    },
    clear() {
      ctx.ui.setStatus(COMMAND_NAME, undefined)
    },
  }
}

function createLoaderStatusReporter(loader: BorderedLoader): StatusReporter {
  return {
    set(message: string) {
      setBorderedLoaderMessage(loader, message)
    },
    clear() {
      // Nothing to clear: the overlay closes when ctx.ui.custom() resolves.
    },
  }
}

function setBorderedLoaderMessage(loader: BorderedLoader, message: string): void {
  const mutableLoader = loader as unknown as LoaderWithMutableMessage
  mutableLoader.loader?.setMessage(message)
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

async function runCommand(args: string, ctx: ExtensionCommandContext, status: StatusReporter): Promise<void> {
  status.set('Discovering Requesty models...')
  const parts = args.split(' ')
  const dryRun = parts.includes(DRY_RUN_ARG)
  if (dryRun) {
    notify(ctx, 'running in dry mode, no changes will be done')
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
      notify(ctx, message, 'info')
    } else if (failed.length < models.length) {
      notify(ctx, message, 'warning')
    } else {
      notify(ctx, message, 'error')
    }
  } catch (error) {
    notify(ctx, `Discovery failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    status.clear()
  }
}

function notify(ctx: ExtensionCommandContext, message: string, level?: NotificationLevel): void {
  const prefixedMessage = `${COMMAND_NAME}: ${message}`
  ctx.ui.notify(prefixedMessage, level)
}
