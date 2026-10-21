import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "ses-emulator:unit",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
