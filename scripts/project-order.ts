// Keeps the maintainers' GitHub project in working order: a new draft lands in the Backlog, every
// release with unfinished work has its own card, and the Order field numbers the cards in the
// order to work on them. docs/maintainers/project-order.md describes the rules and the setup.
//
//   node scripts/project-order.ts           report what would change, and write nothing
//   node scripts/project-order.ts --apply   write it: Backlog, release cards and Order values
//
// A draft made on the board has no Status. Without a release either it is a new idea, and gets
// Backlog. An issue, a pull request and a draft that names a version are given their Status by
// hand, and stop the run until then.
//
// A release's own card is titled "Release 0.0.7". A version on an unfinished card that no such
// card exists for, Done and archived ones included, gets one: a draft with the release checklist,
// Planned, Blocked and assigned to the owner. It is a card to tick off, and releases nothing.
//
// Unfinished cards get Order 1, 2, 3 and so on, and Done cards lose their number. The order:
//
//   1. work with a release that can go ahead, then blocked work with a release, then the
//      unscheduled Backlog
//   2. earlier releases first, 0.0.9 before 0.0.10
//   3. the owner's pins, then cards in Development, then every other stage, then the release's
//      own card
//   4. the number a card has now, then its id
//
// Reads Title, Status, Release, Blocked and Order, and whether a card is a draft. Titles only tell
// release cards apart and are never printed, and it never asks for a card's text or issue, so a
// closed issue stays wherever its card's Status puts it. It writes Order, Backlog on a new draft,
// and the fields a release card it adds or finds unfinished still lacks. Archived cards are left
// as they are.
//
// Reads and writes GitHub with gh, which holds the login. The workflow runs it with plain node
// before installing packages, so it imports only node: modules and dependency-free files, by
// relative path rather than package name.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  compareVersions,
  formatVersion,
  parseVersion,
  type Version,
} from "../packages/contracts/src/version.ts";

/** The maintainers' project, https://github.com/orgs/Mr-Streamer-OSS/projects/1. */
const PROJECT = "PVT_kwDOE_1-uc4BlcDV";

/**
 * The owner's explicit choices. Under a release, these cards go first, in this order, while they
 * are planned for it and not blocked. Cards are named by project item id, never by their title.
 */
const PINS: Pins = {
  "0.0.7": ["PVTI_lADOE_1-uc4BlcDVzg-Ga10", "PVTI_lADOE_1-uc4BlcDVzg-i99U"],
};

/** Who a new release card is assigned to: StiensWout, by GitHub's id for the account. */
const RELEASE_OWNER = "MDQ6VXNlcjcxNDk4NDUy";

/** What a new release card says: what the release takes, and why the card starts blocked. */
const RELEASE_BODY = `## Release checklist

- [ ] Check the exact published nightly in the installed app on every supported desktop build, against this release's changes.
- [ ] Check what this release's changes store, send and leave behind after an uninstall, and that the privacy policy still describes it.
- [ ] Check the licence and source obligations of third-party code this release adds or updates, and verify the packaged notices and the release's attached sources.
- [ ] Get Wout's approval to promote that exact tested build.
- [ ] Write cumulative release notes from the previous stable release.
- [ ] Publish the stable GitHub release and verify the package and download links.
- [ ] Record the Microsoft Store submission, certification and installed update, where applicable.
- [ ] Prepare the announcement copy with the verified download links, then record its approved publication.

This card owns acceptance, promotion, distribution evidence, release notes and the announcement. It tracks the release and publishes nothing.

## Blocked

Waiting for this release's work to be implemented and accepted, and for Wout's approval to promote the tested build.
`;

const STAGES = ["Backlog", "Planned", "Development", "Implemented", "Tested", "Done"] as const;

/** The cards that go first in a release, by release such as "0.0.7". */
export type Pins = Readonly<Record<string, readonly string[]>>;

