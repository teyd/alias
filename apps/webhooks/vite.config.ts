import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "webhooks-lambda:unit",
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
