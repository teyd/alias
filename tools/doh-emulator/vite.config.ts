import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "doh-emulator:unit",
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
