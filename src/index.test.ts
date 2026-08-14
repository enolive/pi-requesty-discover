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

const COMMAND_NAME = 'requesty-discover'

type TestCommand = Omit<RegisteredCommand, 'name' | 'sourceInfo'>
type HealthCheckMode = 'off' | 'basic' | 'full'

type MockScenario = {
  healthCheckMode?: HealthCheckMode
  models?: ProviderModelConfig[]
  healthResults?: HealthCheckResult[]
  getRequestyConfigError?: unknown
  discoverModelsError?: unknown
  diff?: ModelsJsonModule.ModelsDiff
}

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
    const { command } = await loadCommand()

    expect(command.description).toBe(
      'Dynamically discover Requesty models, run health checks, and update the local models.json.',
    )
    expect(command.getArgumentCompletions).toBeTypeOf('function')
    expect(command.handler).toBeTypeOf('function')
  })
})

describe('argument completions', () => {
  it('returns dry-run option for empty prefix', async () => {
    const { command } = await loadCommand()

    const completions = await getArgumentCompletions(command, '')

    expect(completions).toMatchSnapshot()
  })

  it('returns dry-run option for matching prefix', async () => {
    const { command } = await loadCommand()

    const completions = await getArgumentCompletions(command, '--d')

    expect(completions).toMatchSnapshot()
  })

  it('returns empty list for unrelated prefix', async () => {
    const { command } = await loadCommand()

    const completions = await getArgumentCompletions(command, '--wat')

    expect(completions).toEqual([])
  })
})

