import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Independent local services. Production uses the exact Nginx allowlist;
// this dev proxy does not change cookie, CSRF, or Origin requirements.
const proxy = {
  '/v1/study/': { target: 'http://127.0.0.1:8790', changeOrigin: false },
  '/v1': { target: 'http://127.0.0.1:8789', changeOrigin: false },
};
export default defineConfig({plugins:[react()], server:{proxy, strictPort:true}, preview:{proxy, strictPort:true}});
