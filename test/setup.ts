import { afterAll, afterEach, beforeAll, vi } from 'vitest'
import { setupServer } from 'msw/node'

export const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})

afterEach(() => {
  // reset any existing MSW handlers
  server.resetHandlers()
  // reset any fake timers that might exist
  vi.useRealTimers()
})

afterAll(() => {
  server.close()
})
