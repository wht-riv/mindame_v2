import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/mindame_v2/', // ← この行を追加（前後にスラッシュが必要です）
});
