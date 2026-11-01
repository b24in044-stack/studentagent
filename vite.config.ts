import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendPort = process.env.PORT || env.PORT || '3000';
  const apiTarget = process.env.API_PROXY_TARGET || env.API_PROXY_TARGET || `http://127.0.0.1:${backendPort}`;

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          configure(proxy) {
            proxy.on('error', (_error, _request, response) => {
              if (!('writeHead' in response) || response.headersSent) return;
              response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
              response.end(JSON.stringify({
                success: false,
                code: 'API_BACKEND_UNAVAILABLE',
                message: 'LearnPulse API backend is unavailable. Start the Express server and retry.',
              }));
            });
          },
        },
      },
    },
  };
});
