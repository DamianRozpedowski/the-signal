import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `vite build --mode static` builds the read-only edition for static hosting (GitHub Pages);
// SIGNAL_BASE is the path it is served from, e.g. /the-signal/.
export default defineConfig(({ mode }) => ({
  root: "web",
  base: mode === "static" ? (process.env.SIGNAL_BASE ?? "/") : "/",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": { target: "http://localhost:8787", changeOrigin: false } } },
}));
