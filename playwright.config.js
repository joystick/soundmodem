import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  use: {
    baseURL: 'http://localhost:8765',
    browserName: 'chromium',
    // Required for getUserMedia and AudioWorklet
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
    permissions: ['microphone'],
  },
  // No web server — assumes `python3 -m http.server 8765` is running
  timeout: 15000,
});
