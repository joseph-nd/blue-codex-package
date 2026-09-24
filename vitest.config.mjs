import { defineConfig } from 'vitest/config';

/**
 * Unit/integration tests for scripts/main.mjs, run under Node with mocked
 * Foundry v14 + Nimble globals (see tests/README.md and tests/harness/).
 */
export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.mjs'],
		// Every test file gets its own module registry, so module-level state in
		// scripts/main.mjs (caches, patched prototypes) never leaks between files.
		isolate: true,
		// Loading the real pack data (~2k JSON files) takes a moment on a cold cache.
		testTimeout: 30000,
		hookTimeout: 30000,
		// Tests mutate globalThis (game, Hooks, CONFIG…) — keep a file's tests sequential.
		sequence: { concurrent: false },
		reporters: ['default'],
		// main.mjs logs "[blue-codex-package] …" on every grant/block — noise in test
		// output; warnings and errors still show.
		onConsoleLog(log, type) {
			if (type === 'stdout' && log.startsWith('[blue-codex-package]')) return false;
			return undefined;
		},
	},
});
