import fs from 'node:fs'
import path from 'node:path'
import env from './env.js'

const DEFAULT_BASE_URL = 'https://router.requesty.ai/v1'
const DEFAULT_NAME = 'Requesty'

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, '')
}

function readModelsJson() {
  if (!fs.existsSync(env.models_json_path)) {
    throw new Error(`${env.models_json_path} does not exist`)
  }

  const data = JSON.parse(fs.readFileSync(env.models_json_path, 'utf8'))
  if (!data.providers || typeof data.providers !== 'object') {
    throw new Error(`${env.models_json_path} does not define providers`)
  }

  return data
}

export function getRequestyConfig() {
  const data = readModelsJson()
  const provider = data.providers[env.provider_id]

  if (!provider || typeof provider !== 'object') {
    throw new Error(`${env.models_json_path} does not define providers.${env.provider_id}`)
  }

  const apiKey =
    env.requesty_api_key ||
    (typeof provider.apiKey === 'string' && provider.apiKey.length > 0 ? provider.apiKey : undefined)

  if (!apiKey) {
    throw new Error(
      `providers.${env.provider_id}.apiKey must be set in ${env.models_json_path} or via REQUESTY_API_KEY env var`,
    )
  }

  const name = typeof provider.name === 'string' && provider.name.length > 0 ? provider.name : DEFAULT_NAME

  const baseUrl = normalizeBaseUrl(
    typeof provider.baseUrl === 'string' && provider.baseUrl.length > 0 ? provider.baseUrl : DEFAULT_BASE_URL,
  )

  return {
    data,
    provider: {
      ...provider,
      name,
      baseUrl,
      apiKey,
    },
  }
}

function writeModelsJson(data) {
  fs.mkdirSync(path.dirname(env.models_json_path), { recursive: true })
  const tmpPath = `${env.models_json_path}.tmp`
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmpPath, env.models_json_path)
}

export function updateModelsJson(data, models) {
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
  }
  writeModelsJson(data)
}
