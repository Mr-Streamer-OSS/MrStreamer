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

Website identity is diagnostic; the desktop-v1 reuse profile requires only Check and Test identities.
The top-level identity repeats the Check identity for lookup; `profile: desktop-v1` is recorded separately.

The test completeness gate and discovery catalogue come from the exact candidate, like its tests.
They are bound by source SHA and validation identity and remain subject to normal source review.
Using a newer trusted catalogue to judge an older candidate would change that candidate’s intended suite.

Release fallback may set `build: "false"` only when its required final versioned production
bundle gates publication. This omits only the duplicate Check build, leaving all static/workflow
checks and the full Test contract intact. Default PR/main callers keep `build: "true"`.
Fallback does not emit reusable desktop-v1 evidence: that profile still means the producer Check
and Test both executed under the recorded identities, including the default Check build.

## Temporary paired test-job trial

On pull requests only, Checks currently also runs two trial shards on the same candidate as the unchanged full Test
job. The optional `test-shard` input takes `index/count` (for example `1/2`) and skips the per-job
completeness gate; its caller must validate the merged reports. Each shard has independent setup and
an artifact labelled by shard and attempt. Their union must pass the candidate completeness gate,
and both shard jobs must succeed. Release evidence still comes only from the unchanged full Test
job; pushes to main and release calls skip the trial.

For a new measurement use **Re-run all jobs**. The collector refuses an attempt without both
reports from that attempt and gives this instruction. A partial rerun can diagnose a failure but
cannot recover the union or count as a matched timing sample. Never combine reports or timings
across attempts. Compare all setup, report upload and post-job teardown, queue gaps, union
collection, downstream evidence and every applicable non-trial PR check. Keep two jobs only for
at least 30% faster end-to-end PR green with at most 20% additional combined Test runner minutes;
report the extra collector cost too. Otherwise remove the trial and retain one job. Boat timings
alone cannot establish GitHub latency. Later suite/input changes invalidate the measured result.

For the full PR-green comparison, read every check run and commit status on the exact PR head,
plus the branch rules' required checks. Keep hosted review and other applicable validation in
both paths and exclude experimental jobs from the one-job path. Record job creation/start/end
and step times, including collector install and post-job steps. The existing evidence job waits
for full Test: model the split path with the union completion plus the observed evidence-job
queue and duration. Label this counterfactual path as modelled, not an independently observed
split PR-green timestamp. A later hosted review or unrelated check can erase the test speedup.
