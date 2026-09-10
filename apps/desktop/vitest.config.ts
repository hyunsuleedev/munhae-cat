import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    hookTimeout: 15_000,
    testTimeout: 15_000,
  },
});
