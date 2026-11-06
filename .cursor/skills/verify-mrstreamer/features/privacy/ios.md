# iOS consent and diagnostics

For the desktop default referenced below, read [Desktop consent](desktop.md).

## iOS consent

The desktop default above is unchanged. iOS requires a deliberate opt-in through the selected
welcome B and native alert C. Add provider asks before the form; both answers continue. Back
cancels an unfinished login. Privacy policy and the no-provider Downloads entry stay usable.
Saved providers restore normally and undecided installs get the same alert after startup.
Settings changes the existing statistics owner's choice.

Run `pnpm exec vitest run apps/ios/test/telemetry.test.ts apps/ios/test/connect-form.test.ts
apps/ios/test/startup-root.test.ts` for the loopback request/upgrade/storage contracts and public
controls with native stand-ins. Deliberate beta On/Off stays; null-choice beta outbox, identity
and unfinished work must disappear before recovery or delivery and must not return on opt-in
or relaunch. Failed storage leaves collection off. These source tests do not prove native
alerts, keyboard, VoiceOver or hardware acceptance. Use the Mac mini/device workflow with an
isolated simulator for native controls and screenshots; physical-iPhone candidate acceptance
remains a separate release gate.

## iOS diagnostics

`diagnosticsText()` in `apps/ios/src/diagnostics.ts` is the text the viewer previews and shares themselves; nothing is sent. It is written from known kinds and counts only, laid out as the chosen design's report: app version and build, iOS version, the providers counted by kind, a section for each numbered provider with its channel and movie list states (error kinds, never their words) and account state, a TMDB section with whose key, its status and title counts, and when it was made. Provider addresses, logins, provider and title names, viewing history, file paths and the TMDB key are left out. `apps/ios/test/metadata-recovery.test.ts` builds it with a signed-in fake panel whose channel reload then fails unreachable, and checks none of their addresses, logins or labels appear. Settings > Privacy > Diagnostics opens `app/(tabs)/(home)/diagnostics.tsx` on the tab Settings is on: the text read as it opens, in monospace, and Share in the top bar, which hands React Native's `Share` exactly `{ message }` of that text. `apps/ios/test/diagnostics.test.ts` checks the row's route and that payload. The share sheet itself needs the Mac.
