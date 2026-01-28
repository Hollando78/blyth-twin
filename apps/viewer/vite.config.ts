import { defineConfig } from "vite";
import viteCompression from "vite-plugin-compression";

export default defineConfig({
  root: ".",
  publicDir: "../../dist/blyth_mvp_v1",
  build: {
    outDir: "../../dist/viewer",
    emptyOutDir: true,
  },
  plugins: [
    // Gzip compression for production builds
    viteCompression({
      algorithm: "gzip",
      ext: ".gz",
      threshold: 1024, // Only compress files > 1KB
      filter: /\.(js|css|html|json|glb|svg)$/i,
    }),
    // Brotli compression (better ratio)
    viteCompression({
      algorithm: "brotliCompress",
      ext: ".br",
      threshold: 1024,
      filter: /\.(js|css|html|json|glb|svg)$/i,
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
    cors: true,
    headers: {
      "Access-Control-Allow-Origin": "*",
      // Cache static assets for 1 year (with cache busting via hash)
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  },
});
