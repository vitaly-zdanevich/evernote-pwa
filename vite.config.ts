/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
	version: string;
};

export default defineConfig({
	base: './',
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
	},
	build: {
		// iOS 15 must be supported; safari14 keeps the syntax safe for it
		target: 'safari14',
		modulePreload: { polyfill: false },
	},
	server: {
		// lets the dev build talk to Evernote without a CORS proxy:
		// leave "API base URL" empty in the settings screen
		proxy: {
			'/edam': { target: 'https://www.evernote.com', changeOrigin: true },
			'/shard': { target: 'https://www.evernote.com', changeOrigin: true },
		},
	},
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text-summary', 'lcov'],
			include: ['src/**'],
		},
	},
});
