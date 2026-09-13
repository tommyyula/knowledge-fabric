import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 8888,
    strictPort: true,
    watch: {
      ignored: [
        "**/data/.claude/**",
        "**/data/ontology-workspaces/**",
        "**/data/ontology-store.json",
        "**/.cache/**",
        "**/.omx/**",
      ],
    },
    proxy: {
      "/api": "http://localhost:8787",
      "/healthz": "http://localhost:8787",
      "/.well-known": "http://localhost:8787",
    },
  },
});
