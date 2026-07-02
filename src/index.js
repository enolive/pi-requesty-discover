import env from './env.js'
import { getRequestyConfig, updateModelsJson } from './models-json.js'
import { discoverModels } from './requesty-api.js'
import { checkModels, formatHealthSummary, writeHealthCheckLog } from './health-check.js'

// noinspection JSUnusedGlobalSymbols
export default async function (pi) {
  pi.registerCommand('requesty-models-sync', {
    description: 'Dynamically discover Requesty models, run health checks, and update the local models.json.',
    getArgumentCompletions: prefix => {
      const options = [
        { value: '--dry-run', label: '--dry-run', description: 'Preview without writing into the new model.json file' },
      ]
      if (!prefix) return options
      return options.filter(o => o.value.toLowerCase().startsWith(prefix.toLowerCase()))
    },
    async handler(args, ctx) {
      ctx.ui.setStatus('requesty-models-sync', 'Discovering Requesty models...')
      const parts = args.split(' ')
      const dryRun = parts.includes('--dry-run')
      if (dryRun) {
        ctx.ui.notify('running in dry mode, no changes will be done')
      }

      try {
        const { data, provider } = getRequestyConfig()
        const models = await discoverModels(provider)
        const modelsMap = new Map(models.map(m => [m.id, m]))

        let failed = []
        let passing = []
        let logNote = ''
        let healthCheckSummary = ''

        if (env.health_check_mode !== 'off') {
          ctx.ui.setStatus('requesty-models-sync', `Checking ${models.length} model(s)...`)
          const healthResults = await checkModels(provider, models, env.health_check_mode === 'full')
          failed = healthResults.filter(r => !r.ok)
          passing = healthResults.filter(r => r.ok).map(r => modelsMap.get(r.modelId))
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
          ctx.ui.notify(message, 'info')
        } else if (failed.length < models.length) {
          ctx.ui.notify(message, 'warning')
        } else {
          ctx.ui.notify(message, 'error')
        }
      } catch (error) {
        ctx.ui.notify(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      } finally {
        ctx.ui.setStatus('requesty-models-sync', undefined)
      }
    },
  })
}
