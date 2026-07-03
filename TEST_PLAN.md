# Test Setup Plan

## Goals

Add a Vitest-based test suite with:

1. Unit tests colocated next to the implementation files
2. One separate integration test for the full command flow
3. MSW for HTTP/API behavior
4. Temp filesystem paths for `models.json`
5. A fake Pi harness for command registration and UI context

## Test file layout

Unit tests should live next to the source files they cover. Shared test setup/helpers and the integration test live under `test/`:

```text
src/
├── env.ts
├── env.test.ts
├── models-json.ts
├── models-json.test.ts
├── requesty-api.ts
├── requesty-api.test.ts
├── health-check.ts
├── health-check.test.ts
├── index.ts
└── index.test.ts

test/
├── setup.ts
├── integration.test.ts
└── helpers/
    ├── fake-pi.ts
    └── temp-agent.ts
```

Rationale:

- Unit tests stay close to the implementation.
- The broader happy-path integration test is isolated in `test/integration.test.ts`.
- Shared test helpers stay under `test/helpers` so both colocated unit tests and the integration test can use them.

## Dependencies

Install:

```bash
npm install -D vitest msw
```

## Package scripts

Add:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run src",
    "test:integration": "vitest run test/integration.test.ts",
    "test:watch": "vitest",
    "check": "npm run format:check && npm run typecheck && npm run lint && npm run test"
  }
}
```

Keep existing scripts:

```json
"format:check": "prettier --check .",
"format": "prettier --write  .",
"typecheck": "tsc --noEmit",
"lint": "eslint ."
```

## Vitest config

Create:

```text
vitest.config.ts
```

Suggested config:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
})
```

Update `tsconfig.json` if needed:

```json
"include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts", "eslint.config.ts"]
```

## MSW setup

Create:

```text
test/setup.ts
```

```ts
import { afterAll, afterEach, beforeAll } from 'vitest'
import { setupServer } from 'msw/node'

export const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})

afterEach(() => {
  server.resetHandlers()
})

afterAll(() => {
  server.close()
})
```

Colocated unit tests that need MSW can import it from `src/*.test.ts` like this:

```ts
import { server } from '../test/setup'
```

The integration test can import it from `test/integration.test.ts` like this:

```ts
import { server } from './setup'
```

## Shared test helpers

### `test/helpers/fake-pi.ts`

Used by:

```text
src/index.test.ts
test/integration.test.ts
```

Responsibilities:

- fake `pi.registerCommand`
- capture registered commands
- fake command context
- capture notifications
- capture statuses

Suggested shape:

```ts
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'

type NotificationType = 'info' | 'warning' | 'error'

export function createFakePi() {
  const commands = new Map<string, any>()

  const pi = {
    registerCommand(name: string, command: any) {
      commands.set(name, command)
    },
  } as ExtensionAPI

  return { pi, commands }
}

export function createFakeCommandContext() {
  const notifications: Array<{ message: string; type?: NotificationType }> = []
  const statuses: Array<{ key: string; text?: string }> = []

  const ctx = {
    ui: {
      notify(message: string, type?: NotificationType) {
        notifications.push({ message, type })
      },
      setStatus(key: string, text?: string) {
        statuses.push({ key, text })
      },
    },
  } as ExtensionCommandContext

  return { ctx, notifications, statuses }
}
```

The casts are acceptable because this is a partial fake for tests.

### `test/helpers/temp-agent.ts`

Used by:

```text
src/models-json.test.ts
src/health-check.test.ts
test/integration.test.ts
```

Suggested shape:

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export async function createTempAgent() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-requesty-'))
  const agentDir = path.join(homeDir, '.pi', 'agent')
  const modelsJsonPath = path.join(agentDir, 'models.json')
  const healthCheckLogPath = path.join(agentDir, 'requesty-health-check.log')

  await fs.mkdir(agentDir, { recursive: true })

  return {
    homeDir,
    agentDir,
    modelsJsonPath,
    healthCheckLogPath,
  }
}
```

## Recommended source refactor before tests

### `src/env.ts`

Add a factory, keep default export.

Target shape:

```ts
export type Env = {
  models_json_path: string
  health_check_log_path: string
  provider_id: string
  requesty_api_key?: string
  health_check_mode: 'off' | 'basic' | 'full'
}

export function getEnv(options?: {
  env?: NodeJS.ProcessEnv
  homeDir?: string
}): Env {
  // build env object here
}

