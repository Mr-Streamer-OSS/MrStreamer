// Notices for what the installers ship, for Settings > About: every third-party component, and the
// app's own licence, which licences.config.json adds like a component. electron.vite.config.ts
// notes the modules each bundle holds; once main, preload and renderer are written, this finds the
// packages they come from, reads their licence files, adds what licences.config.json describes and
// writes out/licences/third-party.json, which electron-builder packages with the rest of out/.
// Prebuilt files that carry other packages inside them are found through their source maps.
//
// The build fails when a package declares no licence, has no licence file and no override, ships
// under a licence missing from COMPATIBLE, refers to a licence in FULL_TEXT without including it,
// or carries a package that is neither installed nor in the config. It also fails when Electron or
// electron-builder isn't the version the config was reviewed for, and when the files a notice
// links on the app's own release differ from the source archives the config has releases attach.
// scripts/release-sources.ts prepares those archives, and scripts/installer-plugins.ts checks a
// built Windows setup against the plug-ins the config lists.
// docs/contributing/development.md describes the config.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { type, type ArkErrors } from "arktype";
import type { NoticeManifest } from "@mrstreamer/contracts/licences";
import type { Plugin } from "vite";

type Notice = NoticeManifest["notices"][number];

/**
 * Licences whose code may ship with the app's own under GPL-3.0: the FSF lists each as compatible
 * with version 3 (Apache-2.0 with version 3 only, MPL-2.0 through its secondary licence clause,
 * LGPL by conversion to the GPL, ZPL-2.1 too); BlueOak-1.0.0, dtoa and SunPro are permissive
 * licences with only a notice condition, and LZMA-SDK-9.22 places its code in the public domain.
 * GPL-2.0-only is missing on purpose: it can't combine with GPL-3.0. Anything new needs a look at
 * its terms before it goes on the list. A licence that can't go on it ships only as an exception
 * of one described component, never of a package in the bundles.
 */
const COMPATIBLE = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "dtoa",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "ISC",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "LZMA-SDK-9.22",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "Python-2.0",
  "SunPro",
  "Unlicense",
  "Zlib",
  "ZPL-2.1",
]);

/**
 * Licences that recipients must receive in full, with a line of their text. A notice that only
 * refers to one fails the build; `standardText` in an override adds it.
 */
const FULL_TEXT: Readonly<Record<string, string>> = {
  "Apache-2.0": "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
  "GPL-2.0-or-later": "TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION",
  "LGPL-2.1-or-later": "TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION",
};

/** Placeholders the app fills from the Electron it runs on; the build leaves them in. */
const RUNTIME_PLACEHOLDERS = new Set(["chrome", "node"]);

/** Names of licence files a package may carry, with the extensions of plain text. */
const LICENCE_FILE = /^(licen[cs]e|copying|notice)/i;
const TEXT_EXTENSIONS = new Set(["", ".md", ".markdown", ".txt", ".rst", ".mit", ".apache2"]);

/** Between the texts of one notice, such as a package's LICENSE and NOTICE. */
const SEPARATOR = "\n\n---\n\n";

/** A link to a file on one of the app's own releases: the release's tag, then the file. */
const RELEASE_LINK =
  /https:\/\/github\.com\/Mr-Streamer-OSS\/MrStreamer\/releases\/download\/([^/\s]+)\/(\S+)/g;

/** A component described in the config rather than found in node_modules. */
const Component = type({
  name: "string",
  version: "string",
  licence: "string",
  source: "string",
  "homepage?": "string",
  /** Text files, relative to the app folder, shown one after the other. */
  "files?": "string[]",
  /** A project on Chromium's credits page, or `*` for the whole page. */
  "credits?": "string",
});
type Component = typeof Component.infer;

/** A component under `components`: what no bundle shows, some of it not open source. */
const Shipped = Component.merge({
  /**
   * Licences in `licence` that COMPATIBLE doesn't list, each with why the installers carry the
   * component anyway. For files that ship beside the app's code and that it can't replace, such as
   * what Electron's download or the Windows setup program brings. The rest of the expression is
   * still held to COMPATIBLE.
   */
  "exceptions?": { "[string]": "string" },
});

/** What the notices and source archives were reviewed for, for one version of a package. */
const Reviewed = type({
  /** The only version of the package the build accepts. */
  version: "string",
  /** Facts that hold for that version, as values for `{NAME}` placeholders. */
  "pins?": { "[string]": "string" },
});

