# Downloads

Read only the area needed for the changed path.

- For desktop downloads baseline, read [Desktop downloads baseline](downloads/desktop.md).
- For desktop download controls, read [Desktop download controls](downloads/controls.md).
- For desktop download service contracts, read [Desktop download service contracts](downloads/contracts.md).
- For iOS downloads, read [iOS downloads](downloads/ios.md).
- For android bulk downloads and offline Next, read [Android bulk downloads and offline Next](downloads/android.md).
- For desktop pause and order, read [Desktop pause and order](downloads/queue.md).
- For desktop series copies and offline Next, read [Desktop series copies and offline Next](downloads/series.md).
- For copied-video recovery and codecs, read [Copied-video recovery and codecs](downloads/playback.md).
- For desktop layout and progress profiling, read [Desktop layout and progress profiling](downloads/layout-performance.md).
- For default local-copy progress, read [Default local-copy progress](downloads/progress.md).
- For background downloads and Close/Quit, read [Background lifecycle](downloads/background.md).

## Desktop managed folders and selected controls (0.0.24)

The public Downloads commands expose the selected household folder, move selected finished copies, cancel an in-flight move, and pause, resume, retry or remove explicit selections. Folder selection affects future transfers; existing copies move only on request. Commands return a failure rather than success for unavailable destinations or failed writes. Bulk results name successful and failed IDs separately.

Use an isolated profile and disposable folders. Keep a movie with subtitles and artwork plus an unrelated episode and recording. Choose a folder, relaunch and check the choice. Move only the movie, watch it offline and verify its exact ID, details, artwork, subtitles and private resume position. Cancel a move, then disconnect the destination during cleanup and relaunch: the original must remain playable; after reconnection and restart retry the move. Repeat with a missing, full and read-only destination. Bulk-delete only the movie and verify the episode, recording and personal progress remain. Verify picker cancellation, keyboard selection, confirmation, readable error/retry controls and every supported translation when the UI is integrated.

Source proof lives in `apps/desktop/test/downloads.test.ts` through the public Downloads command seam, with real temporary files and fake provider media. Full/read-only write failures are injected at the filesystem call; they do not qualify physical removable drives. Recovery proof retains the persisted interrupted-target marker after failed cleanup and restarts the runtime. Directory flushing is used on Unix; Windows flushes copied files but cannot open directories for flushing through this implementation. Native Windows/macOS, physical disk loss, power loss and the integrated UI require separate runs. No native or UI acceptance follows from command tests alone.
