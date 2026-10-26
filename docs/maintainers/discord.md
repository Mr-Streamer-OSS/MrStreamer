# Discord community

Wout owns the public Mr. Streamer server and moderates initially. The Moderator role gives trusted helpers View Channels, Read Message History, Manage Messages, Moderate Members, Kick Members and Ban Members. Leave Administrator and server, role and webhook management off.

## Server setup

Enable Community in Server Settings, with verified email and media scanning for all members. Set `#start-here` as the rules channel and private `#moderators` as the Community Updates destination. No bot or hosting is needed.

| Channel       | Type         | Ordinary members |
| ------------- | ------------ | ---------------- |
| `#start-here` | Text, rules  | Read             |
| `#releases`   | Announcement | Read             |
| `#nightly`    | Announcement | Read             |
| `#general`    | Text         | Read and write   |
| `#help`       | Text         | Read and write   |
| `#moderators` | Private text | Hidden           |

In the three read-only channels, allow View Channel and Read Message History; deny Send Messages, Send Messages in Threads, Create Public Threads and Create Private Threads for `@everyone`. In `#moderators`, deny `@everyone` View Channel and allow Moderator View Channel and Send Messages. Check category and other role overrides too. Helpers do not need permission to post release announcements.

In Server Settings > Roles, turn off **Mention @everyone, @here and All Roles** for `@everyone` and Moderator. Set the server default notifications to Only @mentions. Members choose their own channel notifications. Do not use `@everyone` or `@here` pings. Cross-server **Publish** stays manual; webhook delivery does not publish to followers.

Post and pin this welcome in `#start-here`:

> Welcome to Mr. Streamer. Get the app: https://mrstreamer.app/download
>
> Be kind. No spam, piracy requests or sharing subscriptions, credentials, provider addresses, stream URLs or viewing history.
>
> Chat in #general, ask questions in #help. #releases has Stable updates; #nightly has previews. Choose notifications per channel.
>
> Report reproducible bugs with your app version, system and steps: https://github.com/Mr-Streamer-OSS/MrStreamer/issues/new/choose

After Community is enabled, create an invite to `#start-here`: Create Invite > Edit invite link > Expire After **Never**, Max Number of Uses **No limit**, temporary membership **off**. Verify a real ordinary member can join, read the three read-only channels, write in general/help and cannot see moderators before putting the invite in README. Role preview alone does not prove joining works.

## Release webhooks

For each release channel: Edit Channel > Integrations > Webhooks > New Webhook. Check its channel, save and copy the URL privately. Install these **repository Actions secrets on GitHub**, `Mr-Streamer-OSS/MrStreamer`, where releases run:

- `DISCORD_STABLE_WEBHOOK_URL`: `#releases`
- `DISCORD_NIGHTLY_WEBHOOK_URL`: `#nightly`

The GitCafe source mirror does not run GitHub Actions. No new PAT is needed. Never commit or log webhook URLs; possession allows posting. To rotate one, create a replacement in the same channel, replace its GitHub secret, verify delivery and delete the old webhook in Discord. Remove the secret to disable that channel's announcements.

`publish.yml`'s Discord job runs only after its GitHub release job succeeds, including the nightly published first during a stable run. Both callers inherit secrets. Dry runs never call the publisher; skipped or failed publication sends nothing. Feed, Store and website results do not control announcements. A message means the GitHub notes/downloads are available, not that every distribution surface has updated.

`scripts/discord-release.ts` selects only that channel's webhook and posts the channel, version and GitHub release page. Mentions are explicitly suppressed with `allowed_mentions: { parse: [] }`. The single request waits for server confirmation, has a ten-second timeout and follows no redirects. Missing configuration, HTTP errors and network timeouts warn without failing publication. The job also tolerates infrastructure failures, so Discord cannot fail a nightly-first publisher and block stable. It can add up to its two-minute job timeout while GitHub waits for the reusable publisher to finish.

There are no automatic retries. A timeout may have delivered the message: inspect the channel before retrying, or rerunning the Discord job. Rerunning a successful announcement job can duplicate its post. Do not rerun publication or publish a release to test Discord.

## Setup proof

For a labelled delivery check without publishing anything, privately supply the two webhook environment variables, then run the script with Node 24 once per channel with `--test`, `CHANNEL`, `VERSION`, `TAG` and `GITHUB_REPOSITORY=Mr-Streamer-OSS/MrStreamer`. Use existing published release tags and versions. Keep webhook values out of terminal history and recordings. Confirm both `[Setup test]` messages appear in the intended channels, link the correct release pages and create no mentions. Do not cross-server Publish test messages.

Record the permanent invite, member join/access result and two test message links on the existing project card. These live checks are separate from the local webhook stub tests, which prove delivery payloads, routing, warnings and bounded failure handling.

References: [Community requirements](https://support.discord.com/hc/en-us/articles/360047132851-Enabling-Your-Community-Server), [invites](https://support.discord.com/hc/en-us/articles/208866998-Invites-101), [announcement channels](https://support.discord.com/hc/en-us/articles/360032008192-Announcement-Channel-FAQ), [webhook execution](https://docs.discord.com/developers/resources/webhook#execute-webhook).