/**
 * An archive every release attaches as `file`: downloaded from `url` and checked against its
 * SHA-256, or cut from the repository `git` at `commit`, which makes a .tar.gz.
 */
const Source = type({ file: "string", url: "string", sha256: "string" }).or({
  file: "string",
  git: "string",
  commit: "string",
});
export type Source = typeof Source.infer;

const Override = type({
  /** Why the package needs help, for whoever reads the config next. */
  why: "string",
  /** An SPDX licence, for a package that declares none or not in SPDX form. */
  "licence?": "string",
  /** Texts to show instead of the package's own files. */
  "files?": "string[]",
  /**
   * Adds the licence's standard text from licences/standard: after the package's own notice when
   * that only refers to the licence, or on its own, naming the package's author, without one.
   */
  "standardText?": "true",
});
type Override = typeof Override.infer;

/** licences.config.json */
const Config = type({
  /** Packages the installers carry without a bundled module, and why. */
  packages: { "[string]": "string" },
  /** Help for packages without a licence or licence file, by name. */
  overrides: { "[string]": Override },
  /**
   * Packages inside another package's prebuilt files and not installed, by `name@version` of the
   * package that carries them.
   */
  embedded: { "[string]": Component.array() },
  /**
   * Packages whose version decides what else the installers carry, by name: Electron brings
   * Chromium, its FFmpeg and Microsoft's files, electron-builder the Windows setup program. Under
   * another version the build fails until someone reviews the notices, `sources` and `installer`.
   * Notices can name the version as `{electron}`.
   */
  reviewed: { "[string]": Reviewed },
  /**
   * What no bundle shows: Chromium, its FFmpeg and Node.js inside Electron, Microsoft's files in
   * Electron's Windows build, the ffmpeg in resources/ffmpeg with the MinGW-w64 runtime in its
   * Windows build, the Windows setup program's parts, and the app itself.
   */
  components: Shipped.array(),
  /** The source archives every release attaches. Each is linked from a notice. */
  sources: Source.array(),
  /**
   * The plug-ins NSIS puts in the Windows setup and in the uninstaller it leaves in the app's
   * folder, by file name, with their SHA-256.
   */
  installer: { setup: { "[string]": "string" }, uninstaller: { "[string]": "string" } },
});
type Config = typeof Config.infer;

const PackageJson = type({
  name: "string",
  version: "string",
  "license?": type("string").or({ type: "string" }),
  "repository?": type("string").or({ url: "string" }),
  "homepage?": "string",
  "author?": type("string").or({ name: "string" }),
});
type PackageJson = typeof PackageJson.infer;

const SourceMap = type({ "sources?": "(string | null)[]" });

interface Package {
  readonly root: string;
  readonly json: PackageJson;
}

export interface NoticeInputs {
  /** The app folder, apps/desktop, with its node_modules and licences.config.json. */
  readonly root: string;
  /** The modules the bundles hold, as Rollup names them. */
  readonly modules: Iterable<string>;
  /** Values for `{name}` placeholders in the config and the text files it names. */
  readonly variables: Readonly<Record<string, string>>;
}

/**
 * Plugins for electron.vite.config.ts: the one for each of `bundles` notes the modules that bundle
 * holds, and once all are written, the notices go to out/licences. `electron-vite dev` serves the
 * renderer instead of bundling it, so development keeps the notices of the last build.
 */
