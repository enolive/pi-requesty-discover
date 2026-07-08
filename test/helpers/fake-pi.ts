import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from '@earendil-works/pi-coding-agent'
import type { RequestyStatusLoader } from '../../src/ui/requesty-status-loader.ts'

type RegisteredCommandOptions = Omit<RegisteredCommand, 'name' | 'sourceInfo'>
type UiCustom = ExtensionCommandContext['ui']['custom']
type UINotify = ExtensionCommandContext['ui']['notify']
type NotificationType = Parameters<UINotify>[1]
type UiCustomFactory = Parameters<UiCustom>[0]
type UiCustomFactoryArgs = Parameters<UiCustomFactory>
type UiCustomComponent = Awaited<ReturnType<UiCustomFactory>>
type UiCustomOptions = Parameters<UiCustom>[1]
type FakeUiCustomFactory<T> = (
  tui: UiCustomFactoryArgs[0],
  theme: UiCustomFactoryArgs[1],
  keybindings: UiCustomFactoryArgs[2],
  done: (result: T) => void,
) => UiCustomComponent | Promise<UiCustomComponent>

export function createFakePi() {
  const commands = new Map<string, RegisteredCommandOptions>()

  const pi = {
    registerCommand(name: string, command: RegisteredCommandOptions) {
      commands.set(name, command)
    },
  } as unknown as ExtensionAPI

  return { pi, commands }
}

type FakeCommandContextOptions = {
  mode?: 'tui' | 'rpc' | 'json' | 'print'
}

export function createFakeCommandContext(options: FakeCommandContextOptions = {}) {
  const notifications: Array<{ message: string; type?: NotificationType }> = []
  const loaderStatusSink: string[] = []

  const fakeTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  } as unknown as UiCustomFactoryArgs[1]

  // noinspection JSUnusedGlobalSymbols - requestRender is required by the ui component
  const fakeTui = {
    requestRender() {
      // Tests only assert message plumbing, not TUI rendering.
    },
  } as unknown as UiCustomFactoryArgs[0]

  const fakeKeybindings = null as unknown as UiCustomFactoryArgs[2]

  const custom: UiCustom = <T>(factory: FakeUiCustomFactory<T>, options?: UiCustomOptions): Promise<T> => {
    void options
    return new Promise<T>(resolve => {
      const loader = factory(fakeTui, fakeTheme, fakeKeybindings, result => {
        loader.dispose()
        resolve(result)
      }) as unknown as RequestyStatusLoader

      const originalSetMessage = loader.setMessage.bind(loader)
      loader.setMessage = (message: string) => {
        loaderStatusSink.push(message)
        originalSetMessage(message)
      }
    })
  }

  const ctx = {
    mode: options.mode ?? 'print',
    ui: {
      notify(message: string, type?: NotificationType) {
        notifications.push({ message, type })
      },
      custom,
    },
  } as unknown as ExtensionCommandContext

  return { ctx, notifications, loaderStatusSink }
}
