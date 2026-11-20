import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local acceptance API only. Production uses the nginx same-origin proxy.
const proxy = { '/v1': { target: 'http://127.0.0.1:8786', changeOrigin: false } };
export default defineConfig({plugins:[react()], server:{proxy}, preview:{proxy}});
