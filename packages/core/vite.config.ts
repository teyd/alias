import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "core:unit",
    include: ["test/**/*.test.ts"],
  },
});