export function thirdPartyNotices(
  root: string,
  bundles: readonly string[],
): (bundle: string) => Plugin {
  const modules = new Map<string, readonly string[]>();
  return (bundle) => ({
    name: "mrstreamer:third-party-notices",
    apply: "build",
    generateBundle(_options, output) {
      modules.set(
        bundle,
        Object.values(output).flatMap((file) =>
          file.type === "chunk"
            ? Object.entries(file.modules).flatMap(([id, module]) =>
                module.renderedLength > 0 ? [id] : [],
              )
            : [],
        ),
      );
    },
    async writeBundle() {
      if (!bundles.every((name) => modules.has(name))) return;
      const manifest = await collectNotices({
        root,
        modules: [...modules.values()].flat(),
        variables: await buildVariables(root),
      });
      modules.clear();
      const dir = join(root, "out", "licences");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "third-party.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    },
  });
}

/** licences.config.json of the app in `root`. */
export async function readConfig(root: string): Promise<Config> {
  return readJson(join(root, "licences.config.json"), Config);
}

/** The archives a release of the app in `root` attaches, with the version being built filled in. */
export async function releaseSources(root: string): Promise<Source[]> {
  const config = await readConfig(root);
  const variables = { ...(await buildVariables(root)), ...pinned(config) };
  return config.sources.map((source) => filledSource(source, variables));
}

/**
 * What's wrong between the files of the app's own release that `notices` link, in a source, a
 * homepage or a text, and the `files` the release of `version` attaches: a link to a file the
 * release lacks or to another release, or an attached file no notice leads to.
 */
export function linkProblems(
  notices: readonly Notice[],
  version: string,
  files: Iterable<string>,
): string[] {
  const attached = new Set(files);
  const linked = new Set<string>();
  const problems = new Set<string>();
  for (const notice of notices) {
    const text = typeof notice.text === "string" ? notice.text : "";
    const places = [notice.source, notice.homepage ?? "", text].join("\n");
    for (const [, tag = "", file = ""] of places.matchAll(RELEASE_LINK)) {
      linked.add(file);
      if (tag !== `v${version}`) {
        problems.add(`${notice.id} links ${file} on release ${tag}, not on v${version}.`);
      } else if (!attached.has(file)) {
        problems.add(
          `${notice.id} links ${file} on the release, which doesn't attach it: "sources" in licences.config.json lists what it does.`,
        );
      }
    }
  }
  for (const file of attached) {
    if (!linked.has(file)) problems.add(`The release attaches ${file}, which no notice links.`);
  }
  return [...problems];
}

/** The notices for `modules` and the config, sorted by name. Throws with every problem found. */
export async function collectNotices({
  root,
  modules,
  variables: build,
}: NoticeInputs): Promise<NoticeManifest> {
  const config = await readConfig(root);
  const variables = { ...build, ...pinned(config) };
  const problems: string[] = [];

  // What was reviewed for one version of Electron or electron-builder says nothing about another.
  for (const [name, { version }] of Object.entries(config.reviewed)) {
    const manifest = join(root, "node_modules", name, "package.json");
    const installed = existsSync(manifest)
      ? (await readJson(manifest, type({ version: "string" }))).version
      : null;
    if (installed !== version) {
      problems.push(
        `${name} ${installed ? `${installed} is` : "isn't"} installed, and the notices and source archives were reviewed for ${version}: go through docs/maintainers/licences.md#upgrading-electron-or-electron-builder, then update "reviewed" in licences.config.json.`,
      );
    }
  }

  // The files each installed package contributes, by package folder.
  const bundled = new Map<string, Set<string>>();
  for (const id of modules) {
    const file = id.replace(/^\0/, "").replace(/\?.*$/, "");
    const packageRoot = packageRootOf(file);
    if (!packageRoot) continue;
    const files = bundled.get(packageRoot) ?? new Set();
    bundled.set(packageRoot, files.add(file));
  }
  const packages = new Map<string, Package>();
  const add = async (packageRoot: string) => {
    const real = await realpath(packageRoot);
    if (packages.has(real)) return;
    const json = await readJson(join(real, "package.json"), PackageJson);
    if (!json.name.startsWith("@mrstreamer/")) packages.set(real, { root: real, json });
  };
  for (const packageRoot of bundled.keys()) await add(packageRoot);
  for (const name of Object.keys(config.packages)) {
    const packageRoot = join(root, "node_modules", name);
    if (existsSync(packageRoot)) await add(packageRoot);
    else problems.push(`"packages" names ${name}, which isn't installed.`);
  }

  // Packages carried inside prebuilt files: installed ones get their own notice, the others need
  // one in the config under the carrying package's name and version.
  const described: Component[] = [];
  const unused = new Set(
    Object.entries(config.embedded).flatMap(([host, list]) =>
      list.map((component) => `${host} ${component.name}`),
    ),
  );
  for (const [packageRoot, files] of bundled) {
    const host = packages.get(await realpath(packageRoot));
    if (!host) continue;
    const key = `${host.json.name}@${host.json.version}`;
    for (const name of await carriedIn(files, host.json.name)) {
      const entry = config.embedded[key]?.find((component) => component.name === name);
      const installed = entry ? null : installedNear(host.root, name);
      if (entry) {
        described.push(entry);
        unused.delete(`${key} ${name}`);
      } else if (installed) {
        await add(installed);
      } else {
        problems.push(
          `${key} carries ${name} in its prebuilt files, and it isn't installed: describe it under "embedded" > "${key}".`,
        );
      }
    }
  }
  for (const stale of unused) problems.push(`"embedded" lists ${stale}, which no bundle carries.`);

  // Only what "components" describes takes exceptions, by the id of its notice. A package with
  // the same id fails the build as listed twice.
  const exceptions = new Map<string, Readonly<Record<string, string>>>();
  const results = await Promise.allSettled([
    ...[...packages.values()].map((found) =>
      packageNotice(found, config.overrides[found.json.name], root, variables),
    ),
    ...described.map((component) => componentNotice(component, root, variables)),
    ...config.components.map(async (component) => {
      const notice = await componentNotice(component, root, variables);
      exceptions.set(notice.id, component.exceptions ?? {});
      return notice;
    }),
  ]);
  const notices: Notice[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      notices.push(result.value);
    } else {
      problems.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }
  const ids = new Set<string>();
  for (const notice of notices) {
    const excepted = exceptions.get(notice.id) ?? {};
    if (!accepted(notice.licence, excepted)) {
      problems.push(
        `${notice.id} is licensed ${notice.licence}, which isn't known to be compatible with GPL-3.0 (COMPATIBLE in scripts/licences.ts).`,
      );
    }
    const terms = notice.licence.split(/\s+(?:AND|OR)\s+|[()]/).map((term) => term.trim());
    for (const licence of Object.keys(excepted)) {
      if (COMPATIBLE.has(licence) || !terms.includes(licence)) {
        problems.push(
          `${notice.id} has an exception for ${licence}, which it doesn't need: its licence is ${notice.licence}.`,
        );
      }
    }
    const line = FULL_TEXT[notice.licence];
    if (line && typeof notice.text === "string" && !notice.text.includes(line)) {
      problems.push(
        `${notice.id}'s notice refers to ${notice.licence} without its text: give it an override with "standardText".`,
      );
    }
    if (ids.has(notice.id)) problems.push(`${notice.id} is listed twice.`);
    ids.add(notice.id);
  }

  // Every file a notice says is on this release has to be one the release attaches.
  const files: string[] = [];
  for (const source of config.sources) {
    try {
      files.push(filledSource(source, variables).file);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  problems.push(...linkProblems(notices, variables["app"] ?? "", files));
  if (problems.length > 0) {
    throw new Error(
      `Third-party notices:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
  }
  notices.sort(
    (a, b) =>
      compare(a.name.toLowerCase(), b.name.toLowerCase()) ||
      compare(a.name, b.name) ||
      compare(a.version, b.version),
  );
  return { version: 1, notices };
}

async function packageNotice(
  { root, json }: Package,
  override: Override | undefined,
  app: string,
  variables: Readonly<Record<string, string>>,
): Promise<Notice> {
  const id = `${json.name}@${json.version}`;
  const licence = override?.licence ?? licenceOf(json);
  if (!licence) {
    throw new Error(
      `${id} declares no licence: give it an override with "licence" in licences.config.json.`,
    );
  }
  const own = override?.files
    ? await texts(app, override.files, (text) => filled(text, variables, id))
    : await licenceFiles(root);
  const standard = override?.standardText
    ? await standardText(app, json, licence, own !== null)
    : null;
  const text = own && standard ? `${own}${SEPARATOR}${standard}` : (own ?? standard);
  if (!text) {
    throw new Error(
      `${id} has no licence file: give it an override with "files" or "standardText" in licences.config.json.`,
    );
  }
  const source =
    repositoryOf(json) ??
    json.homepage ??
    `https://www.npmjs.com/package/${json.name}/v/${json.version}`;
  const homepage = json.homepage?.replace(/#readme$/, "");
  return {
    id,
    name: json.name,
    version: json.version,
    licence,
    source,
    homepage: homepage && homepage !== source ? homepage : null,
    text,
  };
}

async function componentNotice(
  component: Component,
  app: string,
  variables: Readonly<Record<string, string>>,
): Promise<Notice> {
  const fill = (text: string) => filled(text, variables, component.name);
  const { files, credits } = component;
  if ((files === undefined) === (credits === undefined)) {
    throw new Error(`${component.name} needs either "files" or "credits" in licences.config.json.`);
  }
  const version = fill(component.version);
  return {
    id: `${component.name}@${version}`,
    name: component.name,
    version,
    licence: component.licence,
    source: fill(component.source),
    homepage: component.homepage === undefined ? null : fill(component.homepage),
    text: credits === undefined ? await texts(app, files ?? [], fill) : { credits },
  };
}

/** What `reviewed` pins: each package's version under its name, and the facts recorded for it. */
function pinned(config: Config): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, { version, pins }] of Object.entries(config.reviewed)) {
    Object.assign(values, { [name]: version }, pins);
  }
  return values;
}

/**
 * `source` with its placeholders filled. Throws for a file name that isn't plain, a checksum that
 * isn't a SHA-256, or a commit that isn't a full hash: a branch or a tag can move.
 */
function filledSource(source: Source, variables: Readonly<Record<string, string>>): Source {
  const fill = (text: string) => filled(text, variables, `"sources" > ${source.file}`);
  const file = fill(source.file);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file)) {
    throw new Error(`"sources" names ${file}, which isn't a plain file name.`);
  }
  if ("url" in source) {
    const sha256 = fill(source.sha256);
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`"sources" > ${file} needs a SHA-256 in lower-case hex.`);
    }
    return { file, url: fill(source.url), sha256 };
  }
  const commit = fill(source.commit);
  if (!/^[0-9a-f]{40}$/.test(commit) || !file.endsWith(".tar.gz")) {
    throw new Error(`"sources" > ${file} needs a full commit hash and a name ending in .tar.gz.`);
  }
  return { file, git: fill(source.git), commit };
}