export default getEnv()
```

Benefits:

- `src/env.test.ts` can avoid module mocking
- the integration test can generate a test env object
- production behavior stays unchanged

### Optional: `src/models-json.ts`

Current functions use default `env`. Unit tests can either mock `src/env` or parameterize functions with an env object.

Preferred for fewer mocks:

```ts
export function getRequestyConfig(envConfig = env): RequestyConfig
export function updateModelsJson(data, models, envConfig = env): void
```

This can be deferred if the first test setup should stay smaller.

### `src/health-check.ts`

Keep health-check tests focused on public exports. Avoid testing retry internals through unexported helpers.

Parameterize health-check execution options so tests can make timeout/retry/concurrency behavior fast and deterministic without checking many models:

```ts
type HealthCheckOptions = {
  concurrency?: number
  timeoutMs?: number
  retries?: number
  retryDelayMs?: number
}

export async function checkModels(
  provider: Provider,
  models: ProviderModelConfig[],
  checkReasoning: boolean,
  options: HealthCheckOptions = defaultHealthCheckOptions,
): Promise<HealthCheckResult[]>

```

Defaults should keep production behavior unchanged:

- concurrency: `10`
- timeout: `15_000`
- retries: `2`
- retry delay: `500`

The retry-delay option is primarily to test timeout retry behavior through or `checkModels` quickly, using tiny timeouts and `retryDelayMs: 13`.
The concurrency option is primarily to test scheduling through `checkModels` with a small model set, e.g. `concurrency: 2`.

## Unit test plan

Split unit-test work into small, independently reviewable parts. Prefer one focused `describe` block per behavior group.

### Unit task 1: `src/env.test.ts`

Tests:

- defaults provider ID to `requesty-export`
- defaults health check mode to `full`
- accepts `off`
- accepts `basic`
- accepts `full`
- rejects invalid health check mode
- uses provided `homeDir` for:
  - `models_json_path`
  - `health_check_log_path`
- reads `REQUESTY_API_KEY`
- reads `REQUESTY_PROVIDER_ID`

No mocks required if `getEnv()` exists.

### Unit task 2: `src/models-json.test.ts` config/reading tests

Use temp files.

Tests:

- throws if `models.json` does not exist
- throws if JSON is invalid
- throws if schema is invalid
- throws if configured provider is missing
- reads provider config from `models.json`
- env API key override wins over `models.json`
- defaults name to `Requesty`
- defaults base URL to `https://router.requesty.ai/v1`
- removes trailing slash from base URL

If not parameterized, use `vi.doMock('./env', ...)` plus dynamic imports.

### Unit task 3: `src/models-json.test.ts` update tests

Use temp files.

Tests:

- writes models into selected provider
- preserves selected provider fields:
  - `name`
  - `baseUrl`
  - `api`
  - `apiKey`
  - unknown fields
- preserves other providers
- writes trailing newline
- creates parent directory if needed

If not parameterized, use `vi.doMock('./env', ...)` plus dynamic imports.

### Unit task 4: `src/requesty-api.test.ts`

Use MSW.

Tests for `discoverModels`:

- calls `GET /models`
- sends bearer token
- throws on HTTP error
- validates malformed response
- skips invalid model entries
- maps fields:
  - `id`
  - `name`
  - `supports_reasoning` → `reasoning`
  - `supports_vision` → `input`
  - `input_price` → `cost.input * 1_000_000`
  - `output_price` → `cost.output * 1_000_000`
  - `cached_price` → `cost.cacheRead * 1_000_000`
  - `caching_price` → `cost.cacheWrite * 1_000_000`
  - `context_window` → `contextWindow`
  - `max_output_tokens` → `maxTokens`
- defaults:
  - name to model ID
  - input to `['text']`
  - prices to `0`
  - context window to `128000`
  - max tokens to `4096`

### Unit task 5: `src/health-check.test.ts` chat-completion behavior

Use MSW and temp files.

Test through exported/public health-check APIs (`postChatCompletion` and/or `checkModels`) rather than unexported retry helpers.

`postChatCompletion` tests:

- returns ok for response with non-empty `choices`
- returns failure for HTTP error
- returns failure for empty `choices`
- returns failure for malformed response
- sends bearer token
- sends model in request body
- retries timeout failures using parameterized `timeoutMs`, `retries`, and `retryDelayMs: 0` so the test is fast

### Unit task 6: `src/health-check.test.ts` model-check behavior and concurrency

Use MSW.

`checkModels` tests:

- basic check calls chat completion once per model
- full check calls reasoning/tool check for reasoning models
- full check does not call reasoning/tool check for non-reasoning models
- failed basic check does not run reasoning/tool check
- returns result objects with `modelId`
- respects parameterized concurrency, e.g. with `concurrency: 2` and a small set of delayed handlers, assert no more than two requests are in flight at once
- continues processing queued models after failures while still respecting the concurrency limit

