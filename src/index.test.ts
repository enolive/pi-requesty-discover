import type { ProviderModelConfig, RegisteredCommand } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import type { HealthCheckResult, Provider } from './health-check'
import * as HealthCheckModule from './health-check'
import * as ModelsJsonModule from './models-json'
import * as RequestyApiModule from './requesty-api'
import * as EnvModule from './env'
import { createFakeCommandContext, createFakePi } from '../test/helpers/fake-pi'
import { shuffleCompareFn } from '../test/helpers/shuffle.ts'

vi.mock('./health-check')
vi.mock('./models-json')
vi.mock('./requesty-api')
vi.mock('./env')

type TestCommand = Omit<RegisteredCommand, 'name' | 'sourceInfo'>
type HealthCheckMode = 'off' | 'basic' | 'full'

type LoadExtensionOptions = {
  healthCheckMode?: HealthCheckMode
  models?: ProviderModelConfig[]
  healthResults?: HealthCheckResult[]
  getRequestyConfigError?: unknown
  discoverModelsError?: unknown
}

const COMMAND_NAME = 'requesty-discover'
const MODELS_JSON_PATH = '/tmp/pi-requesty-home/.pi/agent/models.json'
const HEALTH_CHECK_LOG_PATH = '/tmp/pi-requesty-home/.pi/agent/requesty-health-check.log'

const provider = {
  name: 'Requesty',
  baseUrl: 'https://router.requesty.ai/v1',
  apiKey: 'test-key',
} satisfies Provider & { name: string }

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

    expect(updateModelsJson).toHaveBeenCalledWith(modelsJson, models, expect.any(Object))
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

    expect(updateModelsJson).toHaveBeenCalledWith(modelsJson, [passingModel], expect.any(Object))
    expect(notifications).toMatchSnapshot()
    expect(statuses.at(-1)).toEqual({ key: COMMAND_NAME, text: undefined })
    expectAllNotificationsPrefixed(notifications)
  })

  it('sorts failing models deterministically for logging', async () => {
    const failingModel1 = createModel({ id: 'requesty/failing-model-1' })
    const failingModel2 = createModel({ id: 'requesty/failing-model-2' })
    const failingModel3 = createModel({ id: 'requesty/failing-model-3' })
    const shuffledHealthResults = [
      createHealthCheckResult({ modelId: 'requesty/failing-model-1', ok: false }),
      createHealthCheckResult({ modelId: 'requesty/failing-model-2', ok: false }),
      createHealthCheckResult({ modelId: 'requesty/failing-model-3', ok: false }),
    ].toSorted(shuffleCompareFn)
    const { command, formatHealthSummary, writeHealthCheckLog } = await loadExtension({
      models: [failingModel1, failingModel2, failingModel3],
      healthResults: shuffledHealthResults,
    })
    const { ctx } = createFakeCommandContext()

    await command.handler('', ctx)

    const modelId = (healthCheck: HealthCheckResult) => healthCheck.modelId
    const [summaryHealthChecks] = formatHealthSummary.mock.calls[0]
    const summaryModelIds = summaryHealthChecks.map(modelId)
    expect(summaryModelIds).toEqual([
      'requesty/failing-model-1',
      'requesty/failing-model-2',
      'requesty/failing-model-3',
    ])
    const [, logHealthChecks] = writeHealthCheckLog.mock.calls[0]
    const logSummaryModelIds = logHealthChecks.map(modelId)
    expect(logSummaryModelIds).toEqual(summaryModelIds)
  })

  it('sorts passing models deterministically for updating the models.json', async () => {
    const passingModel1 = createModel({ id: 'requesty/passing-model-1' })
    const passingModel2 = createModel({ id: 'requesty/passing-model-2' })
    const passingModel3 = createModel({ id: 'requesty/passing-model-3' })
    const shuffledHealthResults = [
      createHealthCheckResult({ modelId: 'requesty/passing-model-1', ok: true }),
      createHealthCheckResult({ modelId: 'requesty/passing-model-2', ok: true }),
      createHealthCheckResult({ modelId: 'requesty/passing-model-3', ok: true }),
    ].toSorted(shuffleCompareFn)
    const { command, updateModelsJson } = await loadExtension({
      models: [passingModel1, passingModel2, passingModel3],
      healthResults: shuffledHealthResults,
    })
    const { ctx } = createFakeCommandContext()

    await command.handler('', ctx)

    const [, passingModels] = updateModelsJson.mock.calls[0]
    const passingModelIds = passingModels.map(model => model.id)
    expect(passingModelIds).toEqual([
      'requesty/passing-model-1',
      'requesty/passing-model-2',
      'requesty/passing-model-3',
    ])
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

  it('notifies full error for sth not deriving from Error', async () => {
    const { command } = await loadExtension({
      getRequestyConfigError: 'this is not an error',
    })
    const { ctx, notifications } = createFakeCommandContext()

    await command.handler('', ctx)

    expect(notifications).toMatchSnapshot()
  })

  it('notifies full error on async rejections', async () => {
    const { command } = await loadExtension({
      discoverModelsError: new Error('requesty has a bad day trying to read its models'),
    })
    const { ctx, notifications } = createFakeCommandContext()

    await command.handler('', ctx)

    expect(notifications).toMatchSnapshot()
  })

  it('sets progress status while checking models', async () => {
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]
    const { command } = await loadExtension({ models })
    const { ctx, statuses } = createFakeCommandContext()

    await command.handler('', ctx)

    expect(statuses).toEqual([
      { key: COMMAND_NAME, text: 'Discovering Requesty models...' },
      { key: COMMAND_NAME, text: 'Checking models 0/2...' },
      { key: COMMAND_NAME, text: 'Checking models 1/2...' },
      { key: COMMAND_NAME, text: 'Checking models 2/2...' },
      { key: COMMAND_NAME, text: undefined },
    ])
  })
})

