# Architecture Decisions

- Runtime calls to SillyTavern globals pass through the foundation host facade.
- Required host APIs target the current stable SillyTavern release.
- Optional host integrations may return a safe fallback.
- Easy and Advanced views edit the same settings.
- Effective settings disable runtime behavior only when the extension is Off.
- Per-chat summaries live with chat metadata and survive extension reloads.
- Global configuration lives in extension settings.
- Any summary layer or snippet mutation must bump the store mutation epoch.
- Consumers cache derived data by mutation epoch.
