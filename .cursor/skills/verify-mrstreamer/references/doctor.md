## Doctor

`pnpm verify:desktop doctor` is a read-only preflight. It reports app version, Git revision, the built main bundle's SHA-256, executable, ffmpeg/ffprobe versions and display availability. It does not launch the app or prove a live session healthy. A changed source tree requires a fresh build; a hash does not establish that source and output agree.

Every scenario also runs a live doctor before driving and after success. It checks that the owned process is alive, that CDP's browser arguments name our profile, port and app directory, and that the renderer URL belongs to our build. A surprising result ends the session with retained failure evidence and cleanup. Diagnose the output, run preflight again, correct the demonstrated problem and start a fresh scenario. Never attach to an unverified daily-driver instance.
