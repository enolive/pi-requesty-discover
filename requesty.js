import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const MODELS_JSON_PATH = path.join(AGENT_DIR, "models.json");
const HEALTH_CHECK_LOG_PATH = path.join(AGENT_DIR, "requesty-health-check.log");
const PROVIDER = process.env.REQUESTY_PROVIDER_ID ?? "requesty";
const DEFAULT_BASE_URL = "https://router.requesty.ai/v1";
const DEFAULT_NAME = "Requesty";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 4096;

const HEALTH_CHECK_TIMEOUT_MS = 15_000;
const HEALTH_CHECK_CONCURRENCY = 10;

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

  const apiKey = process.env.REQUESTY_API_KEY ||
    (typeof provider.apiKey === "string" && provider.apiKey.length > 0 ? provider.apiKey : undefined);

  if (!apiKey) {
    throw new Error(`providers.${PROVIDER}.apiKey must be set in ${MODELS_JSON_PATH} or via REQUESTY_API_KEY env var`);
  }

  const name = typeof provider.name === "string" && provider.name.length > 0 ? provider.name : DEFAULT_NAME;

  const baseUrl = normalizeBaseUrl(
    typeof provider.baseUrl === "string" && provider.baseUrl.length > 0 ? provider.baseUrl : DEFAULT_BASE_URL,
  );

  return {
    data,
    provider: {
      ...provider,
      name,
      baseUrl,
      apiKey,
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

async function postChatCompletion(provider, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  const start = Date.now();

  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - start;

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, latencyMs, error: `HTTP ${response.status} ${response.statusText}${text ? `: ${text}` : ""}` };
    }

    const payload = await response.json();
    if (!payload?.choices?.length) {
      return { ok: false, latencyMs, error: "Empty choices in response" };
    }

    return { ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return { ok: false, latencyMs, error: isTimeout ? `Timed out after ${HEALTH_CHECK_TIMEOUT_MS / 1000}s` : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function checkModel(provider, model) {
  const basicResult = await postChatCompletion(provider, {
    model: model.id,
    messages: [{ role: "user", content: "Say OK" }],
    max_tokens: 16,
  });

  if (!basicResult.ok || !model.reasoning) {
    return basicResult;
  }

  const reasoningResult = await postChatCompletion(provider, {
    model: model.id,
    messages: [{ role: "user", content: "Say OK. Do not call any tools." }],
    tools: [
      {
        type: "function",
        function: {
          name: "health_check_noop",
          description: "A no-op tool used only to verify tool compatibility during model health checks.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      },
    ],
    reasoning_effort: "low"
  });

  if (!reasoningResult.ok) {
    return {
      ...reasoningResult,
      error: `Reasoning/tool check failed: ${reasoningResult.error}`,
    };
  }

  return {
    ok: true,
    latencyMs: basicResult.latencyMs + reasoningResult.latencyMs,
  };
}

async function checkModels(provider, models) {
  const results = [];
  const queue = [...models];
  let active = 0;

  await new Promise((resolve) => {
    function next() {
      while (active < HEALTH_CHECK_CONCURRENCY && queue.length > 0) {
        const model = queue.shift();
        active++;
        checkModel(provider, model).then((result) => {
          results.push({ modelId: model.id, ...result });
          active--;
          if (queue.length === 0 && active === 0) resolve();
          else next();
        });
      }
      if (queue.length === 0 && active === 0) resolve();
    }
    next();
  });

  return results;
}

function formatHealthSummary(results) {
  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  if (failed.length === 0) {
    return `Health check: all ${passed.length} OK.`;
  }

  const failedModels = failed.map((r) => `- ${r.modelId}`).join("\n");

  return `Health check: ${passed.length} OK, ${failed.length} failed:\n${failedModels}`;
}

function writeHealthCheckLog(provider, results) {
  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const lines = [
    `Requesty health check log`,
    `Timestamp: ${new Date().toISOString()}`,
    `Provider: ${PROVIDER}`,
    `Base URL: ${provider.baseUrl}`,
    `Total: ${results.length}`,
    `Passed: ${passed.length}`,
    `Failed: ${failed.length}`,
    "",
  ];

  if (failed.length === 0) {
    lines.push("No failed models.");
  } else {
    lines.push("Failed models:", "");
    for (const result of failed) {
      lines.push(
        `Model: ${result.modelId}`,
        `Latency: ${result.latencyMs}ms`,
        "Error:",
        result.error || "Unknown error",
        "",
        "---",
        "",
      );
    }
  }

  fs.mkdirSync(path.dirname(HEALTH_CHECK_LOG_PATH), { recursive: true });
  fs.writeFileSync(HEALTH_CHECK_LOG_PATH, `${lines.join("\n")}\n`, "utf8");
}

export default async function (pi) {
  pi.registerCommand("requesty-models-sync", {
    description: "Dynamically discover Requesty models, run health checks, and update the local models.json.",
    async handler(_args, ctx) {
      ctx.ui.setStatus("requesty-models-sync", "Discovering Requesty models...");

      try {
        const { data, provider } = getRequestyConfig();
        const models = await discoverModels(provider);

        ctx.ui.setStatus("requesty-models-sync", `Checking ${models.length} model(s)...`);
        const healthResults = await checkModels(provider, models);
        const failed = healthResults.filter((r) => !r.ok);
        const passing = models.filter((m) => healthResults.find((r) => r.modelId === m.id)?.ok);
        const summary = formatHealthSummary(healthResults);
        writeHealthCheckLog(provider, healthResults);

        if (passing.length > 0) {
          updateModelsJson(data, passing);
        }

        const writeNote = passing.length > 0 ? "Run /reload to use models.json changes." : "models.json was not updated.";
        const logNote = `Full health check log: ${HEALTH_CHECK_LOG_PATH}`;
        const message = `Discovered ${models.length} Requesty model(s).\n${summary}\n${logNote}\n${writeNote}`;

        if (failed.length === 0) {
          ctx.ui.notify(message, "success");
        } else if (failed.length < models.length) {
          ctx.ui.notify(message, "warning");
        } else {
          ctx.ui.notify(message, "error");
        }
      } catch (error) {
        ctx.ui.notify(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        ctx.ui.setStatus("requesty-models-sync", undefined);
      }
    },
  });
}
