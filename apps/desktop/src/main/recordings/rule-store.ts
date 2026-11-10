import { readFile } from "node:fs/promises";
import { type } from "arktype";
import {
  RecordingPlanSchema,
  RecordingRetentionSchema,
  RecordingRulePlanSchema,
  RECORDING_RULE_LIMITS,
} from "@mrstreamer/contracts/recordings";
import { writeJsonFile } from "../platform/json-file.ts";

const schema = () =>
  type({
    version: "1",
    rules: type({
      id: "string > 0",
      plan: RecordingRulePlanSchema(),
      // Absent deletes nothing; one this build can't read refuses the whole file (see readRules).
      "retention?": RecordingRetentionSchema().and({ from: "number.integer >= 0" }),
      occurrences: type({
        identity: "string > 0",
        "episodeIdentity?": "string > 0",
        id: "string > 0",
        channelName: "string",
        plan: RecordingPlanSchema().extract({ kind: "'programme'" }),
        settled: "boolean",
        "observed?": { start: "number", stop: "number" },
      })
        .array()
        .atMostLength(RECORDING_RULE_LIMITS.history),
    })
      .array()
      .atMostLength(RECORDING_RULE_LIMITS.rules),
  });

export type KeptRule = ReturnType<typeof schema>["infer"]["rules"][number];

/** Missing is empty; corrupt, newer or unreadable files refuse rule execution and writes. */
export async function readRules(path: string): Promise<KeptRule[] | null> {
  try {
    const parsed = schema()(JSON.parse(await readFile(path, "utf8")));

    return parsed instanceof type.errors ? null : parsed.rules;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? [] : null;
  }
}

export function writeRules(path: string, rules: readonly KeptRule[]) {
  return writeJsonFile(path, { version: 1, rules });
}
