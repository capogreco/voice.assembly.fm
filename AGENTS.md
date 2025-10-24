# Repository Guidelines

## Project Structure & Module Organization

- `src/server/`: Unified Deno server. Entry: `src/server/main.ts` (HTTP +
  WebSocket + static + ICE).
- `src/common/`: Shared browser/server modules (WebRTC, protocol, parameter
  types).
- `public/ctrl` and `public/synth`: Client apps and worklets. Ctrl is TypeScript
  (`ctrl-main.ts`) bundled on-the-fly; Synth is JavaScript.
- `scripts/`: Utility scripts (e.g., `scripts/build.ts`).
- `reference/`: Research/design notes and examples for agents. Use for
  exploration and code snippets; avoid runtime imports.

## Build, Test, and Development Commands

- Run unified dev server: `deno task dev`
  - Uses
    `--allow-net --allow-read --allow-sys --allow-env --allow-run --unstable-kv`.
- Start without watch: `deno task start`
- Optional build helper: `deno run -A scripts/build.ts` (copies shared modules
  if needed).

## Coding Style & Naming Conventions

- Language: TypeScript/JavaScript (Deno). Prefer `.ts` for new modules.
- Indentation: 2 spaces; keep lines concise; use trailing commas where natural.
- Naming: `kebab-case` for files in `public/`, `camelCase` for
  variables/functions, `PascalCase` for types/interfaces.
- Formatting/linting: use `deno fmt` and `deno lint` before pushing.

## Testing Guidelines

- Framework: Deno built-ins. Place tests as `*_test.ts` near sources (e.g.,
  `src/common/foo_test.ts`).
- Run all tests: `deno test --allow-read`.
- Aim for unit tests on pure modules (protocol validation, math); smoke-test
  clients manually in browsers.

## Commit & Pull Request Guidelines

- Commits: short, imperative, scoped when helpful (e.g., "ctrl: fix envelope
  UI").
- PRs: include a clear description, linked issues, screenshots or console output
  for UI/servers, and steps to reproduce/verify.
- Keep changes focused; update README or in-file docs when behavior changes.

## Security & Configuration Tips

- Env: `.env` supports `PORT`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` for
  TURN (`/ice-servers`). Never commit secrets.
- Deno permissions: default tasks already scope permissions; prefer `-A` only
  for local dev tooling.

## Reference Usage Policy

- Use `reference/` freely for research, prototypes, and copying small snippets
  into real modules.
- Do not import from `reference/` at runtime; migrate needed code into `src/*`
  or `public/*`.
- Do not commit edits under `reference/` in PRs. Treat it as local-only research
  material.

## Agent-Specific Instructions

- Prefer minimal, surgical diffs; follow existing patterns in `src/common` and
  `public/*`.
- Use `deno fmt`/`deno lint`; avoid adding new tooling unless requested.
- When adding modules, wire imports via `deno.json` `imports` or relative paths;
  do not import from `reference/` at runtime and avoid committing `reference/`
  changes.
