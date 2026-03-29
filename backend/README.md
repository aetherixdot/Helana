# Website Intelligence Backend

## Local Infrastructure (Docker, PostgreSQL + Redis)

### 1. Start local infrastructure

```bash
docker compose up -d
```

### 2. Verify container is running

```bash
docker ps
```

Expected container names: `archintel_postgres`, `archintel_redis`.

### 3. Connect with psql inside container

```bash
docker exec -it archintel_postgres psql -U archintel_user -d archintel_db
```

### 4. Verify/enable extensions manually (post-startup)

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
\dx
```

The container also auto-runs extension init from `docker/postgres/init/01_extensions.sql` on first boot.

### 5. Prisma setup against Docker PostgreSQL

```bash
npm install
npm run prisma:generate
npx prisma migrate dev --name init
```

For existing migrations in this repo (recommended):

```bash
npm run db:prepare
```

`db:prepare` runs:
1. Prisma client generation
2. Prisma migration deploy
3. DB bootstrap (`pgcrypto` + `vector` extension ensure)

### 6. Confirm Prisma/backend DB connectivity

```bash
npx prisma db pull
npm run dev
```

If your environment blocks multi-process spawns (`EPERM`), use:

```bash
npm run dev:full
```

This no-spawn mode runs API + workers in one watch process for local development.

Health check:

```bash
curl http://localhost:4000/api/v1/health
```

## Environment

`DATABASE_URL` in `.env` is Prisma-compatible:

```env
HOST=127.0.0.1
REQUIRE_API_GATEWAY_KEY=true
API_GATEWAY_KEY=<strong-random-secret>
ALLOW_PRIVATE_TARGETS=false
N8N_STRICT_CONTRACT=true
N8N_HMAC_SECRET=<strong-random-secret>
DATABASE_URL=postgresql://archintel_user:ChangeMe_Strong_Local_Password_2026@localhost:5432/archintel_db?schema=public
SHADOW_DATABASE_URL=postgresql://archintel_user:ChangeMe_Strong_Local_Password_2026@localhost:5432/archintel_shadow?schema=shadow
REDIS_URL=redis://localhost:6379
JWT_SECRET=replace_with_at_least_32_characters_master_jwt_secret_here
```

This format is compatible with Supabase/Neon migration later by swapping host/credentials only, with no schema changes required.

## Open-Source Manager LLM (CEO Copilot)

Reex supports OpenAI-compatible open-source model servers (Ollama, vLLM, TGI gateway, LM Studio gateway).

Configure `.env`:

```env
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://127.0.0.1:8001/v1
LLM_API_KEY=not-configured
LLM_MODEL=Qwen/Qwen3-8B
LLM_FALLBACK_MODELS=Qwen/Qwen2.5-7B-Instruct
LLM_MANAGER_ENABLED=true
LLM_MANAGER_MODEL=Qwen/Qwen3-8B
```

Notes:
1. If your local server needs no auth (example: Ollama), keep `LLM_API_KEY=not-configured`.
2. `LLM_FALLBACK_MODELS` is tried in order when primary model fails.
3. `POST /api/v1/intelligence/chat/stream` now uses manager LLM first and deterministic fallback if unavailable.
4. Market orchestration routes use Python sidecar endpoints secured by `SIDECAR_AUTH_TOKEN`.

### Helena training dataset exports

```bash
npm run export:manager-dataset
npm run export:manager-dpo-dataset
npm run export:forecast-dataset
```

### Helena rollout promotion gate

```bash
npm run gate:helena-rollout
```

This command evaluates `training/rollout-gates/metrics-history.jsonl` and blocks promotion when confidence/relevance deltas or success-rate thresholds are not met.

CI enforcement is available via GitHub Actions workflow `.github/workflows/helena-rollout-gate.yml` and can be required from deployment workflows using `workflow_call`.

Repository-level gated deployment entrypoint: `.github/workflows/deploy-gated.yml`.
This workflow blocks release until Helena rollout gate, backend verification, and frontend verification all pass.

Prisma migration troubleshooting:
1. If `prisma generate` fails with `query_engine-windows.dll.node (EPERM)`, stop running backend/frontend Node dev processes and retry.
2. If historical migrations hit `type "vector" does not exist`, ensure `vector` extension exists in both main and shadow databases before migration commands.

## Production Security Baseline

The backend now enforces fail-fast production checks for these controls:

1. Private bind only (`HOST` cannot be `0.0.0.0` in production).
2. Strong gateway auth (`REQUIRE_API_GATEWAY_KEY=true` + `x-api-key` on API and socket handshake).
3. Strict n8n webhook contract and auth (`N8N_STRICT_CONTRACT=true`, bearer + workflow token + HMAC signature).
4. No placeholder secrets in production (`JWT_*`, integration API keys, gateway key, n8n secrets).
5. Least privilege boundary (integration credentials must be distinct per integration).
6. Prompt-injection guard enabled for all LLM-bound payloads.
7. Unsafe URL target blocking (`ALLOW_PRIVATE_TARGETS=false` to reduce SSRF risk).

Recommended operational policy:

1. Rotate all secrets immediately on suspected exposure.
2. Keep `.env` out of source control (already excluded via `.gitignore`).
3. Review logs continuously for denied auth, prompt-guard sanitization, and n8n contract failures.
4. Patch dependencies on a fixed cadence (weekly security updates, monthly full dependency review).
5. Rebuild and redeploy containers after each security update.

## API Notes

- Health endpoint: `GET /api/v1/health`
- Queue orchestration endpoint: `POST /api/v1/projects/:projectId/analyze`
  - Body: `{ "url": "https://example.com", "rawHtml": "<html>...</html>", "metadata": {} }`
- Snapshot-based enqueue endpoint: `POST /api/v1/projects/:projectId/snapshots/:snapshotId/analyze`

WebSocket events are emitted to authenticated `user:{userId}` rooms:
- `analysis_started`
- `analysis_completed`
- `analysis_failed`

## Strict n8n Contract (Hard-Fail Quality Gate)

Set in `.env`:

```env
N8N_STRICT_CONTRACT=true
```

When enabled:
- n8n payload must include structured `tech_stack`, `revenue_strategy`, `architecture_plan`, `overall_health_score`, and `health_color`.
- weak placeholder payloads are rejected.
- analysis job fails instead of silently falling back.

Use `false` for permissive local testing.

## Trigger Analyze Smoke Test

Run API/workers and then:

```bash
npm run smoke:analyze -- https://react.dev
```

This script will:
1. Login/signup demo user
2. Create/find a project
3. Call `POST /api/v1/projects/:id/analyze`
4. Poll scan status until `completed` or `failed`
