# Desktop installation reports

The files here prepare a PostHog definition change for desktop 0.0.19. They have
not been applied. The release's project card holds approval, validation and any
applied report IDs. Existing playback reports and the project's Europe/Brussels
timezone remain unchanged.

`changes.json` contains exact proposed tool inputs, original definitions for
rollback and concurrent-edit preconditions. Refresh those preconditions before
applying it. New SQL variables and insights need their returned IDs recorded in
the application receipt. Do not delete or overwrite unrelated dashboard content.

## Definitions

- Observed new profiles count distinct desktop installation UUIDs with
  `installation_observed` and `profile_origin: fresh`. All-time means since
  tracking began, not every installer ever downloaded or opened.
- DAU counts distinct foreground-active UUIDs on each recorded UTC
  `activity_date`. WAU counts their union across that day and its six preceding
  UTC dates. It never adds daily unique counts.
- `activity.sql` includes zero dates, 30 completed UTC days and labelled partial
  today. The first six tracking dates have incomplete seven-day history.
- `headlines.sql` reports yesterday's DAU, exactly seven completed UTC dates
  ending yesterday, and partial today's DAU.
- Initial `profile_origin` classifies the directory at first observation. It
  does not identify later completed updates. The proposed rename corrects that
  claim while retaining the existing insight and query.

The all-time new-profile total and SQL reports are standalone insights, linked
from the desktop dashboard. Only the selected-period new-profile total inherits
the dashboard's date range.
Their source date filter stays all-time so the explicit UTC windows retain their
six-day warmup. Their advertised controls are `desktop_build_channel` and
`desktop_distribution`, defaulting to `all`. Channel values are `stable`,
`nightly` and `unknown`; distribution is `direct` or `store`. Historical Linux
`direct` attribution includes pacman and cannot separate it retrospectively.

Do not embed these SQL reports in a dashboard with a date override until its
tile can ignore that override and boundary checks pass. The
[`{filters}` placeholder](https://posthog.com/docs/data-warehouse/sql/variables#applying-dashboard-filters)
also applies dates, which can otherwise remove the WAU warmup. It retains the
source's configured internal/test exclusion. Standalone date controls must stay
all-time; the SQL itself owns the UTC window.

## Validation and remaining work

Read-only native Trends validation returned an all-time fresh-profile
`aggregated_value` of 197 on 23 October 2026. A BoldNumber response's empty
`data` and zero `count` did not mean the total was zero.

Read-only SQL with default variable literals and `filters=true` returned 33
active profiles on 22 October, a union of 151 across 16 to 22 October, and nine
on partial 23 October. These are diagnostic snapshots. Source/filter/variable
readback after separately authorized saving remains required.

The client event contract is documented in [telemetry](../../telemetry.md).
`release-arrivals.sql` selects each identity's first target-version observation
across retained history, using original event time and deduplicating event UUIDs.
Build-channel and distribution controls apply after that selection. Each arrival
belongs to exactly one category: new profile, known same-channel upgrade,
downgrade, channel transition or unknown history. The denominator for the known
upgrade share includes unknown history. This is adoption by release, not a count
of installer executions or every repeated upgrade.

`release-upgrades.sql` shows up to 100 anonymous installation UUIDs whose first
arrival on `desktop_target_version` was a known upgrade. Its default is 0.0.19.
Existing profiles without a version baseline remain unknown. Historical
multi-version activity can suggest an upgrade but is excluded from this explicit
report. Recorded profile origin never substitutes for a previous version.

Read-only literal fixtures returned 11 arrivals on 0.0.19: two new profiles, two
known upgrades, two downgrades, one channel transition and four unknown histories.
Filtering to stable returned ten arrivals and three unknown histories. The
fixtures include duplicate UUIDs, delayed delivery, numeric version ordering,
cleared profiles and downgrade/re-upgrade sequences. The drilldown returned
exactly the two known-upgrade fixture UUIDs. No fixture entered event storage.
Final independent review remains required.

These are installation/profile counts, not named people or devices. Retained
reinstalls keep identity; clearing data can create another identity, and copied
profiles share one. Optional collection, offline expiry and bounded delivery
reduce coverage. Production ingestion and UUID deduplication need actual rollout
evidence. Local fixtures never enter production.
