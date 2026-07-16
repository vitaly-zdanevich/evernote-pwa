import { defineConfig } from '@playwright/test';

// Browser smoke tests against the real production build. WebKit (closest to
// iOS Safari) runs in CI; locally chromium is enough and always available.
export default defineConfig({
	testDir: 'e2e',
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	use: {
		baseURL: 'http://localhost:4499',
		colorScheme: 'dark', // the pure-#000 theme is the one that regresses
		serviceWorkers: 'block', // stale-cache flakiness has bitten before
		viewport: { width: 390, height: 720 },
	},
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium' } },
		...(process.env.CI ? [{ name: 'webkit', use: { browserName: 'webkit' as const } }] : []),
	],
	webServer: {
		command: 'npm run build && npx vite preview --port 4499 --strictPort',
		url: 'http://localhost:4499',
		reuseExistingServer: !process.env.CI,
	},
});
