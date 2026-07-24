# Changelog

SkyGenPanel follows [Semantic Versioning](https://semver.org/). Release versions
are calculated from conventional commits since the previous `v*` Git tag.

## [1.10.1] - 2026-07-24

### Fixed

- Deduplicate global toast notifications (`f10067e`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.10.0...v1.10.1)

## [1.10.0] - 2026-07-24

### New

- Added an isolated customer portal on port 5891 with safe ONT and WiFi status.
- Added immutable, database-backed Customer IDs bound to SoftwareVersion and PPPoE identity.

### Fixed

- Loaded the map engine and topology concurrently, bundled Leaflet CSS locally, and centered existing assets at zoom 15.

### Security

- Hardened session revocation, route isolation, origin checks, rate limits, CSP, and deployment secrets.

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.9.2...v1.10.0)

## [1.9.2] - 2026-07-24

### Improved

- Render cached charts without Recharts (`321ab4b`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.9.1...v1.9.2)

## [1.9.1] - 2026-07-24

### Fixed

- Keep desktop sidebar anchored while scrolling (`9eef4fd`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.9.0...v1.9.1)

## [1.9.0] - 2026-07-24

### New

- Add Git-derived version and changelog UI (`ffae6ab`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.8.5...v1.9.0)

## [1.8.5] - 2026-07-24

### New

- Rebuilt the panel as a lightweight Vite single-page application.
- Added production installer and self-updating `skygenpanel` management CLI.
- Added branded navigation, responsive operator UI, and selectable map layers.
- Added full physical topology management for HTB, OLT, ODC, ODP, ONT, and fiber cables.
- Added typed WiFi configuration tasks compatible with installer virtual parameters.
- Added fleet analytics and the GenieACS fault queue.

### Fixed

- Prevented blank screens caused by GenieACS metadata objects reaching React.
- Preserved the Leaflet map and viewport across topology refreshes.
- Removed stale Next.js artifacts during updates.
- Hardened production headers, dependency bootstrapping, and static asset delivery.

[Full history](https://github.com/skydashnet/genieacs-panel/commits/main)
