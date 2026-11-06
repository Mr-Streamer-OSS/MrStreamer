## Cleanup

The helpers request `Browser.close` for their browser/app and SIGTERM for their preview server, wait for owned children and escalate only against owned PIDs/process groups. The desktop helper closes its fixture servers; both remove their temporary profile or scratch directory in `finally`, including failed runs. Evidence remains in `.local/verification/`; verify the named files still exist after teardown. An unkillable app is a cleanup failure and its profile must be retained for recovery. Interrupt with Ctrl-C for normal cleanup; forced termination cannot run `finally`.