/** `{app}`, the version being built, and what build-ffmpeg.sh pins, such as `{FFMPEG_VERSION}`. */
async function buildVariables(root: string): Promise<Record<string, string>> {
  const app = await readJson(join(root, "package.json"), type({ version: "string" }));
  const script = await readFile(join(root, "scripts", "build-ffmpeg.sh"), "utf8");
  const pinned = [...script.matchAll(/^([A-Z][A-Z0-9_]*)=["']?([^"'\s$]+)["']?$/gm)].flatMap(
    ([, name, value]) => (name && value ? [[name, value] as const] : []),
  );
  return { ...Object.fromEntries(pinned), app: app.version };
}

/** The folder of the installed package `file` belongs to, or null for the app's own files. */
function packageRootOf(file: string): string | null {
  const marker = "/node_modules/";
  const at = file.lastIndexOf(marker) + marker.length;
  if (at < marker.length) return null;
  const [first, second] = file.slice(at).split("/");
  const name = first?.startsWith("@") ? `${first}/${second}` : first;
  return name ? file.slice(0, at) + name : null;
}

/** Packages other than `self` whose code the source maps of `files` place inside them. */
async function carriedIn(files: Iterable<string>, self: string): Promise<Set<string>> {
  const carried = new Set<string>();
  for (const file of files) {
    if (!existsSync(file)) continue;
    const code = await readFile(file, "utf8");
    const url = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(code)?.[1];
    if (url?.startsWith("data:")) continue;
    const path = url ? join(dirname(file), url) : `${file}.map`;
    if (!existsSync(path)) continue;
    const { sources = [] } = await readJson(path, SourceMap);
    for (const source of sources) {
      const names = [...(source ?? "").matchAll(/node_modules\/((?:@[^/]+\/)?[^/.][^/]*)/g)];
      const name = names.at(-1)?.[1];
      if (name && name !== self) carried.add(name);
    }
  }
  return carried;
}

