# Viewing profiles

## Sub-features

The Default profile. An installation's existing personal state (viewing record, Watchlist, custom channel lists, `preferences.json`) is Default's in place; binding it moves, copies and rewrites nothing. The older import of favourites and recent channels from a pre-viewing-record `preferences.json` still runs as before. Subscriptions, guides, downloads and recordings stay installation-owned. No second profile, switcher or profile control is exposed until personal state, including local-copy progress, is fully profile-scoped. See the [user guide](../../../../docs/user/profiles.md).

## How to get to it (user POV)

Nothing new is visible. An upgraded installation shows the same favourites and their order, recent channels, Continue watching and progress, Watchlist, custom lists and Settings values as before, and again after a restart. Going back to the previous release still reads them.

## Public seam

`profiles.active` (main `handlers/profiles.ts`) answers `{ id: "default", revision: 1 }`. The registry lives in `mrstreamer.db` (`platform/profile-store.ts`): the first start writes it in one transaction, never replaces rows already there, and older builds never read it. Until the registry has been read once, a locked or unwritable database fails the call rather than guess a profile, and a later call or start retries; after that the profile is answered from memory for the runtime's life. A database that can't open fails every call until a restart. A registry a later release left with another profile active fails the call and is left unchanged, because this release shows Default's viewing alone. The existing legacy `preferences.json` list import keeps its own import marker.

## Verification

`apps/desktop/test/profiles.test.ts` covers, through the services the IPC handlers call: personal state saved by a build without the registry reads back identically after the upgraded start and a restart, with Default at revision 1; and a start while another connection holds the write lock answers no profile, then Default once the lock is released, with the legacy favourites imported after the refused start and not again when the lists reappear in the file; and a registry naming another active profile fails the call across restarts.

For built-app proof, run the baselines whose state Default keeps (`live-tv`, `watchlist`, `custom-lists`, `preferences`) and a round trip through the prior release's packaged executable on one owned profile, as `custom-lists-round-trip <executable>` does for lists: save state in the prior release, start this build, restart it, and start the prior release again. Linux evidence is not macOS or Windows installed-upgrade acceptance; those need the [installed upgrade](../../../../docs/contributing/testing.md#installed-upgrade) run of a published candidate.
