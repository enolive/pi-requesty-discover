import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

const HealthCheckModeSchema = z.enum(['off', 'basic', 'full']).default('full')

export type Env = {
  models_json_path: string
  health_check_log_path: string
  provider_id: string
  requesty_api_key?: string
  health_check_mode: z.infer<typeof HealthCheckModeSchema>
}

export function getEnv(options?: { env?: NodeJS.ProcessEnv; homeDir?: string }): Env {
  const envVars = options?.env ?? process.env
  const homeDir = options?.homeDir ?? os.homedir()
  const agent_path = path.join(homeDir, '.pi', 'agent')

  return {
    models_json_path: path.join(agent_path, 'models.json'),
    health_check_log_path: path.join(agent_path, 'requesty-health-check.log'),
    provider_id: envVars.REQUESTY_PROVIDER_ID ?? 'requesty-export',
    requesty_api_key: envVars.REQUESTY_API_KEY,
    health_check_mode: HealthCheckModeSchema.parse(envVars.REQUESTY_HEALTH_CHECK_MODE),
  }
}

export default getEnv()
