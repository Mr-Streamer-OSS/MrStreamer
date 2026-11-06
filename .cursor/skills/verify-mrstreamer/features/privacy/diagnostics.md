# Desktop playback diagnostics

For the failed-title-open step, read [Desktop consent](desktop.md).

## Bounded desktop playback diagnostics from 0.0.16

The existing failed-title-open step must retain exactly one `stream_error` and no new start, with typed `deliver` / `provider_unavailable` context in its actual loopback HTTP body. The maintained helper records that event in `observations.failedOpenDiagnostic`. The common allowlist comparison still applies to every raw body. Public analytics/open/renderer contracts cover strict literal validation, future optional diagnostic loading without losing consent/identity/legacy work, repeated/recovered/stale incidents, receiver moves, preview and opt-out exclusion. Playback service fixtures cover missing/failed tools, failed probing, malformed probe output, conversion failure, decode rejection and provider/network evidence without reading raw messages for a codec cause. An actual 0.0.15 loader fixture is retained in the unit's local delivery evidence; the old loader deletes only additive diagnostic properties. Native installed proof and post-release production breakdown remain release-owner checks.
