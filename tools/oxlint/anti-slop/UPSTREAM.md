# Vendored anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `13909c9e07590f5a85d93c62712259fe14a883f7` (13 October 2026), MIT. `LICENSE` here is upstream's, kept verbatim; `vendor/eslint-stylistic/` keeps its own `LICENSE` and `UPSTREAM.md`.

Copied: the generic plugin, upstream's [source folder](https://github.com/dmmulroy/anti-slop/tree/13909c9e07590f5a85d93c62712259fe14a883f7/src) without its `*.test.ts` files and without its Effect plugin folder, which the card leaves out although this repository uses Effect. That is the generic part of the set upstream's install skill ships. The upstream installer was not run. `tsconfig.json` and this file are this repository's own.

The files are unchanged from that commit except two. `shared/dictionary-types.ts` reads `unsafeMembers[0] ?? null` where upstream returns `unsafeMembers[0]`, since this repository's `noUncheckedIndexedAccess` types that read as possibly undefined; the array is never empty there, so the result is the same. `vendor/eslint-stylistic/UPSTREAM.md` links the upstream files and tests it names, which are not in this repository, in place of naming them as local paths, and names this repository's check command beside upstream's.

`index.ts` registers every generic rule; `.oxlintrc.json` at the repository root decides which run. It loads the plugin through `jsPlugins`, ignores this directory, and lists each rule it leaves off. The plugin needs `@oxlint/plugins` at exactly the `oxlint` version, both pinned in the root `package.json`. `pnpm typecheck` checks this directory, and `.gitignore` keeps its `vendor/` folder, which its ignore of build output named `vendor/` would otherwise leave out.

To update: fetch an explicit upstream commit, diff its source folder (without tests and the Effect plugin) against this directory, port what applies, keep the two adaptations above, and update the commit here.