/** A card as the project holds it. Nothing here is checked yet. */
export interface Card {
  /** The project item's id. */
  readonly id: string;
  readonly archived: boolean;
  /** True for a draft, which lives on the project alone. False for an issue or pull request. */
  readonly draft: boolean;
  /** Null when GitHub doesn't show it. */
  readonly title: string | null;
  /** The name of the Status option chosen. */
  readonly status: string | null;
  readonly release: string | null;
  readonly order: number | null;
  /** The name of the Blocked option chosen. */
  readonly blocked: string | null;
}

export interface Field {
  readonly id: string;
  readonly name: string;
  /** GitHub's name for the field's type, such as NUMBER. */
  readonly dataType: string;
  /** What a single-select field offers. */
  readonly options?: readonly { readonly id: string; readonly name: string }[];
}

/** One answer from a project: its fields, and one page of its cards, archived ones included. */
export interface Page {
  readonly fields: readonly Field[];
  /** How many cards the project holds, over all pages. */
  readonly total: number;
  readonly cards: readonly Card[];
  /** Where the next page starts. Null on the last page. */
  readonly next: string | null;
}

/** A value for one field of a card, as GitHub takes it. */
export type Value =
  | { readonly number: number }
  | { readonly text: string }
  | { readonly singleSelectOptionId: string };

export interface Draft {
  readonly title: string;
  readonly body: string;
  /** The ids of the accounts it is assigned to. */
  readonly assignees: readonly string[];
}

/**
 * What this reads from a project and writes to it. The command line answers through gh, tests
 * from fixtures.
 */
export interface Project {
  page(after: string | null): Promise<Page>;
  /** Sets one field of one card, or clears it with null. */
  setField(field: string, card: string, value: Value | null): Promise<void>;
  /** Adds a draft card and answers its id. */
  addDraft(draft: Draft): Promise<string>;
}

export interface Change {
  /** The project item's id, or "Release 0.0.7" for a card a preview would add. */
  readonly card: string;
  readonly from: number | null;
  /** Null clears the number. */
  readonly to: number | null;
}

/** A release's own card to add, or to finish setting up. */
export interface ReleaseCard {
  /** The release, such as "0.0.7". */
  readonly version: string;
  /** The card to finish. Null when the release has none yet. */
  readonly card: Card | null;
}

export interface Numbering {
  /** Unfinished cards in working order. The first gets Order 1. */
  readonly order: readonly string[];
  /** The Order values that differ from the project's, in an order that is safe to stop halfway. */
  readonly changes: readonly Change[];
}

/**
 * What a project needs: its new drafts in the Backlog, its release cards, and the numbering once
 * it has both.
 */
export interface Plan extends Numbering {
  /** The new drafts to put in the Backlog, by project item id. */
  readonly backlog: readonly string[];
  readonly releases: readonly ReleaseCard[];
}

export interface Outcome extends Plan {
  /** True when the plan was written and the project read back as planned. */
  readonly written: boolean;
}

/** Where an unfinished card stands before its number counts. Lower sorts first. */
interface Standing {
  readonly card: Card;
  /** 0 for work that can go ahead, 1 for blocked work, 2 for the unscheduled Backlog. */
  readonly tier: number;
  /** Null in the Backlog. */
  readonly release: Version | null;
  /** Within a release: the pins in their order, then Development, the rest, and its own card. */
  readonly lead: number;
}

/**
 * The working order of a project's cards, and the Order values that must change for the project
 * to show it. Throws, naming each card, when a Status, Release or Blocked doesn't fit the rules:
 * numbering around a card that can't be placed would move the others for no reason.
 */
