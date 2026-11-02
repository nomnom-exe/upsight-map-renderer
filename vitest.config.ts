/** @file Run the tests against the renderer source. @author Norman */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { alias: {
    "@upsight/map-renderer": fileURLToPath(new URL("./src", import.meta.url)),
  } },
  test: { include: ["tests/**/*.test.ts"] },
});
