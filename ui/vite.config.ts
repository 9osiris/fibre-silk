import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// dev server on 5173; electron loads dist/ in prod
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  base: "./",
});
