# Agent workflows

Use the stack's installed skills for the task method and this repo's `verify-mrstreamer` skill for desktop and website runtime control. Keep them separate: this repo does not vendor implementation, bug-fix, investigation, performance, review, autopilot or shipping skills.

`AGENTS.md` remains the repository policy; `CLAUDE.md` imports it. Read the project README and matching card before implementation. Runtime verification does not authorize publishing, deployment or touching a daily-driver profile. Questions are read-only.

## Choose the task method

When available, the installed `poteto-mode` routes task requests to `feature-implementation`, `bug-fix`, `investigation`, `refactoring`, `performance`, planning and review workflows. Individual workflows can also be selected directly. Their descriptions support automatic selection; a prompt naming the workflow is useful when you want a particular method. If those skills are absent on another machine, follow repository policy and `docs/contributing/testing.md` directly rather than inventing a successful skill invocation.

For implementation or bug fixes, use the relevant desktop or website feature-map entry to reproduce and verify the changed user paths. For refactors, verify preserved behavior at those entry points. For independent review, inspect runtime evidence against the actual diff and run the relevant check when necessary. Performance work uses the existing `measure-app.ts` and comparison guidance in testing; the baseline verification helper does not measure performance. PR and release work retains its existing audit, permission and native acceptance gates.

## One project-specific skill

The maintained body, helper, feature map and maintenance loop are in `.cursor/skills/verify-mrstreamer/`, following pstack's template. `.agents/skills/verify-mrstreamer/` and `.claude/skills/verify-mrstreamer/` are small discovery entrypoints that read that same body. They contain no second workflow or copied helper. Plain files work on Windows as well as Unix, without Git symlink setup.

Use the MR Streamer checkout as the agent's workspace. A T3 thread attached to another repository will not discover MR Streamer's project-local skill. After adding the skill, refresh discovery or start a fresh agent in this checkout. No global install is needed.

Codex can invoke `$verify-mrstreamer`; Claude/Cursor can invoke `/verify-mrstreamer`. Example: "Use verify-mrstreamer to verify this playback change, including the Live TV list entry point." Normal discovery is enabled. The AGENTS pointer connects ordinary desktop coding/review tasks to the skill even when you do not name it.

## Prepare and prove

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm verify:desktop doctor
pnpm verify:desktop live-tv
```

On headless Linux use `xvfb-run -a pnpm verify:desktop live-tv`. Other baseline scenarios are `subscriptions`, `titles` and `watchlist`. Each starts a real built app against fake provider/TMDB services, captures UI and side effects, then tears down its isolated instance. Evidence remains in gitignored `.local/verification/`.

Inspect the relevant feature entry before treating a baseline as acceptance. For website changes, build with `pnpm build:marketing`, then use collaborative preview or, when unavailable, `xvfb-run -a pnpm verify:website`. The website entry documents routes, responsive checks, link proof and limits.

Use the installed `architect` skill when types, ownership and module boundaries need a design first; keep delivery sequencing in `multi-phase-plan`.

Use the installed `mac-mini` skill for native macOS checks, including its `onmac` synchronization and installed `cua-driver` controls. The verification skill has checkout-scoped command recipes and evidence pull/cleanup guidance. Real subscriptions, native audio/GPU behavior, installers/updates and TV receivers still need their own documented checks.

Keep the relevant feature entry current in a product change. To audit the entire map, ask "Use verify-mrstreamer to maintain its feature map" and follow its maintenance reference. This reuses the same skill and adds no global workflow or recurring schedule.
