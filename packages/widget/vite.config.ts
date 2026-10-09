import { defineConfig } from "vite-plus";

/** Builds a single self-contained IIFE: dist/widget.js (served by the API at /widget.js). */
export default defineConfig({
  build: {
    target: "es2019",
    outDir: "dist",
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    lib: {
      entry: "src/index.ts",
      name: "TraceWidget",
      formats: ["iife"],
      fileName: () => "widget.js",
    },
  },
});
