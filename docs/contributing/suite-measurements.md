# Complete default-suite measurements

This command supports POSIX hosts (Linux and macOS), where `pnpm` is directly executable.
Run from the repository root, after the frozen install, on the same hardware and with the
same effective worker policy for both revisions:

```sh
node scripts/measure-suite.ts --output .local/measurements/baseline-suite \
  --conditions 'shared host; fresh install; first compile cache cold; later runs warm; no cache purge'
```

The output's parent must exist. The output directory must be new and, when inside the checkout, gitignored. Default is five sequential
attempts, without warmup or automatic retry. A failed test, incomplete CI report or changed/unreadable
source identity stops the campaign, retains the attempt and suppresses its median. Do not
replace a failed capture with a successful one. Investigate it and retain its disposition before
starting a separate campaign. Smaller `--runs` captures are diagnostic, not five-run acceptance.

Each run invokes the complete default `pnpm test`, adding reporters only. Wall time starts
before pnpm is spawned and ends after it exits, including global setup and reporter overhead.
CI completeness validation runs afterward and is reported separately from suite wall time.
Nothing overrides workers, retries, timeouts or discovery. The reporter records Vitest's
resolved worker cap and pool; this is not a measurement of simultaneously active OS workers.
JSON's per-file start/end times describe overlapping file durations, not additive wall-time
savings. Compare repeat medians using exactly the same capture command on both sides.

`environment.json` pins source revision, source diff hash, untracked-file hashes, test paths/hashes, policy inputs,
runtime/CPU identity, declared cache conditions and runner environment override hashes. Each
`run-N` retains raw stdout/stderr, Vitest JSON, resolved policy and outcome/validation receipt.
`summary.json` reports success count and median only for a complete requested campaign.
Retain original outputs and SHA-256 receipts outside mutable build output before review.
Logs contain test fixture diagnostics. Inspect them for private data before publishing.

This command does not freeze app/network budgets, prove native-phone performance, classify
all maintained support code or establish the independent 50% footprint and 25% suite-time
release gates. New collector/reporter code counts in the tooling partition's final footprint.
Use the existing `measure-app.ts`, `compare-builds.ts` and profiling probes for app measurements.
