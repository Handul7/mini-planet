# Hermes Agent integration boundary

Mini Planet is prepared for Hermes, but it is **not connected yet**. The final
connection belongs on the Mac mini after the public site and agent profiles are
ready. This keeps the static site deployable to GitHub Pages and prevents a
Hermes bearer key from ever reaching browser code.

## Architecture decision

```text
public browser
  └─ GET /api/agents/snapshot  or  /api/agents/events (read-only, sanitized)
       └─ Mini Planet bridge on the Mac mini
            ├─ GET /v1/capabilities and /health/detailed
            └─ Hermes profile APIs on 127.0.0.1 (Bearer key stays here)
```

Do **not** point `config/runtime.json` at `http://127.0.0.1:8642` and do not put
`API_SERVER_KEY` in JavaScript, JSON shipped with the site, GitHub secrets used
at build time, or an `EventSource` URL. Hermes documents that its API grants the
agent's full toolset, including terminal and file operations.

The bridge is intentionally small. It discovers supported Hermes features from
`GET /v1/capabilities`, monitors `GET /health/detailed`, reads run state from
`GET /v1/runs/{run_id}` or its SSE stream, and emits only the public contract
below. Raw prompts, tool arguments, terminal output, memory, approvals, and API
keys never pass through it.

## Hermes profiles: one agent, one isolated state directory

Hermes profiles are the right mapping for the six Mini Planet agents. Each
profile has its own config, environment, `SOUL.md`, sessions, memory, skills,
cron jobs, and gateway state.

| Mini Planet input | Hermes destination |
| --- | --- |
| `config/agents.json` `key` | stable profile id and bridge mapping key |
| role / responsibility | `hermes profile create <key> --description "..."` |
| durable identity, voice, temperament | profile `SOUL.md` |
| repo rules, paths, commands, workflow | project `AGENTS.md` |
| permitted starting workspace | explicit absolute `terminal.cwd` |

Profiles isolate state, **not filesystem access**. `terminal.cwd` makes the
starting folder predictable but is not a sandbox. Apply OS/container policy
separately if an agent needs a real access boundary. Start a new session after
changing `SOUL.md` so the identity is reloaded cleanly.

The public role map, handoffs, and safety boundaries are now normalized in
`config/agents.json` from the Rodi Team blueprint. That file is a public
projection, not a replacement for the complete Hermes profile sources. Create
or update the six real profiles on the Mac mini only after the owner-reviewed
`SOUL.md` and `AGENTS.md` files are present there. Never reconstruct a full
SOUL by expanding the short website summary.

## Mac mini API setup (later)

For each profile, use a unique loopback port and secret in that profile's
`.env`. Example only:

```dotenv
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8643
API_SERVER_KEY=replace-with-a-long-random-secret
```

Start the profile gateway, then let the bridge verify:

```text
GET http://127.0.0.1:8643/v1/capabilities
GET http://127.0.0.1:8643/health/detailed
```

The official API also provides `POST /v1/runs`, run status, run-event SSE,
stop, and approval endpoints. Mini Planet's public page should remain a
read-only observer. Any future run submission or approval UI needs separate
authentication and must not share the public status endpoint.

## Public snapshot contract

The original top-level JSON remains supported without schema changes:

```json
{
  "rodi": {
    "state": "작업 중",
    "task": "주간 브리핑 통합",
    "updatedAt": "2026-07-11T09:30:00+09:00"
  }
}
```

