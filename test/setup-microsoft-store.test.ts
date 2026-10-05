import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";

// The setup wizard's key stage takes the one credential that can change the Store listing, pasted
// into a terminal. A paste can hold more than the one line a prompt reads, and what is left over
// shows at the next prompt, or at the shell's once the wizard ends. A terminal decides that, so
// this runs the stage in one of its own, which util-linux's `script` makes, with made-up keys and
// a `gh` that records what it is given.

const WIZARD = resolve("scripts/setup-microsoft-store.sh");
const hasScript = String(spawnSync("script", ["--version"]).stdout).includes("util-linux");

const KEY = "Zq7~Xw9_Lk3.Vb5-Tn1";
const OTHER = "Hj4+Mp8=Rc2,Gd6";
const PASTE = "Paste the key (hidden):";
const STORE = "y or n (hidden):";

/** `gh` for a repository whose Store environment exists for main alone. It stores nothing. */
const GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_CALLS"
case "$1 $2" in
  "repo view") echo example/repo ;;
  "api repos/example/repo/environments/microsoft-store") echo listed ;;
  "api repos/example/repo/environments/microsoft-store/deployment-branch-policies") echo main ;;
  "secret set") cat > "$GH_STORED" ;;
esac
`;

/**
 * Runs the key stage, then carries on in the same terminal as the shell that started the wizard
 * would: it says whether typing shows again, and reads what is still queued as a prompt would.
 */
const SESSION = `trap : INT
bash "$WIZARD" key
case "$(stty -a)" in *" echo "*) typing=shown ;; *) typing=hidden ;; esac
IFS= read -rs -t 0.3 -n 80 queued
printf 'typing %s, queued [%s]\\n' "$typing" "$queued"
`;
const LEFT_AS_FOUND = "typing shown, queued []";

/** The terminal a test types into. */
interface Terminal {
  /** Waits until the wizard has printed `text`, past the last text waited for. */
  shown(text: string): Promise<void>;
  /** Sends `keys` all at once, as a paste arrives. */
  type(keys: string): void;
}

/** What a run of the key stage left behind. */
interface Outcome {
  /** Everything the terminal showed. */
  readonly screen: string;
  /** What `gh secret set` was given, when it ran. */
  readonly stored: string | undefined;
  /** Every `gh` command line, and every file the wizard keeps. */
  readonly kept: string;
}

/** Runs the key stage in a terminal of its own, in a repository made for it, while `play` types. */
async function keyStage(play: (terminal: Terminal) => Promise<void>): Promise<Outcome> {
  const folder = mkdtempSync(join(tmpdir(), "mr-streamer-store-key-"));
  const checkout = join(folder, "checkout");
  const calls = join(folder, "calls");
  const stored = join(folder, "stored");
  // Nothing of whoever runs the tests: git finds the repository made here, and gh is the one above.
  const env = {
    PATH: `${join(folder, "bin")}:${process.env["PATH"]}`,
    TERM: "dumb",
    SHELL: "/bin/bash",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    WIZARD,
    GH_CALLS: calls,
    GH_STORED: stored,
  };
  mkdirSync(join(folder, "bin"));
  writeFileSync(join(folder, "bin", "gh"), GH, { mode: 0o755 });
  // The wizard opens Partner Center with the first opener it finds. This one opens nothing.
  writeFileSync(join(folder, "bin", "wslview"), "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(checkout);
  execFileSync("git", ["init", "--quiet"], { cwd: checkout, env });
  writeFileSync(join(checkout, ".gitignore"), ".local/\n");

  const script = spawn("script", ["--quiet", "--command", SESSION, "/dev/null"], {
    cwd: checkout,
    env,
  });
  try {
    let screen = "";
    let seen = 0;
    let closed = false;
    script.stdout.setEncoding("utf8").on("data", (text: string) => (screen += text));
    const close = new Promise<void>((done) =>
      script.on("close", () => {
        closed = true;
        done();
      }),
    );
    await play({
      async shown(text) {
        const deadline = Date.now() + 10_000;
        while (!screen.includes(text, seen)) {
          if (closed || Date.now() > deadline) {
            throw new Error(`The wizard never showed "${text}":\n${screen.slice(seen)}`);
          }
          await sleep(10);
        }
        seen = screen.indexOf(text, seen) + text.length;
      },
      type: (keys) => script.stdin.write(keys),
    });
    await close;
    const local = join(checkout, ".local");
    return {
      screen,
      stored: existsSync(stored) ? readFileSync(stored, "utf8") : undefined,
      kept: [calls, ...readdirSync(local).map((name) => join(local, name))]
        .map((file) => readFileSync(file, "utf8"))
        .join("\n"),
    };
  } finally {
    script.kill();
    rmSync(folder, { recursive: true, force: true });
  }
}

describe.skipIf(!hasScript)("a key pasted into the setup wizard", { timeout: 30_000 }, () => {
  it("is stored whole when the paste starts with an empty line and ends without one", async () => {
    const run = await keyStage(async ({ shown, type }) => {
      await shown(PASTE);
      type(`\n${KEY}`);
      await shown(STORE);
      type("y\n");
      await shown("YYYY-MM-DD:");
      type("2028-01-01\n");
    });

    expect(run.stored).toBe(KEY);
    // The wizard promises the key is never printed, written to a file or put on a command line.
    expect(run.screen).not.toContain(KEY);
    expect(run.kept).not.toContain(KEY);
    expect(run.screen).toContain(LEFT_AS_FOUND);
  });

  it("is asked for again when the paste holds a second line or a space", async () => {
    const run = await keyStage(async ({ shown, type }) => {
      await shown(PASTE);
      type(`${KEY}\n${OTHER}`);
      await shown("Paste it again.");
      await shown(PASTE);
      type(`${KEY} ${OTHER}\n`);
      await shown("Paste it again.");
      await shown(PASTE);
      type("\u0004");
    });

    expect(run.stored).toBeUndefined();
    expect(run.screen).toContain("Nothing was stored.");
    for (const key of [KEY, OTHER]) expect(run.screen).not.toContain(key);
    expect(run.screen).toContain(LEFT_AS_FOUND);
  });

  it("is asked for again when anything but y or n follows it, as the rest of a slow paste would", async () => {
    const run = await keyStage(async ({ shown, type }) => {
      await shown(PASTE);
      type(`${KEY}\n`);
      await shown(STORE);
      type(`${OTHER}\n`);
      await shown("neither y nor n");
      await shown(PASTE);
      type(`${KEY}\n`);
      await shown(STORE);
      type("n\n");
    });

    expect(run.stored).toBeUndefined();
    expect(run.screen).toContain("Nothing was stored.");
    for (const key of [KEY, OTHER]) expect(run.screen).not.toContain(key);
    expect(run.screen).toContain(LEFT_AS_FOUND);
  });

  it("leaves the terminal showing what is typed after Ctrl-C at the hidden prompt", async () => {
    const run = await keyStage(async ({ shown, type }) => {
      await shown(PASTE);
      type("\u0003");
    });

    expect(run.stored).toBeUndefined();
    expect(run.screen).toContain(LEFT_AS_FOUND);
  });
});
