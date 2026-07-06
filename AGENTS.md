# AGENTS.md

Development notes for coding agents working on this repository.

## Project overview

*pi-requesty* is a Pi Coding Agent extension for syncing Requesty models into Pi's local *models.json*.

Pi loads the extension directly from TypeScript:

```json
{
  "main": "src/index.ts",
  "pi": {
    "extensions": [
      "./src/index.ts"
    ]
  }
}
```

Do **not** add a build/transpile step unless explicitly requested.

## Source layout

```text
src/
├── index.ts          # Pi command registration and high-level command flow
├── env.ts            # Environment variables and paths to pi
├── models-json.ts    # Read/validate/update models.json
├── requesty-api.ts   # Requesty models library API
└── health-check.ts   # Model health checks and health-check log writing
```

## Conventions

- Use TypeScript for source files.
- Keep imports extensionless inside `src`, e.g. `import env from './env'`.
- Use Pi's exported types where available, especially:
  - `ExtensionAPI`
  - `ExtensionCommandContext`
  - `ProviderConfig`
  - `ProviderModelConfig`
- Use `zod` for runtime validation of external data:
  - environment values
  - things from the *models.json*
  - Requesty API responses
- Keep all environment/path access centralized in `src/env.ts`.
- Keep the Pi command name centralized in `src/index.ts` as `COMMAND_NAME`.
- `REQUESTY_HEALTH_CHECK_MODE` is validated as `off | basic | full`.

## Development commands

Run these before handing off changes:

```bash
npm run format:check
npm run typecheck
npm run lint
```

Use formatting when needed:

```bash
npm run format
```

## Package notes

Published files are controlled by `package.json`:

```json
{
  "files": [
    "src",
    "tsconfig.json",
    "README.md",
    "LICENSE"
  ]
}
```

If adding required runtime files, update `files` accordingly.
