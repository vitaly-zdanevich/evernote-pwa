# Evernote PWA

Minimal proof-of-concept PWA to view and edit your latest Evernote notes.

**Live:** https://vitaly-zdanevich.github.io/evernote-pwa/

- Loads the **20 latest edited** notes.
- **Create notes** with the **+** button — works offline too; a new note reaches the server on its first edit, and untouched empty notes are quietly discarded.
- Simple editor: note title plus **bold**/*italic* buttons that appear when text is selected.
- **Images** in notes are displayed, fetched lazily through the proxy and cached in IndexedDB for offline reopening; other attachment types show a placeholder and survive edits untouched.
- **Tables** render with a visible cell grid (even old unstyled ones) and scroll horizontally when they are wider than the screen; they round-trip untouched on save, styles, colspans, colgroups and all.
- **Code blocks** (Evernote's `-en-codeblock`, plus clipped `pre`/`code`) render dark-gray in monospace; the proprietary style marker round-trips byte-for-byte.
- **Audio attachments** play in a native `<audio>` player (fetched and cached like images); the player is display-only and never touches the saved note.
- **Links are tappable** (they open in a new tab — inside a contenteditable a plain click only moves the caret) and headings h1–h4 render normally.
- **Checklists work**: `en-todo` renders as a real checkbox, toggling syncs like any edit; bullet and numbered lists render with compact indents and full nesting.
- **Add photos** with 📷 or by pasting: downscaled on-device to a ≤2048 px JPEG (which also keeps uploads under the Lambda 6 MB payload cap) and attached to the note as a resource.
- Each note shows its **notebook and tags** in the list and the editor; **tags are editable** in the editor (comma-separated — missing tags are created by the server automatically, an empty field removes all tags).
- **Pull to refresh** on the list; refreshes are cheap anyway — one `getSyncState` call skips the whole pull when nothing changed server-side.
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

### Option A: AWS Lambda in Rust (included)

Free at this volume: the Lambda always-free tier is 1 M requests + 400 000 GB-seconds per month, and a personal notes app makes a few hundred sub-second 128 MB calls a day. The proxy lives in [`proxy/`](proxy/) (a ~150-line custom-runtime binary; CORS incl. the OPTIONS preflight is handled by the function URL itself, configured in [`infra/terraform/`](infra/terraform/)). It compiles for the native Lambda CPU: arm64 Graviton with `target-cpu=neoverse-n1`.

```sh
AWS_REGION=eu-central-1 ./scripts/deploy.sh    # build + terraform apply, prints the function URL
./scripts/show-logs.sh                         # CloudWatch logs (SINCE=3d, --follow supported)
```

`ALLOWED_ORIGIN` (default `https://vitaly-zdanevich.github.io`) restricts which web origin may call the proxy; `PACKAGE_ONLY=1` just builds the ZIP; `TF_STATE_BUCKET` switches Terraform to an S3 backend.

### Option B: Cloudflare Worker

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
                   # so the empty API base URL default works without a worker in dev
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
- Adding a photo replaces the note's resource list (existing resources are re-sent as guid stubs, which the service keeps); a resource attached from another client in that same moment could be lost.
- Non-image attachments (`en-media`) are shown as placeholders and round-trip untouched; the ENML serializer strips anything the DTD prohibits so saves are never rejected.
- Notes and images are cached in IndexedDB (images unreferenced by any cached note are pruned); the token lives in `localStorage`, on your device only.

## iOS

Open the app in Safari → Share → **Add to Home Screen**. Standalone mode, launch splash screens and safe-area insets are set up; the dark theme uses pure black.
