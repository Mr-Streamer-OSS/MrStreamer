import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectNotices } from "../scripts/licences.ts";
import { Licences } from "../src/main/services/licences.ts";
import { promised, runtimeFor, tempDir } from "./support.ts";

const MIT = "MIT License\n\nCopyright (c) Someone\n\nPermission is hereby granted, free of charge.";
const APACHE =
  "Apache License\nVersion 2.0, January 2004\n\nTERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION";
const GPL =
  "GNU GENERAL PUBLIC LICENSE\nVersion 2, June 1991\n\nTERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION";

/** A package in the fake app's node_modules, with its package.json and other files. */
function installed(name: string, json: object, files: Record<string, string> = {}) {
  return Object.fromEntries([
    [`node_modules/${name}/package.json`, JSON.stringify({ name, version: "1.0.0", ...json })],
    ...Object.entries(files).map(([file, text]) => [`node_modules/${name}/${file}`, text]),
  ]);
}

/** A fake app folder with `files`, and a licences.config.json that adds nothing unless told to. */
async function app(files: Record<string, string>, config: object = {}): Promise<string> {
  const root = await tempDir();
  const all = {
    "licences.config.json": JSON.stringify({
      packages: {},
      overrides: {},
      embedded: {},
      components: [],
      ...config,
    }),
    ...files,
  };
  for (const [file, text] of Object.entries(all)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), text);
  }
  return root;
}