### Unit task 7: `src/health-check.test.ts` summary/log behavior

Use temp files.

`formatHealthSummary` tests:

- all passed
- partial failure
- all failed

`writeHealthCheckLog` tests:

- creates log file
- writes total/passed/failed counts
- writes failed model ID and error
- writes provider ID and base URL
- creates parent directory

### `src/index.test.ts`

This is intentionally mock-based.

Use `vi.mocked(...)` for mocked functions instead of repeated manual casts.

Mock:

```text
./env
./models-json
./requesty-api
./health-check
```

Import helpers from:

```ts
import { createFakeCommandContext, createFakePi } from '../test/helpers/fake-pi'
```

Tests:

Registration:

- default export registers command `requesty-models-sync`
- command has:
  - description
  - `getArgumentCompletions`
  - `handler`

Completions:

- no prefix returns `--dry-run`
- `--d` returns `--dry-run`
- unrelated prefix returns empty list

Command flow:

- dry-run emits dry-run notification
- dry-run does not call `updateModelsJson`
- success with no failures calls notification with `info`
- partial failure calls notification with `warning`
- all failure calls notification with `error`
- thrown error calls notification with `error`
- status is set while running
- status is cleared in `finally`
- all notification messages start with `requesty-models-sync:`

Prefer snapshotting captured notifications for each command-flow case instead of asserting every notification line separately. Keep targeted non-snapshot assertions for side effects such as `updateModelsJson` calls and final status clearing.

Use dynamic import after mocks if needed:

```ts
vi.resetModules()
vi.doMock('./env', ...)
const extension = await import('./index')
```

## Integration test plan

### `test/integration.test.ts`

One basic happy path only.

Real modules:

```text
src/index.ts
src/models-json.ts
src/requesty-api.ts
src/health-check.ts
```

Use:

- temp filesystem
- MSW Requesty API
- fake Pi harness

Mock only:

```text
src/env
```

### Setup

Create temp agent:

```text
/tmp/.../.pi/agent/models.json
/tmp/.../.pi/agent/requesty-health-check.log
```

Initial `models.json`:

```json
{
  "providers": {
    "requesty-export": {
      "name": "Requesty",
      "baseUrl": "https://router.requesty.ai/v1",
      "apiKey": "test-key",
      "api": "openai-completions",
      "models": []
    }
  }
}
```

Mock env:

```ts
vi.doMock('../src/env', () => ({
  default: {
    models_json_path: modelsJsonPath,
    health_check_log_path: healthCheckLogPath,
    provider_id: 'requesty-export',
    requesty_api_key: undefined,
    health_check_mode: 'basic',
  },
}))
```

MSW handlers:

- `GET https://router.requesty.ai/v1/models`
- `POST https://router.requesty.ai/v1/chat/completions`

`GET /models` returns one model.

`POST /chat/completions` returns:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "OK"
      }
    }
  ]
}
```

### Execute

```ts
import { createFakeCommandContext, createFakePi } from './helpers/fake-pi'

const extension = await import('../src/index')
const { pi, commands } = createFakePi()

extension.default(pi)

const command = commands.get('requesty-models-sync')
const { ctx, notifications, statuses } = createFakeCommandContext()

await command.handler('', ctx)
```

### Assert

- command exists
- `models.json` contains synced model
- model fields are normalized correctly
- health-check log file exists
- notification type is `info`
- notification is prefixed with command name
- final status clears command status

## Execution order

Recommended implementation order:

1. Install dependencies and add config:
   - `vitest.config.ts`
   - `test/setup.ts`
2. Add helpers:
   - `test/helpers/fake-pi.ts`
   - `test/helpers/temp-agent.ts`
3. Refactor `env.ts` to export `getEnv()` while keeping default export.
4. Add colocated unit tests in small tasks:
   - `env`
   - `models-json` config/reading
   - `models-json` update
   - `requesty-api`
   - `health-check` chat-completion behavior
   - `health-check` model-check behavior and concurrency
   - `health-check` summary/log behavior
5. Add mocked colocated unit test for `index`, using `vi.mocked(...)` and notification snapshots.
6. Add one integration test: `test/integration.test.ts`.
7. Add final check script.

## Handoff criteria

Before considering the test setup complete:

```bash
npm run format:check
npm run typecheck
npm run lint
npm run test
```

Optional all-in-one:

```bash
npm run check
```

The first integration test should verify the command can sync one model from Requesty into a temp `models.json` without touching the real user environment.
