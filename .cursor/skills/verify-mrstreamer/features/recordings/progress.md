# Local-copy progress

## Default local-copy progress

A recording's resume position follows [Default local-copy progress](../downloads/progress.md#default-local-copy-progress), with copy kind `recording`. Opening its local copy seeds Default’s legacy position; listing recordings does not. Refused progress writes remain pending in the main runtime for its next retry check, even if the player closes or schedules cannot be read. Its focused tests and candidate acceptance journey are listed there.

## Growing-copy backend checkpoint (0.0.24)

The recorder-owned file cases in `apps/desktop/test/recordings.test.ts` exercise retained wall-clock gaps, unknown final indexed duration, and an exact open session settling to the file's final sample end. The existing file-session probe is reused when already settled; an active session coalesces one bounded, cancellable local probe after settlement, checks the same revision and incarnation, and retains a failed attempt as refusal until reopened. Unchanged track indexes remain the indexes used by the transcoder. A changed inspected track layout refuses that session rather than publishing stale track indexes. Nonzero recording seeks without verified session coverage return 416. The index's presentation span is main-only and is never a final-sample claim.

Active `Recordings.copy` still refuses. Actual random-access coverage and changed-layout stream-index remapping remain unproved; these backend cases do not qualify growing playback, renderer integration, native output or installed builds. No renderer journey is mounted by this checkpoint.
