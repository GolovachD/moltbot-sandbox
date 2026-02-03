# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cloudflare Worker that runs Moltbot (OpenClaw) personal AI assistant inside a Cloudflare Sandbox container. The worker proxies HTTP/WebSocket requests to the Moltbot gateway running on port 18789 inside the container, provides an admin UI for device management, and handles authentication via Cloudflare Access JWTs.

**Note:** The CLI tool is still named `clawdbot` (upstream hasn't renamed yet). CLI commands and internal config paths use that name.

## Commands

```bash
npm test                  # Run tests (vitest)
npm run test:watch        # Tests in watch mode
npm run test:coverage     # Tests with coverage
npm run typecheck         # TypeScript type checking (tsc --noEmit)
npm run types             # Generate Cloudflare type definitions
npm run build             # Build worker + admin UI (vite build)
npm run start             # Local dev worker (wrangler dev)
npm run dev               # Vite dev server (frontend only)
npm run deploy            # Build + deploy to Cloudflare Workers
npx wrangler tail         # View live production logs
```

Run a single test file: `npx vitest run src/auth/jwt.test.ts`

## Architecture

```
Browser → Cloudflare Worker (Hono) → Sandbox Container → Moltbot Gateway (:18789)
```

**Worker (src/index.ts):** Hono app with middleware pipeline: logger → sandbox init → public routes → env validation → CF Access auth → protected routes → catch-all proxy to gateway.

**Key modules:**
- `src/auth/` — CF Access JWT verification and Hono auth middleware
- `src/gateway/process.ts` — Find/start gateway process, wait for port readiness (180s timeout)
- `src/gateway/env.ts` — Maps worker env vars to container env vars (e.g., `MOLTBOT_GATEWAY_TOKEN` → `CLAWDBOT_GATEWAY_TOKEN`)
- `src/gateway/r2.ts` — Mounts R2 bucket at `/data/moltbot` for persistent storage
- `src/gateway/sync.ts` — Periodic R2 backup sync (every 5 min via cron)
- `src/routes/api.ts` — Device pairing API (`/api/admin/*`) using `clawdbot` CLI
- `src/routes/admin-ui.ts` — Serves React admin dashboard at `/_admin/`
- `src/routes/debug.ts` — Debug endpoints at `/debug/*` (enabled via `DEBUG_ROUTES`)
- `src/routes/cdp.ts` — Chrome DevTools Protocol shim for browser automation
- `src/client/` — React admin UI (built by Vite, served at `/_admin/`)

**Container setup:** `Dockerfile` builds image with Node 22 + clawdbot CLI. `start-moltbot.sh` restores config from R2, applies env vars, starts gateway with `--allow-unconfigured`.

## Key Patterns

- **CLI calls from worker:** Always include `--url ws://localhost:18789`. CLI takes 10-15s due to WebSocket overhead. Use `waitForProcess()` helper.
- **Success detection:** CLI outputs "Approved" (capital A). Use case-insensitive checks.
- **WebSocket proxying:** Worker creates `WebSocketPair` to relay and transform messages between client and container.
- **Auth layers:** Cloudflare Access (JWT) → Gateway Token (query param) → Device Pairing (approve via admin UI). `DEV_MODE=true` skips CF Access + pairing. `E2E_TEST_MODE=true` skips CF Access only.
- **Background work:** Uses `executionCtx.waitUntil()` for async tasks.
- **Docker cache busting:** Bump version comment in Dockerfile when changing `start-moltbot.sh` or `moltbot.json.template`.

## Testing

Vitest with tests colocated next to source files (`*.test.ts`). Coverage excludes `src/client/`. Environment: node with globals enabled.

## R2 Storage Gotchas

- Use `rsync -r --no-times` (s3fs doesn't support setting timestamps).
- Check mount status with `mount | grep s3fs`, not `mountBucket()` error messages.
- `/data/moltbot` IS the R2 bucket — `rm -rf` there deletes backup data.
- `proc.status` may not update immediately; verify success via expected output instead.

## Moltbot Config Gotchas

- `agents.defaults.model` must be `{ "primary": "model/name" }`, not a string.
- `gateway.mode` must be `"local"` for headless operation.
- No `webchat` channel — Control UI is served automatically.
- Use `--bind` CLI flag, not `gateway.bind` config option.

## Adding New Functionality

**New API endpoint:** Add handler in `src/routes/api.ts` → types in `src/types.ts` → client API in `src/client/api.ts` → tests.

**New environment variable:** Add to `MoltbotEnv` in `src/types.ts` → add to `buildEnvVars()` in `src/gateway/env.ts` → update `.dev.vars.example` → document in README.md.

## Contributing

- Issues first for non-trivial changes.
- All AI usage must be disclosed with tool name and extent.
- AI-created PRs must reference accepted issues and be human-verified.