# Mini Planet dashboard contract

Mini Planet은 Hermes 팀을 **관찰하는 공개 대시보드**다. 정체성 원문을
편집하거나 Hermes에 직접 명령하는 관리 콘솔이 아니다. 브라우저는 맥미니의
읽기 전용 브리지가 허용 목록으로 정리한 데이터만 받는다.

## 공개 투영 원칙

공개해도 되는 항목:

- 에이전트 id, 표시 이름, 이모지, 정체성 한두 문장 요약
- 사람이 검토한 말투·가치·행동 습관·관계 요약과 개인 결과공간 이름
- 공개 역할, 핵심 책임, 대표 채널, 자율 범위
- 현재 상태, 공개 가능한 작업 제목, 진행률, 최근 결과 링크
- 모델·제공자 별칭, 런타임 헬스, 위험도, 승인 상태, 한 줄 블로커
- 공개용 task 관계, 출처 링크, 아티팩트 링크, 감사 이벤트

브라우저로 보내지 않는 항목:

- 전체 `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md` 내용
- 로컬 `profile_home`, 절대 경로, 세션 원문, 사용자 메모리
- 프롬프트, 사고 과정, 터미널 출력, 도구 인수와 원본 로그
- API 키, 쿠키, 승인 토큰, 비공개 저장소 주소
- 공개 정책이 정해지지 않은 비용·개인 정보·원문 아티팩트

`config/agents.json`은 위 원칙에 맞춘 정적 공개 프로필이다. 실제 SOUL과
실행 계약의 원천은 맥미니의 Hermes 프로필에 남는다.

## Source of truth

| 데이터 | 원천 | 공개 방식 |
| --- | --- | --- |
| 이름·색·역할 요약 | `profile.yaml` + 공개 로스터 | `config/agents.json` |
| 정체성 | `SOUL.md` | 사람이 검토한 요약 필드만 (`identitySummary`, `voiceTraits`, `values`, `mannerisms`, `relationshipSummary`) |
| 역할·경계·핸드오프 | `AGENTS.md` / team registry | 공개 책임·자율 범위만 |
| 사용자 선호·기억 | `USER.md` / memory / wiki | 기본 비공개, 필요 시 출처만 |
| 현재 실행 상태 | gateway / session / run API | bridge snapshot |
| 작업 관계 | kanban / run metadata | 공개 task projection |
| 일정·자동화 | cron / queue | 헬스와 공개 작업명만 |
| 결과물 | artifact registry | 안전한 제목·요약·URL만. 에이전트별 집의 `최근 결과` 탭에 표시 |

브리지는 요청마다 Markdown을 다시 파싱하지 않는다. 프로필 변경 시 정규화한
읽기 전용 인덱스를 갱신하고, snapshot/SSE는 그 인덱스와 런타임 상태를 합친다.
`resultSpace`는 공개 UI의 공간 이름과 설명만 담는 정적 메타데이터다. 결과 원문,
로컬 경로, 비공개 아티팩트를 직접 가리키는 우회 통로로 사용하지 않는다.

## v2 snapshot envelope

기존 top-level map과 v1 `agents` envelope는 계속 지원한다. v2는 향후
Task Graph, Approval Inbox, Runtime Health 화면을 한 응답으로 제공한다.

```json
{
  "schemaVersion": 2,
  "generatedAt": "2026-07-11T09:30:00+09:00",
  "source": "hermes-bridge",
  "team": {
    "id": "rodi-team",
    "orchestrator": "rodi",
    "health": "healthy"
  },
  "agents": {
    "yul": {
      "state": "작업 중",
      "task": "Mini Planet 상태 카드 구현",
      "progress": 0.72,
      "runId": "run_public_alias",
      "updatedAt": "2026-07-11T09:29:00+09:00",
      "runtime": {
        "health": "healthy",
        "model": "public-model-alias",
        "provider": "provider-alias",
        "riskLevel": "L2",
        "approvalState": "not_required",
        "blocker": "",
        "currentTaskId": "task_dashboard_card",
        "lastActivityAt": "2026-07-11T09:29:00+09:00",
        "cost": { "amount": 0.0184, "currency": "USD" }
      },
      "result": {
        "kind": "commit",
        "title": "상태 카드 구현",
        "summary": "검증 대기 중",
        "url": "/results/task_dashboard_card.html",
        "updatedAt": "2026-07-11T09:28:00+09:00"
      },
      "results": [
        {
          "id": "result_dashboard_card",
          "kind": "build",
          "status": "review",
          "title": "상태 카드 구현",
          "summary": "검증 대기 중",
          "url": "/results/task_dashboard_card.html",
          "updatedAt": "2026-07-11T09:28:00+09:00"
        }
      ]
    }
  },
  "tasks": [],
  "approvals": [],
  "runtime": {},
  "knowledge": {},
  "audit": []
}
```

현재 Mini Planet UI는 v2의 `agents.*.runtime`, `agents.*.result`,
`agents.*.results`, `tasks`, `approvals`를 표시한다. `result`는 집 결과공간의
첫 카드이고, `results[]`와 정적 `agent-results.json`이 남은 칸을 채운다.
팀 흐름 패널은 공개 관찰용이라 승인·거절·실행 버튼을 제공하지 않는다.
`knowledge`와 `audit` 컬렉션은 보존·공개 정책을 확정한 뒤 별도 화면으로 연다.
알 수 없는 필드와 등록되지 않은 에이전트 id는 무시한다.

### Agent runtime

