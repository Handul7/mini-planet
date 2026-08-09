# Hermes Agent integration boundary

Mini Planet은 Hermes 연동을 받을 준비가 된 공개 observer지만 기본 배포는
**정적 데모이며 아직 Hermes에 연결되지 않았다**. Hermes bearer와 raw 운영 데이터는
브라우저에 절대 전달하지 않는다.

## Architecture

```text
[Private Mac mini]
Hermes profiles / gateways / Kanban / runs / logs
                  |
                  | raw object 전달 금지
                  v
Private public-projection bridge
- deny-by-default allowlist serializer
- private profile key -> public agent key alias registry
- publication review / freshness / provenance
- rate limit / timeout / output cap / audit
                  |
                  | same-origin read-only HTTPS DTO
                  v
[Public Mini Planet]
/api/agents/snapshot or /api/agents/events
```

`config/runtime.json`을 Hermes loopback API에 직접 연결하거나 bearer를 JavaScript,
공개 JSON, EventSource URL에 넣지 않는다. Hermes API는 terminal과 file tool을
사용할 수 있으므로 public browser와 같은 신뢰 영역에 둘 수 없다.

## Private profile setup

여섯 agent는 Mac mini에서 각자 독립 Hermes profile을 가진다. profile마다 config,
environment, SOUL, session, memory, skills, cron, gateway state를 분리한다. Profile
isolation은 filesystem sandbox가 아니므로 OS/container 정책은 별도로 적용한다.

| Public Mini Planet | Private Hermes |
| --- | --- |
| public agent `key` | private alias registry를 통해 profile key에 매핑 |
| role/responsibility summary | owner-reviewed profile description |
| public identity summary | full private `SOUL.md`에서 별도 출판 |
| public autonomy summary | private `AGENTS.md` 실행 계약에서 별도 출판 |
| home/result metadata | public artifact registry projection |

Public repository에 profile key, absolute path, local port, Discord ID/channel,
gateway nickname을 기록하지 않는다. `config/agents.json`의 짧은 설명을 이용해
full SOUL을 역생성하지 않는다.

각 profile API는 loopback 전용 host, 서로 다른 private port, 서로 다른 secret을
사용한다. Bridge만 capabilities, detailed health, run state를 읽는다. Public Mini
Planet은 run/stop/approve endpoint를 갖지 않는다.

## Serializer rules

Serializer는 raw object를 복사한 뒤 지우지 않는다. 빈 DTO에서 허용 필드를
하나씩 작성한다.

```js
const output = {
  publicTask: publication.publicTask,
  state: mapCoarseState(privateRun.state),
  progress: clampProgress(privateRun.progress),
};
```

다음 필드가 input 어디에 있더라도 output에는 없어야 한다.

- prompt, tool args/results, terminal output, logs, comments, transcript, memory
- email, phone, Discord/user/channel/guild ID
- absolute path, local endpoint/port, profile/config values
- exact provider/model/fallback, token/cost/billing
- internal run/session/task/approval ID와 credential-bearing URL

Task와 approval free text는 raw title을 자르는 방식이 아니라 별도
`publicTitle`, `publicActionSummary`, `publicImpactSummary`, `publicRollbackSummary`가
승인된 경우에만 출판한다. 자세한 DTO는
[`dashboard-contract.md`](dashboard-contract.md)를 따른다.

## Freshness and provenance

모든 live snapshot/SSE event는 완전한 v2 envelope이며 다음을 포함한다.

```json
{
  "schemaVersion": 2,
  "publicationMode": "live",
  "source": "hermes-public-bridge",
  "sourceGeneratedAt": "2026-07-29T09:12:00+09:00",
  "bridgeObservedAt": "2026-07-29T09:12:05+09:00",
  "expiresAt": "2026-07-29T09:15:05+09:00",
  "isStale": false,
  "provenance": {
    "verificationState": "verified",
    "evidenceDigest": "sha256:public-evidence-digest"
  },
  "agents": {},
  "tasks": [],
  "approvals": []
}
```

Transport, gateway, profile, agent run, task outcome, verification health는 서로 다른
명제다. 하나의 green `healthy`로 합치지 않는다. TTL을 넘거나 freshness 필드가
빠지면 Mini Planet은 기존 상태를 유지하지 않고 `상태 미확인`으로 강등한다.

## Runtime switch

Bridge가 security gate를 통과하기 전에는 이 값을 유지한다.

```json
{
  "publication": {
    "mode": "static-demo",
    "label": "정적 데모",
    "notice": "Hermes 미연결 · 상태와 결과는 공개용 샘플입니다."
  }
}
```

Bridge를 same-origin HTTPS로 배치하고 아래 검증을 마친 뒤에만 전환한다.

```json
{
  "publication": {
    "mode": "live",
    "label": "공개 상태",
    "notice": "검증된 공개 snapshot을 표시합니다."
  },
  "status": {
    "mode": "poll",
    "snapshotUrl": "/api/agents/snapshot",
    "eventUrl": "",
    "pollMs": 60000,
    "freshnessTtlMs": 180000,
    "maxSnapshotChars": 262144
  }
}
```

초기 prototype은 poll-only와 coarse six-agent state, curated result만 사용한다.
SSE는 auth, abuse control, reconnect, output cap이 검증된 뒤 선택적으로 켠다.
Browser transport는 same-origin endpoint만 허용하며 SSE가 실패하면 polling으로
돌아간다.

## Release gates

P0, live 연결 전:

1. private alias registry와 deny-by-default serializer
2. forbidden-field negative fixtures와 malformed/future-schema fail-closed test
3. freshness/TTL/stale/provenance test
4. same-origin HTTPS, CORS, auth boundary, rate limit, timeout, output cap
5. public task/result publication 및 removal policy
6. public dashboard와 authenticated admin/approval surface 완전 분리

P1, 제한된 prototype:

1. six-agent coarse state와 curated result만 poll로 연결
2. profile/gateway/transport/run/task/verification health 분리
3. desktop/mobile와 no-WebGL fallback 검증
4. secret/public-artifact scan과 rollback rehearsal

P2, public beta:

1. CSP와 third-party module supply-chain 강화
2. Dependabot 기반 GitHub Actions SHA 갱신 검토와 release/rollback runbook
3. abuse control 확인 후 SSE 검토

## Rollback

Live 상태가 잘못되면 `config/runtime.json`의 publication을 `static-demo`로 되돌리고
snapshot/event URL을 정적 파일로 복원한다. Bridge public route를 차단하고 CDN/PWA
cache를 purge한 뒤 incident 범위를 확인한다. Hermes profile secret rotation은
public rollback과 분리해서 수행한다.

## Official references

- [Hermes API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/)
- [Programmatic Integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
- [Profiles: Running Multiple Agents](https://hermes-agent.nousresearch.com/docs/user-guide/profiles/)
- [Use SOUL.md with Hermes](https://hermes-agent.nousresearch.com/docs/guides/use-soul-with-hermes)
