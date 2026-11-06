# Viewing profiles

## Sub-features

The Default profile. An installation's existing personal state (viewing record, Watchlist, custom channel lists, `preferences.json`) is Default's in place; binding it moves, copies and rewrites nothing. The older import of favourites and recent channels from a pre-viewing-record `preferences.json` still runs as before. Subscriptions, guides, downloads and recordings stay installation-owned. No second profile, switcher or profile control is exposed until personal state, including local-copy progress, is fully profile-scoped. See the [user guide](../../../../docs/user/profiles.md).

## How to get to it (user POV)

Nothing new is visible. An upgraded installation shows the same favourites and their order, recent channels, Continue watching and progress, Watchlist, custom lists and Settings values as before, and again after a restart. Going back to the previous release still reads them.

## Public seam

`profiles.active` (main `handlers/profiles.ts`) answers Default with the registry's revision, `{ id: "default", revision: 1 }` when this release wrote it. The registry lives in `mrstreamer.db` (`platform/profile-store.ts`): the first start writes it in one transaction, never replaces rows already there, and older builds never read it. Until the registry has been read once, a locked or unwritable database fails the call rather than guess a profile, and a later call or start retries; after that the profile is answered from memory for the runtime's life. A database that can't open fails every call until a restart. A registry a later release left with another profile active fails the call and is left unchanged, because this release shows Default's viewing alone. The existing legacy `preferences.json` list import keeps its own import marker.

## Verification

`apps/desktop/test/profiles.test.ts` covers, through the services the IPC handlers call: personal state saved by a build without the registry reads back identically after the upgraded start and a restart, with Default at revision 1; and a start while another connection holds the write lock answers no profile, then Default once the lock is released, with the legacy favourites imported after the refused start and not again when the lists reappear in the file; and a registry naming another active profile fails the call across restarts.

For built-app proof, run the baselines whose state Default keeps (`live-tv`, `watchlist`, `custom-lists`, `preferences`) and a round trip through the prior release's packaged executable on one owned profile, as `custom-lists-round-trip <executable>` does for lists: save state in the prior release, start this build, restart it, and start the prior release again. Linux evidence is not macOS or Windows installed-upgrade acceptance; those need the [installed upgrade](../../../../docs/contributing/testing.md#installed-upgrade) run of a published candidate.

## Backend isolation seam

`apps/desktop/src/main/services/profiles.ts` also provides `ProfileSessions` for backend integration. It is not exposed by the window's IPC handlers. Each admitted operation retains its owner and personal store context across a switch. Default keeps its existing database and preferences paths; other owners use separate personal databases and preference files. Names and file paths never determine ownership of a provider's IDs or command receipts. Profile Settings overlay consent from the installation's Analytics owner rather than save a second consent choice.

Switching requires an explicit interactive-cleanup callback; an owner without that callback or the installation consent dependency cannot become active through this module. Deletion refuses Default and the active owner, tombstones another owner, waits for admitted operations and closes its handle before removing its personal directory. A failed close or directory removal leaves the tombstone retryable; a failed final registry write leaves it pending after directory removal. Household media and job files are outside that directory. Source erasure visits every registered owner and invalidates earlier admissions. Separate databases cannot commit together: an owner erased before another fails stays erased, the call fails, and retry visits every owner again. Subscription removal must await that operation before claiming success when the final routing is connected.

The public module tests in `apps/desktop/test/profiles.test.ts` exercise identical source, content, list and command IDs; retained admissions; personal preferences across restarts; installation consent through the real Analytics owner; cross-database erasure failure and retry; and inactive-profile deletion with household data retained. Copy-open paths capture a `profile-copy-progress.ts` admission before file checks. Session progress events and retries still require their profile contract integration before another profile can be exposed. These tests are source/service evidence, not a built UI, native close-failure, installed-upgrade or real-provider claim.
