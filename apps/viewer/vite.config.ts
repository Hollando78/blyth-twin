import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  publicDir: "../../dist/blyth_mvp_v1",
  build: {
    outDir: "../../dist/viewer",
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    open: true,
  },
});
