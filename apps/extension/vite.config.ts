import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "extension:unit",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
