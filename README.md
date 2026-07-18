# 🌍 Handul Mini Planet — Interactive Hermes Village

A tiny low-poly 3D planet that doubles as a **living dashboard for the Hermes agent team**.
Six resonators from 《별의 공명자들》 stroll a cel-shaded miniature world with live weather;
click any of them and the camera glides over while their status card opens — and every
cottage is the **front door of one of Handul's services**.

Built with **Three.js / WebGL** — walk-on-a-sphere movement, toon shading with inked outlines,
and a pastel harbor palette. The public landing rhythm and on-demand paper UI were informed by
[messenger.abeto.co](https://messenger.abeto.co); all world assets, UI, and code are original.

## ✦ The team (별의 공명자들)

The six-person roster lives in [`config/agents.json`](config/agents.json) — edit that file to change
names, colors, roles, public persona notes, speech lines, or character visuals. No code changes
are needed as long as the six stable keys stay aligned across status/services/results. Full Hermes SOUL files stay private; this repository contains only concise,
human-reviewed public projections.

Each roster entry also owns a small `visual` profile. Its stable style enum, scale, cap,
and color options drive the Three.js character design; silhouette/tool/motif fields document
the art direction beside the role. This keeps appearance aligned without key-specific
rendering rules.

| Agent | 실제 역할 (SOUL) | 판타지 정체성 | 집 |
|-------|------------------|----------------|----|
| **Rodi** 로디 | 메인 오케스트레이터 | 별의 목소리를 잇는 조율자 | 마을 광장 (금빛) |
| **Jarvis** 자비스 | 운영 비서 | 시간의 흐름을 지키는 기계 올빼미 *(3D도 올빼미!)* | 마을 광장 (남청) |
| **Yul** 율 | 엔지니어 | 소리와 신호를 잇는 공명공학자 | 마을 광장 (청록) |
| **Ludwig** 루드비히 | 검증관 | 달빛의 공명학자 | 마을 광장 (보라) |
| **Anne** 앤 | 콘텐츠 크리에이터 | 향기를 세공하는 숲의 요정 | 마을 광장 (산호) |
| **Argos** 아르고스 | 리서처 · 관측자 | 백 개의 눈을 가진 파수꾼 | **행성 반대편 등대곶** (남보라) |

Each agent owns a cottage (marked by a flag in their color) and wanders near it,
chatting in role-flavored speech bubbles — and occasionally reporting their current task.
Argos, the watchman, keeps his distance: his home is the red-and-white lighthouse on the far cape.
Each home is also that agent's personal result space. The same door now opens service details
and up to six sanitized recent results without adding another central building.

## ✨ Features

- **Public homepage entrance** — the live 3D world remains visible behind a focused landing card;
  one primary CTA enters the village, while dashboard and edit tools stay secondary.
- **Visitor checklist + avatar color** — an on-demand paper panel teaches the three core interactions
  and remembers progress locally; a second tile lets visitors recolor their traveler without an account.
- **The planet is the dashboard** — a team bar lists all six agents with live states;
  clicking an agent (in 3D or on the bar) opens a status card with their role, fantasy
  identity, public SOUL summary, channel, autonomy boundary, core responsibilities, compact
  voice/value/home notes, and current task. Hermes runtime health, model alias, risk, approval, and blocker appear
  only when the safe bridge supplies them. The agent stops and turns to face you while you read.
- **Observation camera** — agent focus keeps the agent and their home in one unobstructed frame.
  An optional nine-second auto patrol visits all six agents; any direct camera or navigation input
  stops it immediately.
- **Read-only team flow** — the team bar opens a compact Team Overview with live metrics,
  role-based handoff routes, sanitized v2 tasks, and pending L4 approvals. Before Hermes is
  connected it shows quiet empty states; it never submits runs or approves actions.
- **Houses are services** — stand at any cottage door (prompt appears → `F` or tap) or
  click the house to open its **service / recent results panel**: description, online/offline check,
  "새 창에서 열기", an optional embedded live preview, and up to six public result cards.
  The house→service map is [`config/services.json`](config/services.json) — edit freely.
- **Live status data** — edit [`agent-status.json`](agent-status.json) and the planet
  updates (~1 min polling or the manual refresh button). The team bar shows the last successful
  check separately from the source timestamp, and its recent-results shortcut opens the newest
  agent home exhibition in one step. This is the Hermes integration point — see below.
- **You appear too** — walk the planet as 한들 with a follow camera, jump, and emoji reactions.
- **Edit mode** — rearrange the whole PLANET: every lake, bridge, forest tree
  and building is an editable object (only the pole rose stays put).
  Drag/rotate/scale/delete 20+ prop types (hand-built primitives plus bundled
  CC0 KayKit models — wells, windmills, watermills, lanterns, benches…; see
  [`assets/models/ATTRIBUTION.md`](assets/models/ATTRIBUTION.md)), draw
  spline-smoothed roads/rivers and free-form ponds/sand/grass, all auto-saved
  to `localStorage` with visible save feedback, undo/redo, restorable safety backups before reset/import,
  and versioned JSON export/import. Agent homes (flags, nameplates,
  service doors) follow the houses around.
- **Animated characters** — config-driven little people (and one owl) with swinging limbs,
  role-specific clothing silhouettes and tools, building/water collision, and obstacle avoidance.
  Live states add restrained role-specific motifs: Rodi conducts, Jarvis keeps time, Yul
  traces a circuit, Ludwig reviews proofs, Anne shapes petals, and Argos observes. Review,
  completion, and error states change the same motif instead of spawning permanent clutter.
- **Live weather (Open-Meteo)** — bright side shows **Seoul** weather, dark side **Rio**;
  cloud cover, day/night-aware rain streaks, wind-driven foliage/flags, and harbor motion
  reflect real conditions. WMO weather kinds keep snow/fog from masquerading as rain, and
  the opening frame starts at the correct local time instead of fading in from noon.
- **Opt-in procedural ambience** — the weather chip can enable softly synthesized waves,
  wind, rain, and a restrained completion chime. It fetches no audio files and starts muted
  on every visit; turning it off suspends audio rendering after the fade to save power.
- **A real night sky** — the moon renders with **today's actual lunar phase**
  (computed locally, no API), the sun and moon swap cleanly at dawn/dusk, and
  **Polaris** shines above the north pole where a Little Prince rose grows as
  the planet's fixed reference point.
- **Installable PWA** — network-first app updates plus cached local assets and
  runtime-cached Three.js modules for fast repeat loads. A first online load is
  still required before the 3D module can be available offline.

## 🎮 Controls

| Action | Desktop | Mobile |
|--------|---------|--------|
| Move | `W A S D` / Arrows (automatically enters Explore mode) | Virtual joystick |
| Jump | `Space` | — |
| Enter a house (service) | `F` at the door, or click the house | Tap the door prompt / house |
| Look / Zoom | Drag / Wheel | Drag / Pinch |
| Agent card | Click an agent or the team bar | Tap |
| Ambient sound | `♬` in the weather chip (muted by default) | Tap `♬` |
| Edit mode | Header `편집`, intro button, or `E` | Header `편집` or the pencil tile |

**Edit mode:** click to select, drag to move, `[` `]` rotate, `-` `=` scale,
`Ctrl+D`/⧉ duplicate, `Delete` remove, `Ctrl/⌘+Z` undo and `Ctrl/⌘+Shift+Z` redo
(30 steps; touch buttons included). The compact
editor dock separates **Objects** from **Paths & terrain**, keeps one prop
category open at a time, and can be collapsed while arranging the scene. Use its buttons to
add props (including 🌉 다리 — bridges carry their own walkable water
crossing), 도로/흙길/눈길/물길 buttons to draw spline-smoothed paths and
연못/모래밭/풀밭 to fill free-form shapes (click points, double-click or ✓ to
finish — ponds are swimmable water), 시점 presets (🏘️ 마을 / 🌹 북극),
⬇️/⬆️ for JSON export/import. Tip: open with `?dev=1` to skip the service
worker while developing (and get a small `devPlanet` console helper).

For deterministic atmosphere QA, development mode also accepts
`&weatherPreset=clear|cloudy|rain|storm`; `devPlanet.weatherState()`,
`devPlanet.ambientMotionState()`, and `devPlanet.audioState()` expose compact checks.

> Pond / sand fills triangulate radially from the outline's center, so they
> work best for convex or star-shaped outlines — strongly concave or
> self-crossing shapes may fill (and register water) imperfectly.

## ⚙️ Configuration (no code needed)

| File | What it controls |
|------|------------------|
| [`config/agents.json`](config/agents.json) | Public team projection: identity/voice/value summaries, role, responsibility, channel, permissions, handoffs, activity motif, config-driven character visual, home result-space metadata, color, speech |
| [`config/services.json`](config/services.json) | House→service map: name, description, url, icon, embedded preview on/off, run note |
| [`config/runtime.json`](config/runtime.json) | Status transport plus reload-time public result fallback URL |
| [`config/site.json`](config/site.json) | Public title, description, canonical URL, homepage link, GitHub link |
| [`agent-status.json`](agent-status.json) | **Live** states — the file Hermes (or anything else) keeps writing |
| [`agent-results.json`](agent-results.json) | Curated public result fallback for the six home exhibitions |

Rules of thumb: an agent's `key` ties all three files together; a service with an empty
`url` shows as **준비 중**; `embed: true` shows a live iframe preview (best for
`http://localhost:…` apps running on the same machine).

## 🤖 헤르메스 연동 (prepared, not connected yet)

The default runtime polls `agent-status.json` every 60 s. It accepts the original
top-level agent map and a versioned bridge envelope, so deployment can later switch
to a same-origin SSE endpoint without changing the 3D scene or dashboard:

```json
{
  "rodi":  { "state": "작업 중", "task": "아침 브리핑 검토", "progress": 0.6, "updatedAt": "2026-07-07T09:12:00+09:00" },
  "argos": { "state": "수집 중", "task": "AI 뉴스 크롤링",   "updatedAt": "2026-07-07T09:10:00+09:00" }
}
```

- `state` → badge on the team bar & card (keywords color it: 작업/진행 = amber,
  검증/리뷰 = violet, 오류/실패 = red, else green). Max 16 chars.
- `task` → shown on the card and sometimes in the agent's speech bubble. Max 80 chars.
- `updatedAt` (optional, ISO 8601) → "N분 전 갱신" on the card.
- `progress` (optional, `0..1`) → progress bar on the card.
- `result` (optional) → the sanitized current result shown first.
- `results` (optional, newest-first, max 6) → sanitized recent result history for the owner's home.
- `runtime` (optional) → allowlisted health, model/provider alias, risk level,
  approval state, blocker, current task id, activity time, and optional public cost.
- v2 top-level `tasks` and `approvals` → sanitized Team Flow and read-only Approval Inbox.
- Unknown keys are ignored; missing agents keep their `defaultStatus` from
  `config/agents.json`.

The browser must never receive `API_SERVER_KEY` or call Hermes directly: the API can
use terminal and file tools. After deployment, a small Mac-mini bridge should query
Hermes profile APIs on loopback, allowlist/sanitize six public agent records, then
serve `/api/agents/snapshot` and `/api/agents/events` from the site's HTTPS origin.
The client already falls back from SSE to polling and reconnects automatically.

The Rodi Team blueprint is reflected here only as a reviewed public projection. On the
Mac mini, each agent still gets a separate Hermes profile: full identity and voice in
`SOUL.md`, routing role and boundaries in `AGENTS.md`, structured metadata in
`profile.yaml`, and an explicit `terminal.cwd`. See the official-source-based deployment
plan in [`docs/hermes-integration.md`](docs/hermes-integration.md) and the normalized
dashboard entities/privacy boundary in [`docs/dashboard-contract.md`](docs/dashboard-contract.md).
The home-based exhibition direction is recorded in
[`docs/home-result-spaces.md`](docs/home-result-spaces.md); a central archive remains deferred.

## 📁 Project structure

```
.
├── index.html              # markup, CSP, import map, HUD + dashboard + service panel + editor UI
├── src/
│   ├── main.js             # scene orchestration, world, agents, dashboard, services, editor
│   ├── sky.js              # weather, clouds, rain, lighting, celestial bodies, day/night
│   ├── ambient-audio.js    # opt-in procedural ocean/wind/rain + completion chime
│   ├── performance.js      # adaptive Retina DPR, shadow cadence, and weather render budget
│   ├── agent-activity.js   # shared status semantics + role-specific 3D activity motifs
│   ├── agent-results.js    # public result normalization, merging, labels, safe links
│   ├── status-source.js    # polling/SSE transport boundary for Hermes status
│   └── style.css           # UI styling (HUD, cards, team bar, service panel, editor, intro)
├── config/
│   ├── agents.json         # the roster — edit me!
│   ├── services.json       # house→service map — edit me!
│   ├── site.json           # public homepage metadata + links
│   └── runtime.json        # status transport settings
├── docs/
│   ├── hermes-integration.md # Mac-mini bridge boundary and deployment plan
│   ├── dashboard-contract.md # public entities, task/approval schema, privacy allowlist
│   └── home-result-spaces.md # implemented per-agent result rooms and artifact boundary
├── agent-status.json       # live agent states — Hermes writes me!
├── agent-results.json      # curated public fallback for home result spaces
├── manifest.json           # PWA manifest
├── sw.js                   # network-first app updates + repeat/offline asset cache
├── scripts/
│   └── validate-predeploy.mjs # zero-dependency schema/cache/syntax/privacy checks
├── .github/workflows/
│   └── deploy.yml          # GitHub Pages auto-deploy
├── LICENSE                 # MIT
└── README.md
```

No build step, no bundler — the browser loads `src/main.js` as an ES module, which imports
the focused local modules above and pulls Three.js from a CDN via the import map.

## 🚀 Run locally

Serve over HTTP (modules + service worker don't work from `file://`):

```bash
# any static server works, e.g.
npx serve .
# or
python3 -m http.server 4173
```

Retina laptops start in the visually close `balanced` render tier: bloom renders at a
lower internal pixel ratio, shadows refresh at 30 fps, and rain keeps its 60 fps motion
with a smaller active pool. The governor steps down only after sustained frame loss and
uses long recovery hysteresis so quality does not flicker. For deterministic visual QA,
open `?dev=1&quality=high|balanced|performance`; combine it with
`&weatherPreset=storm`. `devPlanet.performanceState()` reports the active pixel ratio,
frame-time average, shadow cadence, rain budget, and draw statistics.

## 🌐 Deploy

The whole folder is a static site — copy it anywhere. The included GitHub Actions
workflow publishes to GitHub Pages on every push to `main` (Settings → Pages → Source:
**GitHub Actions**). Any static host (Netlify, Vercel, Cloudflare Pages) works too —
HTTPS required for the CDN and weather API.

Before publishing, set the public links in `config/site.json`:

```json
{
  "publicUrl": "https://your-domain.example/mini-planet/",
  "homepageUrl": "https://your-domain.example/",
  "githubUrl": "https://github.com/your-name/mini-planet"
}
```

Blank values are intentionally hidden. This lets forks and local previews work without broken links.
All app URLs are relative, so project Pages URLs such as `https://name.github.io/mini-planet/` work
without a build-time base path. On a public host, localhost-only service notes and buttons are replaced
with a neutral **개인 네트워크** state instead of exposing local launch instructions.

> Note: service URLs pointing at `http://localhost:…` only resolve on the machine
> running those services. On a public deploy, either leave them (they'll show
> 오프라인) or point them at public URLs in `config/services.json`.

Run the same zero-dependency gate used by GitHub Actions before committing a release:

```bash
node scripts/validate-predeploy.mjs
```

The Pages workflow validates JSON schemas and six-agent key parity, checks every JavaScript
module's syntax, verifies the service-worker shell/cache version, and scans the public agent
projection for local paths or obvious secrets. Deployment runs only after this job passes.

## 🛠️ Tech

- [Three.js](https://threejs.org/) `0.160.0` (unpkg CDN via import map)
- [Open-Meteo API](https://open-meteo.com/) for key-less live weather
- `localStorage` for the village layout; service worker + manifest for installable PWA and repeat-load caching
- Meta-tag **Content-Security-Policy** restricting scripts/connections to self + CDN + weather API (+ localhost for service panels)
- Plain HTML / CSS / JS — no bundler, nothing to install

## 📄 License

[MIT](LICENSE)
