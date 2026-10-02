# Microsoft Store setup

> For maintainers. The [slice 6 handoff](slices/06-everyday-viewing-and-release-readiness.md) owns the product scope and acceptance; this runbook owns the Partner Center steps, the package identity and the private submission checklist.

Status: Wout opened the publisher account and reserved Mr. Streamer on 2 October 2026; the [package identity](#package-identity) is below. [Submission 1](#submission-1), package `1.0.4.0` from Stable 0.0.4, was submitted the same day for a private audience and is in certification. Checked against Microsoft's documentation and dashboard on 2 October 2026. Check the current dashboard and rules while setting up.

Goal: a Windows x64 MSIX that a private test audience installs through the Store. The direct-download EXE and GitHub releases carry on as they are. Making the app public in the Store is a later launch action.

## Ownership and order

An agent prepares the package, manifest, assets, notices, certification notes and validation. Wout verifies his identity, accepts the agreements and chooses the publisher details. Secrets and local state stay out of tracked files, and identity documents, testers' email addresses and credentials never go into chat, logs or public artifacts.

Set up the account and reserve the name early, so packaging can use the real identity. The privacy, transport, content and licence gates must pass before submitting. A Store approval isn't legal clearance for the app.

`scripts/setup-microsoft-store.sh` walks Wout through what's left for him in Partner Center: verifying the notification email, creating the testers' group, and the private submission from its readiness check to Submit for certification. Run it from a checkout. It resumes where it stopped, `--list` shows each stage and whether it's done, and a stage's number or name, such as `scripts/setup-microsoft-store.sh submit`, runs that stage again. It keeps its progress in the gitignored `.local/` and never asks for a password, an identity document or a tester's address.

## 1. Create the publisher account

Start at [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com/) and follow Microsoft's [account setup guide](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account). That page is the only entry to the new onboarding flow, which is free; Partner Center, Xbox and Visual Studio lead to the legacy flow. If a fee appears, check the entry point before paying anything.

Wout describes Mr. Streamer as a non-commercial hobby project, so start with an Individual developer account in Belgium, on a personal Microsoft account with multi-factor authentication and recovery set up. A work or school account can't open an Individual account. Complete the ID and selfie verification privately in Microsoft's flow, and give accurate publisher and contact details. If distribution is actually connected to a business, trade or profession, choose Company instead. Microsoft doesn't support turning an Individual account into a Company one, so settle who owns the app before accepting the setup.

Done: the verified account opens Partner Center's Apps & Games workspace. Record only the non-secret identity and configuration the package needs. Registration, identity checks and agreements are Wout's steps.

## 2. Reserve the app and record its identity

In Apps & Games, create a new MSIX or PWA app, reserve Mr. Streamer if it's available, and open Product management > Product identity. Name availability isn't trademark clearance. If the reservation fails, propose alternatives to Wout.

Record the Store ID, the package identity name, the publisher identity, the publisher display name and the package family name. The manifest uses Partner Center's exact identity; never invent a publisher distinguished name. Keep the direct app's identity as it is, and document how the two distributions relate.

Done: the product is reserved and the packaging configuration validates against its actual identity. Microsoft removes a reserved name that isn't used within three months; check the current rule rather than assuming the reservation lasts.

Reference: [Store onboarding and name reservation](https://learn.microsoft.com/en-us/windows/apps/publish/get-started).

## 3. Prepare and validate the MSIX

The release workflow builds the package with electron-builder's `appx` target, for dry runs and stable releases, and checks it installed; [releasing](releasing.md#microsoft-store-package) describes the job, the identity it uses and how Store versions are numbered.

- Choose a maintained packaging path that fits the existing Electron bundle; look at current tooling before adding a second app framework. Configure Windows x64 desktop support, the logos, the manifest and the full-trust capabilities the app needs.
- Keep MSIX build and test artifacts apart from the direct-download update feed. Start with an opt-in packaging or dry-run path, so unfinished Partner Center setup can't break the direct nightlies. Building a package never submits it.
- Bundle the actual FFmpeg and ffprobe, the third-party notices, the app's own GPL text and the source references. Test that data is written outside the read-only install directory, and test safeStorage, in a real packaged app.
- Map the GitHub semver to the Store's numeric package version deterministically, always increasing. A nightly label never goes into the numeric manifest version. Keep the exact source commit for each package, and keep data readable by the newest stable release.
- Validate install, launch, the provider connection, live and on-demand playback, child processes, and uninstall and its data. Run the Windows App Certification Kit and record its result.
- Verify that a Store installation is detected and that the update actions are Store-aware. The direct EXE flow stays separate. Test both installed side by side, and any proposed data import, explicitly; never overwrite an existing profile silently.

Microsoft signs MSIX and AppX packages the Store delivers, after certification. A local development certificate can help test a package in isolation but proves nothing about Store trust, and doesn't make direct downloads warning-free. MSI and EXE submissions need the publisher's own trusted signature, so they aren't the low-cost route chosen here. Don't buy a certificate for Store-only signing.

References: [package upload](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/upload-app-packages), [MSIX certification](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-certification-process) and the [distribution and signing overview](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app).

## 4. Prepare a private submission

Create a free submission with Private audience under Pricing and availability > Visibility. Add Wout's and the chosen testers' personal Microsoft account addresses to a known user group in the dashboard, and keep those addresses private. An unlisted public product isn't a private test, and a product first submitted as Public can't switch to Private later. Leave "Make this product public on" unset.

Prepare an accurate Entertainment listing: the Windows versions and languages actually supported, lawful screenshots and artwork, a support contact and the public privacy policy URL. Say early that the app supplies no channels or subscriptions and needs the user's own provider. Answer the IARC age rating and capability questions honestly. Wout kept HTTP compatibility and asked to clarify the dedicated adult tab first, so get Microsoft's guidance on both before declaring compliance. A warning about HTTP doesn't by itself meet the secure-transmission requirement, and any restriction Microsoft requires goes back to Wout to decide. For submission 1, Microsoft support approved both, and the Individual account, as Wout reports; [submission 1](#submission-1) has the details.

Give certification instructions and a reliable, lawful demo provider and account that exercise live TV and on-demand playback. Never give Microsoft Wout's own subscription. The notes for certification refuse links and credentials, so name where the demo lives instead of linking it. An agent prepares the fixtures and hosting instructions; deploying a demo service needs an authorized destination. Submit the app's real capabilities instead of hiding some for review.

Use the publishing hold options so nothing becomes available by accident. Wout confirms the private audience and approves the exact package and submission before it's submitted or released to testers. This slice authorizes no public Store publication.

Done: the prepared submission holds a validated package and a complete listing, policy, ratings and reviewer instructions, and its visibility is verified private. The wizard's last three stages walk through this section.

References: [create a submission](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission), [private audience](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/visibility-options) and [publishing holds](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/manage-submission-options#publishing-hold-options).

## 5. Test the real Store delivery

Once the private submission is certified and published, sign in to the Microsoft Store with an allowed personal account and open the private listing link. Install without trusting a development certificate by hand. On Wout's PC, verify the Store's signature, the launch and the bundled playback resources.

Submit a later private package with a higher numeric version. Check that the Store update keeps the login, preferences, favourites and viewing progress, and that the app never runs the direct EXE updater. Install it beside an existing direct build and document which profile each one owns. Unsupported or unavailable controls must say so honestly.

Done: a real private install and update are recorded. Anything waiting on account verification, certification or Wout's testing stays pending; a generated MSIX doesn't stand in for this evidence.

## 6. Prepare later automation without turning it on

Store publishing automation belongs to the later launch and distribution slice. Slice 6 records the prerequisites and keeps package creation reproducible. Don't create credentials nobody uses yet, or connect nightlies to Store publication.

When the time comes, associate a Microsoft Entra tenant with Partner Center, register an application and grant it the documented submission role. Put the tenant id, client id, publisher or seller id and a short-lived, renewable client secret in the matching protected GitHub environment, and keep the secret's value out of files and logs. Complete the first submission by hand, and confirm what the chosen CLI or API needs for a first publication, before automating updates.

Use Microsoft's Store Developer CLI and its GitHub Action, or the submission API, with an explicit private or public destination and promotion of the tested commit. Certification still applies. Document when the credentials expire and how to revoke them, and never edit a submission the API manages in the dashboard at the same time.

References: [GitHub Actions for Store updates](https://learn.microsoft.com/en-us/windows/apps/publish/msstore-dev-cli/github-actions) and the [submission API](https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions).

## Setup record

Update this table as work happens. Never record secrets or personal verification data.

| Step                                  | State                                     | Evidence                                                                                                                         |
| ------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Publisher account                     | Done, 2 October 2026                      | Apps & Games access verified                                                                                                     |
| App reservation and identity          | Done, 2 October 2026                      | Mr. Streamer reserved; the identity below                                                                                        |
| Notification email                    | Verified, 2 October 2026                  | Action Center > My Preferences                                                                                                   |
| MSIX and certification kit            | Validated, 2 October 2026                 | `1.0.4.0` from `3cfa1e3`, run 36998968726: identity and contents checked, installed test-signed, kit PASS                        |
| Privacy, content, transport, licences | Done for the private test, 2 October 2026 | The policy live at `https://mrstreamer.app/privacy`; Microsoft's guidance received; the [readiness record](release-readiness.md) |
| Private submission                    | Submitted, 2 October 2026                 | Private audience with the testers' group, publishing hold set; in certification                                                  |
| Store install and update              | Pending                                   | Install from the testers' link once certified, then 0.0.5 as `1.0.5.0`; Wout's acceptance on Windows                             |
| Automated publishing                  | Deferred                                  | Set up in the later launch slice                                                                                                 |

### Package identity

Copied from Partner Center's Product identity page on 2 October 2026. These values are public: every package carries them, and the MSIX packaging uses them exactly.

| Value                                   | Mr. Streamer                              |
| --------------------------------------- | ----------------------------------------- |
| Package/Identity/Name                   | `MrStreamerOSS.Mr.Streamer`               |
| Package/Identity/Publisher              | `CN=A132E842-C4C9-40BF-83C4-D304E7952C2D` |
| Package/Properties/PublisherDisplayName | `Mr Streamer OSS`                         |
| Package family name                     | `MrStreamerOSS.Mr.Streamer_5yzg1erdm3xmr` |
| Store ID                                | `9N45GG76ZP4T`                            |

The publisher display name has no period on purpose: Partner Center doesn't allow one there.

Submission 1 went in on 2 October 2026, within the three months the reservation allows. Testers signed in with an account in the group install from the private link, `https://apps.microsoft.com/detail/restricted/9N45GG76ZP4T`, once the submission is published. Public listing links come with the public launch.

## Submission 1

Wout entered submission 1 on 2 October 2026 from an agent's drafts, and sent screenshots of each page. Where his screenshots didn't show the final text, the entries below are the drafts he entered from. The testers' addresses are recorded nowhere but Partner Center.

### Pricing and availability

- Markets: every market, and future ones, as Partner Center proposes.
- Visibility: Private audience, with the known user group of testers' personal Microsoft accounts. "Make this product public on" stays unticked. Discoverability shows "available but not discoverable, direct link only", which applies to the private audience only.
- Pricing: Free in all 240 markets of the default group, with no trial and no sale. Organizational licensing keeps its defaults: volume acquisition allowed, offline licensing not. Neither limits what the GPL grants.

### Properties

- Category Entertainment, no subcategory.
- "Yes, my product uses personal information", with `https://mrstreamer.app/privacy`. Website `https://mrstreamer.app`, which redirects to GitHub for now. Support contact hello@mrstreamer.app, without a phone number or address.
- The display mode trap: Properties had "This experience is designed to run in an immersive (not 2D) view on Windows Mixed Reality" ticked for PC. That declares a Mixed Reality headset app, and Partner Center then demanded headset hardware under System requirements. Untick it for PC and HoloLens.
- "Windows can include this app's data in automatic backups to OneDrive" is off. The policy and listing say the data stays on the PC, and a password sealed with the Windows account couldn't be opened elsewhere anyway.
- The accessibility claim is off, since nobody has tested it. Installing to other drives stays on. No external purchases, drivers or NT services.
- No system requirements are set.

### Age rating

The IARC questionnaire, for "All Other App Types", got honest answers. Online Content is Yes, since the app plays whatever the user's provider sends. Downloaded app content, user content sharing, age-restricted products, location sharing, digital purchases, cash rewards, web browsing, and news or education are all No. The follow-ups for online content answer Yes to violence, sexuality, language and controlled substances, shown and spoken, with none as the app's purpose, and Yes to every strength of language.

The result is 18+ everywhere: IARC 18+, PEGI 18, USK 18, DJCTQ 18 and Microsoft 18+, and ESRB Adults Only, since any visual sexual material scores as explicit there. Policy 11.11.2 asks for an accurate rating, and rating too high breaks no rule.

An alternative for later, before the public launch and ideally after asking Microsoft: policy 11.11.3 allows content above the app's own rating when the user opts in by signing in with an existing account. The user's own provider login could count as that opt-in, with Online Content answered No and a low rating as a result, which is likely how general players such as VLC and Kodi are rated.

### Package

`Mr-Streamer-0.0.4-win-x64.msix`: package `1.0.4.0`, x64, Windows.Desktop, from `3cfa1e3`, built by release run 36998968726, certification kit PASS.

### Listing

English (United States) only, entered from these drafts:

- Product name Mr. Streamer. Short description: "A clean, fast player for the IPTV subscription you already have. Live TV with a programme guide, movies and series with resume and next episode, every sound and subtitle track. Bring your own provider; no channels included."
- The description starts with what the app needs, as policy 10.2.4 asks: "Mr. Streamer plays the IPTV subscription you already have. It supplies no channels, playlists or subscriptions: you connect your own provider's Xtream Codes login or playlist link." Four points follow (live TV, movies and series, the mini player and subtitle controls, free and open source under GPL-3.0), then where the login is kept with the privacy policy's address, and TMDB's notice.
- Features: live TV with a programme guide and favourites; movies and series with resume and automatic next episode; every sound and subtitle track, teletext and captions included; one row per channel with a choice of quality; a mini player on top; Xtream Codes logins and M3U playlist links.
- What's new: "First release in the Microsoft Store."
- Screenshots: the README's three, from the fake provider with made-up titles, at 2560 × 1600. The listing has to stay suitable for PEGI 12 (policy 11.1), although the app is rated 18+.
- Search terms: IPTV, IPTV player, Xtream Codes, M3U, Live TV, TV guide, EPG.
- Copyright "Copyright © 2026 Wout Stiens", as in the app and package. Developed by Mr Streamer OSS.
- Additional license terms carry the source offer: the app is free software under GPL-3.0-only, with links to `LICENSE` and to the releases, which hold every version's source. Without them, Microsoft's Standard Application License Terms would apply, and they conflict with the GPL ([readiness](release-readiness.md#7-store-licence-terms-and-copy-protection)).
- No short, voice or sort title. No trailer yet; one is being made for a later submission.

### Submission options

- Publishing hold: "Don't publish this submission until I select Publish now".
- The `runFullTrust` justification, entered from this draft: Mr. Streamer is an Electron app, which runs as a full-trust Win32 process, and every Electron app packaged as MSIX needs the capability. It starts its bundled ffmpeg and ffprobe as child processes and serves playback through a local proxy on 127.0.0.1. It installs no drivers or services, doesn't start with Windows and writes only to its own data folder.
- Notes for certification live under Supplemental info > Additional Testing Information. Its Description field won't save with a link in it, and its Credentials table refused the link too. So the notes say how to find the playlist instead: open the public repository Mr-Streamer-OSS/certification-playlist on GitHub, open `reviewer.m3u`, choose Raw and copy the address. Then connect with "Use an M3U link" and no login, and play any of the five channels: Al Jazeera English, DW English, DW Español, DW Arabic and ABC News Australia. The notes also say the demo is live TV only, without a guide, that Movies and Series need a provider that offers them, that titles and channels for adults stay hidden until Settings > General > For adults, and that the app asks before sending a login over http. No credentials were entered.

Submitted for certification on 2 October 2026; in certification (pre-processing) when last seen.
