# Microsoft Store setup

> For maintainers. The [slice 6 handoff](slices/06-everyday-viewing-and-release-readiness.md) owns the product scope and acceptance; this runbook owns the Partner Center steps, the package identity and the private submission checklist.

Status: planned for slice 6; nothing is configured or submitted yet. Checked against Microsoft's documentation on 2 October 2026. Check the current dashboard and rules while setting up.

Goal: a Windows x64 MSIX that a private test audience installs through the Store. The direct-download EXE and GitHub releases carry on as they are. Making the app public in the Store is a later launch action.

## Ownership and order

An agent prepares the package, manifest, assets, notices, certification notes and validation. Wout verifies his identity, accepts the agreements and chooses the publisher details. Secrets and local state stay out of tracked files, and identity documents, testers' email addresses and credentials never go into chat, logs or public artifacts.

Set up the account and reserve the name early, so packaging can use the real identity. The privacy, transport, content and licence gates must pass before submitting. A Store approval isn't legal clearance for the app.

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

Prepare an accurate Entertainment listing: the Windows versions and languages actually supported, lawful screenshots and artwork, a support contact and the public privacy policy URL. Say early that the app supplies no channels or subscriptions and needs the user's own provider. Answer the IARC age rating and capability questions honestly. Wout kept HTTP compatibility and asked to clarify the dedicated adult tab first, so get Microsoft's guidance on both before declaring compliance. A warning about HTTP doesn't by itself meet the secure-transmission requirement, and any restriction Microsoft requires goes back to Wout to decide.

Give certification instructions and a reliable, lawful demo provider and account that exercise live TV and on-demand playback. Never give Microsoft Wout's own subscription. An agent prepares the fixtures and hosting instructions; deploying a demo service needs an authorized destination. Submit the app's real capabilities instead of hiding some for review.

Use the publishing hold options so nothing becomes available by accident. Wout confirms the private audience and approves the exact package and submission before it's submitted or released to testers. This slice authorizes no public Store publication.

Done: the prepared submission holds a validated package and a complete listing, policy, ratings and reviewer instructions, and its visibility is verified private.

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

| Step                                  | State       | Evidence needed                                        |
| ------------------------------------- | ----------- | ------------------------------------------------------ |
| Publisher account                     | Not started | Verified access to Apps & Games                        |
| App reservation and identity          | Not started | A valid package identity and configuration             |
| MSIX and certification kit            | Not started | The artifact's commit, its source and the kit's result |
| Privacy, content, transport, licences | Not started | The policy URL and the recorded decisions              |
| Private submission                    | Not started | The right audience and a completed certification       |
| Store install and update              | Not started | Wout's acceptance on Windows                           |
| Automated publishing                  | Deferred    | Set up in the later launch slice                       |
