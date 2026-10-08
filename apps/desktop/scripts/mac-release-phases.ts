// Times the phases of the Mac release step from the output it prints, so a slow release says
// whether Apple or the runner was the wait. It adds nothing to the build:
//
//   { pnpm exec electron-builder ...; node scripts/notarize-dmg.ts ...; } 2>&1 | node scripts/mac-release-phases.ts "<title>"
//
// The output passes through unchanged. When it ends, the phases are printed and, in a workflow,
// added to the job summary. Run with DEBUG=electron-notarize*, which makes electron-builder's
// notarizer print the lines that mark the app's phases; the DMG's come from notarize-dmg.ts.
//
// "Apple" phases are the ones that wait on Apple's service or servers: the notary round trip
// includes uploading the archive, and stapling fetches the ticket. The rest is the runner's own
// work. A phase whose marker never prints is listed as not observed, and the phase before it can
// no longer say where its time went: it keeps the elapsed time up to the next marker that did print,
// names the phases it covers, and counts toward neither total but the unattributed one.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

interface Phase {
  readonly name: string;
  readonly waitsOn: "runner" | "Apple";
  /** The line that starts the phase. The first phase starts with the step. */
  readonly start?: RegExp;
  /** Captures the notary submission's id, which is not a secret, from a line of the phase. */
  readonly submission?: RegExp;
}

const PHASES: readonly Phase[] = [
  { name: "Package", waitsOn: "runner" },
  { name: "Sign", waitsOn: "runner", start: /• signing\b/ },
  { name: "Check and zip the app", waitsOn: "runner", start: /\belectron-notarize\b/ },
  {
    name: "App notary round trip",
    waitsOn: "Apple",
    start: /zip succeeded, attempting to upload to Apple/,
    submission: /notarization success \(id: ([\w-]+)\)/,
  },
  { name: "Staple the app", waitsOn: "Apple", start: /attempting to staple app/ },
  { name: "Create the DMG and ZIP", waitsOn: "runner", start: /staple succeeded/ },
  {
    name: "DMG notary round trip",
    waitsOn: "Apple",
    start: /^Submitting .+ for notarization$/,
    submission: /^Notarization ([\w-]+) Accepted$/,
  },
  { name: "Staple the DMG and update its checksum", waitsOn: "Apple", start: /^Stapling / },
];

/** The last line notarize-dmg.ts prints: the final phase ends with it. */
const FINISHED = /^Notarized and stapled /;

export interface Line {
  /** When the line was read, in milliseconds. */
  readonly at: number;
  readonly text: string;
}

export interface PhaseTime {
  readonly name: string;
  readonly waitsOn: Phase["waitsOn"];
  /** Null when the phase's marker never printed. */
  readonly seconds: number | null;
  /** False for the phase the output ended in, when it ended before the last marker. */
  readonly finished: boolean;
  readonly submission?: string;
  /**
   * Phases whose markers never printed inside this phase's span. The time is then shared with
   * them, and it is not known how much of it, or whether it was Apple's or the runner's, is ours.
   */
  readonly covers: readonly string[];
}

/**
 * Splits the time from `startedAt` to the end of `lines` into the phases above. A line starts the
 * latest phase whose marker it matches, if that comes after the current one, and ends the phase
 * before it. A build that ended early has no later phases to cover; a finished one does.
 */
export function timePhases(startedAt: number, lines: readonly Line[]): PhaseTime[] {
  const began: (number | undefined)[] = PHASES.map(() => undefined);
  const submissions: (string | undefined)[] = PHASES.map(() => undefined);
  began[0] = startedAt;
  let current = 0;
  let finishedAt: number | undefined;
  for (const { at, text } of lines) {
    // Several markers can match one line, such as the notarizer's name; the latest phase is meant.
    const next = PHASES.findLastIndex((phase, index) => index > current && phase.start?.test(text));
    if (next !== -1) {
      current = next;
      began[next] = at;
    }
    const id = PHASES[current]?.submission?.exec(text)?.[1];
    if (id) submissions[current] = id;
    if (FINISHED.test(text)) finishedAt = at;
  }
  const endedAt = finishedAt ?? lines.at(-1)?.at ?? startedAt;
  return PHASES.map((phase, index) => {
    const start = began[index];
    if (start === undefined) {
      return {
        name: phase.name,
        waitsOn: phase.waitsOn,
        seconds: null,
        finished: true,
        covers: [],
      };
    }
    const finished = index < current || finishedAt !== undefined;
    const nextSeen = began.findIndex((at, other) => other > index && at !== undefined);
    const end = nextSeen === -1 ? endedAt : began[nextSeen]!;
    const coveredUntil = nextSeen !== -1 ? nextSeen : finishedAt !== undefined ? PHASES.length : 0;
    return {
      name: phase.name,
      waitsOn: phase.waitsOn,
      seconds: (end - start) / 1000,
      finished,
      covers: PHASES.slice(index + 1, coveredUntil).map((covered) => covered.name),
      ...(submissions[index] ? { submission: submissions[index] } : {}),
    };
  });
}

/**
 * The phases as a Markdown table with their sum by what they waited on. A phase that covers
 * unobserved ones adds to the unattributed time instead, so the two totals only hold what was seen.
 */
export function phaseTable(title: string, phases: readonly PhaseTime[]): string {
  const sum = (keep: (phase: PhaseTime) => boolean) =>
    phases.reduce((total, phase) => total + (keep(phase) ? (phase.seconds ?? 0) : 0), 0);
  const exact = (waitsOn: Phase["waitsOn"]) =>
    sum((phase) => phase.waitsOn === waitsOn && phase.covers.length === 0);
  const unattributed = sum((phase) => phase.covers.length > 0);
  const rows = phases.map((phase) => {
    const seconds = phase.seconds === null ? "not observed" : phase.seconds.toFixed(1);
    const note = [
      phase.finished ? "" : "did not finish",
      phase.covers.length > 0 ? `also covers ${phase.covers.join(", ")}` : "",
      phase.submission ?? "",
    ]
      .filter(Boolean)
      .join(", ");
    return `| ${phase.name} | ${phase.covers.length > 0 ? "unknown" : phase.waitsOn} | ${seconds} | ${note} |`;
  });
  const partial = unattributed > 0 ? " at least: the unattributed time is not in it" : "";
  return [
    `### ${title}`,
    "",
    "| Phase | Waits on | Seconds | Notes |",
    "| --- | --- | ---: | --- |",
    ...rows,
    `| Runner total | | ${exact("runner").toFixed(1)} |${partial} |`,
    `| Apple total | | ${exact("Apple").toFixed(1)} |${partial} |`,
    `| Unattributed | | ${unattributed.toFixed(1)} | |`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const startedAt = Date.now();
  const lines: Line[] = [];
  for await (const text of createInterface({ input: process.stdin })) {
    console.log(text);
    lines.push({ at: Date.now(), text });
  }
  const report = phaseTable(process.argv[2] ?? "Mac release phases", timePhases(startedAt, lines));
  console.log(`\n${report}`);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) appendFileSync(summary, `${report}\n`);
}
