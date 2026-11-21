import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// WebXR only works on HTTPS (or localhost). basicSsl gives the dev server a
// self-signed certificate so a phone on the same Wi-Fi can open it.
export default defineConfig({
  base: "./", // relative paths, so `dist/` works on any static host
  plugins: [basicSsl()],
  build: { chunkSizeWarningLimit: 1000 }, // three.js alone is ~600 kB; that's expected
  server: {
    host: true, // listen on the LAN, not just localhost
    allowedHosts: [".trycloudflare.com"], // Cloudflare quick tunnel (see README)
  },
  preview: {
    host: true,
    allowedHosts: [".trycloudflare.com"], // Cloudflare quick tunnel (see README)
  },
});
