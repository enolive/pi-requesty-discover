import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import env from './env'
import { getRequestyConfig, updateModelsJson } from './models-json'
import { discoverModels } from './requesty-api'
import { checkModels, formatHealthSummary, writeHealthCheckLog } from './health-check'

const COMMAND_NAME = 'requesty-models-sync'
const DRY_RUN_ARG = '--dry-run'

interface AutocompleteItem {
  value: string
  label: string
  description: string
}

type NotificationLevel = 'info' | 'warning' | 'error'

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

async function runCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.setStatus(COMMAND_NAME, 'Discovering Requesty models...')
  const parts = args.split(' ')
  const dryRun = parts.includes(DRY_RUN_ARG)
  if (dryRun) {
    notify(ctx, 'running in dry mode, no changes will be done')
  }

  try {
    const { data, provider } = getRequestyConfig()
    const models = await discoverModels(provider)
    const modelsMap = new Map(models.map(m => [m.id, m]))

    let failed = []
    let passing: ProviderModelConfig[]
    let logNote = ''
    let healthCheckSummary = ''

    if (env.health_check_mode !== 'off') {
      ctx.ui.setStatus(COMMAND_NAME, `Checking ${models.length} model(s)...`)
      const healthResults = await checkModels(provider, models, env.health_check_mode === 'full')
      failed = healthResults.filter(r => !r.ok)
      passing = healthResults.flatMap(r => {
        const model = modelsMap.get(r.modelId)
        return r.ok && model ? [model] : []
      })
      healthCheckSummary = formatHealthSummary(healthResults)
      writeHealthCheckLog(env.health_check_log_path, provider, healthResults)
      logNote = `Full health check log: ${env.health_check_log_path}\n`
    } else {
      passing = models
    }

    const shouldUpdate = passing.length > 0 && !dryRun
    if (shouldUpdate) {
      updateModelsJson(data, passing)
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
    ctx.ui.setStatus(COMMAND_NAME, undefined)
  }
}

// noinspection JSUnusedGlobalSymbols
export default async function (pi: ExtensionAPI): Promise<void> {
  pi.registerCommand(COMMAND_NAME, {
    description: 'Dynamically discover Requesty models, run health checks, and update the local models.json.',
    getArgumentCompletions,
    handler: runCommand,
  })
}

function notify(ctx: ExtensionCommandContext, message: string, level?: NotificationLevel): void {
  const prefixedMessage = `${COMMAND_NAME}: ${message}`
  ctx.ui.notify(prefixedMessage, level)
}