describe('discovery workflow', () => {
  it('emits notification and does not update models.json on dry-run', async () => {
    const { updateModelsJson } = configureMockedDependencies({ healthCheckMode: 'off' })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx, capturedNotifications } = createFakeCommandContext()

    await runDiscoveryWorkflow(ctx, '--dry-run')

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(capturedNotifications).toMatchSnapshot()
  })

  it('updates models.json and notifies info on no failures', async () => {
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]
    const healthResults = [
      createHealthCheckResult({ modelId: 'requesty/model-a', ok: true }),
      createHealthCheckResult({ modelId: 'requesty/model-b', ok: true }),
    ]
    const { updateModelsJson } = configureMockedDependencies({ models, healthResults })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx, capturedNotifications } = createFakeCommandContext({ confirmResult: true })

    await runDiscoveryWorkflow(ctx, '')

    expect(updateModelsJson).toHaveBeenCalledWith(modelsJson, models, expect.any(Object))
    expect(capturedNotifications).toMatchSnapshot()
  })

  it('updates passing models and notifies warning on partial failures', async () => {
    const passingModel = createModel({ id: 'requesty/passing-model' })
    const failingModel = createModel({ id: 'requesty/failing-model' })
    const healthResults = [
      createHealthCheckResult({ modelId: 'requesty/passing-model', ok: true }),
      createHealthCheckResult({ modelId: 'requesty/failing-model', ok: false }),
    ]
    const { updateModelsJson } = configureMockedDependencies({
      models: [passingModel, failingModel],
      healthResults,
    })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx, capturedNotifications } = createFakeCommandContext({ confirmResult: true })

    await runDiscoveryWorkflow(ctx, '')

    expect(updateModelsJson).toHaveBeenCalledWith(modelsJson, [passingModel], expect.any(Object))
    expect(capturedNotifications).toMatchSnapshot()
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
    const { formatHealthSummary, writeHealthCheckLog } = configureMockedDependencies({
      models: [failingModel1, failingModel2, failingModel3],
      healthResults: shuffledHealthResults,
    })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx } = createFakeCommandContext({ confirmResult: true })

    await runDiscoveryWorkflow(ctx, '')

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
    const { updateModelsJson } = configureMockedDependencies({
      models: [passingModel1, passingModel2, passingModel3],
      healthResults: shuffledHealthResults,
    })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx } = createFakeCommandContext({ confirmResult: true })

    await runDiscoveryWorkflow(ctx, '')

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
    const { updateModelsJson } = configureMockedDependencies({ models, healthResults })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx, capturedNotifications } = createFakeCommandContext({ confirmResult: true })

    await runDiscoveryWorkflow(ctx, '')

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(capturedNotifications).toMatchSnapshot()
  })

  it('notifies full error and clears status', async () => {
    const { updateModelsJson } = configureMockedDependencies({
      getRequestyConfigError: new Error('models.json exploded'),
    })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx, capturedNotifications } = createFakeCommandContext({ confirmResult: true })

    await runDiscoveryWorkflow(ctx, '')

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(capturedNotifications).toMatchSnapshot()
  })

  it('notifies full error for sth not deriving from Error', async () => {
    configureMockedDependencies({
      getRequestyConfigError: 'this is not an error',
    })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx, capturedNotifications } = createFakeCommandContext({ confirmResult: true })

    await runDiscoveryWorkflow(ctx, '')

    expect(capturedNotifications).toMatchSnapshot()
  })

  it('notifies full error on async rejections', async () => {
    configureMockedDependencies({
      discoverModelsError: new Error('requesty has a bad day trying to read its models'),
    })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx, capturedNotifications } = createFakeCommandContext({ confirmResult: true })

    await runDiscoveryWorkflow(ctx, '')

    expect(capturedNotifications).toMatchSnapshot()
  })

  it('includes the model diff summary in the notification', async () => {
    const diff = { added: ['requesty/model-new'], removed: ['requesty/model-old'] }
    const { formatModelsDiffSummary } = configureMockedDependencies({ diff })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx, capturedNotifications } = createFakeCommandContext({ confirmResult: true })

    await runDiscoveryWorkflow(ctx, '')

    expect(formatModelsDiffSummary).toHaveBeenCalledWith(diff)
    expect(capturedNotifications[0].message).toContain('Models diff summary.')
  })

  it('includes the model diff summary even when health checks are off', async () => {
    const diff = { added: ['requesty/model-new'], removed: [] }
    const { formatModelsDiffSummary } = configureMockedDependencies({ healthCheckMode: 'off', diff })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx, capturedNotifications } = createFakeCommandContext({ confirmResult: true })

    await runDiscoveryWorkflow(ctx, '')

    expect(formatModelsDiffSummary).toHaveBeenCalledWith(diff)
    expect(capturedNotifications[0].message).toContain('Models diff summary.')
  })

  it('reports progress while checking models', async () => {
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]
    configureMockedDependencies({ models })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx, capturedStatuses } = createFakeCommandContext({ confirmResult: true })

    await runDiscoveryWorkflow(ctx, '')

    expect(capturedStatuses).toEqual([
      'Discovering Requesty models...',
      'Checking models 0/2...',
      'Checking models 1/2...',
      'Checking models 2/2...',
    ])
  })
})

