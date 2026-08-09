# Mini Planet public dashboard contract

Mini Planet은 Hermes 팀을 관찰하는 공개 대시보드다. Hermes에 명령하거나
승인하는 관리 콘솔이 아니며, 브라우저는 private bridge가 새로 만든 공개 DTO만
받는다. raw Hermes/Kanban 객체를 줄이거나 그대로 직렬화하지 않는다.

## Publication modes

| mode | 의미 | UI 표시 |
| --- | --- | --- |
| `static-demo` | Hermes 미연결, 사람이 검토한 샘플 | `정적 데모 · Hermes 미연결` |
| `live` | private bridge가 생성한 유효한 공개 snapshot | transport와 freshness에 따라 `실시간/주기 확인/상태 만료` |

저장소 기본값은 `static-demo`다. `live`로 바꾸려면 bridge, negative test,
TTL, rate limit, rollback 검증을 먼저 통과해야 한다.

## Public/private boundary

공개 후보:

- public agent key, 표시 이름, 역할·정체성의 human-reviewed 요약
- `idle/working/blocked/offline`에 해당하는 coarse state
- `publicTask`, `publicBlocker`처럼 별도로 승인된 짧은 문구
- 진행률, 공개 위험도·승인 상태, coarse model family
- 공개 검증 상태, 검증 시각, 비식별 evidence digest
- 공개 안정 ID와 공개 URL을 가진 curated result

항상 비공개:

- prompt, tool args/results, terminal output, logs, comments, transcript, memory
- Discord/user/channel/guild ID, email, phone, requester identity
- absolute path, profile/config, endpoint, local port
- provider의 정확한 model/fallback, token/cost/billing
- internal run/session/task/approval ID와 미공개 artifact URL

`config/agents.json`은 공개 프로필이다. 실제 SOUL, AGENTS, USER, memory,
profile key와 public key의 대응표는 Mac mini private 영역에만 둔다.

## v2 snapshot envelope

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
  "team": { "health": "healthy" },
  "agents": {
    "yul": {
      "state": "작업 중",
      "publicTask": "공개 상태 카드 개선",
      "progress": 0.72,
      "updatedAt": "2026-07-29T09:11:50+09:00",
      "runtime": {
        "health": "healthy",
        "modelFamily": "general-reasoning",
        "providerAlias": "hosted-model",
        "riskLevel": "L2",
        "approvalState": "not_required",
        "publicBlocker": "",
        "publicTaskId": "task-public-7f3a",
        "lastActivityAt": "2026-07-29T09:11:50+09:00",
        "verificationState": "pending"
      }
    }
  },
  "tasks": [],
  "approvals": []
}
```

Live snapshot은 네 freshness 필드를 모두 제공한다.

- `sourceGeneratedAt`: Hermes/Kanban 원천 상태 생성 시각
- `bridgeObservedAt`: bridge가 원천을 관측한 시각
- `expiresAt`: 상태를 live로 표시할 수 있는 마지막 시각
- `isStale`: bridge 자체의 stale 판정

하나라도 없거나 잘못됐거나 TTL을 넘으면 UI는 이전 값을 유지하지 않고 모든
live agent를 `상태 미확인`으로 강등한다. `static-demo`에는 live freshness를
적용하지 않고 샘플임을 명시한다. Legacy map과 v1은 정적 호환용으로만 남기며,
live publication은 v2만 허용한다. 미래 schema는 fail-closed로 거부한다.

## Agent status

| 필드 | 규칙 |
| --- | --- |
| `state` | `idle/working/blocked/offline` 계열 coarse state만 허용하고 UI label로 매핑 |
| `publicTask` | live에서 유일하게 허용되는 작업 문구, 최대 80자 |
| `progress` | `0..1` |
| `updatedAt` | ISO 8601 |
| `runtime.health` | `healthy/degraded/error/offline/unknown` |
| `runtime.modelFamily` | 정확한 model ID가 아닌 coarse family |
| `runtime.providerAlias` | 공개 검토된 제공자 별칭 |
| `runtime.publicBlocker` | 공개 승인된 한 줄 사유 |
| `runtime.publicTaskId` | internal ID와 무관한 opaque public ID |
| `runtime.verificationState` | `unverified/pending/verified/failed/not_applicable` |

Live mode에서는 `task`, `blocker`, `model`, `provider`, `currentTaskId`, `runId`,
`cost`를 읽지 않는다.

## Task projection

```json
{
  "publicId": "task-public-7f3a",
  "publicTitle": "에이전트 상태 카드 개선",
  "ownerAgent": "yul",
  "requesterAgent": "rodi",
  "status": "verifying",
  "publicParentIds": ["task-public-root"],
  "publicDependencyIds": [],
  "riskLevel": "L2",
  "approvalState": "not_required",
  "verifierAgent": "ludwig",
  "verificationState": "pending",
  "updatedAt": "2026-07-29T09:11:50+09:00"
}
```

v2 live에서는 `publicTitle`이 없으면 task 전체를 버린다. raw `title`, task body,
comments, thread, internal graph ID는 fallback으로 사용하지 않는다. 상태 enum은
`queued/running/blocked/waiting_approval/verifying/completed/failed/cancelled`다.

## Approval projection

```json
{
  "publicId": "approval-public-92be",
  "publicTaskId": "task-public-7f3a",
  "requestedByAgent": "rodi",
  "riskLevel": "L4",
  "status": "pending",
  "publicActionSummary": "검토된 결과를 공개 채널에 게시",
  "publicImpactSummary": "공개 게시물 1건 생성",
  "publicRollbackSummary": "게시물 삭제 가능, 외부 확산은 회수 불가",
  "requestedAt": "2026-07-29T09:10:00+09:00"
}
```

v2 live에서는 `publicActionSummary`가 없으면 approval 전체를 버린다. 공개 UI는
read-only이며 승인·거절·실행 버튼을 제공하지 않는다.

## Result projection

Live agent snapshot은 `publicResult/publicResults` 필드만 읽는다. 각 result는
`id/kind/status/title/summary/updatedAt/url`만 허용하며 agent별 최대 6개다.
URL은 공개 http(s) 또는 상대 주소만 허용하고 credentials, unsafe scheme,
public-to-private-network 링크를 버린다. Live bridge는 title과 summary가 공개
승인된 result DTO만 전달해야 한다.

## Automated gates

- six-agent key parity와 JSON/schema 검사
- 공개 설정의 local path, localhost URL, 내부 channel, credential scan
- status/result의 forbidden field-name scan
- payload size cap과 same-origin status endpoint
- future schema fail-closed, malformed snapshot, stale/TTL contract tests
- public task/approval 필수 필드와 cap test

이 검사는 browser-side 방어선이다. 핵심 보안 경계는 private bridge의
deny-by-default serializer와 publication workflow다.
