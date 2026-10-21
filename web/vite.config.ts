import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // HTTPS is not optional: browsers only expose the camera and geolocation to
  // secure origins, and a phone on the LAN is not "localhost". The plugin
  // issues a self-signed certificate, which the phone accepts once.
  plugins: [basicSsl()],
  resolve: {
    // The browser imports the shared package's pure modules from source —
    // canonical encoding, the signed payload and the geofence arithmetic —
    // so the device runs the same code the contract does, not a copy.
    alias: { '@shared': here('../packages/shared/src') },
  },
  server: {
    host: true,
    port: 5173,
    // One origin for the page and the API: an HTTPS page may not call an
    // HTTP API, and a phone cannot reach the API's localhost anyway.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        home: here('index.html'),
        faculty: here('faculty.html'),
        student: here('student.html'),
        verify: here('verify.html'),
        registrar: here('registrar.html'),
      },
    },
  },
  test: { environment: 'node' },
});