/** Where `name` is installed for the package in `host`, or null. */
function installedNear(host: string, name: string): string | null {
  // Forward slashes, so Windows paths find their node_modules too.
  const path = host.replaceAll("\\", "/");
  const modules = path.slice(0, path.lastIndexOf("/node_modules/") + "/node_modules/".length);
  return (
    [join(host, "node_modules", name), join(modules, name)].find((dir) =>
      existsSync(join(dir, "package.json")),
    ) ?? null
  );
}

/** A package's licence, notice and copying files, one after the other, or null without any. */
async function licenceFiles(root: string): Promise<string | null> {
  const names = (await readdir(root, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        LICENCE_FILE.test(entry.name) &&
        TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()),
    )
    .map((entry) => entry.name)
    .sort((a, b) => compare(a.toLowerCase(), b.toLowerCase()));
  const read = await Promise.all(
    names.map(async (name) => ({
      name,
      text: normalized(await readFile(join(root, name), "utf8")),
    })),
  );
  const sections = read.filter((section) => section.text.length > 0);
  const [first] = sections;
  if (!first) return null;
  if (sections.length === 1) return first.text;
  return sections.map(({ name, text }) => `${name}\n\n${text}`).join(SEPARATOR);
}

/**
 * The licence's standard text, marked as such: to follow a notice that only refers to it, or for a
 * package without a licence file, with the author its package.json names as copyright holder.
 */