export function planOrder(cards: readonly Card[], pins: Pins): Numbering {
  const unfinished: Standing[] = [];
  const cleared: Change[] = [];
  const problems: string[] = [];
  for (const card of cards) {
    if (card.archived) continue;
    if (card.status === "Done") {
      if (card.order !== null) cleared.push({ card: card.id, from: card.order, to: null });
      continue;
    }
    const standing = standingOf(card, pins);
    if (typeof standing === "string") problems.push(`${card.id} ${standing}`);
    else unfinished.push(standing);
  }
  if (problems.length > 0) {
    throw new Error(
      [
        `${count(problems.length, "card")} can't be placed, so the project can't be ordered.`,
        ...problems,
      ].join("\n"),
    );
  }

  unfinished.sort(compareStandings);
  const numbered = unfinished.flatMap(({ card }, index) =>
    card.order === index + 1 ? [] : [{ card: card.id, from: card.order, to: index + 1 }],
  );
  // The number a card has decides its place among its neighbours, so a run that stops halfway
  // must not leave two of them sorting the other way round. Cards moving to a lower number are
  // written first, lowest first, then cards moving up, highest first: after every single write
  // the cards still sort as planned, and the next run finishes the same order.
  const down = numbered.filter((change) => change.from === null || change.to < change.from);
  const up = numbered.filter((change) => change.from !== null && change.to > change.from);
  return {
    order: unfinished.map(({ card }) => card.id),
    changes: [...down, ...up.reverse(), ...cleared],
  };
}

/** Where an unfinished card stands, or why the rules can't place it. */
function standingOf(card: Card, pins: Pins): Standing | string {
  if (card.status === null) return "has no Status.";
  if (!STAGES.some((stage) => stage === card.status)) {
    return `has a Status other than ${STAGES.join(", ")}.`;
  }
  if (card.blocked !== null && card.blocked !== "Blocked") {
    return "has a Blocked value other than Blocked.";
  }
  if (card.status === "Backlog") {
    return unscheduled(card.release)
      ? { card, tier: 2, release: null, lead: 0 }
      : "is in Backlog, so its Release must be Unscheduled or empty.";
  }
  const release = versionOf(card.release);
  const own = releaseOf(card);
  if (own !== null && (!release || formatVersion(release) !== own)) {
    return `is titled Release ${own}, so its Release must be ${own}.`;
  }
  if (!release) return `is ${card.status}, so its Release must be a version such as 0.0.7.`;
  // A blocked pin gives up its place, so it never holds up work that can go ahead.
  const blocked = card.blocked !== null;
  const pinned = blocked ? [] : (pins[formatVersion(release)] ?? []);
  const pin = pinned.indexOf(card.id);
  // A release's own card closes its release, behind the work it waits for.
  const after = own !== null ? 2 : card.status === "Development" ? 0 : 1;
  return { card, tier: blocked ? 1 : 0, release, lead: pin === -1 ? pinned.length + after : pin };
}

function compareStandings(a: Standing, b: Standing): number {
  return (
    a.tier - b.tier ||
    (a.release && b.release ? compareVersions(a.release, b.release) : 0) ||
    a.lead - b.lead ||
    // Cards without a number go after the numbered ones of their group.
    compare(a.card.order ?? Infinity, b.card.order ?? Infinity) ||
    compare(a.card.id, b.card.id)
  );
}

/** Plain order: numbers by value, text by code unit, the same on every machine. */
function compare<T extends number | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The stable version a Release names. Null for none, Unscheduled, a nightly or other text. */
function versionOf(release: string | null): Version | null {
  const version = parseVersion(release?.trim() ?? "");
  return version && !version.nightly ? version : null;
}

/** True for a Release that plans nothing: empty, or the word Unscheduled. */
function unscheduled(release: string | null): boolean {
  const text = release?.trim() ?? "";
  return text === "" || text === "Unscheduled";
}

/** The release a card is titled after: "Release 0.0.7" is 0.0.7's own card. Null for the rest. */
function releaseOf(card: Card): string | null {
  const named = /^Release (\d+\.\d+\.\d+)$/.exec(card.title?.trim() ?? "")?.[1];
  const version = versionOf(named ?? null);
  return version && formatVersion(version);
}

