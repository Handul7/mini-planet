# 🌍 Handul Mini Planet — Interactive Hermes Village

A tiny low-poly 3D planet that doubles as a **public showcase and dashboard shell for the Hermes agent team**.
Six resonators from 《별의 공명자들》 stroll a cel-shaded miniature world with live weather;
click any of them and the camera glides over while their status card opens — and every
cottage is the **front door of one of Handul's services**.

Built with **Three.js / WebGL** — walk-on-a-sphere movement, matte cardstock shading,
layered paper foliage, folded hulls, and a pastel harbor palette. Original paper templates and
customization notes live in [`assets/papercut`](assets/papercut/README.md).
The public landing rhythm and on-demand paper UI were informed by
[messenger.abeto.co](https://messenger.abeto.co). Bundled third-party models retain their asset licenses.

## ✦ The team (별의 공명자들)

The six-person roster lives in [`config/agents.json`](config/agents.json) — edit that file to change
names, colors, roles, public persona notes, speech lines, or character visuals. No code changes
are needed as long as the six stable keys stay aligned across status/services/results. Full Hermes SOUL files stay private; this repository contains only concise,
human-reviewed public projections.

Each roster entry also owns a small `visual` profile. Its stable style enum, body type, scale,
and color options drive the Three.js character design; silhouette/tool/motif fields document
the art direction beside the role. Renderer tests keep those public contracts aligned with the
setting-book canon and each owner's home marker.

| Agent | 실제 역할 (SOUL) | 판타지 정체성 | 집 |
|-------|------------------|----------------|----|
| **Rodi** 로디 | 메인 오케스트레이터 | 북극성의 지휘자 | 마을 광장 (미드나이트 네이비) |
| **Jarvis** 자비스 | 운영 비서 | 시간의 집사 · 인간형 오토마톤 | 마을 광장 (스틸 블루) |
| **Yul** 율 | 엔지니어 | 마지막으로 공명을 듣는 자 | 마을 광장 (딥 틸) |
| **Ludwig** 루드비히 | 검증관 | 달빛의 공명학자 | 마을 광장 (문라이트 그레이) |
| **Anne** 앤 | 콘텐츠 크리에이터 | 향기를 세공하는 숲의 요정 | 마을 광장 (세이지 그린) |
| **Argos** 아르고스 | 리서처 · 관측자 | 감긴 백 개의 눈을 지닌 별지기 | **행성 반대편 등대곶** (나이트워치 바이올렛) |

Five agents own cottages and Argos owns the lighthouse; every home carries its owner's palette,
facade crest, roof signature, and flag. Agents wander nearby, chatting in role-flavored speech
bubbles and occasionally reporting their current task. Argos keeps his distance at the violet-and-white far-cape lighthouse.
Each home is also that agent's personal result space. The same door now opens service details
and up to six sanitized recent results without adding another central building.

## ✨ Features

- **Public homepage entrance** — the live 3D world remains visible behind an unframed title layer;
  one primary CTA enters the village, while walk and edit tools stay secondary.
- **Visitor checklist + avatar color** — an on-demand paper panel teaches the three core interactions
  and remembers progress locally; a second tile lets visitors recolor their traveler without an account.
- **The planet is the dashboard** — a team bar lists all six agents with published states;
  clicking an agent (in 3D or on the bar) opens a status card with their role, fantasy
  identity, public SOUL summary, channel, autonomy boundary, core responsibilities, compact
  voice/value/home notes, and current task. Hermes runtime health, model alias, risk, approval, and blocker appear
  only when the safe bridge supplies them. The agent stops and turns to face you while you read.
- **Human-scale connected harbor** — a short cross street, harbor axis, and two work lanes connect
  five street-facing homes to the civic core and working waterfront. House approaches now run
  from each actual front door to the nearest street, while the pavilion, repair yard, ferry gate,
  result board, clock kiosk, and shared garden sit inside the places whose activity they explain.
  Curbs, hedges, quay rails, and paved frontages form continuous district boundaries instead of
  scattering more standalone decoration. Three architecture profiles give the five front homes
  different rooflines and working facades while preserving their owner/service contracts.
- **Observation camera** — agent focus keeps the agent and their home in one unobstructed frame.
  Opposite-side transitions follow an arc outside the globe, and the exploration camera sits lower
  and closer so the street reads before the whole miniature planet does.
  An optional nine-second auto patrol visits all six agents; any direct camera or navigation input
  stops it immediately.
- **Read-only team flow** — the team bar opens a compact Team Overview with published metrics,
  role-based handoff routes, sanitized v2 tasks, and pending L4 approvals. Before Hermes is
  connected it shows quiet empty states; it never submits runs or approves actions.
- **Houses are services** — stand at any cottage door (prompt appears → `F` or tap) or
  click the house to open its **service / recent results panel**: description, online/offline check,
  "새 창에서 열기", an optional embedded live preview, and up to six public result cards.
  The house→service map is [`config/services.json`](config/services.json) — edit freely.
- **Status snapshot boundary** — edit [`agent-status.json`](agent-status.json) and the planet
  updates (~1 min polling or the manual refresh button). The team bar shows the last successful
  check separately from the source timestamp, and its recent-results shortcut opens the newest
  agent home exhibition in one step. This is the Hermes integration point — see below.
- **You appear too** — walk the planet as 한들 with a follow camera, jump, and emoji reactions.
- **Edit mode** — rearrange the whole PLANET: every lake, bridge, forest tree
  and building is an editable object (only the pole rose stays put).
  Drag/rotate/scale/delete 20+ prop types (hand-built primitives plus bundled
  CC0 KayKit models — wells, windmills, watermills, lanterns, benches…; see
  [`assets/models/ATTRIBUTION.md`](assets/models/ATTRIBUTION.md)), draw
  spline-smoothed roads/rivers and free-form ponds/sand/grass. Desktop editors can also open
  **고급 세계 구조** to draw islands, sea, decks, market paths, breakwaters, wave bands,
  and camellia trails; these structural edits create a safety backup before drawing. Everything is auto-saved
  to `localStorage` with visible save feedback, undo/redo, restorable safety backups before reset/import,
  and versioned JSON export/import. Agent homes (flags, nameplates,
  service doors) follow the houses around.
- **Animated characters** — six config-driven humanoid rigs, plus Argos's bronze owl vessel, with swinging limbs,
  role-specific clothing silhouettes and tools, building/water collision, and obstacle avoidance.
  Live states add restrained role-specific motifs: Rodi conducts, Jarvis keeps time, Yul
  listens for resonance, Ludwig reviews proofs, Anne shapes petals, and Argos observes. Review,
  completion, and error states change the same motif instead of spawning permanent clutter.
- **Agent signature homes** — each public `visual.style` maps to a lightweight code-native
  landmark: Rodi's repaired harmonic fork, Jarvis's chronicle dial, Yul's resonance fork,
  Ludwig's locked crescent archive, Anne's scent atelier, and Argos's owl observatory. The catalog lives in
  [`src/agent-signatures.js`](src/agent-signatures.js), while geometry stays in
  [`src/main.js`](src/main.js). Updating a style without a registered signature fails the
  release tests instead of silently producing a generic home.
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
- **Installable PWA** — real 192/512px and maskable app icons, Apple touch icon,
  network-first app updates, and a complete local app shell.
  The pinned Three.js runtime ships in-repository, so the 3D world does not depend
  on a third-party CDN at launch.

## 🎮 Controls

| Action | Desktop | Mobile | Standard gamepad |
|--------|---------|--------|------------------|
| Move | `W A S D` / Arrows (automatically enters Explore mode) | Virtual joystick | Left stick / D-pad |
| Jump | `Space` | `↑` action button | A |
| Enter a house (service) | `F` at the door, or click the house | `⌂` near a door / tap the house | X |
| Board / leave a boat | `F` beside the harbor boat / near shore | `⛵` action button | X |
| Look / Zoom | Drag / Wheel | Drag / Pinch | Right stick |
| Agent card | Click an agent, team bar, or press `1`–`6` | Tap | — |
| Ambient sound | `♬` in the weather chip (muted by default) | Tap `♬` | — |
| Edit mode | Header `편집`, intro button, or `E` | Header `편집` or the pencil tile | — |

**Edit mode:** click to select, drag to move, `[` `]` rotate, `-` `=` scale,
`Ctrl+D`/⧉ duplicate, `Delete` remove, `Ctrl/⌘+Z` undo and `Ctrl/⌘+Shift+Z` redo
(30 steps; touch buttons included). The compact
editor dock separates **Objects** from **Paths & terrain**, keeps one prop
category open at a time, and can be collapsed while arranging the scene. Use its buttons to
add props (including 🌉 다리 — bridges carry their own walkable water
crossing), 도로/흙길/눈길/물길 buttons to draw spline-smoothed paths and
연못/모래밭/풀밭 to fill free-form shapes (click points, double-click or ✓ to
finish — water blocks walking; sea travel requires boarding a harbor boat). On desktop, **고급 세계 구조** exposes
섬/바다/데크/어시장/방파제/파도/동백길 tools behind a separate disclosure and
backs up the current layout before structural drawing. Use 시점 presets (🏘️ 마을 / 🌹 북극),
⬇️/⬆️ for JSON export/import. Tip: open with `?dev=1` to skip the service
worker while developing (and get a small `devPlanet` console helper).
Edits are saved only in the current browser's local storage; they never change the
published homepage source.

The default harbor keeps open water at roughly 40% of the sphere and treats it as
a working district: the boardable fishing boat, channel beacon, buoy, and cargo
ferry all sit on registered water. A single roadside vending point and the public
work buildings carry the medium-scale environmental rhythm onto land without adding
solid navigation blockers. Repeated foliage sheets and static visual fragments are
batched inside their existing edit/animation roots to reduce render calls.

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
| [`config/services.json`](config/services.json) | Public house→service map. Only reviewed HTTPS URLs and visitor-safe notes |
| `config/services.local.json` | Optional local-only service override; ignored by Git |
| [`config/runtime.json`](config/runtime.json) | Publication mode, freshness policy, status transport, public result fallback |
| [`config/site.json`](config/site.json) | Public title, description, canonical URL, homepage link, GitHub link |
| [`agent-status.json`](agent-status.json) | v2 public status snapshot. The repository default is an explicit static demo |
| [`agent-results.json`](agent-results.json) | Curated public result fallback for the six home exhibitions |

Rules of thumb: an agent's public `key` ties the files together; a service with an empty
`url` shows as **준비 중**. Keep private endpoints and launch notes in the ignored
`config/services.local.json`; the public config accepts reviewed HTTPS services only.

## 🤖 헤르메스 연동 (prepared, not connected yet)

The default runtime polls a clearly labeled static sample every 60 s. A verified bridge
can later switch to a same-origin v2 endpoint without changing the 3D scene or dashboard:

```json
{
  "schemaVersion": 2,
  "publicationMode": "live",
  "sourceGeneratedAt": "2026-07-29T09:12:00+09:00",
  "bridgeObservedAt": "2026-07-29T09:12:05+09:00",
  "expiresAt": "2026-07-29T09:15:05+09:00",
  "isStale": false,
  "source": "hermes-public-bridge",
  "agents": {
    "rodi": { "state": "작업 중", "publicTask": "공개 브리핑 검토", "progress": 0.6 }
  },
  "tasks": [],
  "approvals": []
}
```

- `state` → badge on the team bar & card (keywords color it: 작업/진행 = amber,
  검증/리뷰 = violet, 오류/실패 = red, else green). Max 16 chars.
- `publicTask` → human-approved public task summary. Raw task text is ignored in live mode.
- `updatedAt` (optional, ISO 8601) → "N분 전 갱신" on the card.
- `progress` (optional, `0..1`) → progress bar on the card.
- `publicResult` (optional) → the explicitly published current result shown first.
- `publicResults` (optional, newest-first, max 6) → explicitly published result history.
- `runtime` (optional) → allowlisted health, coarse `modelFamily`/`providerAlias`, risk,
  approval, `publicBlocker`, public task id, activity time, and verification fields.
- v2 `tasks` and `approvals` require `publicTitle` and `publicActionSummary`; raw text fields are ignored.
- Missing or expired freshness metadata degrades every live agent to **상태 미확인**.
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
├── index.html              # markup, strict script CSP, HUD + dashboard + service panel + editor UI
├── src/
│   ├── boot.js             # module boot, friendly failure state, service-worker lifecycle
│   ├── main.js             # scene orchestration, world, agents, dashboard, services, editor
│   ├── sky.js              # weather, clouds, rain, lighting, celestial bodies, day/night
│   ├── ambient-audio.js    # opt-in procedural ocean/wind/rain + completion chime
│   ├── performance.js      # adaptive Retina DPR, shadow cadence, and weather render budget
│   ├── agent-activity.js   # shared status semantics + role-specific 3D activity motifs
│   ├── agent-signatures.js # visual.style → distinct home landmark contract
│   ├── input-controls.js   # deadzone-safe standard gamepad input projection
│   ├── agent-results.js    # public result normalization, merging, labels, safe links
│   ├── status-source.js    # polling/SSE transport boundary for Hermes status
│   ├── public-dashboard.js # allowlist task/approval/status projection + freshness policy
│   ├── release-quality.js  # fleet summary and deterministic layout release audit
│   ├── paper-style.js      # shared matte paper surface + batched solid foliage
│   ├── world/
│   │   └── harbor-kit.js   # architecture profiles, curbs, hedges, and quay rails
│   └── style.css           # UI styling (HUD, cards, team bar, service panel, editor, intro)
├── config/
│   ├── agents.json         # the roster — edit me!
│   ├── services.json       # house→service map — edit me!
│   ├── services.local.json # optional local override — ignored by Git
│   ├── site.json           # public homepage metadata + links
│   └── runtime.json        # status transport settings
├── docs/
│   ├── hermes-integration.md # Mac-mini bridge boundary and deployment plan
│   ├── dashboard-contract.md # public entities, task/approval schema, privacy allowlist
│   └── home-result-spaces.md # implemented per-agent result rooms and artifact boundary
├── agent-status.json       # curated static-demo status snapshot
├── agent-results.json      # curated public fallback for home result spaces
├── assets/fonts/           # pinned Nunito WOFF2 weights + OFL license
├── assets/icons/           # favicon/PWA/Apple install icons
├── assets/social/          # 1200×630 Open Graph share image
├── assets/papercut/        # original solid-paper contour templates and customization notes
├── manifest.json           # PWA manifest
├── sw.js                   # network-first app updates + repeat/offline asset cache
├── scripts/
│   ├── build-site.mjs      # allowlisted runtime files → _site
│   ├── validate-site-artifact.mjs # relative-path and artifact-boundary checks
│   └── validate-predeploy.mjs # schema/cache/syntax/privacy/GLTF checks
├── tests/
│   └── *.test.mjs          # public contract, transport, and release-quality tests
├── vendor/three/           # pinned Three.js core + only the add-ons we import
├── .github/workflows/
│   └── deploy.yml          # GitHub Pages auto-deploy
├── LICENSE                 # MIT
└── README.md
```

No bundler is required — `src/boot.js` loads the app as native ES modules, and every
Three.js import resolves directly to the pinned local runtime. Deployment has one deterministic
assembly step that copies only the public runtime allowlist into `_site`.

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

The included GitHub Actions workflow builds a minimal `_site` artifact and publishes it to
GitHub Pages on every push to `main` (Settings → Pages → Source: **GitHub Actions**).
Any static host (Netlify, Vercel, Cloudflare Pages) can serve the generated `_site` directory.
HTTPS is required for service workers and the optional weather API.

Before publishing, set the public links in `config/site.json`. When Mini Planet itself is
the main homepage, use the root domain as `publicUrl` and leave `homepageUrl` blank so the
visitor panel does not link back to the page it is already showing:

```json
{
  "publicUrl": "https://your-domain.example/",
  "homepageUrl": "",
  "githubUrl": "https://github.com/your-name/mini-planet"
}
```

Run `node scripts/sync-site-metadata.mjs` after changing the domain. It updates the static
canonical/Open Graph URL and image tags, PWA description, `robots.txt`, and `sitemap.xml`; the deployment
workflow also runs it automatically before validation and upload. Configure the same hostname
in the chosen static host and enable HTTPS. Desktop and mobile visitors use the same URL; the
responsive UI and input mode adapt in the browser.

Blank values are intentionally hidden. All app URLs are relative, so project Pages URLs such as
`https://name.github.io/mini-planet/` work without a build-time base path. Local endpoints and
launch notes belong in `config/services.local.json`, which is loaded only on a loopback host and
is excluded from Git.

Run the same zero-dependency gate used by GitHub Actions before committing a release:

```bash
node scripts/validate-predeploy.mjs
node --test tests/*.test.mjs
node scripts/build-site.mjs
node scripts/validate-site-artifact.mjs _site
```

The Pages workflow validates JSON schemas and six-agent key parity, checks every JavaScript
module's syntax, verifies the service-worker shell/cache version, and scans the public agent
projection for local paths, private fields, local endpoints, and obvious secrets. Contract tests
also verify fail-closed future schemas, public-only task text, projection caps, and stale behavior.

## 🛠️ Tech

- [Three.js](https://threejs.org/) `0.160.0` (pinned local ES module; MIT notice in `vendor/three`)
- [Nunito](https://fontsource.org/fonts/nunito) `5.2.6` package assets (local WOFF2; OFL license in `assets/fonts`)
- [Open-Meteo API](https://open-meteo.com/) for key-less live weather
- `localStorage` for the village layout; service worker + manifest for installable PWA and repeat-load caching
- Meta-tag **Content-Security-Policy** restricting scripts to self and connections to self + weather API (+ localhost for service panels)
- Plain HTML / CSS / JS — no bundler, nothing to install

## 📄 License

[MIT](LICENSE)
