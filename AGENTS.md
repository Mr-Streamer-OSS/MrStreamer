# Mr. Streamer

Desktop IPTV player, docs indexed in `docs/README.md`. The [GitHub project](https://github.com/orgs/Mr-Streamer-OSS/projects/1) is the planning authority.

For coding-agent work, read [agent workflows](docs/contributing/agent-workflows.md). Use the available stack task skills for their methods and [verify-mrstreamer](.cursor/skills/verify-mrstreamer/SKILL.md) for player and website launch, control and runtime proof. For player or website changes, follow its relevant feature-map entry; keep that entry current when the changed behavior or entry points make it stale. Reviewers inspect the recorded proof and run focused verification when needed. Questions stay read-only.

- Read its README and your card through `gh api graphql`. `gh project item-list` drains the shared rate limit.
- When Wout asks you to implement something specific, first search the project for a matching card and use it. If none matches, scope the request first, then create a draft card with its scope and acceptance, the project README's next release and Status Planned before implementing.
- Without a specific request, take a card that has a Release version, has its implementation prerequisites satisfied and isn't Blocked, Done or archived.
- Record a dependency only when a card needs another card for its implementation. Link the prerequisite card and explain what is needed in the dependent card's body. Set the dependent card Blocked while that prerequisite is unmet and clear Blocked when it is satisfied, which can be before its card is Done.
- A card with no content beyond its title gets a small `$grilling` session on scope and acceptance first. Once confirmed, rename the card to the agreed outcome and write that scope and acceptance on it before planning, release assignment or development.
- Keep Status current: Backlog, Planned, Development, Implemented (checks or merge pending), Tested (ready to merge), Done (merged or accepted). Blocked is separate. Set a draft that has neither a Status nor a Release version to Backlog.
- Keep a feature's plan, decisions, PR, validation evidence and acceptance on one draft card. PostPlan links go only there. Repository Issues are bugs only.
- Each version has one `Release <version>` card for its installed checks and announcement. When you plan a card for a version that has none, add it as a draft with that Release and Status Planned, assigned to a maintainer, holding the unticked checklist of the newest release card. Publishing stable needs a maintainers approval.
- Smoke live TV changes in the real app per [testing](docs/contributing/testing.md). The rest uses the fake provider and TMDB.
- Provider logins and stream URLs stay in gitignored `.local/`, never in commits, logs, fixtures or evidence.
- UI is true black, white text, minimal copy.
- Outside contributions are small bug fixes, per `CONTRIBUTING.md`.
