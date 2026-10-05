# Project order

> For maintainers. How the [GitHub project](https://github.com/orgs/Mr-Streamer-OSS/projects/1) gets its Backlog, its release cards and its Order numbers.

`.github/workflows/project-order.yml` runs `scripts/project-order.ts` every hour. Each run does three things:

- It puts a [new draft](#new-drafts), one without a Status or a release, in the Backlog.
- It gives every release with unfinished work its own card, `Release 0.0.7`.
- It numbers the unfinished cards 1, 2, 3 and so on in the Order field, in the order to work on them, and clears the number of Done cards.

It writes Order, Backlog on a new draft, and the empty fields of a release card. It never changes a Status, Release, Blocked, owner or text that it read on a card, though it can overwrite an [edit made during a run](#edits-during-a-run). It builds, publishes and submits nothing. It is off until someone [sets it up](#setup).

## The order

1. Cards with a release that can go ahead, then blocked cards with a release, then the unscheduled Backlog.
2. Earlier releases first. 0.0.9 comes before 0.0.10.
3. Within a release: the owner's pins, then cards in Development, then every other stage, then the release's own card.
4. The number the card has now. Cards without one go last in their group, and equal numbers go by card id.

- A blocked card leaves the queue of work that can go ahead, whatever its pin or stage. It comes back when Blocked is cleared.
- Pins are the owner's explicit choices. `PINS` at the top of the script lists them by release and project item id. A pin counts while its card is planned for that release and not blocked. Change them with a pull request.
- A closed issue stays where its card's Status puts it. The script never asks GitHub whether an issue is open, so only moving the card to Done takes it out of the order.
- Archived cards keep whatever they hold.

## Moving a card

Type a number between the two cards it should sit between, such as 4.5 to go between 4 and 5. The next run renumbers.

A number moves a card within its group only. Its release, Blocked and stage decide the rest, so a card that should move further needs one of those changed.

## New drafts

A draft made on the board starts without a Status. The next run puts it in the Backlog and numbers it there, so a new idea needs only its title.

- A draft counts while its Release is empty or `Unscheduled`. Its Release, Blocked, owner and text stay as they are.
- A draft that names a version stops the run until someone chooses its Status, Planned or later.
- So does an issue or pull request without a Status. The run chooses a Status for drafts alone.
- A draft titled exactly `Release 0.0.10` is a [release card](#release-cards), and is set up as one.
- Archived drafts keep whatever they hold.

## Release cards

A release's own card is titled exactly `Release 0.0.7`. It holds the release checklist, the acceptance, the notes and the announcement.

When an unfinished card is planned for a version that has no such card, the next run adds one. It is a draft titled `Release <version>`, with that Release, Planned, Blocked, assigned to Wout, holding the checklist from `RELEASE_BODY` in the script. It sorts last in its release.

- Only versions on unfinished cards count. Unscheduled, Done cards and archived cards ask for nothing.
- An existing card counts whatever its state, Done and archived included, so a release that is out never gets a second card. Existing cards are never rewritten.
- Keep the title exact. A card renamed to `Release 0.0.7 checks` no longer counts, and the next run adds a new one.
- A card titled `Release 0.0.10` without a Release gets that Release, and keeps its Status and Blocked. That is also how a run that stopped halfway through adding a card is finished by the next one. Release is the last field written, so a card without it is known to be unfinished. In the Backlog such a card is an idea still, and stays as it is.
- A card titled `Release 0.0.10` whose Release names anything else stops the run. Fix the title or the field.

## What a card needs

| Field   | Unfinished cards                                                                                    |
| ------- | --------------------------------------------------------------------------------------------------- |
| Status  | Backlog, Planned, Development, Implemented or Tested. Only a [new draft](#new-drafts) may have none |
| Release | A version such as `0.0.7` from Planned to Tested. `Unscheduled` or empty in the Backlog only        |
| Blocked | `Blocked` or empty                                                                                  |

A card that doesn't fit stops the run before it writes anything, so the order never forms around a card it can't place. Done and archived cards can hold anything.

The run names such a card by its project item id, because the repository's logs are public and card titles are not. To see which card it is:

```sh
gh api graphql -f id=PVTI_... -f query='query($id: ID!) { node(id: $id) { ... on ProjectV2Item { content { ... on DraftIssue { title } ... on Issue { title url } } } } }'
```

## Setup

The project belongs to the organization, which a workflow's own token can't reach. The script uses a token made for this job.

1. Create a fine-grained personal access token. Resource owner `Mr-Streamer-OSS`, no repository permissions, organization permission **Projects: Read and write**, and an expiry date. The account needs write access to the project. The organization has to allow fine-grained tokens and may ask an owner to approve this one. A classic token with the `project` scope works too, and reaches every project that account can edit.
2. Store it. The command asks for the token, so it never lands in the shell's history:

   ```sh
   gh secret set PROJECT_AUTOMATION_TOKEN --repo Mr-Streamer-OSS/MrStreamer
   ```

3. Preview. Under Actions, run **Project order** on `main` with "apply" unticked. The run's page lists the drafts it would put in the Backlog, the release cards it would add and every number it would change.
4. Turn it on:

   ```sh
   gh variable set PROJECT_ORDER_ENABLED --body true --repo Mr-Streamer-OSS/MrStreamer
   ```

Any other value, or deleting the variable, turns it off again. Off, the hourly run is skipped and applying by hand is refused. A preview by hand still works.

A GitHub App with the organization permission Projects: Read and write could replace the token. Its tokens last an hour, so the workflow would need a step that requests one, which it doesn't have today.

## Running it

- Every hour, at 17 minutes past. GitHub can start scheduled runs late.
- By hand, from the Actions page. Unticked it previews, and with "apply" ticked it does what the hourly run does.
- On your computer, `node scripts/project-order.ts` previews with your `gh` login, which needs the `read:project` scope: `gh auth refresh -s read:project`. `--apply` writes, needs the `project` scope, and doesn't wait its turn behind a workflow run. Leave applying to the workflow.

Runs take turns and never overlap. Nothing is applied from an old preview. Applying reads the whole project again and plans from what it holds at that moment.

## When a run fails

| The run says                           | What to do                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The secret is missing                  | [Set it up](#setup)                                                                                                                                                   |
| Project order is off                   | Turn it on, or run a preview                                                                                                                                          |
| GitHub refused the request             | Usually an expired token or one without access to the project. Create a new one and store it                                                                          |
| A card can't be placed                 | Fix that card's [fields](#what-a-card-needs)                                                                                                                          |
| A card can't be read                   | GitHub hides that card's title from the token, so release cards can't be told apart. Give the token access to the card's repository, or take the card off the project |
| A card didn't show as set up           | Nothing. GitHub hadn't shown a new Status or a new release card yet, and the next run looks again                                                                     |
| The project has no field, or no option | The script expects Status with Backlog and Planned, Release, Blocked with Blocked, and Order. Restore it or change the script                                         |
| The project changed while it was read  | Nothing. A card was added or removed mid-read, and the next run reads again                                                                                           |
| The project was edited while written   | Nothing. The next run orders it again                                                                                                                                 |

A run that stops halfway leaves part of its changes written. That part is safe. Numbers are written in an order that keeps every card sorting as planned after each single write. The next run numbers a draft that reached the Backlog, and finishes a half-added release card.

## Edits during a run

GitHub can't write a value only where it is still the one that was read. A run plans from what it read and writes a moment later, so it overwrites an edit made in between to a field it writes:

- An Order typed during the few seconds a run writes the numbers.
- A Status chosen for a new draft between the run's read and its Backlog write. The Backlog write comes first, straight after the read, so that gap is about a second for the first new draft, and a request longer for each further one. The card says Backlog afterwards. If it was given a version as well, the run then fails and names the card, because a Backlog card can't hold a version.
- A Status, Blocked or Release filled in on a release card the run is setting up.

The board shows the overwritten value at once, so set it again.
