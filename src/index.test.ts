import type { ProviderModelConfig, RegisteredCommand } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import type { NotificationLevel, Notifier, StatusReporter } from './index'
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
    const { runCommand, updateModelsJson } = await loadExtension({ healthCheckMode: 'off' })
    const { notifier, capturedNotifications } = createFakeNotifier()
    const { status, capturedStatuses } = createFakeStatusReporter()

    await runCommand('--dry-run', status, notifier)

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(capturedNotifications).toMatchSnapshot()
    expect(capturedStatuses.at(-1)).toBeUndefined()
  })

  it('updates models.json and notifies info on no failures', async () => {
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]
    const healthResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', ok: true }),
      createHealthCheckResult({ modelId: 'requesty/model-b', ok: true }),
    ]
    const { runCommand, updateModelsJson } = await loadExtension({ models, healthResults })
    const { notifier, capturedNotifications } = createFakeNotifier()
    const { status, capturedStatuses } = createFakeStatusReporter()

    await runCommand('', status, notifier)

    expect(updateModelsJson).toHaveBeenCalledWith(modelsJson, models, expect.any(Object))
    expect(capturedNotifications).toMatchSnapshot()
    expect(capturedStatuses.at(-1)).toBeUndefined()
  })

  it('updates passing models and notifies warning on partial failures', async () => {
    const passingModel = createModel({ id: 'requesty/passing-model' })
    const failingModel = createModel({ id: 'requesty/failing-model' })
    const healthResults = [
      createHealthCheckResult({ modelId: 'requesty/passing-model', ok: true }),
      createHealthCheckResult({ modelId: 'requesty/failing-model', ok: false }),
    ]
    const { runCommand, updateModelsJson } = await loadExtension({
      models: [passingModel, failingModel],
      healthResults,
    })
    const { notifier, capturedNotifications } = createFakeNotifier()
    const { status, capturedStatuses } = createFakeStatusReporter()

    await runCommand('', status, notifier)

    expect(updateModelsJson).toHaveBeenCalledWith(modelsJson, [passingModel], expect.any(Object))
    expect(capturedNotifications).toMatchSnapshot()
    expect(capturedStatuses.at(-1)).toBeUndefined()
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
    const { runCommand, formatHealthSummary, writeHealthCheckLog } = await loadExtension({
      models: [failingModel1, failingModel2, failingModel3],
      healthResults: shuffledHealthResults,
    })
    const { notifier } = createFakeNotifier()
    const { status } = createFakeStatusReporter()

    await runCommand('', status, notifier)

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
    const { runCommand, updateModelsJson } = await loadExtension({
      models: [passingModel1, passingModel2, passingModel3],
      healthResults: shuffledHealthResults,
    })
    const { notifier } = createFakeNotifier()
    const { status } = createFakeStatusReporter()

    await runCommand('', status, notifier)

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
    const { runCommand, updateModelsJson } = await loadExtension({ models, healthResults })
    const { notifier, capturedNotifications } = createFakeNotifier()
    const { status, capturedStatuses } = createFakeStatusReporter()

    await runCommand('', status, notifier)

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(capturedNotifications).toMatchSnapshot()
    expect(capturedStatuses.at(-1)).toBeUndefined()
  })

  it('notifies full error and clears status', async () => {
    const { runCommand, updateModelsJson } = await loadExtension({
      getRequestyConfigError: new Error('models.json exploded'),
    })
    const { notifier, capturedNotifications } = createFakeNotifier()
    const { status, capturedStatuses } = createFakeStatusReporter()

    await runCommand('', status, notifier)

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(capturedNotifications).toMatchSnapshot()
    expect(capturedStatuses.at(-1)).toBeUndefined()
  })

  it('notifies full error for sth not deriving from Error', async () => {
    const { runCommand } = await loadExtension({
      getRequestyConfigError: 'this is not an error',
    })
    const { notifier, capturedNotifications } = createFakeNotifier()
    const { status } = createFakeStatusReporter()

    await runCommand('', status, notifier)

    expect(capturedNotifications).toMatchSnapshot()
  })

  it('notifies full error on async rejections', async () => {
    const { runCommand } = await loadExtension({
      discoverModelsError: new Error('requesty has a bad day trying to read its models'),
    })
    const { notifier, capturedNotifications } = createFakeNotifier()
    const { status } = createFakeStatusReporter()

    await runCommand('', status, notifier)

    expect(capturedNotifications).toMatchSnapshot()
  })

  it('reports progress while checking models', async () => {
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]
    const { runCommand } = await loadExtension({ models })
    const { notifier } = createFakeNotifier()
    const { status, capturedStatuses } = createFakeStatusReporter()

    await runCommand('', status, notifier)

    expect(capturedStatuses).toEqual([
      'Discovering Requesty models...',
      'Checking models 0/2...',
      'Checking models 1/2...',
      'Checking models 2/2...',
      undefined,
    ])
  })
})

describe('command handler ui wiring', () => {
  it('does not use ui sinks outside tui mode', async () => {
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]
    const { command } = await loadExtension({ models })
    const { ctx, loaderStatusSink, notifications } = createFakeCommandContext({ mode: 'print' })

    await command.handler('', ctx)

    expect(loaderStatusSink).toEqual([])
    expect(notifications).toEqual([])
  })

  it('uses the loader status reporter in tui mode', async () => {
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]
    const { command } = await loadExtension({ models })
    const { ctx, loaderStatusSink, notifications } = createFakeCommandContext({ mode: 'tui' })

    await command.handler('', ctx)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].type).toBe('info')
    expect(notifications[0].message).toContain(`${COMMAND_NAME}: Discovered 2 Requesty model(s).`)
    expect(loaderStatusSink).toEqual([
      'Discovering Requesty models...',
      'Checking models 0/2...',
      'Checking models 1/2...',
      'Checking models 2/2...',
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
    runCommand: extension.runCommand,
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

function createFakeNotifier() {
  const notifications: Array<{ message: string; type?: NotificationLevel }> = []
  const notifier: Notifier = {
    notify(message, type) {
      notifications.push({ message, type })
    },
  }

  return { notifier, capturedNotifications: notifications }
}

function createFakeStatusReporter() {
  const statuses: Array<string | undefined> = []
  const status: StatusReporter = {
    set(message) {
      statuses.push(message)
    },
    clear() {
      statuses.push(undefined)
    },
  }

  return { status, capturedStatuses: statuses }
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
