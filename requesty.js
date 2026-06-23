import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const MODELS_JSON_PATH = path.join(os.homedir(), ".pi", "agent", "models.json");
const PROVIDER = process.env.REQUESTY_PROVIDER_ID ?? "requesty-export";
const DEFAULT_BASE_URL = "https://router.requesty.ai/v1";
const DEFAULT_NAME = process.env.REQUESTY_PROVIDER_NAME ?? "Requesty";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Resolve a config value using the same rules as pi's internal resolveConfigValue:
 *   !command   → execute shell command, return trimmed stdout
 *   $ENV_VAR   → interpolate environment variable
 *   ${ENV_VAR} → interpolate environment variable
 *   $$         → literal "$"
 *   $!         → literal "!"
 *   otherwise  → literal string
 * Returns undefined if any referenced env var is missing or a command fails.
 */
function resolveConfigValue(config) {
  if (typeof config !== "string" || config.length === 0) return undefined;

  if (config.startsWith("!")) {
    const command = config.slice(1);
    try {
      return execSync(command, { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  // Template interpolation
  let result = "";
  let i = 0;
  while (i < config.length) {
    const dollarIdx = config.indexOf("$", i);
    if (dollarIdx < 0) { result += config.slice(i); break; }
    result += config.slice(i, dollarIdx);
    const next = config[dollarIdx + 1];
    if (next === "$" || next === "!") { result += next; i = dollarIdx + 2; continue; }
    if (next === "{") {
      const end = config.indexOf("}", dollarIdx + 2);
      if (end < 0) { result += "$"; i = dollarIdx + 1; continue; }
      const name = config.slice(dollarIdx + 2, end);
      const val = process.env[name];
      if (val === undefined) return undefined;
      result += val;
      i = end + 1;
      continue;
    }
    const match = config.slice(dollarIdx + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (match) {
      const val = process.env[match[0]];
      if (val === undefined) return undefined;
      result += val;
      i = dollarIdx + 1 + match[0].length;
      continue;
    }
    result += "$";
    i = dollarIdx + 1;
  }
  return result || undefined;
}

const HEALTH_CHECK_TIMEOUT_MS = 15_000;
const HEALTH_CHECK_CONCURRENCY = 10;
const HEALTH_CHECK_STARTUP_MAX = 20;

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

  const apiKey = resolveConfigValue(provider.apiKey);
  if (!apiKey) {
    throw new Error(`providers.${PROVIDER}.apiKey could not be resolved (value: ${provider.apiKey})`);
  }

  // Precedence: REQUESTY_PROVIDER_NAME env var > models.json name field > "Requesty"
  const name =
    process.env.REQUESTY_PROVIDER_NAME ??
    (typeof provider.name === "string" && provider.name.length > 0 ? provider.name : DEFAULT_NAME);

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

/**
 * Fire a minimal completion request to verify a model is reachable and responding.
 * Returns { ok: true, latencyMs } or { ok: false, latencyMs, error }.
 */
async function checkModel(provider, modelId) {
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
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Say OK" }],
        max_tokens: 16,
      }),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - start;

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, latencyMs, error: `HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 120)}` : ""}` };
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

/**
 * Run checkModel over a list of models with a concurrency cap.
 * Returns an array of { modelId, ok, latencyMs, error? } in completion order.
 */
async function checkModels(provider, models) {
  const results = [];
  const queue = [...models];
  let active = 0;

  await new Promise((resolve) => {
    function next() {
      while (active < HEALTH_CHECK_CONCURRENCY && queue.length > 0) {
        const model = queue.shift();
        active++;
        checkModel(provider, model.id).then((result) => {
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

/**
 * Format health check results into a human-readable summary string.
 * e.g. "Health check: 40 OK, 2 failed (gpt-foo, bar-turbo)."
 */
function formatHealthSummary(results) {
  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  if (failed.length === 0) {
    return `Health check: all ${passed.length} OK.`;
  }

  const failedIds = failed.map((r) => r.modelId);
  const failedLabel =
    failedIds.length <= 3
      ? `${failed.length} failed (${failedIds.join(", ")})`
      : `${failed.length} failed`;

  return `Health check: ${passed.length} OK, ${failedLabel}.`;
}

export default async function (pi) {
  pi.registerCommand("requesty-models-sync", {
    description: "Dynamically discover Requesty models, run health checks, and update the local models.json.",
    async handler(_args, ctx) {
      ctx.ui.setStatus("requesty-models-sync", "Discovering Requesty models...");

      try {
        const { data, provider } = getRequestyConfig();
        const models = await discoverModels(provider);
        updateModelsJson(data, models);

        ctx.ui.setStatus("requesty-models-sync", `Checking ${models.length} model(s)...`);
        const healthResults = await checkModels(provider, models);
        const summary = formatHealthSummary(healthResults);
        const failed = healthResults.filter((r) => !r.ok);

        const message = `Discovered ${models.length} Requesty model(s). ${summary} Run /reload to use models.json changes.`;

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

  try {
    const { provider } = getRequestyConfig();
    const models = await discoverModels(provider);

    if (models.length > 0) {
      pi.registerProvider(PROVIDER, {
        ...provider,
        models,
      });

      // Health-check a capped subset at startup — non-blocking, failures are warnings only.
      const sample = models.slice(0, HEALTH_CHECK_STARTUP_MAX);
      checkModels(provider, sample).then((healthResults) => {
        const failed = healthResults.filter((r) => !r.ok);
        for (const f of failed) {
          console.warn(`[pi-requesty] health check failed for ${f.modelId}: ${f.error}`);
        }
        if (failed.length > 0) {
          console.warn(`[pi-requesty] ${failed.length}/${sample.length} sampled model(s) failed health checks.`);
        }
      });
    }
  } catch (error) {
    console.warn(
      `[pi-requesty-model-discovery] startup discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