/**
 * True for a draft made on the board with nothing chosen yet: no Status, and no release. It is a
 * new idea, and goes to the Backlog. A draft titled after a release is that release's own card,
 * and follows `releaseCards` instead.
 */
function startsInBacklog(card: Card): boolean {
  return (
    card.draft &&
    !card.archived &&
    card.status === null &&
    unscheduled(card.release) &&
    releaseOf(card) === null
  );
}

/**
 * The release cards to add or finish. A release needs a card when unfinished work is planned for
 * it and no card is titled after it. Done and archived cards count, so a release that is out
 * never gets a second one.
 */
function releaseCards(cards: readonly Card[]): ReleaseCard[] {
  const carded = new Set<string>();
  const planned = new Map<string, Version>();
  const unfinished: ReleaseCard[] = [];
  for (const card of cards) {
    const own = releaseOf(card);
    const open = !card.archived && card.status !== "Done";
    if (own !== null) {
      carded.add(own);
      // Without a Release, a run stopped before it set the card up, or someone made it by hand.
      // In the Backlog it is an idea still, and stays one.
      if (open && card.status !== "Backlog" && !card.release?.trim()) {
        unfinished.push({ version: own, card });
      }
    } else if (open) {
      const version = versionOf(card.release);
      if (version) planned.set(formatVersion(version), version);
    }
  }
  const missing = [...planned]
    .filter(([version]) => !carded.has(version))
    .sort(([, a], [, b]) => compareVersions(a, b))
    .map(([version]) => ({ version, card: null }));
  return [...unfinished, ...missing];
}

/** A release's card as GitHub holds it right after adding it, under the name a preview lists. */
function addedRelease(version: string): Card {
  const title = `Release ${version}`;
  return {
    id: title,
    archived: false,
    draft: true,
    title,
    status: null,
    release: null,
    order: null,
    blocked: null,
  };
}

/**
 * A release's card once it is set up. One without a Status is new, and starts Planned and
 * Blocked. One that has a Status keeps it, and its Blocked, as someone chose them.
 */
function setUp(card: Card, version: string): Card {
  return card.status === null
    ? { ...card, blocked: card.blocked ?? "Blocked", status: "Planned", release: version }
    : { ...card, release: version };
}

/**
 * The new drafts that go to the Backlog, the release cards the project needs, and the order of
 * its cards once both are done. Throws when a title can't be read: it could be a release's own
 * card, and adding another would double it.
 */
function plan(cards: readonly Card[], pins: Pins): Plan {
  const unread = cards.filter((card) => card.title === null);
  if (unread.length > 0) {
    throw new Error(
      [
        `${count(unread.length, "card")} can't be read, so release cards can't be told apart.`,
        ...unread.map((card) => `${card.id} shows no title.`),
      ].join("\n"),
    );
  }
  const backlog = cards.filter(startsInBacklog);
  const releases = releaseCards(cards);
  const changing = new Set([...backlog, ...releases.map(({ card }) => card)]);
  return {
    backlog: backlog.map((card) => card.id),
    releases,
    ...planOrder(
      [
        ...cards.filter((card) => !changing.has(card)),
        ...backlog.map((card) => ({ ...card, status: "Backlog" })),
        ...releases.map(({ card, version }) => setUp(card ?? addedRelease(version), version)),
      ],
      pins,
    ),
  };
}

/**
 * Brings the project in order: reads every card, plans, and with `apply` puts new drafts in the
 * Backlog, adds and finishes release cards and writes the Order values that differ. Throws
 * without writing when the project lacks a field, a page is missing or a card can't be placed,
 * and after writing when the project didn't end up as planned.
 */
