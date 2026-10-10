// Where the test files are. vitest.config.ts runs these, and scripts/ci-test-results.ts finds the
// same files to require each one in CI's report, so a new test file needs no list of its own.

/** Globs of the test files, from the repository's root. */
export const include = [
  "test/**/*.test.ts",
  "packages/*/test/**/*.test.ts",
  "apps/*/test/**/*.test.ts",
];

/** Vitest's default exclusions, named here so the report check leaves out the same files. */
export const exclude = ["**/node_modules/**", "**/.git/**"];