async function loadExtension(options: LoadExtensionOptions = {}) {
  const models = options.models ?? [createModel({ id: 'requesty/model-a' })]
  const healthResults = options.healthResults ?? models.map(model => createHealthCheckResult({ modelId: model.id }))
  const getRequestyConfig = vi.mocked(ModelsJsonModule.getRequestyConfig)
  if (options.getRequestyConfigError) {
    getRequestyConfig.mockThrow(options.getRequestyConfigError)
  } else {
    getRequestyConfig.mockReturnValue({ data: modelsJson, provider })
  }
  const updateModelsJson = vi.mocked(ModelsJsonModule.updateModelsJson)
  const discoverModels = vi.mocked(RequestyApiModule.discoverModels)
  if (options.discoverModelsError) {
    discoverModels.mockRejectedValue(options.discoverModelsError)
  } else {
    discoverModels.mockResolvedValue(models)
  }

  const checkModels = vi.mocked(HealthCheckModule.checkModels)
  checkModels.mockImplementation(
    async (
      _provider,
      checkedModels,
      _checkReasoning,
      healthCheckOptions,
      // part of function signature
      // eslint-disable-next-line @typescript-eslint/require-await
    ) => {
      healthResults.forEach((result, index) => {
        healthCheckOptions?.onProgress?.({
          completed: index + 1,
          total: checkedModels.length,
          modelId: result.modelId,
        })
      })
      return healthResults
    },
  )

  const formatHealthSummary = vi.mocked(HealthCheckModule.formatHealthSummary)
  formatHealthSummary.mockReturnValue('Health check summary.\n')
  const writeHealthCheckLog = vi.mocked(HealthCheckModule.writeHealthCheckLog)
  const getEnv = vi.mocked(EnvModule.getEnv)
  getEnv.mockReturnValue({
    models_json_path: MODELS_JSON_PATH,
    health_check_log_path: HEALTH_CHECK_LOG_PATH,
    provider_id: 'requesty-export',
    requesty_api_key: 'ignore-me-plz',
    health_check_mode: options.healthCheckMode ?? 'basic',
  })

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
