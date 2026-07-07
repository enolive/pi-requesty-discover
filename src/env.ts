import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { prettifyError, z } from 'zod'

const HealthCheckModeSchema = z.enum(['off', 'basic', 'full']).default('full')

export type Env = {
  models_json_path: string
  health_check_log_path: string
  provider_id: string
  requesty_api_key: string
  health_check_mode: z.infer<typeof HealthCheckModeSchema>
}

export function getEnv(): Env {
  const envVars = process.env
  const configuredAgentPath = envVars.PI_CODING_AGENT_DIR
  const defaultAgentPath = path.join(os.homedir(), '.pi', 'agent')
  const agentPath = configuredAgentPath || defaultAgentPath

  const result = HealthCheckModeSchema.safeParse(envVars.REQUESTY_HEALTH_CHECK_MODE)
  if (!result.success) {
    throw new Error(prettifyError(result.error))
  }

  const apiKey = envVars.REQUESTY_API_KEY
  if (!apiKey) {
    throw new Error(`apiKey must be set via REQUESTY_API_KEY env var`)
  }

  return {
    models_json_path: path.join(agentPath, 'models.json'),
    health_check_log_path: path.join(agentPath, 'requesty-health-check.log'),
    provider_id: envVars.REQUESTY_PROVIDER_ID ?? 'requesty-export',
    requesty_api_key: apiKey,
    health_check_mode: result.data,
  }
}

export default getEnv