export async function maintainProject(
  project: Project,
  pins: Pins,
  options: { readonly apply: boolean },
): Promise<Outcome> {
  let board = await readBoard(project);
  let planned = plan(board.cards, pins);
  const { backlog, releases } = planned;
  if (!options.apply || backlog.length + releases.length + planned.changes.length === 0) {
    return { ...planned, written: false };
  }

  if (backlog.length + releases.length > 0) {
    // The plan above placed every card, so one that can't be placed stopped the run before this.
    // Backlog goes first, straight after the read: GitHub can't write a Status only where it is
    // still empty, so one chosen on the board between that read and this write is overwritten.
    for (const card of backlog) {
      const { field, option } = board.backlog;
      await project.setField(field, card, { singleSelectOptionId: option });
    }
    for (const release of releases) await setUpRelease(project, board, release);
    // The cards are numbered from what the project holds now, not from what this run expected.
    board = await readBoard(project);
    planned = plan(board.cards, pins);
    const pending = planned.backlog.length + planned.releases.length;
    if (pending > 0) {
      throw new Error(
        `${count(pending, "card")} didn't show as set up when the project was read again, so no Order was written. The next run looks again.`,
      );
    }
  }
  for (const change of planned.changes) {
    const value = change.to === null ? null : { number: change.to };
    await project.setField(board.order, change.card, value);
  }
  // GitHub can't write a number only where it is still the one that was read, so an edit made on
  // the board during the writes shows only now, as a project that is out of order again.
  const after = plan((await readBoard(project)).cards, pins);
  const left = after.backlog.length + after.releases.length + after.changes.length;
  if (left > 0) {
    throw new Error(
      `The project was edited while it was written, and ${count(left, "change")} came due again. The next run takes over.`,
    );
  }
  return { ...planned, backlog, releases, written: true };
}

/**
 * Adds a release's card, or takes the unfinished one, and sets the fields it lacks. Release goes
 * last: a card without it is the mark of a run that stopped here, and the next run finishes it
 * instead of adding another.
 */
async function setUpRelease(
  project: Project,
  board: Board,
  { version, card }: ReleaseCard,
): Promise<void> {
  const before = card ?? {
    ...addedRelease(version),
    id: await project.addDraft({
      title: `Release ${version}`,
      body: RELEASE_BODY,
      assignees: [RELEASE_OWNER],
    }),
  };
  const after = setUp(before, version);
  if (after.blocked !== before.blocked) {
    const { field, option } = board.blocked;
    await project.setField(field, before.id, { singleSelectOptionId: option });
  }
  if (after.status !== before.status) {
    const { field, option } = board.planned;
    await project.setField(field, before.id, { singleSelectOptionId: option });
  }
  await project.setField(board.release, before.id, { text: version });
}

/** A single-select field's id, and the id of the one option this writes there. */
interface Choice {
  readonly field: string;
  readonly option: string;
}

/** Every card of the project, and the ids this writes with. */
interface Board {
  readonly cards: readonly Card[];
  /** The Order field. */
  readonly order: string;
  /** The Release field. */
  readonly release: string;
  /** Status, and its Backlog. */
  readonly backlog: Choice;
  /** Status, and its Planned. */
  readonly planned: Choice;
  /** Blocked, and its Blocked. */
  readonly blocked: Choice;
}

/** The project's cards and fields, once the fields are the expected ones and the pages add up. */
async function readBoard(project: Project): Promise<Board> {
  let page = await project.page(null);
  fieldOf(page, "Title", "TITLE");
  const ids = {
    order: fieldOf(page, "Order", "NUMBER").id,
    release: fieldOf(page, "Release", "TEXT").id,
    backlog: choiceOf(page, "Status", "Backlog"),
    planned: choiceOf(page, "Status", "Planned"),
    blocked: choiceOf(page, "Blocked", "Blocked"),
  };
  const cards = [...page.cards];
  while (page.next !== null) {
    page = await project.page(page.next);
    cards.push(...page.cards);
  }
  // Pages are read one after another, so a card that leaves the project in between is still in
  // an earlier page, and one that moves can come twice.
  if (cards.length !== page.total || new Set(cards.map((card) => card.id)).size !== page.total) {
    throw new Error("The project changed while it was read. The next run reads it again.");
  }
  return { cards, ...ids };
}

