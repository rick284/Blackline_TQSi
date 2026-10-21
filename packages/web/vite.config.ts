import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The browser talks to the API through /api, so there is nothing to configure for cross-origin access.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.API_URL ?? "http://127.0.0.1:3000", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});