# Plan: Multi-provider support for `/requesty-discover`

Collab session plan. Execute stepwise, one step at a time, user sign-off after each step.

## Motivation

Users with more than one Requesty account — e.g. one for their own work and one with a
strict model whitelist for a client — currently have to hand-edit the settings file and
re-run discovery per provider. Since the model list differs per API key (whitelists),
each provider must be discovered and health-checked against its own key. A settings
`providerIds` list plus an optional `providerId` command argument turns the manual
edit-workaround into a one-word command.

## Steps

1. **Settings: `providerIds` list** — `src/settings.ts`: replace `providerId: string`
   with `providerIds: string[]`. Accept legacy single `providerId` string for backwards
   compat, normalize to a one-element array. Default: `[DEFAULT_PROVIDER_ID]`. Update the
   written default settings file and its comments. TDD in `settings.test.ts` (defaults,
   legacy migration, list reading, invalid entries rejected).

2. **Argument parsing** — `src/discovery.ts`: add `parseDiscoveryArgs(args)` returning
   `--dry-run` flag + optional positional `providerId`. If a `providerId` is given, use
   it (unknown provider fails via the existing `getRequestyConfig` error, which must name
   the requested provider — verify with a test). If omitted, default to the single entry
   of `providerIds`; require the argument when the list has more than one entry — i.e.
   with multiple `providerIds` and no argument, discovery refuses to run and errors
   out asking for a `providerId` argument (no guessing, no silent default, no
   sequential all-provider run). TDD in `discovery.test.ts`.

3. **Completions** — `getArgumentCompletions` gets candidate provider IDs from settings
   (`providerIds`); `src/index.ts` wires it in. `--dry-run` stays in the completion list.

4. **Usage status** — `updateUsageStatus`: clear the footer only when the currently
   selected model's provider is not in `providerIds`; fetch usage with the currently
   selected provider's key. No aggregation across providers — one footer line for the
   active provider only, no extra clutter.

5. **Docs** — `README.adoc`: document `providerIds` and the optional argument.

6. **Verify** — `npm run check` + `npm test`.