/** The problems a build of `root` with `modules` reports. */
async function problems(root: string, modules: string[]): Promise<string> {
  const failure = await collectNotices({ root, modules, variables: {} }).then(
    () => new Error("The notices were written."),
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  return failure.message;
}

describe("collecting notices", () => {
  it("lists the packages the bundles hold, devDependencies included, with their licence files", async () => {
    const root = await app({
      "package.json": JSON.stringify({ devDependencies: { player: "1.0.0", tool: "1.0.0" } }),
      ...installed(
        "player",
        { license: "MIT", repository: "git+https://github.com/someone/player.git" },
        { LICENSE: `${MIT}\r\n` },
      ),
      ...installed("tool", { license: "MIT" }, { LICENSE: MIT }),
    });

    const manifest = await collectNotices({
      root,
      modules: [
        `${root}/node_modules/player/dist/player.js`,
        `\0${root}/node_modules/player/dist/player.js?commonjs-module`,
        `${root}/src/renderer/main.tsx`,
        "\0commonjsHelpers.js",
      ],
      variables: {},
    });

    expect(manifest).toEqual({
      version: 1,
      notices: [
        {
          id: "player@1.0.0",
          name: "player",
          version: "1.0.0",
          licence: "MIT",
          source: "https://github.com/someone/player",
          homepage: null,
          text: MIT,
        },
      ],
    });
  });

  it("reproduces an Apache NOTICE file with the licence", async () => {
    const root = await app(
      installed(
        "codec",
        { license: "Apache-2.0" },
        { LICENSE: APACHE, NOTICE: "Codec\nCopyright 2024 Someone" },
      ),
    );

    const [notice] = (
      await collectNotices({
        root,
        modules: [`${root}/node_modules/codec/index.js`],
        variables: {},
      })
    ).notices;

    expect(notice?.text).toBe(
      `LICENSE\n\n${APACHE}\n\n---\n\nNOTICE\n\nCodec\nCopyright 2024 Someone`,
    );
  });

  it("fails the build for a package without a licence, a licence file or a compatible licence", async () => {
    const root = await app({
      ...installed("undeclared", {}, { LICENSE: MIT }),
      ...installed("unwritten", { license: "MIT" }),
      ...installed("gpl2only", { license: "GPL-2.0-only" }, { COPYING: GPL }),
    });

    const reported = await problems(
      root,
      ["undeclared", "unwritten", "gpl2only"].map(
        (name) => `${root}/node_modules/${name}/index.js`,
      ),
    );

    expect(reported).toMatch(/undeclared@1\.0\.0 declares no licence/);
    expect(reported).toMatch(/unwritten@1\.0\.0 has no licence file/);
    expect(reported).toMatch(/gpl2only@1\.0\.0 is licensed GPL-2\.0-only/);
  });

  it("needs a notice for a package carried inside a prebuilt file", async () => {
    const files = {
      ...installed(
        "player",
        { license: "MIT" },
        {
          LICENSE: MIT,
          "dist/player.js": "code\n//# sourceMappingURL=player.js.map\n",
          "dist/player.js.map": JSON.stringify({
            sources: [
              "webpack://player/./node_modules/emitter/index.js",
              "webpack://player/./src/a.js",
            ],
          }),
        },
      ),
      "licences/emitter-LICENSE": MIT,
    };
    const modules = (root: string) => [`${root}/node_modules/player/dist/player.js`];
    const unknown = await app(files);
    const described = await app(files, {
      embedded: {
        "player@1.0.0": [
          {
            name: "emitter",
            version: "2.0.0",
            licence: "MIT",
            source: "https://github.com/someone/emitter",
            files: ["licences/emitter-LICENSE"],
          },
        ],
      },
    });

    expect(await problems(unknown, modules(unknown))).toMatch(
      /player@1\.0\.0 carries emitter in its prebuilt files/,
    );
    const { notices } = await collectNotices({
      root: described,
      modules: modules(described),
      variables: {},
    });
    expect(notices.map(({ id }) => id)).toEqual(["emitter@2.0.0", "player@1.0.0"]);
  });

  it("adds the packages and components the config describes, filled in from the build", async () => {
    const root = await app(
      {
        ...installed("electron", { license: "MIT" }, { LICENSE: MIT }),
        "licences/FFmpeg.txt": "FFmpeg {FFMPEG_VERSION}, source in v{app}",
        "licences/COPYING.GPLv2": GPL,
      },
      {
        packages: { electron: "Every installer carries it." },
        components: [
          {
            name: "FFmpeg",
            version: "{FFMPEG_VERSION}",
            licence: "GPL-2.0-or-later",
            source: "https://example.com/v{app}/ffmpeg-{FFMPEG_VERSION}.tar.xz",
            homepage: "https://ffmpeg.org",
            files: ["licences/FFmpeg.txt", "licences/COPYING.GPLv2"],
          },
          {
            name: "Chromium",
            version: "{chrome}",
            licence: "BSD-3-Clause",
            source: "https://source.chromium.org",
            credits: "*",
          },
        ],
      },
    );

    const { notices } = await collectNotices({
      root,
      modules: [],
      variables: { app: "1.2.3", FFMPEG_VERSION: "9.0.2" },
    });

    expect(notices).toEqual([
      {
        id: "Chromium@{chrome}",
        name: "Chromium",
        version: "{chrome}",
        licence: "BSD-3-Clause",
        source: "https://source.chromium.org",
        homepage: null,
        text: { credits: "*" },
      },
      expect.objectContaining({ id: "electron@1.0.0", text: MIT }),
      {
        id: "FFmpeg@9.0.2",
        name: "FFmpeg",
        version: "9.0.2",
        licence: "GPL-2.0-or-later",
        source: "https://example.com/v1.2.3/ffmpeg-9.0.2.tar.xz",
        homepage: "https://ffmpeg.org",
        text: `FFmpeg 9.0.2, source in v1.2.3\n\n---\n\n${GPL}`,
      },
    ]);
  });
});

describe("reading notices", () => {
  /** Chromium's credits page as Electron ships it, cut down to two projects. */
  const CREDITS = `<!doctype html>
<div class="product">
<span class="title">Abseil</span>
<span class="homepage"><a href="https://abseil.io">homepage</a></span>
<label class="show" tabindex="0"><input type="checkbox" hidden></label>
<div class="license">
<pre>Apache License &quot;2.0&quot;</pre>
</div>
</div>
<div class="product">
<span class="title">Node.js</span>
<span class="homepage"><a href="https://github.com/nodejs/node">homepage</a></span>
<label class="show" tabindex="0"><input type="checkbox" hidden></label>
<div class="license">
<pre>Copyright Node.js contributors &amp; others. It&#x27;s MIT.
</pre>
</div>
</div>`;

  /** The service on what a build of a small app wrote, with Chromium's credits page. */
  async function licences() {
    const root = await app(installed("player", { license: "MIT" }, { LICENSE: MIT }), {
      components: [
        {
          name: "Chromium",
          version: "{chrome}",
          licence: "BSD-3-Clause",
          source: "https://source.chromium.org/chromium/chromium/src/+/refs/tags/{chrome}",
          credits: "*",
        },
        {
          name: "Node.js",
          version: "{node}",
          licence: "MIT",
          source: "https://nodejs.org",
          credits: "Node.js",
        },
      ],
    });
    const manifest = await collectNotices({
      root,
      modules: [`${root}/node_modules/player/index.js`],
      variables: {},
    });
    await writeFile(join(root, "third-party.json"), JSON.stringify(manifest));
    await writeFile(join(root, "LICENSES.chromium.html"), CREDITS);
    return promised(
      runtimeFor(
        Licences.layer({
          manifest: join(root, "third-party.json"),
          credits: [
            join(root, "missing", "LICENSES.chromium.html"),
            join(root, "LICENSES.chromium.html"),
          ],
          versions: { chrome: "152.0.7977.130", node: "24.21.0" },
        }),
      ),
      Licences,
    );
  }

  it("lists the notices without their texts, with the running Electron's versions", async () => {
    expect(await (await licences()).list()).toEqual([
      {
        id: "Chromium@152.0.7977.130",
        name: "Chromium",
        version: "152.0.7977.130",
        licence: "BSD-3-Clause",
        source: "https://source.chromium.org/chromium/chromium/src/+/refs/tags/152.0.7977.130",
        homepage: null,
      },
      {
        id: "Node.js@24.21.0",
        name: "Node.js",
        version: "24.21.0",
        licence: "MIT",
        source: "https://nodejs.org",
        homepage: null,
      },
      {
        id: "player@1.0.0",
        name: "player",
        version: "1.0.0",
        licence: "MIT",
        source: "https://www.npmjs.com/package/player/v/1.0.0",
        homepage: null,
      },
    ]);
  });

  it("gives each text in full, Chromium's and Node.js's from the credits page as plain text", async () => {
    const service = await licences();

    expect(await service.text("player@1.0.0")).toBe(MIT);
    expect(await service.text("Node.js@24.21.0")).toBe(
      "Copyright Node.js contributors & others. It's MIT.",
    );
    expect(await service.text("Chromium@152.0.7977.130")).toBe(
      'Abseil\nhttps://abseil.io\n\nApache License "2.0"\n\n---\n\nNode.js\nhttps://github.com/nodejs/node\n\nCopyright Node.js contributors & others. It\'s MIT.',
    );
    await expect(service.text("unknown@1.0.0")).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });
  });

  it("fails when the build wrote no notices", async () => {
    const root = await tempDir();
    const service = await promised(
      runtimeFor(
        Licences.layer({ manifest: join(root, "third-party.json"), credits: [], versions: {} }),
      ),
      Licences,
    );

    await expect(service.list()).rejects.toMatchObject({
      error: { kind: "unexpected", detail: expect.stringContaining("pnpm build") },
    });
  });
});
