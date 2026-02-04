# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cloudflare Worker that runs Moltbot (OpenClaw) personal AI assistant inside a Cloudflare Sandbox container. The worker proxies HTTP/WebSocket requests to the Moltbot gateway running on port 18789 inside the container, provides an admin UI for device management, and handles authentication via Cloudflare Access JWTs.

**Status:** Experimental proof-of-concept. Not officially supported by OpenClaw or Cloudflare. Requires Workers Paid plan ($5/month) for Sandbox containers.

**Note:** This project uses `clawdbot@2026.1.24-3`. Upstream has renamed to `openclaw` (npm package available), but `clawdbot` remains as a compatibility shim. This project continues using `clawdbot` to avoid migration complexity in Docker + R2 environment.

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
Browser
   │
   ▼
┌─────────────────────────────────────┐
│     Cloudflare Worker (index.ts)    │
│  - Starts Moltbot in sandbox        │
│  - Proxies HTTP/WebSocket requests  │
│  - Passes secrets as env vars       │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│     Cloudflare Sandbox Container    │
│  ┌───────────────────────────────┐  │
│  │     Moltbot Gateway           │  │
│  │  - Control UI on port 18789   │  │
│  │  - WebSocket RPC protocol     │  │
│  │  - Agent runtime              │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

**Worker (src/index.ts):** Hono app with middleware pipeline: logger → sandbox init → public routes → env validation → CF Access auth → protected routes → catch-all proxy to gateway.

**Key modules:**
- `src/auth/` — CF Access JWT verification (jose library) and Hono auth middleware
- `src/gateway/process.ts` — Find/start gateway process, wait for port readiness (180s timeout)
- `src/gateway/env.ts` — Maps worker env vars to container env vars (e.g., `MOLTBOT_GATEWAY_TOKEN` → `CLAWDBOT_GATEWAY_TOKEN`)
- `src/gateway/r2.ts` — Mounts R2 bucket at `/data/moltbot` for persistent storage via s3fs
- `src/gateway/sync.ts` — Periodic R2 backup sync (every 5 min via cron)
- `src/routes/public.ts` — Unauthenticated routes: `/sandbox-health`, `/api/status`, `/logo*`
- `src/routes/api.ts` — Device pairing API (`/api/admin/*`) using `clawdbot` CLI
- `src/routes/admin-ui.ts` — Serves React admin dashboard at `/_admin/`
- `src/routes/debug.ts` — Debug endpoints at `/debug/*` (enabled via `DEBUG_ROUTES`)
- `src/routes/cdp.ts` — Chrome DevTools Protocol shim for browser automation
- `src/client/` — React admin UI (built by Vite, served at `/_admin/`)

**Container setup:** `Dockerfile` builds image with Node 22 + clawdbot CLI. `start-moltbot.sh` restores config from R2, applies env vars, starts gateway with `--allow-unconfigured`.

**Container lifecycle:** Default `SANDBOX_SLEEP_AFTER=never` keeps container alive indefinitely (recommended due to 1-2 minute cold starts). Can be set to `10m`, `1h`, etc. for cost optimization. With R2 configured, data persists across restarts.

**Browser automation:** Worker includes CDP (Chrome DevTools Protocol) shim at `/cdp/*` endpoints. Requires `CDP_SECRET` and `WORKER_URL` secrets. Pre-installed `cloudflare-browser` skill provides screenshot/video scripts using `@cloudflare/puppeteer`.

## Key Patterns

- **CLI calls from worker:** Always include `--url ws://localhost:18789`. CLI takes 10-15s due to WebSocket overhead. Use `waitForProcess()` helper.
- **Success detection:** CLI outputs "Approved" (capital A). Use case-insensitive checks.
- **WebSocket proxying:** Worker creates `WebSocketPair` to relay and transform messages between client and container.
- **Auth layers:** Cloudflare Access (JWT) → Gateway Token (query param) → Device Pairing (approve via admin UI). `DEV_MODE=true` skips CF Access + pairing. `E2E_TEST_MODE=true` skips CF Access only.
- **Background work:** Uses `executionCtx.waitUntil()` for async tasks.
- **Docker cache busting:** Bump version comment in Dockerfile when changing `start-moltbot.sh` or `moltbot.json.template`.
- **Route handler style:** Keep handlers thin — extract logic to separate modules. Use Hono's context methods (`c.json()`, `c.html()`) for responses.

