# Evernote PWA

Minimal proof-of-concept PWA to view and edit your latest Evernote notes.

**Live:** https://vitaly-zdanevich.github.io/evernote-pwa/

- Loads the **10 latest edited** notes.
- Simple editor: note title plus **bold**/*italic* buttons that appear when text is selected.
- **Syncs after every edit** (1 s debounce). Indicator dot: 🟠 orange = syncing, 🟢 green = synced, 🔴 red = failed (auto-retries).
- **Offline**: the app shell is served by a service worker and note contents are cached locally; edits made offline upload when the connection returns.
- Dark theme follows `prefers-color-scheme`, with a pure `#000` background (OLED-friendly).
- No framework, no runtime dependencies — a hand-rolled ~200-line Thrift binary protocol client talks to the EDAM API directly. Whole app is ~6 kB gzipped, minified, targets iOS 15 Safari.

## Setup

1. Open the app → ⚙ Settings.
2. Paste your Evernote **token**. Evernote no longer issues new developer tokens, so reuse the token of an already-authorized app (for example one obtained through [Reeknote](https://github.com/vitaly-zdanevich/reeknote) or [evernote-backup](https://github.com/vzhd1701/evernote-backup)).
3. Set **API base URL** to your CORS proxy (below).

## CORS proxy

The Evernote API does not send `Access-Control-Allow-Origin` headers, so a browser page cannot call it directly — this is a hard platform limitation for any static-hosted client. The app stays 100 % client-side; you just need a dumb path-preserving proxy that adds CORS headers. Deploy your own (do **not** use a public CORS proxy: your token would pass through it).

Cloudflare Worker example (free tier is plenty):

```js
const CORS = {
	'Access-Control-Allow-Origin': 'https://vitaly-zdanevich.github.io',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
	async fetch(req) {
		const url = new URL(req.url);
		if (!url.pathname.startsWith('/edam/') && !url.pathname.startsWith('/shard/')) {
			return new Response('Not found', { status: 404 });
		}
		if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
		const res = await fetch('https://www.evernote.com' + url.pathname, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-thrift' },
			body: req.body,
		});
		return new Response(res.body, { status: res.status, headers: CORS });
	},
};
```

Put the worker URL (e.g. `https://evernote-cors.example.workers.dev`) into **Settings → API base URL**. The note-store URL returned by Evernote is rewritten onto the same base automatically.

## Development

```sh
npm ci
npm run dev        # Vite dev server; its proxy forwards /edam and /shard to Evernote,
                   # so an empty API base URL (the dev default) works without a worker
npm test           # vitest: Thrift protocol, EDAM decoding, ENML serializer, merge logic
npm run lint
npm run typecheck
npm run build      # minified dist/ + generated service worker
npm run icons      # regenerate PNG icons/splashes from public/icons/icon.svg
```

## Deploy

CI runs lint, typecheck, tests and the build on every push and PR. A push to `main` that changes `"version"` in `package.json` is deployed to GitHub Pages.

## Notes on sync semantics (proof of concept)

- Last write wins — no conflict detection against a newer server copy.
- Only guid/title/content are sent on update; Evernote keeps tags, resources and other note fields unchanged.
- Attachments (`en-media`) are not rendered, but they round-trip untouched, and the ENML serializer strips anything the DTD prohibits so saves are never rejected.
- Notes are cached in `localStorage`; the token lives there too, on your device only.

## iOS

Open the app in Safari → Share → **Add to Home Screen**. Standalone mode, launch splash screens and safe-area insets are set up; the dark theme uses pure black.
