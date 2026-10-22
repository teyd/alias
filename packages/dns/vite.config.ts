import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "dns:unit",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