describe('confirm-to-write', () => {
  describe('presents summary, then asks for confirmation, then presents final message for', () => {
    it.each([true, false])('confirmation: %s', async confirmResult => {
      const models = [createModel({ id: 'requesty/model-a' })]
      configureMockedDependencies({ healthCheckMode: 'off', models })
      const { runDiscoveryWorkflow } = await loadCommand()
      const { ctx, capturedUiOrder } = createFakeCommandContext({ confirmResult })

      await runDiscoveryWorkflow(ctx, '')

      expect(capturedUiOrder).toEqual(['notify', 'confirm', 'notify'])
    })
  })

  it('asks for confirmation before updating models.json', async () => {
    const models = [createModel({ id: 'requesty/model-a' })]
    const { updateModelsJson } = configureMockedDependencies({ healthCheckMode: 'off', models })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx } = createFakeCommandContext({ confirmResult: true })
    const confirmSpy = vi.spyOn(ctx.ui, 'confirm')

    await runDiscoveryWorkflow(ctx, '')

    expect(updateModelsJson).toHaveBeenCalledOnce()
    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(confirmSpy.mock.invocationCallOrder[0]).toBeLessThan(updateModelsJson.mock.invocationCallOrder[0])
  })

  it('does not update models.json when confirmation is declined', async () => {
    const models = [createModel({ id: 'requesty/model-a' })]
    const { updateModelsJson } = configureMockedDependencies({ healthCheckMode: 'off', models })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx, capturedNotifications } = createFakeCommandContext({ confirmResult: false })

    await runDiscoveryWorkflow(ctx, '')

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(capturedNotifications).toMatchSnapshot()
  })

  it('still confirms when the model id diff is empty', async () => {
    const models = [createModel({ id: 'requesty/model-a' })]
    const { updateModelsJson } = configureMockedDependencies({
      healthCheckMode: 'off',
      models,
      diff: { added: [], removed: [] },
    })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx, capturedNotifications, capturedConfirmations } = createFakeCommandContext({ confirmResult: true })

    await runDiscoveryWorkflow(ctx, '')

    expect(capturedConfirmations).toHaveLength(1)
    expect(capturedNotifications[0]?.message).toEqual(
      [`${COMMAND_NAME}: Discovered 1 Requesty model(s).`, 'Models diff summary.'].join('\n'),
    )
    expect(capturedConfirmations[0]).toEqual({
      title: 'Refresh models.json?',
      message: 'No model ID changes. Rewrite the file to refresh metadata anyway?',
    })
    expect(updateModelsJson).toHaveBeenCalledTimes(1)
    expect(capturedNotifications.at(-1)).toEqual({
      message: `${COMMAND_NAME}: Updated models.json. Run /reload to use the changes.`,
      type: 'info',
    })
  })

  it('does not ask for confirmation on dry-run', async () => {
    const { updateModelsJson } = configureMockedDependencies({ healthCheckMode: 'off' })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx, capturedConfirmations } = createFakeCommandContext({ confirmResult: true })

    await runDiscoveryWorkflow(ctx, '--dry-run')

    expect(capturedConfirmations).toHaveLength(0)
    expect(updateModelsJson).not.toHaveBeenCalled()
  })

  it('does not ask for confirmation when there are no passing models', async () => {
    const models = [createModel({ id: 'requesty/model-a' })]
    const healthResults = [createHealthCheckResult({ modelId: 'requesty/model-a', ok: false })]
    const { updateModelsJson } = configureMockedDependencies({ models, healthResults })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx, capturedConfirmations } = createFakeCommandContext({ confirmResult: true })

    await runDiscoveryWorkflow(ctx, '')

    expect(capturedConfirmations).toHaveLength(0)
    expect(updateModelsJson).not.toHaveBeenCalled()
  })

  it('notifies discovery summary before a short confirmation prompt', async () => {
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]
    const diff = { added: ['requesty/model-new'], removed: ['requesty/model-old'] }
    configureMockedDependencies({ healthCheckMode: 'off', models, diff })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx, capturedNotifications, capturedConfirmations } = createFakeCommandContext({ confirmResult: true })

    await runDiscoveryWorkflow(ctx, '')

    expect(capturedNotifications[0]?.message).toEqual(
      [`${COMMAND_NAME}: Discovered 2 Requesty model(s).`, 'Models diff summary.'].join('\n'),
    )
    expect(capturedConfirmations).toEqual([
      {
        title: 'Write 2 model(s)?',
        message: 'Update models.json with the discovery result above.',
      },
    ])
    expect(capturedNotifications.at(-1)).toEqual({
      message: `${COMMAND_NAME}: Updated models.json. Run /reload to use the changes.`,
      type: 'info',
    })
  })

  it('notifies health-check context before confirmation', async () => {
    const models = [createModel({ id: 'requesty/model-a' })]
    const diff = { added: ['requesty/model-a'], removed: [] }
    configureMockedDependencies({ models, diff })
    const { runDiscoveryWorkflow } = await loadCommand()
    const { ctx, capturedNotifications, capturedConfirmations } = createFakeCommandContext({ confirmResult: true })

    await runDiscoveryWorkflow(ctx, '')

    expect(capturedNotifications[0]?.message).toEqual(
      [
        `${COMMAND_NAME}: Discovered 1 Requesty model(s).`,
        'Health check summary.',
        'Models diff summary.',
        `Full health check log: ${HEALTH_CHECK_LOG_PATH}`,
      ].join('\n'),
    )
    expect(capturedConfirmations).toEqual([
      {
        title: 'Write 1 model(s)?',
        message: 'Update models.json with the discovery result above.',
      },
    ])
  })
})

