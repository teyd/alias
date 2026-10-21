import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

// Ports come from the per-worktree port block written by `pnpm agent:setup` (see scripts/lib/ports.ts).
const webPort = Number(process.env.ALIAS_WEB_PORT ?? 5173);
const apiOrigin = `http://127.0.0.1:${process.env.ALIAS_API_PORT ?? 8787}`;

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      "/v1": apiOrigin,
      "/health": apiOrigin,
    },
  },
});
