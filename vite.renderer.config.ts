import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 渲染进程纯 Web 预览配置——M6 UI 开发自检用。
 * 不启动 Electron,数据全部来自 tests/helpers/mock-bridge.ts。
 * 真实 Electron 视觉验证在 M8-02(第⑥关)做。
 */
export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  server: {
    port: 5199,
    strictPort: true,
  },
})