## Container Environment Variables

Worker env vars are mapped to container-internal names in `src/gateway/env.ts`:

| Worker Variable | Container Variable | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` | Moltbot reads directly from env |
| `MOLTBOT_GATEWAY_TOKEN` | `CLAWDBOT_GATEWAY_TOKEN` | Also passed as `--token` flag |
| `DEV_MODE` | `CLAWDBOT_DEV_MODE` | Maps to `controlUi.allowInsecureAuth` |
| `TELEGRAM_BOT_TOKEN` | `TELEGRAM_BOT_TOKEN` | Channel config |
| `DISCORD_BOT_TOKEN` | `DISCORD_BOT_TOKEN` | Channel config |
| `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` | Same | Channel config |

## Configuration

**wrangler.jsonc:** Main worker config defining:

- Container: `standard-4` instance with `Dockerfile` image, max 1 instance
- Assets: Vite-built admin UI at `./dist/client` served as SPA
- R2 bucket: `moltbot-data` binding for persistent storage
- Cron: Runs backup sync every 5 minutes (`*/5 * * * *`)
- Browser binding: For CDP/Puppeteer functionality

## Testing

Vitest with tests colocated next to source files (`*.test.ts`). Coverage excludes `src/client/`. Environment: node with globals enabled. Config in [vitest.config.ts](vitest.config.ts).

Test coverage includes: JWT/JWKS auth, environment variable mapping, process management, R2 mounting, and backup sync logic.

## Local Development

**Setup:** Create `.dev.vars` from `.dev.vars.example` with `ANTHROPIC_API_KEY` and `DEV_MODE=true`. Run `npm run start` for local worker.

**Limitations:**

- `wrangler dev` has issues proxying WebSocket connections through sandbox. HTTP works but WebSocket may fail intermittently.
- R2 mounting doesn't work locally (only in production deployments).
- Containers not fully supported on Windows (`wrangler.jsonc` sets `dev.enable_containers: false`).
- For full functionality testing, deploy to Cloudflare Workers instead of local dev.

## R2 Storage Gotchas

- **Production only:** R2 mounting only works in deployed workers, NOT with `wrangler dev`.
- Use `rsync -r --no-times` (s3fs doesn't support setting timestamps).
- Check mount status with `mount | grep s3fs`, not `mountBucket()` error messages.
- `/data/moltbot` IS the R2 bucket — `rm -rf` there deletes backup data.
- `proc.status` may not update immediately; verify success via expected output instead.
- Backup structure: `$BACKUP_DIR/clawdbot/` for config, `$BACKUP_DIR/skills/` for skills, `$BACKUP_DIR/.last-sync` for timestamp.

## Moltbot Config Gotchas

- `agents.defaults.model` must be `{ "primary": "model/name" }`, not a string.
- `gateway.mode` must be `"local"` for headless operation.
- No `webchat` channel — Control UI is served automatically.
- Use `--bind` CLI flag, not `gateway.bind` config option.
- See [Moltbot docs](https://docs.molt.bot/gateway/configuration) for full config schema.

## Adding New Functionality

**New API endpoint:** Add handler in `src/routes/api.ts` → types in `src/types.ts` → client API in `src/client/api.ts` → tests.

**New environment variable:** Add to `MoltbotEnv` in `src/types.ts` → add to `buildEnvVars()` in `src/gateway/env.ts` → update `.dev.vars.example` → document in README.md.

## Deployment & Debugging

**Deploy:** `npm run deploy` (builds + deploys to Cloudflare)

**View logs:** `npx wrangler tail` (live production logs)

**Check secrets:** `npx wrangler secret list`

**Troubleshooting:**

- First request takes 1-2 minutes (cold start)
- Config changes need Docker cache bust (bump version comment in Dockerfile)
- WebSocket issues in local dev are expected (deploy to test)
- Device list API takes 10-15s due to CLI WebSocket overhead
- R2 mount issues: verify all 3 secrets set (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CF_ACCOUNT_ID`)

## Contributing

- Issues first for non-trivial changes.
- All AI usage must be disclosed with tool name and extent.
- AI-created PRs must reference accepted issues and be human-verified.
