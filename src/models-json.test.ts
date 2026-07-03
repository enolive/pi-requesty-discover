import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from './env'
import { getRequestyConfig } from './models-json'
import { createTempDirectory, TempDirectory } from '../test/helpers/temp-agent.ts'

describe('getRequestyConfig', () => {
  let tempDirectory: TempDirectory

  beforeEach(async () => {
    tempDirectory = await createTempDirectory()
  })

  afterEach(async () => {
    await tempDirectory.clean()
  })

  it('throws if models.json does not exist', () => {
    const envConfig = createTestEnv(tempDirectory)

    const readConfig = () => getRequestyConfig(envConfig)

    expect(readConfig).toThrow(`models.json does not exist`)
  })

  it('throws if JSON is invalid', async () => {
    const envConfig = await createEnvWithModelsJsonContent(tempDirectory, '{')

    const readConfig = () => getRequestyConfig(envConfig)

    expect(readConfig).toThrow()
  })

  it('throws if schema is invalid', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, { providers: [] })

    const readConfig = () => getRequestyConfig(envConfig)

    expect(readConfig).toThrow(`${envConfig.models_json_path} is invalid`)
  })

  it('throws if configured provider is missing', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: { other: { apiKey: 'models-json-key' } },
    })

    const readConfig = () => getRequestyConfig(envConfig)

    expect(readConfig).toThrow(`${envConfig.models_json_path} does not define providers.requesty-export`)
  })

  it('reads provider config from models.json', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: {
        'requesty-export': {
          name: 'Custom Requesty',
          baseUrl: 'https://example.com/v1',
          apiKey: 'models-json-key',
        },
      },
    })

    const config = getRequestyConfig(envConfig)

    expect(config.provider).toMatchObject({
      name: 'Custom Requesty',
      baseUrl: 'https://example.com/v1',
      apiKey: 'models-json-key',
    })
  })

  it('env API key override wins over models.json', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: { 'requesty-export': { apiKey: 'models-json-key' } },
    })
    envConfig.requesty_api_key = 'env-key'

    const config = getRequestyConfig(envConfig)

    expect(config.provider.apiKey).toBe('env-key')
  })

  it('defaults name to Requesty', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: { 'requesty-export': { apiKey: 'models-json-key' } },
    })

    const config = getRequestyConfig(envConfig)

    expect(config.provider.name).toBe('Requesty')
  })

  it('defaults base URL to https://router.requesty.ai/v1', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: { 'requesty-export': { apiKey: 'models-json-key' } },
    })

    const config = getRequestyConfig(envConfig)

    expect(config.provider.baseUrl).toBe('https://router.requesty.ai/v1')
  })

  it('removes trailing slash from base URL', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: {
        'requesty-export': {
          baseUrl: 'https://router.requesty.ai/v1///',
          apiKey: 'models-json-key',
        },
      },
    })

    const config = getRequestyConfig(envConfig)

    expect(config.provider.baseUrl).toBe('https://router.requesty.ai/v1')
  })
})

function createTestEnv(tempDirectory: TempDirectory): Env {
  return {
    models_json_path: tempDirectory.modelsJsonPath,
    health_check_log_path: tempDirectory.healthCheckLogPath,
    provider_id: 'requesty-export',
    requesty_api_key: undefined,
    health_check_mode: 'full',
  }
}

async function createEnvWithModelsJsonContent(tempDirectory: TempDirectory, content: string) {
  await fs.writeFile(tempDirectory.modelsJsonPath, content, 'utf8')
  return createTestEnv(tempDirectory)
}

async function createEnvWithModelsJson(tempDirectory: TempDirectory, data: unknown) {
  return createEnvWithModelsJsonContent(tempDirectory, JSON.stringify(data))
}