The prepared v1 envelope adds progress, run correlation, a safe current result,
and optional recent history while remaining backward-compatible:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-11T09:30:00+09:00",
  "source": "hermes-bridge",
  "agents": {
    "rodi": {
      "state": "작업 중",
      "task": "주간 브리핑 통합",
      "progress": 0.65,
      "runId": "run_abc123",
      "updatedAt": "2026-07-11T09:30:00+09:00",
      "result": {
        "kind": "report",
        "title": "주간 브리핑 초안",
        "summary": "검증 대기 중인 핵심 결과 4건",
        "url": "/results/weekly-briefing.html",
        "updatedAt": "2026-07-11T09:29:00+09:00"
      },
      "results": [
        {
          "id": "briefing_2026_w28",
          "kind": "briefing",
          "status": "review",
          "title": "주간 브리핑 초안",
          "summary": "검증 대기 중인 핵심 결과 4건",
          "url": "/results/weekly-briefing.html",
          "updatedAt": "2026-07-11T09:29:00+09:00"
        }
      ]
    }
  }
}
```

The dashboard also accepts the public-safe `runtime` projection planned for
the v2 envelope. These fields appear only when the bridge supplies them:

```json
{
  "schemaVersion": 2,
  "agents": {
    "yul": {
      "state": "작업 중",
      "task": "상태 카드 구현",
      "runtime": {
        "health": "healthy",
        "model": "public-model-alias",
        "provider": "provider-alias",
        "riskLevel": "L2",
        "approvalState": "not_required",
        "blocker": "",
        "currentTaskId": "task_dashboard_card",
        "lastActivityAt": "2026-07-11T09:29:00+09:00"
      }
    }
  },
  "tasks": [],
  "approvals": []
}
```

The read-only Team Flow panel now renders sanitized task and pending-approval
projections, with static handoff routes and safe empty states before the bridge
is live. Knowledge and audit projections remain intentionally hidden until
their retention and public-disclosure policies are defined. The normalized
schemas and privacy allowlist are in [`dashboard-contract.md`](dashboard-contract.md).

Contract rules:

- Only keys from `config/agents.json` are accepted by the UI.
- `state` is at most 16 characters; `task` 80; result title 80; summary 180.
- `result` is the current singleton; `results[]` is newest-first public history,
  capped at six cards per home. Duplicate public ids are removed.
- `progress` is a number from `0` to `1`.
- Result links must be relative or `https://`/`http://`; browser-unsafe schemes,
  credentials, and public-to-private-network links are discarded.
- Runtime fields are allowlisted and length-limited; full SOUL, memory, prompts,
  tool arguments, terminal output, secrets, and local profile paths are forbidden.
- Every SSE payload is a **complete snapshot**, sent either as a default
  `message` or a named `snapshot` event.
- On an SSE failure, the client polls `snapshotUrl` and periodically reconnects.

Suggested bridge state mapping:

| Hermes run state | Mini Planet `state` |
| --- | --- |
| queued / idle | 대기 중 |
| started / running | 작업 중 |
| waiting for approval / review | 검증 중 |
| completed | 완료 |
| failed / cancelled unexpectedly | 오류 |

## Runtime switch

Keep the repository default in static polling mode. After the bridge is live,
change only `config/runtime.json`:

```json
{
  "status": {
    "mode": "sse",
    "snapshotUrl": "/api/agents/snapshot",
    "eventUrl": "/api/agents/events",
    "pollMs": 60000,
    "reconnectMs": 15000
  },
  "results": {
    "snapshotUrl": "agent-results.json"
  }
}
```

Live `results[]` should normally travel inside the complete status snapshot/SSE
payload. `results.snapshotUrl` is a reload-time curated fallback, useful for a
static GitHub Pages deployment; it is not a second realtime channel.

Serve the site and bridge from one HTTPS origin when possible. A GitHub Pages
site cannot safely call a private Mac-mini loopback address; use an authenticated
public HTTPS reverse proxy/tunnel or host Mini Planet behind the Mac mini's
reverse proxy. Keep the public endpoints read-only, rate-limited, output-sized,
and stripped of secrets. For file snapshots, write to a temporary file and
rename atomically.

## Deployment checklist

1. Put the owner-reviewed full SOUL, project rules, and workspace settings on the Mac mini.
2. Create one Hermes profile per key; assign unique API ports and secrets.
3. Confirm `/v1/capabilities` before relying on runs or SSE features.
4. Implement the bridge allowlist and v1/v2 snapshot serializers, including
   current `result` and newest-first `results[]` public projections.
5. Test legacy poll, v1/v2 poll, SSE reconnect, malformed payloads, and stale runs.
6. Put the site and bridge behind HTTPS; expose no Hermes API port publicly.
7. Switch `runtime.json`, then verify all six cards, progress, results, and homes.

## Official references

- [Hermes API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/)
- [Programmatic Integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
- [Profiles: Running Multiple Agents](https://hermes-agent.nousresearch.com/docs/user-guide/profiles/)
- [Use SOUL.md with Hermes](https://hermes-agent.nousresearch.com/docs/guides/use-soul-with-hermes)
