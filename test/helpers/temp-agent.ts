import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export async function createTempAgent() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-requesty-'))
  const agentDir = path.join(homeDir, '.pi', 'agent')
  const modelsJsonPath = path.join(agentDir, 'models.json')
  const healthCheckLogPath = path.join(agentDir, 'requesty-health-check.log')

  await fs.mkdir(agentDir, { recursive: true })

  return {
    homeDir,
    agentDir,
    modelsJsonPath,
    healthCheckLogPath,
  }
}
