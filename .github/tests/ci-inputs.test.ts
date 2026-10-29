import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, selectChecks } from "../scripts/ci-inputs.ts";

test("select expensive work by known inputs; shared, unknown and incomplete changes run everything", () => {
  for (const paths of [
    null,
    [],
    ["pnpm-lock.yaml"],
    ["packages/core/src/index.ts"],
    ["new/config"],
    Array(3001).fill("docs/a.md"),
  ])
    assert.deepEqual(selectChecks(paths), { desktop: true, website: true });
  assert.deepEqual(selectChecks(["docs/guide.md"]), { desktop: false, website: false });
  assert.deepEqual(selectChecks(["apps/desktop/src/main.ts"]), { desktop: true, website: false });
  assert.deepEqual(selectChecks(["apps/marketing/src/index.ts"]), {
    desktop: false,
    website: true,
  });
  assert.deepEqual(selectChecks(["apps/desktop/a", "apps/marketing/b"]), {
    desktop: true,
    website: true,
  });
});

test("a complete multi-commit diff includes deleted paths and both sides of renames", () => {
  const previous = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "ci-inputs-"));
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  try {
    process.chdir(dir);
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    mkdirSync("apps/desktop", { recursive: true });
    writeFileSync("apps/desktop/a", "same");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    mkdirSync("docs");
    git("mv", "apps/desktop/a", "docs/a.md");
    git("commit", "-qm", "move");
    writeFileSync("docs/b.md", "another commit");
    git("add", ".");
    git("commit", "-qm", "docs");
    const paths = changedPaths(base, git("rev-parse", "HEAD"), false);
    assert.deepEqual(paths, ["apps/desktop/a", "docs/a.md", "docs/b.md"]);
    assert.deepEqual(selectChecks(paths), { desktop: true, website: false });
    assert.deepEqual(changedPaths(base, git("rev-parse", "HEAD"), true), paths);
    assert.equal(changedPaths("0".repeat(40), base, false), null);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});
