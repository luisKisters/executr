import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

function nodeSqlitePlugin(): Plugin {
  return {
    name: 'node-sqlite-compat',
    resolveId(id) {
      if (id === 'sqlite' || id === 'node:sqlite') return '\0node-sqlite';
      return undefined;
    },
    load(id) {
      if (id === '\0node-sqlite') {
        return `module.exports = require('node:sqlite');`;
      }
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [nodeSqlitePlugin()],
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
