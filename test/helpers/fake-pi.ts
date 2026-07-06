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

  const ctx = {
    ui: {
      notify(message: string, type?: NotificationType) {
        notifications.push({ message, type })
      },
      setStatus(key: string, text?: string) {
        statuses.push({ key, text })
      },
    },
  } as unknown as ExtensionCommandContext

  return { ctx, notifications, statuses }
}
