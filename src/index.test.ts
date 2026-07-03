import type { ProviderModelConfig, RegisteredCommand } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import type { HealthCheckResult, Provider } from './health-check'
import { createFakeCommandContext, createFakePi } from '../test/helpers/fake-pi'

type TestCommand = Omit<RegisteredCommand, 'name' | 'sourceInfo'>
type HealthCheckMode = 'off' | 'basic' | 'full'

type LoadExtensionOptions = {
  healthCheckMode?: HealthCheckMode
  models?: ProviderModelConfig[]
  healthResults?: HealthCheckResult[]
  getRequestyConfigError?: Error
  discoverModelsError?: Error
}

const COMMAND_NAME = 'requesty-models-sync'
const MODELS_JSON_PATH = '/tmp/pi-requesty-home/.pi/agent/models.json'
const HEALTH_CHECK_LOG_PATH = '/tmp/pi-requesty-home/.pi/agent/requesty-health-check.log'

const provider: Provider = {
  name: 'Requesty',
  baseUrl: 'https://router.requesty.ai/v1',
  apiKey: 'test-key',
} as Provider

const modelsJson = {
  providers: {
    'requesty-export': {
      name: 'Requesty',
      baseUrl: 'https://router.requesty.ai/v1',
      apiKey: 'test-key',
      models: [],
    },
  },
}

describe('extension registration', () => {
  it('registers requesty sync command', async () => {
    const { command } = await loadExtension()

    expect(command.description).toBe(
      'Dynamically discover Requesty models, run health checks, and update the local models.json.',
    )
    expect(command.getArgumentCompletions).toBeTypeOf('function')
    expect(command.handler).toBeTypeOf('function')
  })
})

describe('argument completions', () => {
  it('returns dry-run option for empty prefix', async () => {
    const { command } = await loadExtension()

    const completions = await getArgumentCompletions(command, '')

    expect(completions).toMatchSnapshot()
  })

  it('returns dry-run option for matching prefix', async () => {
    const { command } = await loadExtension()

    const completions = await getArgumentCompletions(command, '--d')

    expect(completions).toMatchSnapshot()
  })

  it('returns empty list for unrelated prefix', async () => {
    const { command } = await loadExtension()

    const completions = await getArgumentCompletions(command, '--wat')

    expect(completions).toEqual([])
  })
})

describe('command flow', () => {
  it('emits notification and does not update models.json on dry-run', async () => {
    const { command, updateModelsJson } = await loadExtension({ healthCheckMode: 'off' })
    const { ctx, notifications, statuses } = createFakeCommandContext()

    await command.handler('--dry-run', ctx)

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(notifications).toMatchSnapshot()
    expect(statuses.at(-1)).toEqual({ key: COMMAND_NAME, text: undefined })
    expectAllNotificationsPrefixed(notifications)
  })

  it('updates models.json and notifies info on no failures', async () => {
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]
    const healthResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', ok: true }),
      createHealthCheckResult({ modelId: 'requesty/model-b', ok: true }),
    ]
    const { command, updateModelsJson } = await loadExtension({ models, healthResults })
    const { ctx, notifications, statuses } = createFakeCommandContext()

    await command.handler('', ctx)

    expect(updateModelsJson).toHaveBeenCalledWith(modelsJson, models)
    expect(notifications).toMatchSnapshot()
    expect(statuses.at(-1)).toEqual({ key: COMMAND_NAME, text: undefined })
    expectAllNotificationsPrefixed(notifications)
  })

  it('updates passing models and notifies warning on partial failures', async () => {
    const passingModel = createModel({ id: 'requesty/passing-model' })
    const failingModel = createModel({ id: 'requesty/failing-model' })
    const healthResults = [
      createHealthCheckResult({ modelId: 'requesty/passing-model', ok: true }),
      createHealthCheckResult({ modelId: 'requesty/failing-model', ok: false }),
    ]
    const { command, updateModelsJson } = await loadExtension({
      models: [passingModel, failingModel],
      healthResults,
    })
    const { ctx, notifications, statuses } = createFakeCommandContext()

    await command.handler('', ctx)

    expect(updateModelsJson).toHaveBeenCalledWith(modelsJson, [passingModel])
    expect(notifications).toMatchSnapshot()
    expect(statuses.at(-1)).toEqual({ key: COMMAND_NAME, text: undefined })
    expectAllNotificationsPrefixed(notifications)
  })

  it('does not update models.json and notifies error on full error', async () => {
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]
    const healthResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', ok: false }),
      createHealthCheckResult({ modelId: 'requesty/model-b', ok: false }),
    ]
    const { command, updateModelsJson } = await loadExtension({ models, healthResults })
    const { ctx, notifications, statuses } = createFakeCommandContext()

    await command.handler('', ctx)

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(notifications).toMatchSnapshot()
    expect(statuses.at(-1)).toEqual({ key: COMMAND_NAME, text: undefined })
    expectAllNotificationsPrefixed(notifications)
  })

  it('notifies full error and clears status', async () => {
    const { command, updateModelsJson } = await loadExtension({
      getRequestyConfigError: new Error('models.json exploded'),
    })
    const { ctx, notifications, statuses } = createFakeCommandContext()

    await command.handler('', ctx)

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(notifications).toMatchSnapshot()
    expect(statuses.at(-1)).toEqual({ key: COMMAND_NAME, text: undefined })
    expectAllNotificationsPrefixed(notifications)
  })

  it('sets status while running', async () => {
    const { command } = await loadExtension()
    const { ctx, statuses } = createFakeCommandContext()

    await command.handler('', ctx)

    expect(statuses).toEqual([
      { key: COMMAND_NAME, text: 'Discovering Requesty models...' },
      { key: COMMAND_NAME, text: 'Checking 1 model(s)...' },
      { key: COMMAND_NAME, text: undefined },
    ])
  })
})

