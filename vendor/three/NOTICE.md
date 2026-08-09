# Three.js vendored runtime

- Package: `three`
- Version: `0.160.0`
- Source: `https://www.npmjs.com/package/three/v/0.160.0`
- npm package SHA-1: `cd1e4dbd01aee0719280a9086d75545db52b7a8f`
- License: MIT (see `LICENSE`)

Only the core ES module and add-ons imported by Mini Planet are included. Keeping the
runtime in-repository removes a first-boot CDN dependency and makes packaged/offline
launches deterministic.

The selected add-ons' bare `three` import specifiers are changed to relative imports of
the vendored core module. No runtime behavior is otherwise modified.
