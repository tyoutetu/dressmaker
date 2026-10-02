import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VITE_BASE_PATH is only needed when hosting under a sub-path, e.g. GitHub Pages
// project sites (https://user.github.io/<repo>/). The Pages workflow passes it
// via --base, so this default of "/" covers custom domains and local dev.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH ?? "/",
});
