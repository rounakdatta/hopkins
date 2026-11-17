import { configDefaults, defineConfig } from "vitest/config";

// .dev holds the dev and preview daemons' homes, including a copy of this repo: never test it twice.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, ".dev/**"] },
});
