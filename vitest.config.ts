import { defineConfig } from "vitest/config";
import { exclude, include } from "./test/suites.ts";

export default defineConfig({
  test: {
    include,
    exclude,
    environment: "node",
  },
});