/** The project's field with this name. Throws when it is missing or of another type. */
function fieldOf(page: Page, name: string, dataType: string): Field {
  const field = page.fields.find((each) => each.name === name);
  if (!field) throw new Error(`The project has no ${name} field, so it can't be ordered.`);
  if (field.dataType !== dataType) {
    throw new Error(
      `The project's ${name} field is ${field.dataType}, not ${dataType}, so it can't be ordered.`,
    );
  }
  return field;
}

/** A single-select field and one of its options, by name. Throws when either is missing. */
function choiceOf(page: Page, name: string, option: string): Choice {
  const field = fieldOf(page, name, "SINGLE_SELECT");
  const found = field.options?.find((each) => each.name === option);
  if (!found) {
    throw new Error(`The project's ${name} field has no ${option} option, so it can't be ordered.`);
  }
  return { field: field.id, option: found.id };
}

function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? "" : "s"}`;
}

// Archived cards come too: an archived release card still stands for its release. Selects no
// text or issue, and the titles it does select are never printed.
const PAGE = `query($project: ID!, $after: String) {
  node(id: $project) {
    ... on ProjectV2 {
      fields(first: 100) {
        nodes {
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { options { id name } }
        }
      }
      items(first: 100, after: $after, archivedStates: [ARCHIVED, NOT_ARCHIVED]) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isArchived
          type
          title: fieldValueByName(name: "Title") { ... on ProjectV2ItemFieldTextValue { text } }
          status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          release: fieldValueByName(name: "Release") { ... on ProjectV2ItemFieldTextValue { text } }
          order: fieldValueByName(name: "Order") { ... on ProjectV2ItemFieldNumberValue { number } }
          blocked: fieldValueByName(name: "Blocked") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        }
      }
    }
  }
}`;

const SET = `mutation($project: ID!, $field: ID!, $card: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(
    input: { projectId: $project, fieldId: $field, itemId: $card, value: $value }
  ) { clientMutationId }
}`;

const CLEAR = `mutation($project: ID!, $field: ID!, $card: ID!) {
  clearProjectV2ItemFieldValue(input: { projectId: $project, fieldId: $field, itemId: $card }) {
    clientMutationId
  }
}`;

const ADD = `mutation($project: ID!, $title: String!, $body: String!, $assignees: [ID!]) {
  addProjectV2DraftIssue(
    input: { projectId: $project, title: $title, body: $body, assigneeIds: $assignees }
  ) { projectItem { id } }
}`;

/** What GitHub answers PAGE with. A value of another type than its field's comes back empty. */
interface PageAnswer {
  /** Without fields and items when the id names something other than a project. */
  readonly node: {
    readonly fields?: { readonly nodes: readonly Field[] };
    readonly items?: {
      readonly totalCount: number;
      readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
      readonly nodes: readonly {
        readonly id: string;
        readonly isArchived: boolean;
        /** DRAFT_ISSUE, ISSUE or PULL_REQUEST, and REDACTED for a card the token can't see. */
        readonly type: string;
        readonly title: { readonly text?: string | null } | null;
        readonly status: { readonly name?: string | null } | null;
        readonly release: { readonly text?: string | null } | null;
        readonly order: { readonly number?: number | null } | null;
        readonly blocked: { readonly name?: string | null } | null;
      }[];
    };
  } | null;
}

/** What GitHub answers ADD with. */
interface AddAnswer {
  readonly addProjectV2DraftIssue: { readonly projectItem: { readonly id: string } | null } | null;
}

/** The project with this id on GitHub, read and written through gh. */
function githubProject(id: string): Project {
  return {
    async page(after) {
      // GitHub answers a query in the query's own shape.
      const { node } = github(PAGE, { project: id, after }) as PageAnswer;
      if (!node?.fields || !node.items) throw new Error(`${id} is not a project.`);
      const { totalCount, pageInfo, nodes } = node.items;
      return {
        fields: node.fields.nodes,
        total: totalCount,
        cards: nodes.map((item) => ({
          id: item.id,
          archived: item.isArchived,
          draft: item.type === "DRAFT_ISSUE",
          title: item.title?.text ?? null,
          status: item.status?.name ?? null,
          release: item.release?.text ?? null,
          order: item.order?.number ?? null,
          blocked: item.blocked?.name ?? null,
        })),
        next: pageInfo.hasNextPage ? pageInfo.endCursor : null,
      };
    },
    async setField(field, card, value) {
      if (value === null) github(CLEAR, { project: id, field, card });
      else github(SET, { project: id, field, card, value });
    },
    async addDraft({ title, body, assignees }) {
      const answer = github(ADD, { project: id, title, body, assignees }) as AddAnswer;
      const added = answer.addProjectV2DraftIssue?.projectItem?.id;
      if (!added) throw new Error(`GitHub didn't name the card it added for ${title}.`);
      return added;
    },
  };
}

