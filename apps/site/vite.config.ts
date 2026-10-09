import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite-plus";
import { filledIcons, strokeIcons } from "./src/icons.ts";

/** Replaces `<i data-icon="mail" class="…"></i>` in index.html with the inline SVG, so the page ships no icon JS. */
function inlineIcons(): Plugin {
  return {
    name: "inline-icons",
    transformIndexHtml(html) {
      return html.replace(
        /<i\s+data-icon="([\w-]+)"(?:\s+class="([^"]*)")?\s*><\/i\s*>/g,
        (_, name: string, cls = "") => {
          // width/height keep the icon at text size until the stylesheet's size-* classes apply.
          const attrs = `width="1em" height="1em" class="${cls}" aria-hidden="true" focusable="false"`;
          const filled = filledIcons[name];
          if (filled) return `<svg viewBox="${filled.viewBox}" fill="currentColor" ${attrs}>${filled.body}</svg>`;
          const stroke = strokeIcons[name];
          if (!stroke) throw new Error(`unknown icon "${name}" in index.html`);
          return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${attrs}>${stroke}</svg>`;
        },
      );
    },
  };
}

/**
 * Fills every `<div class="trace-field">` with src/trace-field.svg, inlined so the spans can animate from
 * styles.css (same timing as the app's sign-in background: each trace writes itself left to right, the
 * groups staggered, with a slightly different loop length per group).
 */
function inlineTraceField(): Plugin {
  const file = new URL("./src/trace-field.svg", import.meta.url);
  const render = () => {
    let group = -1;
    let span = 0;
    return readFileSync(file, "utf8")
      .replace(/<\?xml[^>]*>\s*/, "")
      .replace(/<svg /, '<svg aria-hidden="true" focusable="false" ')
      .replace(/<text |<rect ([^>]*height="4")/g, (match, attrs?: string) => {
        if (!attrs) {
          group++;
          span = 0;
          return match;
        }
        const delay = group * 2.4 + span++ * 0.42;
        const duration = 15 + group * 1.5;
        return `<rect class="trace-bar" style="animation-delay:-${delay.toFixed(2)}s;animation-duration:${duration}s" ${attrs}`;
      });
  };
  return {
    name: "inline-trace-field",
    configureServer(server) {
      server.watcher.add(file.pathname);
    },
    transformIndexHtml(html) {
      const svg = render();
      return html.replace(/(<div\s+class="trace-field"[^>]*>)\s*(<\/div>)/g, `$1${svg}$2`);
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), inlineIcons(), inlineTraceField()],
  server: { port: 5174, strictPort: true },
});
