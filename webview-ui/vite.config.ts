import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { defineConfig } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  // Inline JS+CSS into a single index.html. VS Code webviews are far more
  // reliable when the bundle is inlined: it removes the cross-origin
  // `type="module"` fetch of /assets/* from the vscode-cdn.net host, which is
  // the usual cause of a permanently grey/blank webview (silent CSP/CORS block).
  plugins: [react(), tailwindcss(), viteSingleFile()],
  css: { postcss: {} },
  build: {
    // Force every asset (incl. large chunks) to be inlined into the HTML.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 100_000_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
