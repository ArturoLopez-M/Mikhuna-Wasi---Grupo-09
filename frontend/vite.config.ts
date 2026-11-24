import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Sitio estático: `npm run build` genera dist/, que se sube al bucket S3 y
// se sirve con CloudFront (diagrama: "S3 (carga la web)").
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false },
  test: { environment: "node" },
});
