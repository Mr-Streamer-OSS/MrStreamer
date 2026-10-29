# Secretless validation contract

After checking out the exact candidate and trusted validation tools, call this composite action
with `part: check`, `test`, or `website`, and a unique `report-name` when calling more than once. Run Check and Test in separate jobs, with the existing
10/15-minute bounds. Check includes the production desktop build and workflow validation.
Test preserves the full suite, multimedia setup, JSON artifact and completeness gate. Website
requires only a read-only `GH_TOKEN` for release history. There are no signing or publishing steps.

The caller must execute trusted action code: for an older candidate, check out the workflow's
reviewed tools separately with a full checkout, including `.github/scripts` and `.github/tests`,
and refer to that action path. A sparse checkout of actions alone is insufficient. Run from the
candidate workspace.
Do not load validation code from arbitrary forks in a privileged release workflow.

`node .github/scripts/validation-evidence.ts record <file>` records schema version 1,
exact checked-out `sha`, `identity`, `profile: desktop-v1` and `results: {check,test,website}` plus per-job `identities`.
Results come from job conclusions via CHECK_RESULT, TEST_RESULT and WEBSITE_RESULT.
CHECK_IDENTITY, TEST_IDENTITY and WEBSITE_IDENTITY carry the action outputs from the jobs that
actually validated. Missing or mismatched Check/Test identities refuse reuse, including image
rollouts between jobs. The collector never substitutes its own runner for a validation runner. A skipped
Test is recorded as skipped and cannot satisfy the desktop profile. The identity hashes validation
inputs, effective trusted tooling, lockfile, package manager declaration, actual Node version, OS/architecture and runner image.
Main always checks its actual merged source; PR evidence is diagnostic only.

Release consumers find the immutable `validation-<report-name-or-run-id>-<attempt>` artifact on a completed
Checks run, authenticate its repository, workflow path, event, branch, source SHA and conclusion
against GitHub's API, and download that exact run attempt's artifact. Never take producer metadata
from the artifact itself. Do not accept artifacts from a different run, an expired/missing artifact,
a fork, a PR, a failed/cancelled run or an untrusted workflow revision. The consumer must verify
that the producing workflow revision is trusted under its release policy before calling verify.

Use `node .github/scripts/validation-evidence.ts verify <file> <producer.json>` with VALIDATION_SHA
set to the exact candidate. Producer JSON uses API-verified `repository`, `event`, `branch`,
`workflow` (workflow path), `sha`, and `conclusion`. Exit 0 permits reuse; nonzero means run the
shared Check/Test action instead. Identity is recomputed from the current trusted validation
checkout and toolchain. Toolchain/image drift deliberately falls back. Website failures cannot be
reused; an intentionally skipped Website does not constitute executed website validation.

Checks checks out trusted workflow tools in `.local/validation-tools` independently of the candidate.
The action runs candidate checks/build/tests, and its own validation contract tests from those tools.
The Test job covers the root suite, including marketing tests; website inputs therefore select both
Test and Website. Main runs selected Website validation even though publication may also build it.
This keeps an independent secretless validation result during the Website workflow transition.
