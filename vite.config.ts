import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // The Tauri shell's devUrl pins 5173; a busy port must fail loudly
    // instead of drifting to 5174 where the shell would load a stale build.
    strictPort: true,
    // Bind IPv4 explicitly: on macOS Node resolves `localhost` to ::1, and
    // WKWebView's localhost lookup goes IPv4 — an IPv6-only listener leaves
    // the shell window blank. 127.0.0.1 keeps shell and browser on one host.
    host: '127.0.0.1',
  },
});
