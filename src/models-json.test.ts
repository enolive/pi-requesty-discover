import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from './env'
import { getRequestyConfig, updateModelsJson } from './models-json'
import { createTempDirectory, type TempDirectory } from '../test/helpers/temp-agent'

type TestProvider = Record<string, unknown> & { models?: unknown }
type TestModelsJson = { providers: Record<string, TestProvider> }

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

  it('throws if API key is missing from models.json and env', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: { 'requesty-export': {} },
    })

    const readConfig = () => getRequestyConfig(envConfig)

    expect(readConfig).toThrow(
      `providers.requesty-export.apiKey must be set in ${envConfig.models_json_path} or via REQUESTY_API_KEY env var`,
    )
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

describe('updateModelsJson', () => {
  let tempDirectory: TempDirectory

  beforeEach(async () => {
    tempDirectory = await createTempDirectory()
  })

  afterEach(async () => {
    await tempDirectory.clean()
  })

  it('writes models into selected provider', async () => {
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: { 'requesty-export': { apiKey: 'models-json-key', models: [] } },
    })
    const data = getRequestyConfig(envConfig).data
    const models = [createModel({ id: 'requesty/model-a', name: 'Model A' })]

    updateModelsJson(data, models, envConfig)

    const written = await readModelsJsonFile(envConfig)
    expect(written).toMatchSnapshot()
  })

  it('preserves selected provider fields', async () => {
    const originalRequestyProvider = {
      name: 'Custom Requesty',
      baseUrl: 'https://example.com/v1',
      api: 'openai-completions',
      apiKey: 'models-json-key',
      customField: 'custom-value',
    }

    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: { 'requesty-export': originalRequestyProvider },
    })
    const data = getRequestyConfig(envConfig).data
    const models = [createModel(), createModel(), createModel()]

    updateModelsJson(data, models, envConfig)

    const written = await readModelsJsonFile(envConfig)
    expect(written.providers['requesty-export']).toEqual(expect.objectContaining(originalRequestyProvider))
  })

  it('preserves other providers', async () => {
    const originalAnthropicProvider = {
      name: 'Anthropic',
      apiKey: 'anthropic-key',
      models: [{ id: 'claude', name: 'Claude' }],
    }
    const envConfig = await createEnvWithModelsJson(tempDirectory, {
      providers: {
        'requesty-export': { apiKey: 'models-json-key', models: [] },
        anthropic: originalAnthropicProvider,
      },
    })
    const data = getRequestyConfig(envConfig).data
    const models = [createModel()]

    updateModelsJson(data, models, envConfig)

    const written = await readModelsJsonFile(envConfig)
    expect(written.providers.anthropic).toEqual(originalAnthropicProvider)
  })

  it('creates parent directory if needed', async () => {
    const modelsJsonPath = path.join(tempDirectory.homeDir, 'nested', 'agent', 'models.json')
    const envConfig = {
      ...createTestEnv(tempDirectory),
      models_json_path: modelsJsonPath,
    }
    const data = {
      providers: { 'requesty-export': { apiKey: 'models-json-key', models: [] } },
    }
    const models = [createModel()]

    updateModelsJson(data, models, envConfig)

    const content = await fs.readFile(modelsJsonPath, 'utf8')
    expect(content).toContain('requesty/model')
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

async function readModelsJsonFile(envConfig: Env): Promise<TestModelsJson> {
  const content = await fs.readFile(envConfig.models_json_path, 'utf8')
  return JSON.parse(content) as TestModelsJson
}

function createModel(overrides: Partial<ProviderModelConfig> = {}): ProviderModelConfig {
  return {
    id: 'requesty/model',
    name: 'Requesty Model',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
    },
    contextWindow: 128000,
    maxTokens: 4096,
    ...overrides,
  }
}
