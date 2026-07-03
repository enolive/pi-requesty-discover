import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

const agent_path = path.join(os.homedir(), '.pi', 'agent')

const HealthCheckModeSchema = z.enum(['off', 'basic', 'full']).default('full')

export default {
  models_json_path: path.join(agent_path, 'models.json'),
  health_check_log_path: path.join(agent_path, 'requesty-health-check.log'),
  provider_id: process.env.REQUESTY_PROVIDER_ID ?? 'requesty-export',
  requesty_api_key: process.env.REQUESTY_API_KEY,
  health_check_mode: HealthCheckModeSchema.parse(process.env.REQUESTY_HEALTH_CHECK_MODE),
}
