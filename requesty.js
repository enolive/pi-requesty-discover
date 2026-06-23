import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODELS_JSON_PATH = path.join(os.homedir(), ".pi", "agent", "models.json");
const PROVIDER = "requesty-export";
const DEFAULT_BASE_URL = "https://router.requesty.ai/v1";
const DEFAULT_NAME = "Requesty";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 4096;

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

function readModelsJson() {
  if (!fs.existsSync(MODELS_JSON_PATH)) {
    throw new Error(`${MODELS_JSON_PATH} does not exist`);
  }

  const data = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, "utf8"));
  if (!data.providers || typeof data.providers !== "object") {
    throw new Error(`${MODELS_JSON_PATH} does not define providers`);
  }

  return data;
}

function getRequestyConfig() {
  const data = readModelsJson();
  const provider = data.providers[PROVIDER];

  if (!provider || typeof provider !== "object") {
    throw new Error(`${MODELS_JSON_PATH} does not define providers.${PROVIDER}`);
  }

  if (typeof provider.apiKey !== "string" || provider.apiKey.length === 0) {
    throw new Error(`providers.${PROVIDER}.apiKey must be set in ${MODELS_JSON_PATH}`);
  }

  const name = typeof provider.name === "string" && provider.name.length > 0 ? provider.name : DEFAULT_NAME;

  const baseUrl = normalizeBaseUrl(
    typeof provider.baseUrl === "string" && provider.baseUrl.length > 0 ? provider.baseUrl : DEFAULT_BASE_URL,
  );

  return {
    data,
    provider: {
      ...provider,
      name: name,
      baseUrl: baseUrl,
      apiKey: provider.apiKey,
    },
  };
}

async function discoverModels(provider) {
  const response = await fetch(`${provider.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${provider.apiKey}` },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error("Expected OpenAI-compatible response with a data array");
  }

  return payload.data
    .filter((model) => model && typeof model.id === "string" && model.id.length > 0)
    .map((model) => ({
      id: model.id,
      name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
      reasoning: model.supports_reasoning === true,
      input: model.supports_vision === true ? ["text", "image"] : ["text"],
      cost: {
        input: pricePerMillionTokens(model.input_price),
        output: pricePerMillionTokens(model.output_price),
        cacheRead: pricePerMillionTokens(model.cached_price),
        cacheWrite: pricePerMillionTokens(model.caching_price),
      },
      contextWindow: model.context_window || DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.max_output_tokens || DEFAULT_MAX_TOKENS,
    }));
}

function pricePerMillionTokens(value) {
  return (value ?? 0) * 1_000_000;
}

function writeModelsJson(data) {
  fs.mkdirSync(path.dirname(MODELS_JSON_PATH), { recursive: true });
  const tmpPath = `${MODELS_JSON_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, MODELS_JSON_PATH);
}

function updateModelsJson(data, models) {
  data.providers[PROVIDER] = {
    ...data.providers[PROVIDER],
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  };
  writeModelsJson(data);
}

export default async function (pi) {
  pi.registerCommand("requesty-models-sync", {
    description: "Dynamically discover Requesty models and update the local models.json.",
    async handler(_args, ctx) {
      ctx.ui.setStatus("requesty-models-sync", "Discovering Requesty models...");

      try {
        const { data, provider } = getRequestyConfig();
        const models = await discoverModels(provider);
        updateModelsJson(data, models);
        ctx.ui.notify(`Discovered ${models.length} Requesty model(s). Run /reload to use models.json changes.`, "success");
      } catch (error) {
        ctx.ui.notify(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        ctx.ui.setStatus("requesty-models-sync", undefined);
      }
    },
  });

  try {
    const { provider } = getRequestyConfig();
    const models = await discoverModels(provider);

    if (models.length > 0) {
      pi.registerProvider(PROVIDER, {
        ...provider,
        models,
      });
    }
  } catch (error) {
    console.warn(
      `[pi-requesty-model-discovery] startup discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
