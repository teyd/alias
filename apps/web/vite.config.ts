import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { securityHeaders } from "./securityHeaders.ts";

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
      // The MCP endpoint and the OAuth metadata (PLAN.md §20.24); `/oauth/authorize` stays the app's.
      "/mcp": apiOrigin,
      "/.well-known": apiOrigin,
    },
  },
  // The production bundle under production's headers (CloudFront adds them there).
  preview: { headers: securityHeaders },
});
