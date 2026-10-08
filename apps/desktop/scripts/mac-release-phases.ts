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
// work. A phase whose marker never prints is listed as not observed, and the one before it runs on
// to the next marker that did.
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
}

/**
 * Splits the time from `startedAt` to the end of `lines` into the phases above. A line starts the
 * latest phase whose marker it matches, if that comes after the current one, and ends the phase
 * before it.
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
      return { name: phase.name, waitsOn: phase.waitsOn, seconds: null, finished: true };
    }
    const end = began.slice(index + 1).find((at) => at !== undefined) ?? endedAt;
    const finished = index < current || finishedAt !== undefined;
    return {
      name: phase.name,
      waitsOn: phase.waitsOn,
      seconds: (end - start) / 1000,
      finished,
      ...(submissions[index] ? { submission: submissions[index] } : {}),
    };
  });
}

/** The phases as a Markdown table with their sum by what they waited on. */
export function phaseTable(title: string, phases: readonly PhaseTime[]): string {
  const total = (waitsOn: Phase["waitsOn"]) =>
    phases.reduce((sum, phase) => sum + (phase.waitsOn === waitsOn ? (phase.seconds ?? 0) : 0), 0);
  const rows = phases.map((phase) => {
    const seconds = phase.seconds === null ? "not observed" : phase.seconds.toFixed(1);
    const note = [phase.finished ? "" : "did not finish", phase.submission ?? ""]
      .filter(Boolean)
      .join(", ");
    return `| ${phase.name} | ${phase.waitsOn} | ${seconds} | ${note} |`;
  });
  return [
    `### ${title}`,
    "",
    "| Phase | Waits on | Seconds | Notes |",
    "| --- | --- | ---: | --- |",
    ...rows,
    `| Runner total | | ${total("runner").toFixed(1)} | |`,
    `| Apple total | | ${total("Apple").toFixed(1)} | |`,
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
