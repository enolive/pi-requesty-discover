import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from '@earendil-works/pi-coding-agent'

type NotificationType = 'info' | 'warning' | 'error'
type RegisteredCommandOptions = Omit<RegisteredCommand, 'name' | 'sourceInfo'>

export function createFakePi() {
  const commands = new Map<string, RegisteredCommandOptions>()

  const pi = {
    registerCommand(name: string, command: RegisteredCommandOptions) {
      commands.set(name, command)
    },
  } as unknown as ExtensionAPI

  return { pi, commands }
}

export function createFakeCommandContext() {
  const notifications: Array<{ message: string; type?: NotificationType }> = []
  const statuses: Array<{ key: string; text?: string }> = []

  // Minimal fake theme
  const fakeTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  }

  const ctx = {
    ui: {
      notify(message: string, type?: NotificationType) {
        notifications.push({ message, type })
      },
      setStatus(key: string, text?: string) {
        statuses.push({ key, text })
      },
      custom<T>(_fn: (tui: unknown, theme: typeof fakeTheme, kb: unknown, done: (result: T) => void) => unknown): Promise<T> {
        // Fake implementation: call the function with mock dependencies
        // The function sets up the UI component and returns it, the actual async work
        // (like runCommand) runs internally and calls done() when complete
        _fn(null, fakeTheme, null, () => {})
        // Wait a tick for async work to complete
        return new Promise(resolve => setTimeout(() => resolve(undefined as T), 0))
      },
    },
  } as unknown as ExtensionCommandContext

  return { ctx, notifications, statuses }
}
