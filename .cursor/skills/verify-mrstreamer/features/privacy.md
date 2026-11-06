# Product-use and reliability statistics

Read only the area needed for the changed path.

- For desktop consent and built-app baseline, read [Desktop consent and built-app baseline](privacy/desktop.md).
- For desktop slow startup, read [Desktop slow startup](privacy/startup.md).
- For desktop lifecycle, read [Desktop lifecycle](privacy/lifecycle.md).
- For installed native telemetry, read [Installed native telemetry](privacy/native.md).
- For archived compatibility, read [Archived compatibility](privacy/archived.md).
- For policy and acceptance limits, read [Policy and acceptance limits](privacy/limits.md).
- For desktop playback diagnostics, read [Desktop playback diagnostics](privacy/diagnostics.md).
- For iOS consent and diagnostics, read [iOS consent and diagnostics](privacy/ios.md).

## Viewing-profile isolation

Personal viewing records, Watchlists, channel lists, preferences and local-copy progress are scoped to an admitted profile. Default retains the original files and database connection; private profiles use separate personal databases. `apps/desktop/test/profiles.test.ts` proves identical source/content/command IDs stay separate, profile deletion retains household files, and source erasure visits every profile. Erasure across separate databases is non-atomic: a partial failure is visible, earlier erasures stay committed, subscription removal does not claim success, and retry cannot revive stale erased-source callbacks. Untouched-source callbacks remain usable through their captured admission; transaction guards cover erasure during asynchronous viewing work. Deletion tombstones precede handle disposal and personal-directory removal; actual native close/removal failures remain unproven.

Private-preference parser and schema refusals use a translated fixed message without stored values or a nested raw cause. Public reader tests cover both failure types, refused writes, unchanged file bytes and retry after repair. Default's older-file compatibility remains separate.

Analytics consent remains installation-owned. The profile Settings overlay reads and updates the existing Analytics owner; opting out in profile B is read consistently after switching and restarting in the public Analytics-backed test. No profile-specific consent copy is used. The remaining viewing preferences, including the TMDB key, are personal. The profile menu composes the admitted lifecycle methods. Service isolation evidence does not replace the assembled two-profile UI privacy journey or native acceptance.
