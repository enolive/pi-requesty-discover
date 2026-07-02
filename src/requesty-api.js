const DEFAULT_CONTEXT_WINDOW = 128000
const DEFAULT_MAX_TOKENS = 4096

export async function discoverModels(provider) {
  const response = await fetch(`${provider.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${provider.apiKey}` },
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }

  const payload = await response.json()
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error('Expected OpenAI-compatible response with a data array')
  }

  return payload.data
    .filter(model => model && typeof model.id === 'string' && model.id.length > 0)
    .map(model => ({
      id: model.id,
      name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
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

function pricePerMillionTokens(value) {
  return (value ?? 0) * 1_000_000
}
