import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 单元测试只覆盖纯逻辑（房间管理、文件切片/拼装），
    // 媒体协商部分靠双标签页手动验证，见 README。
    include: ['client/src/**/*.test.ts', 'server/src/**/*.test.ts'],
    environment: 'node',
  },
});
