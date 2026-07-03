import type { ProviderConfig, ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import env from './env'

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

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function readModelsJson(): ModelsJson {
  if (!fs.existsSync(env.models_json_path)) {
    throw new Error(`${env.models_json_path} does not exist`)
  }

  const data = JSON.parse(fs.readFileSync(env.models_json_path, 'utf8'))
  const result = ModelsJsonSchema.safeParse(data)

  if (!result.success) {
    throw new Error(`${env.models_json_path} is invalid: ${z.prettifyError(result.error)}`)
  }

  return result.data
}

export function getRequestyConfig(): RequestyConfig {
  const data = readModelsJson()
  const provider = data.providers[env.provider_id]

  if (!provider) {
    throw new Error(`${env.models_json_path} does not define providers.${env.provider_id}`)
  }

  const apiKey = env.requesty_api_key || nonEmptyString(provider.apiKey)

  if (!apiKey) {
    throw new Error(
      `providers.${env.provider_id}.apiKey must be set in ${env.models_json_path} or via REQUESTY_API_KEY env var`,
    )
  }

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

function writeModelsJson(data: ModelsJson): void {
  fs.mkdirSync(path.dirname(env.models_json_path), { recursive: true })
  const tmpPath = `${env.models_json_path}.tmp`
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmpPath, env.models_json_path)
}

export function updateModelsJson(data: ModelsJson, models: ProviderModelConfig[]): void {
  data.providers[env.provider_id] = {
    ...data.providers[env.provider_id],
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

  writeModelsJson(data)
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined
}
