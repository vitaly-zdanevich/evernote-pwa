// Generated at build time by scripts/postbuild.mjs (placeholders injected).
const CACHE = 'enpwa-__VERSION__';
const ASSETS = __PRECACHE__;

self.addEventListener('install', (e) => {
	e.waitUntil(
		caches
			.open(CACHE)
			.then((c) => c.addAll(ASSETS))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener('activate', (e) => {
	e.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener('fetch', (e) => {
	const req = e.request;
	const url = new URL(req.url);
	// Evernote API calls pass through untouched
	if (req.method !== 'GET' || url.origin !== location.origin) return;
	if (req.mode === 'navigate') {
		e.respondWith(fetch(req).catch(() => caches.match('./')));
		return;
	}
	e.respondWith(
		caches.match(req).then(
			(hit) =>
				hit ||
				fetch(req).then((res) => {
					if (res.ok) {
						const copy = res.clone();
						caches.open(CACHE).then((c) => c.put(req, copy));
					}
					return res;
				}),
		),
	);
});