describe('command handler ui wiring', () => {
  it('notifies Discovery failed for Error throws during evaluation', async () => {
    const { updateModelsJson } = configureMockedDependencies({
      getRequestyConfigError: new Error('models.json exploded'),
    })
    const { command } = await loadCommand()
    const { ctx, capturedNotifications, capturedConfirmations } = createFakeCommandContext()

    await command.handler('', ctx)

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(capturedConfirmations).toEqual([])
    expect(capturedNotifications).toEqual([
      {
        message: `${COMMAND_NAME}: Discovery failed: models.json exploded`,
        type: 'error',
      },
    ])
  })

  it('notifies Discovery failed for non-Error throws during evaluation', async () => {
    const { updateModelsJson } = configureMockedDependencies({
      getRequestyConfigError: 'this is not an error',
    })
    const { command } = await loadCommand()
    const { ctx, capturedNotifications, capturedConfirmations } = createFakeCommandContext()

    await command.handler('', ctx)

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(capturedConfirmations).toEqual([])
    expect(capturedNotifications).toEqual([
      {
        message: `${COMMAND_NAME}: Discovery failed: this is not an error`,
        type: 'error',
      },
    ])
  })

  it('notifies Discovery failed for async rejections during evaluation', async () => {
    const { updateModelsJson } = configureMockedDependencies({
      discoverModelsError: new Error('requesty has a bad day trying to read its models'),
    })
    const { command } = await loadCommand()
    const { ctx, capturedNotifications, capturedConfirmations } = createFakeCommandContext()

    await command.handler('', ctx)

    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(capturedConfirmations).toEqual([])
    expect(capturedNotifications).toEqual([
      {
        message: `${COMMAND_NAME}: Discovery failed: requesty has a bad day trying to read its models`,
        type: 'error',
      },
    ])
  })

  it('exits early outside tui mode', async () => {
    const models = [createModel({ id: 'requesty/model-a' })]
    const { discoverModels, updateModelsJson } = configureMockedDependencies({
      healthCheckMode: 'off',
      models,
    })
    const { command } = await loadCommand()
    const { ctx, capturedStatuses, capturedNotifications, capturedConfirmations } = createFakeCommandContext({
      mode: 'print',
    })

    await command.handler('', ctx)

    expect(discoverModels).not.toHaveBeenCalled()
    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(capturedStatuses).toEqual([])
    expect(capturedNotifications).toEqual([])
    expect(capturedConfirmations).toEqual([])
  })

  it('uses the loader status reporter', async () => {
    const models = [createModel({ id: 'requesty/model-a' }), createModel({ id: 'requesty/model-b' })]
    configureMockedDependencies({ models })
    const { command } = await loadCommand()
    const { ctx, capturedStatuses, capturedNotifications } = createFakeCommandContext()

    await command.handler('', ctx)

    expect(capturedNotifications).toHaveLength(2)
    expect(capturedNotifications[0]?.type).toBe('info')
    expect(capturedNotifications[0]?.message).toContain(`${COMMAND_NAME}: Discovered 2 Requesty model(s).`)
    expect(capturedNotifications[1]).toEqual({
      type: 'info',
      message: `${COMMAND_NAME}: Updated models.json. Run /reload to use the changes.`,
    })
    expect(capturedStatuses).toEqual([
      'Discovering Requesty models...',
      'Checking models 0/2...',
      'Checking models 1/2...',
      'Checking models 2/2...',
    ])
  })

  it('uses ui.confirm before writing', async () => {
    const models = [createModel({ id: 'requesty/model-a' })]
    const { updateModelsJson } = configureMockedDependencies({ healthCheckMode: 'off', models })
    const { command } = await loadCommand()
    const { ctx, capturedConfirmations } = createFakeCommandContext({ confirmResult: true })

    await command.handler('', ctx)

    expect(capturedConfirmations).toHaveLength(1)
    expect(updateModelsJson).toHaveBeenCalledTimes(1)
  })

  it('does not write when ui.confirm is declined', async () => {
    const models = [createModel({ id: 'requesty/model-a' })]
    const { updateModelsJson } = configureMockedDependencies({ healthCheckMode: 'off', models })
    const { command } = await loadCommand()
    const { ctx, capturedConfirmations, capturedNotifications } = createFakeCommandContext({
      confirmResult: false,
    })

    await command.handler('', ctx)

    expect(capturedConfirmations).toHaveLength(1)
    expect(updateModelsJson).not.toHaveBeenCalled()
    expect(capturedNotifications.at(-1)).toEqual({
      type: 'info',
      message: `${COMMAND_NAME}: Left models.json unchanged.`,
    })
  })
})

