import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const api = process.env.TRACE_API_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  server: {
    port: 5173,
    // Auth cookies and APP_URL expect 5173 — fail loudly instead of silently moving to another port.
    strictPort: true,
    proxy: {
      "/api": { target: api, changeOrigin: false },
      "/widget.js": { target: api },
    },
  },
});
