import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";

const proxy = {
  "/api": { target: "http://127.0.0.1:5000", changeOrigin: true },
  "/aura-ws": { target: "ws://127.0.0.1:5001", ws: true, changeOrigin: true },
  "/__aura_voice": {
    target: "http://127.0.0.1:5002",
    changeOrigin: true,
    rewrite: requestPath => requestPath.replace(/^\/__aura_voice/, ""),
  },
};

const https = process.env.AURA_DEV_TLS_KEY && process.env.AURA_DEV_TLS_CERT
  ? {
      key: fs.readFileSync(process.env.AURA_DEV_TLS_KEY),
      cert: fs.readFileSync(process.env.AURA_DEV_TLS_CERT),
    }
  : process.env.AURA_DEV_TLS_PFX
    ? { pfx: fs.readFileSync(process.env.AURA_DEV_TLS_PFX) }
    : undefined;

export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "index.html"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: "localhost",
    https,
    proxy,
  },
  preview: {
    host: "localhost",
    proxy,
  },
});
