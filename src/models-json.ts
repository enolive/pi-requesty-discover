import type { ProviderConfig, ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { getEnv, type Env } from './env'

const DEFAULT_BASE_URL = 'https://router.requesty.ai/v1'
const DEFAULT_NAME = 'Requesty'

const ProviderSchema = z
  .object({
    name: z.string().optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
  })
  .catchall(z.unknown())

const ModelsJsonSchema = z
  .object({
    providers: z.record(z.string(), ProviderSchema),
  })
  .catchall(z.unknown())

type ModelsJson = z.infer<typeof ModelsJsonSchema>
type ModelsJsonProvider = z.infer<typeof ProviderSchema>

type RequestyProvider = ModelsJsonProvider & {
  name: string
  baseUrl: string
  apiKey: string
}

type RequestyConfig = {
  data: ModelsJson
  provider: RequestyProvider
}

export function getRequestyConfig(envConfig: Env = getEnv()): RequestyConfig {
  const data = readModelsJson(envConfig)
  const provider = data.providers[envConfig.provider_id]

  if (!provider) {
    throw new Error(`${envConfig.models_json_path} does not define providers.${envConfig.provider_id}`)
  }

  const apiKey = envConfig.requesty_api_key
  return {
    data,
    provider: {
      ...provider,
      name: nonEmptyString(provider.name) ?? DEFAULT_NAME,
      baseUrl: normalizeBaseUrl(nonEmptyString(provider.baseUrl) ?? DEFAULT_BASE_URL),
      apiKey,
    },
  }
}

export function updateModelsJson(data: ModelsJson, models: ProviderModelConfig[], envConfig: Env = getEnv()): void {
  const provider = data.providers[envConfig.provider_id]
  data.providers[envConfig.provider_id] = {
    ...provider,
    apiKey: nonEmptyString(provider.apiKey) ?? '$REQUESTY_API_KEY',
    models: models.map(model => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  } satisfies ProviderConfig

  writeModelsJson(data, envConfig)
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function readModelsJson(envConfig: Env = getEnv()): ModelsJson {
  if (!fs.existsSync(envConfig.models_json_path)) {
    throw new Error(`${envConfig.models_json_path} does not exist`)
  }

  const data = JSON.parse(fs.readFileSync(envConfig.models_json_path, 'utf8')) as unknown
  const result = ModelsJsonSchema.safeParse(data)

  if (!result.success) {
    throw new Error(`${envConfig.models_json_path} is invalid: ${z.prettifyError(result.error)}`)
  }

  return result.data
}

function writeModelsJson(data: ModelsJson, envConfig: Env = getEnv()): void {
  fs.mkdirSync(path.dirname(envConfig.models_json_path), { recursive: true })
  const tmpPath = `${envConfig.models_json_path}.tmp`
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmpPath, envConfig.models_json_path)
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined
}
