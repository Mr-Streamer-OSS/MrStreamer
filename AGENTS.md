# Mr. Streamer

Desktop IPTV player, docs indexed in `docs/README.md`. The [GitHub project](https://github.com/orgs/Mr-Streamer-OSS/projects/1) is the planning authority.

- Read its README and your card through `gh api graphql`. `gh project item-list` drains the shared rate limit.
- When Wout asks you to implement something specific, first search the project for a matching card and use it. If none matches, scope the request first, then create a draft card with its scope and acceptance, the project README's next release and Status Planned before implementing.
- Without a specific request, take a card that has a Release version, has its implementation prerequisites satisfied and isn't Blocked, Done or archived.
- Record a dependency only when a card needs another card for its implementation. Link the prerequisite card and explain what is needed in the dependent card's body. Set the dependent card Blocked while that prerequisite is unmet and clear Blocked when it is satisfied, which can be before its card is Done.
- A card with no content beyond its title gets a small `$grilling` session on scope and acceptance first. Once Wout confirms, rename the card to the agreed outcome and write that scope and acceptance on it before planning, release assignment or development.
- Keep Status current: Backlog, Planned, Development, Implemented (checks or merge pending), Tested (ready to merge), Done (merged or accepted). Blocked is separate. Set a draft that has neither a Status nor a Release version to Backlog.
- Keep a feature's plan, decisions, PR, validation evidence and acceptance on one draft card. PostPlan links go only there. Repository Issues are bugs only.
- Each version has one `Release <version>` card for its installed checks and announcement. When you plan a card for a version that has none, add it as a draft with that Release and Status Planned, assigned to Wout, holding the unticked checklist of the newest release card. Publishing stable needs Wout's approval.
- Before handing back, pass `pnpm knip`, `lint`, `fmt:check`, `typecheck` and `test`, which needs `ffmpeg` and `ffprobe`.
- Smoke live TV changes in the real app per [testing](docs/contributing/testing.md). The rest uses the fake provider and TMDB.
- Provider logins and stream URLs stay in gitignored `.local/`, never in commits, logs, fixtures or evidence.
- UI is true black, white text, minimal copy.
- Outside contributions are small bug fixes, per `CONTRIBUTING.md`.
