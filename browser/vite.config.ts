import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "browser",
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