async function loadExtension(options: LoadExtensionOptions = {}) {
  vi.resetModules()

  const models = options.models ?? [createModel({ id: 'requesty/model-a' })]
  const healthResults = options.healthResults ?? models.map(model => createHealthCheckResult({ modelId: model.id }))
  const getRequestyConfig = vi.fn(() => {
    if (options.getRequestyConfigError) {
      throw options.getRequestyConfigError
    }

    return { data: modelsJson, provider }
  })
  const updateModelsJson = vi.fn()
  const discoverModels = vi.fn(() => {
    if (options.discoverModelsError) {
      return Promise.reject(options.discoverModelsError)
    }

    return Promise.resolve(models)
  })
  const checkModels = vi.fn(() => Promise.resolve(healthResults))
  const formatHealthSummary = vi.fn(() => 'Health check summary.\n')
  const writeHealthCheckLog = vi.fn()

  vi.doMock('./env', () => ({
    default: {
      models_json_path: MODELS_JSON_PATH,
      health_check_log_path: HEALTH_CHECK_LOG_PATH,
      provider_id: 'requesty-export',
      requesty_api_key: undefined,
      health_check_mode: options.healthCheckMode ?? 'basic',
    },
  }))
  vi.doMock('./models-json', () => ({ getRequestyConfig, updateModelsJson }))
  vi.doMock('./requesty-api', () => ({ discoverModels }))
  vi.doMock('./health-check', () => ({ checkModels, formatHealthSummary, writeHealthCheckLog }))

  const extension = await import('./index')
  const { pi, commands } = createFakePi()
  extension.default(pi)
  const command = commands.get(COMMAND_NAME)

  if (!command) {
    throw new Error(`${COMMAND_NAME} was not registered`)
  }

  return {
    command,
    getRequestyConfig,
    updateModelsJson,
    discoverModels,
    checkModels,
    formatHealthSummary,
    writeHealthCheckLog,
  }
}

async function getArgumentCompletions(command: TestCommand, prefix: string) {
  if (!command.getArgumentCompletions) {
    throw new Error('Command did not register argument completions')
  }

  return command.getArgumentCompletions(prefix)
}

function expectAllNotificationsPrefixed(notifications: Array<{ message: string }>) {
  for (const notification of notifications) {
    expect(notification.message).toMatch(new RegExp(`^${COMMAND_NAME}:`))
  }
}

function createHealthCheckResult(overrides: Partial<HealthCheckResult> = {}): HealthCheckResult {
  return {
    modelId: 'requesty/model',
    ok: true,
    latencyMs: 123,
    ...overrides,
  }
}

function createModel(overrides: Partial<ProviderModelConfig> = {}): ProviderModelConfig {
  return {
    id: 'requesty/model',
    name: 'Requesty Model',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
    },
    contextWindow: 128000,
    maxTokens: 4096,
    ...overrides,
  }
}