/** Configure mocked domain deps. No Pi registration. */
function configureMockedDependencies(scenario: MockScenario = {}) {
  const models = scenario.models ?? [createModel({ id: 'requesty/model-a' })]
  const healthResults = scenario.healthResults ?? models.map(model => createHealthCheckResult({ modelId: model.id }))

  const { updateModelsJson, formatModelsDiffSummary } = mockModelsModule(scenario)
  const discoverModels = mockRequestyApiModule(scenario, models)
  const { formatHealthSummary, writeHealthCheckLog } = mockHealthCheckModule(healthResults)
  mockEnvModule(scenario)

  return {
    updateModelsJson,
    discoverModels,
    formatHealthSummary,
    writeHealthCheckLog,
    formatModelsDiffSummary,
  }
}

function mockModelsModule(scenario: MockScenario) {
  const getRequestyConfig = vi.mocked(ModelsJsonModule.getRequestyConfig)
  if (scenario.getRequestyConfigError) {
    getRequestyConfig.mockThrow(scenario.getRequestyConfigError)
  } else {
    getRequestyConfig.mockReturnValue({
      data: modelsJson,
      provider,
      existingModelIds: [],
    })
  }

  const updateModelsJson = vi.mocked(ModelsJsonModule.updateModelsJson)
  const diffModels = vi.mocked(ModelsJsonModule.diffModels)
  diffModels.mockReturnValue(scenario.diff ?? { added: [], removed: [] })
  const formatModelsDiffSummary = vi.mocked(ModelsJsonModule.formatModelsDiffSummary)
  formatModelsDiffSummary.mockReturnValue('Models diff summary.')
  return { updateModelsJson, formatModelsDiffSummary }
}

function mockRequestyApiModule(scenario: MockScenario, models: ProviderModelConfig[]) {
  const discoverModels = vi.mocked(RequestyApiModule.discoverModels)
  if (scenario.discoverModelsError) {
    discoverModels.mockRejectedValue(scenario.discoverModelsError)
  } else {
    discoverModels.mockResolvedValue(models)
  }
  return discoverModels
}

function mockHealthCheckModule(healthResults: HealthCheckResult[]) {
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
  return { formatHealthSummary, writeHealthCheckLog }
}

function mockEnvModule(options: MockScenario) {
  const getEnv = vi.mocked(EnvModule.getEnv)
  getEnv.mockReturnValue({
    models_json_path: MODELS_JSON_PATH,
    health_check_log_path: HEALTH_CHECK_LOG_PATH,
    provider_id: 'requesty-export',
    requesty_api_key: 'ignore-me-plz',
    health_check_mode: options.healthCheckMode ?? 'basic',
  })
}

/** Mini Pi glue: import extension, register command, return entrypoints. */
async function loadCommand() {
  const extension = await import('./index')
  const { pi, commands } = createFakePi()
  extension.default(pi)
  const command = commands.get(COMMAND_NAME)

  if (!command) {
    throw new Error(`${COMMAND_NAME} was not registered`)
  }

  return {
    command,
    runDiscoveryWorkflow: extension.runDiscoveryWorkflow,
  }
}

async function getArgumentCompletions(command: TestCommand, prefix: string) {
  if (!command.getArgumentCompletions) {
    throw new Error('Command did not register argument completions')
  }

  return command.getArgumentCompletions(prefix)
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
