// What a repository's repo-kit.config.mjs may import.
export { chain } from "./verify.mjs";
export { KIT_VERSION } from "./check.mjs";
export { BUN_VERSION } from "./token.mjs";

/** Identity, for editors: `export default defineConfig({ ... })`. */
export function defineConfig(config) {
  return config;
}
