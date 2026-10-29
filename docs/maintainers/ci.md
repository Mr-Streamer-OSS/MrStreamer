# CI: what runs when

> For maintainers. [Releasing](releasing.md) has the release policy; [testing](../contributing/testing.md#ci) describes acceptance.

The operational workflow set is Checks, Release and Website.

- `checks.yml` validates every PR and push to main. Check always reports and includes the desktop production build. Test and Website use conservative input selection; unknown inputs run both. Main validates its actual merged source. PR evidence is diagnostic only.
- `release.yml` plans one candidate, authenticates prior Checks evidence or runs secretless fallback, builds one versioned shared JS bundle, packages native targets and sources, performs installed checks, then publishes when authorized by the selected operation. Dry runs publish nothing.
- `website.yml` owns website builds and publication. A workflow-only merge cannot deploy the production website. A stable version commit receives an explicit Website handoff after finalization because workflow-token pushes start no new workflow.

## Candidate and validation

Plan resolves the full product source SHA, version and tag once. Stable requires an explicitly tested published nightly and rebuilds that source with the Stable version even when main has newer commits. It never builds a second nightly. Promotion ancestry and version ordering remain checked by the planner and Windows upgrade resolver.

Release's validation job searches exact-source main push Checks runs. It waits at most five minutes for an in-flight match. Reuse requires API-authenticated repository, event, branch, workflow, source, conclusion and current attempt, unexpired immutable artifact identity, trusted main ancestry, identical trusted validation tooling and matching effective input/toolchain/image identities. Missing, failed, cancelled, foreign, expired or incompatible evidence runs fallback. Signed/versioned packages never satisfy source validation.

Fallback runs the shared validation action with separate Check and Test jobs and their existing 10/15-minute bounds. Only the Check production build is omitted: Release's required final versioned bundle supplies that build. PR/main Check keeps its default build. Test retains default discovery, workers, retries, timeouts, multimedia setup, JSON report and candidate completeness gate. See the [shared action contract](../../.github/actions/validation/README.md).

The bundle is built once per candidate. macOS/Linux and Windows package independently after it. MSIX begins after Windows, without waiting for the other platforms. Stable installed-upgrade proof runs beside packaging and gates publication. Source archives, receipts, checksums, native integrity, signatures, app and DMG notarizations, installed checks and their historical version guards remain mandatory as documented in [releasing](releasing.md).

## Operations

| Operation         | Entry point                                                          | Result                                                                                                                           |
| ----------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Automatic nightly | Daily 03:17 UTC                                                      | Latest nightly published on an earlier UTC day, only desktop release-input changes across the full range; unknown inputs qualify |
| Manual nightly    | Release on main, operation release, channel nightly                  | Immediate one-candidate build                                                                                                    |
| Stable            | Release on main, operation release, channel stable, nightly selected | Rebuild selected source, upgrade proof, publish                                                                                  |
| Dry run           | Same-repository PR label `release dry run`, or manual dry-run        | Signed nonpublishing packages, UI proof, MSIX and receipts, kept 14 days                                                         |
| Feed repair       | Release on main, operation feed                                      | Regenerate existing releases' feed without packaging; allow-regress is explicit                                                  |
| Store             | Release on main, operation store                                     | Preflight/status/submit an existing release package; no rebuild                                                                  |
| Installed upgrade | Release on main, operation upgrade, candidate tag                    | Disposable Windows installed proof, no publication                                                                               |
| Website           | Website workflow                                                     | Independent build/delivery; stable finalization explicitly calls it                                                              |

Nightly and Stable share the release queue. Dry runs queue per PR/branch. Maintenance runs do not block packaging, and feed, Store and installed-upgrade jobs retain independent noncancelling serialization. A failed publication can leave an unpublished draft; rerunning removes only that unfinished attempt. After GitHub publication, feed and Discord failures do not undo the release. Store and website have separate outcomes.

## Trust and permissions

Product build/scripts/tests and receipts come from the candidate. Validation and setup tools come from the reviewed workflow SHA, in separate full validation or scoped `.workflow` checkouts. Privileged publication jobs run workflow tools, never arbitrary fork validation code. Source validation jobs have read-only access; validation lookup additionally reads Actions artifacts.

The bundle reads TMDB and public analytics inputs; dry runs compile capture off. Only macOS signing reads signing/notarization secrets. Feed retains the `github-pages` environment and Pages permissions. Store preflight checks its kill switch and branch restrictions before any job names `microsoft-store`; only its final step reads the credential. Website retains its own `marketing-production` environment. No settings, secrets, apps or runner installation is required by this graph change.

`pnpm actionlint` checks the workflow and shell contracts. `test/release.test.ts` covers public planning/publication rules; `test/publication-guard.test.ts` evaluates real publication job conditions, skipped fallback handling, failures, PR/dry-run boundaries and the independent Website decision steps. Source checks and local proof do not establish actual publication integration. That requires separately approved maintainer acceptance.

Changes to Release workflow or shared packaging actions require a signed nonpublishing PR dry run
on the final reviewed head before merge acceptance. A PR head cannot prove main-push validation
reuse; retain that actual Checks-to-Release handoff on the maintainer acceptance card for the next
approved operation, without publishing solely to fill proof.

Test JSON reports remain seven days. Dry-run packages, receipts and native/UI evidence remain
14 days. Published-run packages/receipts stay three days, with Store packages 90 days; the shared
JS bundle stays one day. Failed native profiles keep their existing seven-day bounds.

| Workflow/operation | Inputs                                                               | Credentials and environments                                                                                            |
| ------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Checks             | Called legacy contract: sha, report-name                             | Read-only source; Website part reads release history                                                                    |
| Release candidate  | operation=release, channel, nightly, version, dry-run                | Bundle TMDB_API_KEY; POSTHOG_PROJECT_TOKEN/HOST only enable capture outside dry runs                                    |
| macOS packaging    | Resolved candidate source/version                                    | MAC_CERTIFICATE_P12/PASSWORD, APPLE_API_KEY_P8/ID/ISSUER, APPLE_TEAM_ID                                                 |
| Feed maintenance   | operation=feed, allow-regress                                        | Read contents, write Pages/id-token; github-pages environment                                                           |
| Store maintenance  | operation=store, store-action, version, draft, draft-metadata-sha256 | STORE_AUTOMATION_ENABLED; microsoft-store holds STORE_CLIENT_SECRET and STORE_TENANT_ID/CLIENT_ID/CLIENT_SECRET_EXPIRES |
| Installed upgrade  | operation=upgrade, candidate, candidate-sha, native_case             | Read-only, no secrets; focused coverage is maintenance-only                                                             |
| Website            | deploy                                                               | MARKETING_DEPLOY_ENABLED and public analytics variables; marketing-production holds VERCEL_TOKEN/ORG_ID/PROJECT_ID      |

Maintenance with dry-run selected deliberately performs no operation and remains green. Choose
operation=release for signed nonpublishing packaging proof. The MSIX checksum is exposed only
after installed acceptance, upload and receipt succeed, independently of job-level error tolerance.
