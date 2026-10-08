# Maintain the verification map

This is the repo adaptation of pstack's [maintain-verification-skill](https://github.com/cursor/plugins/blob/ccb5507cec1546dc88135c1139c811e6c59115ba/pstack/skills/maintain-verification-skill/SKILL.md), kept inside `verify-mrstreamer` to avoid another overlapping skill.

For a full maintenance request:

1. Compare `features/README.md` with its sibling feature files and the current desktop and marketing source. Fix missing, duplicate or dead index entries. Trace each feature's documented entry points to source, recording concrete drift and a live recipe. Independent read-only source readers can help a broad audit; the coordinator owns live driving.
2. Sweep relevant source changes for missing user surfaces. Add a map entry only when a real route, control or contract supports it. Keep the map about user behavior rather than helper implementation.
3. Exercise desktop entries with `pnpm verify:desktop <scenario>` and the website entry with collaborative preview or its documented fallback, then the additional paths needed for the audit. Each command owns a fresh session with live doctor, evidence and cleanup. After a surprising result inspect retained failure evidence and run a corrected fresh session. A helper correction must itself pass a real run.
4. Separate doc drift, harness gaps and product regressions. A maintenance request authorizes edits to this skill's instructions/map/helper, not product fixes. Report a broken product path; preserve its intended acceptance rather than changing the map to call it correct. Keep shared entrypoints and repo wiring aligned if the skill's location/name changes.
5. Confirm evidence survives every teardown and all owned resources were cleaned. Report **clean**, **changed**, or **blocked**, with source coverage, actual live paths, prerequisites and remaining gaps. A baseline pass does not cover all additional paths. Native-only paths need their native host and explicit access; explain a missing prerequisite and the route attempted.

Keep run notes in `.local/verification/`. Use the existing project's card for scope and evidence. File, review, commit, merge or deploy through the installed stack workflows only when authorized. A question about the map is read-only; a maintenance request is an edit request. No schedule is created by this document.
