# Viewing profiles

Use local viewing profiles to keep each viewer's lists, progress and preferences separate. Default keeps the personal state saved before profiles were introduced, in its original files.

Each profile keeps its own favourites, recent channels, channel lists, Watchlist, movie and episode progress, watched marks, downloaded-copy and recording progress, and viewing preferences. Subtitle selection, Off and visibility are personal too.

Subscriptions, guides, downloaded files, recordings, subtitle timing and usage-statistics consent are shared by the installation. Switching stops interactive playback after saving its progress; household downloads and recordings continue.

Use the profile avatar in the window bar. Choose **New profile**, enter a name and choose **Add**. Choose another profile to switch. To delete an inactive profile, choose its trash button and confirm. Default and the active profile cannot be deleted. Deleting removes that profile’s lists, progress and settings while keeping household media. A failed deletion stays visible with Retry.

If configuration or a named profile's preferences cannot be read, the error stays visible. Retry attempts the durably selected profile again; the profile menu also lets you select another viewer. Unreadable named-profile files are kept without exposing their contents or replacing them with defaults. Default retains its older-file compatibility behavior.

Before returning to a release that supports only Default, switch to Default. A single-profile build that recognizes the registry refuses personal-copy progress when a named profile is active. Older builds read Default’s original files and cannot read another profile’s personal state. Installed downgrade compatibility after switching has not been verified.

To make a kids profile, create the profile, then choose **Manage profiles** in the profile menu while an adult profile is active. The first time, it asks you to set a PIN of 4 to 12 digits; after that it asks for the PIN before showing anything. Tick the box beside the profile under **Kids profiles**, then choose what it can open: search for channels, movies and series, and tick each one, and tick downloads and recordings in their lists. Each channel quality is a separate choice labelled with its provider name and subscription; approving it does not approve other or future streams. Nothing is approved until you tick it, and nothing changes until you choose **Save**. The active profile can't be changed there; switch to another adult profile first. Kids profiles show _Kids · allowed titles only_ in the profile menu, and **Manage profiles** is not offered while one is active.

Kids-profile restrictions are enforced by the desktop backend using explicit approvals. Online channels, movies and series are approved by subscription and provider ID; downloaded and recorded copies require separate approvals. A series approval includes its episodes. Default remains an adult profile. Once a PIN is configured, profile creation, deletion and policy changes require it, as does leaving a kids profile for an adult. Entering a kids profile or switching between kids profiles does not require the PIN.

The policy is kept in the installation database. An unreadable policy refuses content access and policy changes instead of guessing unrestricted access. A refused save keeps the previous policy for retry. Hidden household downloads, recordings and reminders continue; restricted content is withheld from public reads, playback opens and notifications. A wrong PIN is refused with the field cleared for another try.

There is no in-app recovery for a forgotten PIN or an unreadable policy. Retry only helps when the underlying read problem has been repaired. Keep the PIN somewhere safe. If access is lost, contact a maintainer for help with the installation data; do not delete the database or expect a restart to remove the restriction.
