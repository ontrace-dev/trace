import { defineConfig } from "vite-plus";

/** Builds a single self-contained IIFE: dist/portal.js (served by the API at /portal.js). */
export default defineConfig({
  build: {
    target: "es2019",
    outDir: "dist",
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    lib: {
      entry: "src/index.ts",
      name: "TracePortal",
      formats: ["iife"],
      fileName: () => "portal.js",
    },
  },
});
