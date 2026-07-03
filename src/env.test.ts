import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getEnv } from './env'

const TEST_HOME_DIR = '/tmp/pi-requesty-home'
const REQUESTY_ENV_KEYS = ['REQUESTY_API_KEY', 'REQUESTY_PROVIDER_ID', 'REQUESTY_HEALTH_CHECK_MODE'] as const

function deleteRequestyEnv() {
  for (const key of REQUESTY_ENV_KEYS) {
    delete process.env[key]
  }
}

describe('getEnv', () => {
  beforeEach(() => {
    deleteRequestyEnv()
  })

  afterEach(() => {
    deleteRequestyEnv()
  })

  it('defaults provider ID to requesty-export', () => {
    const homeDir = TEST_HOME_DIR

    const envConfig = getEnv({ homeDir })

    expect(envConfig.provider_id).toBe('requesty-export')
  })

  it('defaults health check mode to full', () => {
    const homeDir = TEST_HOME_DIR

    const envConfig = getEnv({ homeDir })

    expect(envConfig.health_check_mode).toBe('full')
  })

  it('accepts off health check mode', () => {
    process.env.REQUESTY_HEALTH_CHECK_MODE = 'off'

    const envConfig = getEnv({ homeDir: TEST_HOME_DIR })

    expect(envConfig.health_check_mode).toBe('off')
  })

  it('accepts basic health check mode', () => {
    process.env.REQUESTY_HEALTH_CHECK_MODE = 'basic'

    const envConfig = getEnv({ homeDir: TEST_HOME_DIR })

    expect(envConfig.health_check_mode).toBe('basic')
  })

  it('accepts full health check mode', () => {
    process.env.REQUESTY_HEALTH_CHECK_MODE = 'full'

    const envConfig = getEnv({ homeDir: TEST_HOME_DIR })

    expect(envConfig.health_check_mode).toBe('full')
  })

  it('rejects invalid health check mode', () => {
    process.env.REQUESTY_HEALTH_CHECK_MODE = 'invalid'

    const createEnv = () => getEnv({ homeDir: TEST_HOME_DIR })

    expect(createEnv).toThrow(/Invalid option/)
  })

  it('uses provided homeDir for models_json_path', () => {
    const homeDir = TEST_HOME_DIR

    const envConfig = getEnv({ homeDir })

    expect(envConfig.models_json_path).toBe(`${TEST_HOME_DIR}/.pi/agent/models.json`)
  })

  it('uses provided homeDir for health_check_log_path', () => {
    const homeDir = TEST_HOME_DIR

    const envConfig = getEnv({ homeDir })

    expect(envConfig.health_check_log_path).toBe(`${TEST_HOME_DIR}/.pi/agent/requesty-health-check.log`)
  })

  it('reads REQUESTY_API_KEY', () => {
    process.env.REQUESTY_API_KEY = 'test-api-key'

    const envConfig = getEnv({ homeDir: TEST_HOME_DIR })

    expect(envConfig.requesty_api_key).toBe('test-api-key')
  })

  it('reads REQUESTY_PROVIDER_ID', () => {
    process.env.REQUESTY_PROVIDER_ID = 'custom-provider'

    const envConfig = getEnv({ homeDir: TEST_HOME_DIR })

    expect(envConfig.provider_id).toBe('custom-provider')
  })
})
