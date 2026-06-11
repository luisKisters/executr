import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

// node:sqlite is an experimental Node 22+ built-in; Vite's bundler doesn't know
// about it and strips the `node:` prefix before trying to resolve it.
// This plugin intercepts the bare `sqlite` id and returns an empty virtual module
// that re-exports from the actual `node:sqlite` so it runs in Node's native loader.
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
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
  },
});
