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
const HEALTH_CHECK_MODE = process.env.REQUESTY_HEALTH_CHECK_MODE ?? "full";

const HEALTH_CHECK_TIMEOUT_MS = 15_000;
const HEALTH_CHECK_TIMEOUT_RETRIES = 2;
const HEALTH_CHECK_RETRY_DELAY_MS = 500;
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

async function checkModels(provider, models, checkReasoning) {
  const results = [];
  const queue = [...models];
  let active = 0;

  await new Promise((resolve) => {
    function next() {
      while (active < HEALTH_CHECK_CONCURRENCY && queue.length > 0) {
        const model = queue.shift();
        active++;
        checkModel(provider, model, checkReasoning).then((result) => {
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

async function checkModel(provider, model, checkReasoning) {
  const basicResult = await postChatCompletion(provider, {
    model: model.id,
    messages: [{ role: "user", content: "Say OK" }],
    max_tokens: 16,
  });

  if (!basicResult.ok || !model.reasoning || !checkReasoning) {
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

async function postChatCompletion(provider, body) {
  const start = Date.now();
  try {
    const response = await fetchWithTimeoutRetries(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }, {
      timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
      retries: HEALTH_CHECK_TIMEOUT_RETRIES,
      retryDelayMs: HEALTH_CHECK_RETRY_DELAY_MS,
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
    const attempts = HEALTH_CHECK_TIMEOUT_RETRIES + 1;
    return {
      ok: false,
      latencyMs,
      error: isTimeoutError(err)
        ? `Timed out after ${attempts} attempt(s); per-attempt timeout is ${HEALTH_CHECK_TIMEOUT_MS / 1000}s`
        : String(err),
    };
  }
}

function isTimeoutError(error) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function fetchWithTimeoutRetries(url, options, { timeoutMs, retries, retryDelayMs }) {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = error;

      if (!isTimeoutError(error) || attempt === retries) {
        throw error;
      }

      if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
    }
  }

  throw lastError;
}

function formatHealthSummary(results) {
  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  if (failed.length === 0) {
    return `Health check: all ${passed.length} OK.`;
  }

  const failedModels = failed.map((r) => `- ${r.modelId}`).join("\n");

  return `Health check: ${passed.length} OK, ${failed.length} failed:\n${failedModels}\n`;
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

// noinspection JSUnusedGlobalSymbols
export default async function (pi) {
  pi.registerCommand("requesty-models-sync", {
    description: "Dynamically discover Requesty models, run health checks, and update the local models.json.",
    getArgumentCompletions: (prefix) => {
    const options = [
      { value: "--dry-run", label: "[--dry-run]: Preview without writing into the new model.json file" },
    ];
    if (!prefix) return options;
    return options.filter(o =>
        o.value.toLowerCase().startsWith(prefix.toLowerCase())
    );
  },
    async handler(args, ctx) {
      ctx.ui.setStatus("requesty-models-sync", "Discovering Requesty models...");
      const parts = args.split(" ");
      const dryRun = parts.includes("--dry-run");
      if (dryRun) {
        ctx.ui.notify('running in dry mode, no changes will be done')
      }

      try {
        const { data, provider } = getRequestyConfig();
        const models = await discoverModels(provider);

        let failed = [];
        let passing = [];
        let logNote = '';
        let healthCheckSummary = '';

        if (HEALTH_CHECK_MODE !== "off") {
          ctx.ui.setStatus("requesty-models-sync", `Checking ${models.length} model(s)...`);
          const healthResults = await checkModels(provider, models, HEALTH_CHECK_MODE === "full");
          failed = healthResults.filter((r) => !r.ok);
          passing = models.filter((m) => healthResults.find((r) => r.modelId === m.id)?.ok);
          healthCheckSummary = formatHealthSummary(healthResults);
          writeHealthCheckLog(provider, healthResults);
          logNote = `Full health check log: ${HEALTH_CHECK_LOG_PATH}\n`;
        } else {
          passing = models;
        }

        const shouldUpdate = passing.length > 0 && !dryRun;
        if (shouldUpdate) {
          updateModelsJson(data, passing);
        }

        const writeNote = shouldUpdate ? "Run /reload to use models.json changes." : "models.json was not updated.";
        const message = `Discovered ${models.length} Requesty model(s).\n${healthCheckSummary}${logNote}${writeNote}`;

        if (failed.length === 0) {
          ctx.ui.notify(message, "info");
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
