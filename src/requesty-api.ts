import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'

const DEFAULT_CONTEXT_WINDOW = 128000
const DEFAULT_MAX_TOKENS = 4096

const RequestyModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    supports_reasoning: z.boolean().optional(),
    supports_vision: z.boolean().optional(),
    input_price: z.number().optional().nullable(),
    output_price: z.number().optional().nullable(),
    cached_price: z.number().optional().nullable(),
    caching_price: z.number().optional().nullable(),
    context_window: z.number().optional().nullable(),
    max_output_tokens: z.number().optional().nullable(),
  })
  .catchall(z.unknown())

export type RequestyModel = z.infer<typeof RequestyModelSchema>

const ListModelsResponseSchema = z.object({
  data: z.array(z.unknown()),
})

type Provider = {
  baseUrl: string
  apiKey: string
}

export async function discoverModels(provider: Provider): Promise<ProviderModelConfig[]> {
  const response = await fetch(`${provider.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${provider.apiKey}` },
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }

  const rawData = (await response.json()) as unknown
  const payload = ListModelsResponseSchema.parse(rawData)

  return payload.data
    .map(model => RequestyModelSchema.safeParse(model))
    .filter(result => result.success)
    .map(result => result.data)
    .map(model => ({
      id: model.id,
      name: model.name && model.name.length > 0 ? model.name : model.id,
      reasoning: model.supports_reasoning === true,
      input: model.supports_vision === true ? ['text', 'image'] : ['text'],
      cost: {
        input: pricePerMillionTokens(model.input_price),
        output: pricePerMillionTokens(model.output_price),
        cacheRead: pricePerMillionTokens(model.cached_price),
        cacheWrite: pricePerMillionTokens(model.caching_price),
      },
      contextWindow: model.context_window || DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.max_output_tokens || DEFAULT_MAX_TOKENS,
    }))
}

function pricePerMillionTokens(value: number | null | undefined): number {
  return (value ?? 0) * 1_000_000
}
