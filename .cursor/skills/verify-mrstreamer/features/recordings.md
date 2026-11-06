# Recordings

Read only the area needed for the changed path.

- For desktop recording controls and baseline, read [Desktop recording controls and baseline](recordings/desktop.md).
- For scheduling controls and contracts, read [Scheduling controls and contracts](recordings/schedules.md).
- For interruptions, storage and lifecycle, read [Interruptions, storage and lifecycle](recordings/storage-recovery.md).
- For shared capture, read [Shared capture](recordings/shared-capture.md).
- For local-copy progress, read [Local-copy progress](recordings/progress.md).
- For recording and background download coexistence, read [Background download coexistence](recordings/background.md).

Programme-following rule contracts (0.0.24) use `recordings.previewRule`, `recordings.saveRule`, `recordings.rules` and `recordings.cancelRule`. The rule-specific cases in `apps/desktop/test/recordings.test.ts` exercise selected-channel previews, positive premiere evidence, repeated airings, source-qualified overlapping time changes, cancellation/write failure and stopped/deleted occurrence recovery through the main runtime and fake provider. The bounded planner in `apps/desktop/src/main/recordings/rules.ts` is shared by preview and execution; `rules.json` retains occurrence identity before schedules can start and settlement before deletion. Manual programme and weekday schedules keep their existing contracts. Renderer, keyboard, translations and exact-source UI proof require the separate rule UI journey; these backend tests establish no native, real-provider or installed-release qualification.
