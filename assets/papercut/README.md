# Layered Papercut Asset Kit

Original code-native assets for Handul Mini Planet, covered by the repository
MIT license. No external packs, new framework, or downloaded textures required.

## Construction

- `contours.js`: normalized leaf, pine, hull, stone, and blossom cutting shapes.
- `src/paper-style.js`: shared 128 x 128 seeded grain, cut geometry, and trees
  with three interlocking planes, each made of five double-sided card sheets.
- `src/world/paper-assets.js`: vertex-colored, single-draw-call building blocks.
  House shells have three layers and actual door/window openings on all sides.
  Slabs form folded roofs; tiered polygons form public roofs and the lighthouse;
  reliefs form boat hulls, rocks, and flowers.
- `src/world/harbor-kit.js`: agent-specific roof silhouettes and instanced
  paper hedges, using the same construction as the main asset kit.

## Art Rules

Use visible cut edges, restrained face colors, and small real air gaps between
sheets. Keep the owner's existing roof color and signature. Do not add black
outlines, glossy surfaces, noisy decals, or decorative filler props.
Keep a closed 3D silhouette across camera orbits; these are physical paper
diorama assets, not camera-facing image billboards.

## Editing

Edit silhouettes in `contours.js`; edit layer depth/gap/inset in the builders.
Always retain vertex colors when merging these meshes. Window materials and
animated boat/tree/lighthouse nodes remain separate for state and movement.
House scale, door offsets, collision radii, placement, and saved layout keys are
unchanged. Do not reset saved layouts for an art-only update.

`node --test tests/paper-style.test.mjs tests/paper-assets.test.mjs tests/harbor-kit.test.mjs`
checks solid geometry, real openings, batching, and finite vertex data. Then
check the running planet on desktop and mobile before publishing.

## Detail Pass (v97)

`makePaperWindowTrim` batches all five window surrounds and mullions into one
mesh. `makePaperDoor` keeps the original door dimensions while adding inset
panels and a small brass handle. `makePaperSlab({ folds: 3 })` adds subtle roof
crease lines without additional draw calls. Flowers include a cut-paper center,
and double-sided leaf veins stay inside the existing canopy mesh.

Thin facade, door, window trim, and foliage layers intentionally do not receive
real-time shadows: close parallel faces produced shadow-map banding. They still
receive scene lighting and cast shadows on the ground. Preserve this choice
when changing mesh batching or applying new material presets.

Coastal pine crowns use two main tiers to reduce intersecting silhouettes.
No placement, storage-key, interaction, or collider changes are part of v97.
