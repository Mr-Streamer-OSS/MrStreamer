import { join } from "node:path";
import { expect, it } from "vitest";
import { missingReferences } from "../scripts/docs-references.ts";

it("names only repository paths that exist", () => {
  expect(missingReferences(join(import.meta.dirname, ".."))).toEqual([]);
});
