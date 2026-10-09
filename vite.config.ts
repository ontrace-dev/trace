import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    printWidth: 120,
    ignorePatterns: ["**/drizzle/**", "**/dist/**"],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ["**/drizzle/**", "**/dist/**"],
    overrides: [
      {
        // navigate() and queryClient.invalidateQueries() are fire-and-forget by design in the UI.
        files: ["apps/web/**"],
        rules: { "typescript/no-floating-promises": "off" },
      },
    ],
  },
  run: {
    // Scripts here touch databases and long-running servers — never replay them from cache.
    cache: { scripts: false, tasks: true },
  },
});
