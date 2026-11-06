import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { changedPaths, selectChecks } from "../scripts/ci-inputs.ts";

test("Checks supports dispatch without inputs", () => {
  const workflow = parseDocument(
    readFileSync(new URL("../workflows/checks.yml", import.meta.url), "utf8"),
  );

  assert.equal(workflow.hasIn(["on", "workflow_dispatch"]), true);
  assert.equal(workflow.getIn(["on", "workflow_dispatch"]), null);
});

test("the CLI selects full dispatch checks and preserves push, PR and reusable input selection", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-inputs-events-"));

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("commit", "--allow-empty", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs/guide.md"), "guide");
    git("add", ".");
    git("commit", "-qm", "docs");
    const docs = git("rev-parse", "HEAD");
    mkdirSync(join(dir, "apps/desktop"), { recursive: true });
    writeFileSync(join(dir, "apps/desktop/main.ts"), "desktop");
    git("add", ".");
    git("commit", "-qm", "desktop");
    const desktop = git("rev-parse", "HEAD");

    const cases = [
      { name: "workflow_dispatch", event: {}, head: docs, expected: [true, true] },
      { name: "push", event: { before: base }, head: docs, expected: [false, false] },
      { name: "push", event: { before: docs }, head: desktop, expected: [true, false] },
      { name: "push", event: { before: "0".repeat(40) }, head: docs, expected: [true, true] },
      ...[
        { head: docs, expected: [false, false] },
        { head: desktop, expected: [true, false] },
        { head: "missing", expected: [true, true] },
      ].map(({ head, expected }) => ({
        name: "pull_request",
        event: { pull_request: { base: { sha: base }, head: { sha: head } } },
        head: docs,
        expected,
      })),
      { name: "workflow_call", event: {}, head: docs, expected: [true, false] },
    ];

    for (const { name, event, head, expected } of cases) {
      const output = join(dir, "output");
      const eventPath = join(dir, "event.json");
      writeFileSync(eventPath, JSON.stringify(event));
      writeFileSync(output, "");
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL("../scripts/ci-inputs.ts", import.meta.url))],
        {
          cwd: dir,
          env: {
            ...process.env,
            GITHUB_EVENT_NAME: name,
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_SHA: head,
            GITHUB_OUTPUT: output,
            VALIDATION_SHA: name === "workflow_call" ? docs : "",
          },
        },
      );
      assert.equal(
        readFileSync(output, "utf8"),
        `desktop=${expected[0]}\nwebsite=${expected[1]}\n`,
        `${name}: ${JSON.stringify(event)}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("select expensive work by known inputs; shared, unknown and incomplete changes run everything", () => {
  for (const paths of [
    null,
    [],
    ["pnpm-lock.yaml"],
    ["LICENSE"],
    ["packages/core/src/index.ts"],
    ["new/config"],
  ])
    assert.deepEqual(selectChecks(paths), { desktop: true, website: true });
  assert.deepEqual(selectChecks(["docs/guide.md"]), { desktop: false, website: false });
  assert.deepEqual(selectChecks(["apps/desktop/src/main.ts"]), { desktop: true, website: false });
  assert.deepEqual(selectChecks(["apps/marketing/src/index.ts"]), {
    desktop: true,
    website: true,
  });

  for (const path of [
    "docs/privacy.md",
    "docs/about.md",
    "docs/security.md",
    "docs/user/live.md",
    "docs/assets/image.png",
    "apps/desktop/assets/brand/mark.svg",
    "apps/marketing/test/site.test.ts",
  ])
    assert.deepEqual(selectChecks([path]), { desktop: true, website: true });
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