async function standardText(
  app: string,
  json: PackageJson,
  licence: string,
  afterNotice: boolean,
): Promise<string> {
  const id = `${json.name}@${json.version}`;
  const template = join(app, "licences", "standard", `${licence}.txt`);
  if (!existsSync(template)) throw new Error(`${id}: licences/standard has no ${licence}.txt.`);
  const author = typeof json.author === "string" ? json.author : json.author?.name;
  const holder = author?.replace(/\s*[<(].*$/, "").trim();
  const text = normalized(await readFile(template, "utf8"));
  if (text.includes("{holder}") && !holder) {
    throw new Error(`${id} names no author for the standard ${licence} text.`);
  }
  const standard = filled(text, holder ? { holder } : {}, id);
  return afterNotice
    ? `The ${licence} licence, which the notice above refers to:\n\n${standard}`
    : `${json.name} ${json.version} publishes no licence file. This is the standard ${licence} text, with the author its package.json names.\n\n${standard}`;
}

/** Text files relative to the app folder, filled in, one after the other. */
async function texts(
  app: string,
  files: readonly string[],
  fill: (text: string) => string,
): Promise<string> {
  const sections = await Promise.all(
    files.map(async (file) => fill(normalized(await readFile(join(app, file), "utf8")))),
  );
  return sections.join(SEPARATOR);
}

/** `text` with its `{name}` placeholders filled from `variables`, except the app's own. */
function filled(text: string, variables: Readonly<Record<string, string>>, where: string): string {
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = variables[name];
    if (value !== undefined) return value;
    if (RUNTIME_PLACEHOLDERS.has(name)) return placeholder;
    throw new Error(`${where}: nothing fills ${placeholder}.`);
  });
}

function licenceOf(json: PackageJson): string | null {
  return (typeof json.license === "string" ? json.license : json.license?.type) ?? null;
}

/** The repository as a web address: `git+https://github.com/a/b.git` and `a/b` become https://github.com/a/b. */
function repositoryOf(json: PackageJson): string | null {
  const raw = typeof json.repository === "string" ? json.repository : json.repository?.url;
  if (!raw) return null;
  const url = raw
    .replace(/^git\+/, "")
    .replace(/^(git|ssh):\/\/(git@)?/, "https://")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^github:/, "")
    .replace(/(\.git)?(#.*)?$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url;
}

/**
 * Whether the build accepts an SPDX expression: every part of an AND, and some alternative of an
 * OR, is on the COMPATIBLE list or among the licences the component's config `excepted`.
 */
function accepted(expression: string, excepted: Readonly<Record<string, string>>): boolean {
  const alternatives = splitOutside(expression, " OR ");
  if (alternatives.length > 1) return alternatives.some((each) => accepted(each, excepted));
  const parts = splitOutside(expression, " AND ");
  if (parts.length > 1) return parts.every((each) => accepted(each, excepted));
  const single = expression.trim();
  return single.startsWith("(") && single.endsWith(")")
    ? accepted(single.slice(1, -1), excepted)
    : COMPATIBLE.has(single) || Object.hasOwn(excepted, single);
}

/** `text` split at `separator`, except inside parentheses. */
function splitOutside(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    if (text[at] === "(") depth++;
    else if (text[at] === ")") depth--;
    else if (depth === 0 && text.startsWith(separator, at)) {
      parts.push(text.slice(start, at));
      start = at + separator.length;
    }
  }
  return [...parts, text.slice(start)];
}

/** Line endings as \n, without leading blank lines or trailing space. */
function normalized(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/^\n+/, "").trimEnd();
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function readJson<T>(path: string, schema: (data: unknown) => T | ArkErrors): Promise<T> {
  const parsed = schema(JSON.parse(await readFile(path, "utf8")));
  if (parsed instanceof type.errors) throw new Error(`${path}: ${parsed.summary}`);
  return parsed;
}