/** Asks GitHub's GraphQL API through gh and answers the data. Throws with gh's reason. */
function github(query: string, variables: Record<string, unknown>): unknown {
  const { error, status, stdout, stderr } = spawnSync("gh", ["api", "graphql", "--input", "-"], {
    input: JSON.stringify({ query, variables }),
    encoding: "utf8",
  });
  if (error) throw error;
  if (status !== 0) throw new Error(`GitHub refused the request. ${stderr.trim()}`);
  try {
    return JSON.parse(stdout).data;
  } catch {
    // The parser's own message quotes what it read, which holds titles.
    throw new Error("GitHub's answer could not be read.");
  }
}

/**
 * A line for the run, then one per new draft, per release card and per number: the card, and what
 * changes.
 */
function describe({ backlog, releases, order, changes, written }: Outcome): string[] {
  const cards = count(order.length, "unfinished card");
  const drafts = count(backlog.length, "new draft");
  const added = count(releases.length, "release card");
  const numbers = count(changes.length, "Order value");
  const headline =
    backlog.length + releases.length + changes.length === 0
      ? `In order already: ${cards}, nothing to write.`
      : written
        ? `Put ${drafts} in the Backlog, set up ${added} and wrote ${numbers}. ${cards} are in order.`
        : `Preview: ${drafts} to put in the Backlog, ${added} to set up and ${numbers} to change across ${cards}. Nothing was written.`;
  return [
    headline,
    ...backlog.map((card) => `${card}: no Status → Backlog`),
    ...releases.map(
      ({ version, card }) => `Release ${version}: ${card ? `finish ${card.id}` : "new card"}`,
    ),
    ...changes
      .toSorted((a, b) => compare(a.to ?? Infinity, b.to ?? Infinity))
      .map((change) => `${change.card}: ${change.from ?? "none"} → ${change.to ?? "none"}`),
  ];
}

/**
 * Prints the lines, the first as the run's result, and puts them on the run's page when a workflow
 * runs this.
 */
function report([headline = "", ...details]: readonly string[], failed: boolean): void {
  console.log([`${failed ? "::error::" : ""}${headline}`, ...details].join("\n"));
  const file = process.env["GITHUB_STEP_SUMMARY"];
  if (file) {
    appendFileSync(file, `${[headline, "", ...details.map((line) => `- ${line}`)].join("\n")}\n`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });
  const outcome = await maintainProject(githubProject(PROJECT), PINS, { apply: values.apply });
  report(describe(outcome), false);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    report((error instanceof Error ? error.message : String(error)).split("\n"), true);
    process.exit(1);
  });
}
