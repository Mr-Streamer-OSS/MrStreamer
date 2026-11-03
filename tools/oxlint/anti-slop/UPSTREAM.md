# Vendored anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `13909c9e07590f5a85d93c62712259fe14a883f7` (13 October 2026), MIT. `LICENSE` here is upstream's, kept verbatim; `vendor/eslint-stylistic/` keeps its own `LICENSE` and `UPSTREAM.md`.

Copied: the generic plugin, upstream's `src/` without its `*.test.ts` files and without `src/effect/`, the separate Effect plugin. That is the same set upstream's install skill ships in `skills/install-anti-slop/assets/anti-slop/`. The upstream installer was not run.

The files are unchanged from that commit except one: `shared/dictionary-types.ts` reads `unsafeMembers[0] ?? null` where upstream returns `unsafeMembers[0]`, since this repository's `noUncheckedIndexedAccess` types that read as possibly undefined. The array is never empty there, so the result is the same.

`index.ts` registers every generic rule; `.oxlintrc.json` at the repository root decides which run. It loads the plugin through `jsPlugins`, ignores this directory, and lists each rule it leaves off. The plugin needs `@oxlint/plugins` at exactly the `oxlint` version, both pinned in the root `package.json`.

To update: fetch an explicit upstream commit, diff its `src/` (without tests and `effect/`) against this directory, port what applies, keep the adaptation above, and update the commit here.
