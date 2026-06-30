import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri fronts the Vite dev server. Use a dedicated port (5273) so it never
// collides with the extension's own tooling when both run in the monorepo.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5273,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
