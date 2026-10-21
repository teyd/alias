import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "e2e:stack",
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
