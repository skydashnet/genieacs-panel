# Changelog

SkyGenPanel follows [Semantic Versioning](https://semver.org/). Release versions
are calculated from conventional commits since the previous `v*` Git tag.

## [1.0.0] - 2026-07-24

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