| 필드 | 형식 | 규칙 |
| --- | --- | --- |
| `health` | enum | `healthy/degraded/error/offline` |
| `model` | string | 공개 별칭, 최대 80자 |
| `provider` | string | 공개 별칭, 최대 40자 |
| `riskLevel` | enum | `L1/L2/L3/L4` |
| `approvalState` | enum | `not_required/pending/approved/rejected` |
| `blocker` | string | 민감 정보 없는 한 줄, 최대 160자 |
| `currentTaskId` | string | task의 공개 id, 최대 120자 |
| `lastActivityAt` | ISO 8601 | 카드의 상대 시각 기준 |
| `cost` | object | 선택. `amount >= 0`, `currency` 최대 8자 |

런타임 필드는 `runtime` 객체를 권장한다. 이전 브리지와의 호환을 위해 UI는
같은 필드가 agent 레코드에 평평하게 들어온 경우도 읽는다.

### Agent result projection

| 필드 | 형식 | 규칙 |
| --- | --- | --- |
| `id` | string | 공개 안정 id, 최대 120자. 중복 제거 기준 |
| `kind` | enum | `briefing/decision/operations/build/verification/content/research/report/commit/image/link/artifact` |
| `status` | enum | `ready/review/draft/live` |
| `title` | string | 필수, 최대 80자 |
| `summary` | string | 선택, 최대 180자 |
| `updatedAt` | ISO 8601 | 결과 카드 날짜 |
| `url` | string | 선택, 공개 가능한 http(s) 또는 상대 링크 |

`result`는 현재 결과 하나, `results[]`는 최신순 공개 이력(최대 6개)이다.
브라우저는 현재 결과 → 라이브 이력 → 정적 fallback 순으로 합치고 `id` 중복을
제거한다. 공개 사이트에서는 인증 정보가 든 URL과 localhost·사설망 URL을
링크로 만들지 않는다.

## Task projection

```json
{
  "id": "task_dashboard_card",
  "title": "에이전트 상태 카드 구현",
  "ownerAgent": "yul",
  "requester": "rodi",
  "status": "verifying",
  "parentIds": ["task_dashboard"],
  "dependencyIds": [],
  "riskLevel": "L2",
  "approvalState": "not_required",
  "verifier": "ludwig",
  "artifactLinks": ["/results/task_dashboard_card.html"],
  "sourceLinks": [],
  "startedAt": "2026-07-11T09:10:00+09:00",
  "updatedAt": "2026-07-11T09:28:00+09:00",
  "completedAt": null
}
```

권장 status는
`queued/running/blocked/waiting_approval/verifying/completed/failed/cancelled`다.
Task Graph는 `parentIds`와 `dependencyIds`만으로 그릴 수 있어야 하며,
원본 프롬프트나 내부 run id를 요구하지 않는다.

## Approval projection

```json
{
  "id": "approval_public_post",
  "taskId": "task_campaign_publish",
  "requestedBy": "rodi",
  "riskLevel": "L4",
  "status": "pending",
  "actionSummary": "검토된 캠페인 결과를 외부 채널에 게시",
  "impactSummary": "공개 게시물 1건 생성",
  "rollbackSummary": "게시물 삭제 가능, 외부 확산은 회수 불가",
  "requestedAt": "2026-07-11T09:25:00+09:00"
}
```

공개 Mini Planet은 승인 상태만 보여준다. 실제 승인·거절 요청은 인증된 별도
관리 화면에서 처리해야 하며 공개 snapshot의 id를 승인 토큰으로 사용하면 안 된다.

## Team handoff contract

- Argos 조사 → Rodi 통합
- Yul 구현 → Ludwig 검증 → Rodi 보고
- Anne 콘텐츠 → Ludwig 공개 검토 → Rodi 전달
- Jarvis 운영 브리핑 → Rodi 조율 또는 한들 보고

Ludwig는 검증 결과를 만들지만 구현 파일을 직접 수정하지 않는다. Argos는 외부
지식의 입구지만 시스템 운영 모니터링은 Jarvis/Yul의 책임이다. Jarvis와 Yul은
웹 조사 크롤러로 사용하지 않는다.

## Risk and approval

| 단계 | 의미 | 기본 처리 |
| --- | --- | --- |
| L1 | 읽기·정리·검증 | 역할 범위 안에서 자율 |
| L2 | 되돌릴 수 있는 내부 변경 | 기록과 검증을 남기고 자율 |
| L3 | 범위가 명확한 실행 | 계약된 경계 안에서 자율 |
| L4 | 외부 영향 또는 비가역 작업 | 한들의 명시적 승인 전 대기 |

외부 발송·게시, 결제, 권한 변경, 비가역 삭제는 항상 L4다. Rodi는 승인을
우회하지 않고 Approval Inbox로 라우팅한다.

## 화면 단계

1. **현재 — Agent Detail:** 공개 정체성, 역할, 책임, 채널, 자율 범위,
   상태, 결과, 런타임 헬스와 승인 대기 표시.
2. **현재 — Team Flow:** Team Overview, 역할별 handoff routes, task projection,
   L4 Approval Inbox를 읽기 전용으로 표시. 브리지 전에는 안전한 빈 상태를 사용.
3. **다음 — Runtime Health / Knowledge / Audit:** 인증·보존 기간·비용 공개
   정책을 정한 뒤 추가.

SOUL이나 AGENTS를 웹에서 편집하는 기능은 초기 버전에 넣지 않는다. 나중에
필요해도 diff, 백업, 명시적 승인, 감사 기록이 모두 있는 별도 관리 기능으로 만든다.
