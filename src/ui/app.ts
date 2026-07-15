import { enmlToHtml, htmlToEnml } from '../enml';
import type { XmlNode } from '../enml';
import { md5Hex } from '../md5';
import * as store from '../store';
import * as sync from '../sync';
import { clear, el } from './dom';

const SAVE_DEBOUNCE_MS = 1000;

let root: HTMLElement;

/** Repaints the current view; set once initUi has run. */
export let rerender: () => void = () => undefined;

// editor state; reset on every route change
let editorGuid = '';
let editorAttrs = '';
let editorBody: HTMLElement | null = null;
let editorTitle: HTMLInputElement | null = null;
let editorLoading = false;
let toolbar: HTMLElement | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingEdit = false;

export function initUi(): void {
	root = document.getElementById('app') as HTMLElement;
	addEventListener('hashchange', render);
	document.addEventListener('selectionchange', updateToolbar);
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) flushEditor(); // persist before iOS suspends us
	});
	sync.onChange(onSyncChange);
	rerender = render;
	sync.onGuidChange((from, to) => {
		// the note being edited just got its server guid
		if (editorGuid === from) {
			editorGuid = to;
			history.replaceState(null, '', '#n/' + encodeURIComponent(to));
		}
	});
	render();
}

function route(): { view: 'list' | 'editor' | 'settings'; guid: string } {
	const h = location.hash;
	if (h.startsWith('#n/')) return { view: 'editor', guid: decodeURIComponent(h.slice(3)) };
	return { view: h === '#settings' ? 'settings' : 'list', guid: '' };
}

function render(): void {
	flushEditor();
	editorGuid = '';
	editorBody = editorTitle = toolbar = null;
	editorLoading = false;
	const r = route();
	if (r.view === 'list') store.dropUntouchedLocalNotes();
	clear(root);
	if (r.view === 'editor') root.append(editorView(r.guid));
	else if (r.view === 'settings') root.append(settingsView());
	else root.append(listView());
}

function onSyncChange(): void {
	const r = route();
	if (r.view === 'list') {
		clear(root).append(listView());
		return;
	}
	if (r.view === 'editor' && editorLoading && store.getNote(r.guid)?.enml != null) {
		render(); // content arrived while the placeholder was up
		return;
	}
	updateDots();
}

function uiStatus(): sync.SyncState {
	return pendingEdit ? 'syncing' : sync.status();
}

const STATUS_LABEL: Record<sync.SyncState, string> = {
	synced: 'Synced',
	syncing: 'Syncing…',
	error: 'Sync failed — will retry',
};

function dot(state: sync.SyncState = uiStatus()): HTMLElement {
	return el('span', { class: 'dot ' + state, role: 'status', title: STATUS_LABEL[state] });
}

function updateDots(): void {
	const state = uiStatus();
	for (const d of root.querySelectorAll('.dot.global')) {
		d.className = 'dot global ' + state;
		(d as HTMLElement).title = STATUS_LABEL[state];
	}
}

function header(title: string, back: boolean, ...actions: (Node | null)[]): HTMLElement {
	const d = dot();
	d.classList.add('global');
	return el(
		'header',
		{},
		back ? el('a', { class: 'back', href: '#', 'aria-label': 'Back' }, '‹') : null,
		el('h1', {}, title),
		d,
		...actions,
	);
}

function displayTags(n: store.NoteRecord): string[] {
	return n.tagNames ?? store.tagNames(n.tagGuids);
}

/** "Notebook · tag1, tag2" — whatever parts the note has. */
function noteContext(n: store.NoteRecord): string {
	const parts = [store.notebookName(n.notebookGuid), displayTags(n).join(', ')];
	return parts.filter(Boolean).join(' · ');
}

function fmtDate(ms: number): string {
	const d = new Date(ms);
	const now = new Date();
	if (d.toDateString() === now.toDateString()) {
		return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	}
	return d.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
	});
}

function newNote(): void {
	const rec = store.createLocalNote();
	location.hash = '#n/' + encodeURIComponent(rec.guid);
}

/** iOS standalone has no reload button; overscrolling the list re-syncs. */
function attachPullToRefresh(section: HTMLElement): void {
	const bar = el('div', { class: 'ptr' }, 'Pull to refresh');
	section.append(bar);
	let startY = 0;
	let tracking = false;
	let armed = false;
	const opts = { passive: true };
	section.addEventListener(
		'touchstart',
		(e) => {
			tracking = window.scrollY <= 0;
			armed = false;
			startY = (e as TouchEvent).touches[0].clientY;
		},
		opts,
	);
	section.addEventListener(
		'touchmove',
		(e) => {
			if (!tracking) return;
			const delta = (e as TouchEvent).touches[0].clientY - startY;
			armed = delta > 70 && window.scrollY <= 0;
			bar.classList.toggle('show', delta > 20 && window.scrollY <= 0);
			bar.classList.toggle('armed', armed);
			bar.textContent = armed ? 'Release to refresh' : 'Pull to refresh';
		},
		opts,
	);
	section.addEventListener(
		'touchend',
		() => {
			if (armed) void sync.refresh();
			tracking = false;
			armed = false;
			bar.classList.remove('show', 'armed');
		},
		opts,
	);
}

function listView(): HTMLElement {
	const notes = [...store.getNotes()].sort((a, b) => b.updated - a.updated);
	const err = sync.lastRefreshError();
	const hasToken = Boolean(store.getSettings().token);
	const section = el(
		'section',
		{},
		header(
			'',
			false,
			el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'New note', onclick: newNote }, '+'),
			el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Refresh', onclick: () => void sync.refresh() }, '↻'),
			el('a', { class: 'iconbtn', href: '#settings', 'aria-label': 'Settings' }, '⚙'),
		),
		err ? el('p', { class: 'error' }, err) : null,
		!hasToken
			? el('p', { class: 'hint' }, 'Add your Evernote token in ', el('a', { href: '#settings' }, 'Settings'), ' to load notes.')
			: null,
		el(
			'ul',
			{ class: 'notes' },
			...notes.map((n) => {
				const context = noteContext(n);
				return el(
					'li',
					{},
					el(
						'a',
						{ href: '#n/' + encodeURIComponent(n.guid) },
						n.dirty || n.error ? dot(n.error ? 'error' : 'syncing') : null,
						el(
							'div',
							{ class: 'tw' },
							el('div', { class: 't' }, n.title || 'Untitled'),
							context ? el('div', { class: 'sub' }, context) : null,
						),
						el('span', { class: 'd' }, fmtDate(n.updated)),
					),
				);
			}),
		),
		hasToken && !notes.length && !err
			? el('p', { class: 'hint' }, `Loading your ${store.MAX_NOTES} latest notes…`)
			: null,
	);
	attachPullToRefresh(section);
	return section;
}

function fmtButton(label: string, cmd: string): HTMLElement {
	return el(
		'button',
		{
			class: 'fmtb',
			type: 'button',
			'data-cmd': cmd,
			'aria-label': cmd,
			// keep the text selection: don't let the button take focus
			onmousedown: (e: Event) => e.preventDefault(),
			onclick: () => {
				document.execCommand(cmd);
				updateToolbar();
			},
		},
		label,
	);
}

function updateToolbar(): void {
	if (!toolbar || !editorBody) return;
	const sel = getSelection();
	const show = Boolean(sel && !sel.isCollapsed && sel.anchorNode && editorBody.contains(sel.anchorNode));
	toolbar.classList.toggle('show', show);
	if (!show) return;
	for (const b of toolbar.querySelectorAll('.fmtb')) {
		b.classList.toggle('on', document.queryCommandState((b as HTMLElement).dataset.cmd as string));
	}
}

/**
 * Big camera photos become bounded JPEGs; small GIF/PNG/WebP keep their
 * format (animation, transparency). Falls back to the original bytes when
 * decoding fails.
 */
async function prepareImage(file: Blob): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
	const keepFormat = /image\/(gif|png|webp)/.test(file.type) && file.size < 1_500_000;
	if (!keepFormat) {
		try {
			const bmp = await createImageBitmap(file);
			const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
			const canvas = document.createElement('canvas');
			canvas.width = Math.round(bmp.width * scale);
			canvas.height = Math.round(bmp.height * scale);
			const ctx = canvas.getContext('2d');
			if (!ctx) throw new Error('no 2d context');
			ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
			const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
			if (blob) return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg' };
		} catch {
			// not decodable here; upload the original bytes
		}
	}
	return { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type || 'application/octet-stream' };
}

async function addPhoto(file: Blob): Promise<void> {
	if (!editorBody || !editorGuid) return;
	const { bytes, mime } = await prepareImage(file);
	const hash = md5Hex(bytes);
	const blob = new Blob([bytes], { type: mime });
	store.cacheImage(hash, blob);
	if (!imageUrls.has(hash)) imageUrls.set(hash, URL.createObjectURL(blob));
	const img = el('img', { src: imageUrls.get(hash), 'data-en-hash': hash, 'data-en-type': mime });
	editorBody.append(el('div', {}, img));
	const rec = store.getNote(editorGuid);
	const pending = rec?.pendingResources ?? [];
	if (!pending.includes(hash)) {
		store.patchNote(editorGuid, { pendingResources: [...pending, hash] });
	}
	scheduleSave();
	flushEditor(); // a photo is worth syncing immediately
}

function editorView(guid: string): HTMLElement {
	const rec = store.getNote(guid);
	if (!rec) {
		return el('section', {}, header('Note', true), el('p', { class: 'hint' }, 'Note not found.'));
	}
	editorGuid = guid;
	editorTitle = el('input', {
		class: 'title',
		type: 'text',
		value: rec.title,
		placeholder: 'Title',
		'aria-label': 'Note title',
		oninput: scheduleSave,
	});
	if (store.isLocalGuid(guid) && !rec.title && !rec.dirty) {
		const t = editorTitle;
		setTimeout(() => t.focus(), 0); // after it is in the document
	}
	toolbar = el('div', { class: 'fmt' }, fmtButton('B', 'bold'), fmtButton('I', 'italic'));
	const fileInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
	fileInput.addEventListener('change', () => {
		const file = fileInput.files?.[0];
		if (file) void addPhoto(file);
		fileInput.value = '';
	});
	const photoBtn = el(
		'button',
		{ class: 'iconbtn', type: 'button', 'aria-label': 'Add photo', onclick: () => fileInput.click() },
		'📷',
	);
	const notebook = store.notebookName(rec.notebookGuid);
	let contextLine: HTMLElement;
	let body: HTMLElement;
	if (rec.enml === null) {
		editorLoading = true;
		// tags become editable once the content is here and syncing can work
		const context = noteContext(rec);
		contextLine = el('div', { class: 'notemeta' }, context);
		body = el('div', { class: 'body hint' }, 'Loading…');
	} else {
		const parsed = enmlToHtml(rec.enml);
		editorAttrs = parsed.attrs;
		body = el('div', { class: 'body', contenteditable: 'true' });
		body.innerHTML = parsed.html;
		body.addEventListener('input', scheduleSave);
		body.addEventListener('paste', (ev) => {
			const file = (ev as ClipboardEvent).clipboardData?.files?.[0];
			if (file && file.type.startsWith('image/')) {
				ev.preventDefault();
				void addPhoto(file);
			}
		});
		// contenteditable swallows link clicks (they just move the caret)
		body.addEventListener('click', (ev) => {
			const target = ev.target as Element | null;
			const link = target?.closest ? target.closest('a[href]') : null;
			const href = link?.getAttribute('href') ?? '';
			if (/^(https?:|mailto:|tel:)/i.test(href)) {
				ev.preventDefault();
				window.open(href, '_blank', 'noopener');
			}
		});
		editorBody = body;
		void hydrateMedia(body, guid);
		const tagsInput = el('input', {
			class: 'tagsinput',
			type: 'text',
			value: displayTags(rec).join(', '),
			placeholder: 'tags',
			autocapitalize: 'off',
			autocorrect: 'off',
			spellcheck: 'false',
			'aria-label': 'Tags, comma separated',
		});
		tagsInput.addEventListener('keydown', (e) => {
			if ((e as KeyboardEvent).key === 'Enter') tagsInput.blur();
		});
		tagsInput.addEventListener('change', () => {
			if (editorGuid) sync.tagsEdited(editorGuid, store.parseTags(tagsInput.value));
		});
		contextLine = el(
			'div',
			{ class: 'notemeta' },
			notebook ? el('span', {}, notebook + ' · ') : null,
			tagsInput,
		);
	}
	return el(
		'section',
		{ class: 'editor' },
		header('', true, toolbar, photoBtn, fileInput),
		editorTitle,
		contextLine,
		body,
	);
}

// hash -> object URL, cached for the session so reopening a note is instant
const imageUrls = new Map<string, string>();

/** Resource bytes as an object URL: session cache, then IndexedDB, then network. */
async function resourceObjectUrl(noteGuid: string, hash: string): Promise<string> {
	let url = imageUrls.get(hash);
	if (url) return url;
	let blob = await store.getCachedImage(hash);
	if (!blob) {
		blob = await sync.fetchImage(noteGuid, hash);
		store.cacheImage(hash, blob);
	}
	url = URL.createObjectURL(blob);
	imageUrls.set(hash, url);
	return url;
}

async function hydrateMedia(body: HTMLElement, noteGuid: string): Promise<void> {
	for (const media of Array.from(body.querySelectorAll('en-media'))) {
		const type = media.getAttribute('type') ?? '';
		const hash = media.getAttribute('hash') ?? '';
		if (!hash || !/^(image|audio)\//.test(type)) continue; // others stay placeholders
		try {
			const url = await resourceObjectUrl(noteGuid, hash);
			if (!media.isConnected) continue; // user navigated away or deleted it
			if (type.startsWith('audio/')) {
				// display-only player next to the (hidden) en-media, which is
				// what actually round-trips; the class is stripped on save
				media.after(el('audio', { controls: true, src: url, contenteditable: 'false' }));
				media.setAttribute('class', 'played');
			} else {
				const img = el('img', {
					src: url,
					'data-en-hash': hash,
					'data-en-type': type,
					width: media.getAttribute('width'),
					height: media.getAttribute('height'),
				});
				media.replaceWith(img);
			}
		} catch {
			// leave the dashed en-media placeholder; a reopen retries
		}
	}
}

function scheduleSave(): void {
	if (!editorGuid) return;
	pendingEdit = true;
	updateDots(); // orange immediately, not only when the debounce fires
	clearTimeout(saveTimer);
	saveTimer = setTimeout(flushEditor, SAVE_DEBOUNCE_MS);
}

function flushEditor(): void {
	clearTimeout(saveTimer);
	saveTimer = undefined;
	if (!pendingEdit || !editorGuid || !editorTitle) return;
	pendingEdit = false;
	const enml = editorBody
		? htmlToEnml(editorBody as unknown as XmlNode, editorAttrs)
		: (store.getNote(editorGuid)?.enml ?? '');
	sync.noteEdited(editorGuid, editorTitle.value.trim() || 'Untitled', enml);
}

const GITHUB_OWNER = 'vitaly-zdanevich';
const GITHUB_REPO = 'evernote-pwa';
const GITHUB_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;

interface GhCommit {
	sha: string;
	html_url: string;
	commit: { message: string; committer?: { date?: string }; author?: { date?: string } };
}

/** package.json version at a given commit; raw.githubusercontent is CORS-open and not API-rate-limited. */
async function versionAt(sha: string): Promise<string> {
	try {
		const res = await fetch(`https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${sha}/package.json`);
		if (!res.ok) return '';
		const v = (JSON.parse(await res.text()) as { version?: string }).version;
		return v ? `v${v}` : '';
	} catch {
		return '';
	}
}

async function loadCommits(container: HTMLElement): Promise<void> {
	try {
		let commits: GhCommit[] | null = null;
		let versions: string[] | null = null;
		const cached = sessionStorage.getItem('en_commits');
		if (cached) {
			const parsed = JSON.parse(cached) as { ts: number; data: GhCommit[]; versions: string[] };
			if (Date.now() - parsed.ts < 10 * 60 * 1000) {
				commits = parsed.data;
				versions = parsed.versions;
			}
		}
		if (!commits || !versions) {
			const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits?per_page=10`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			commits = (await res.json()) as GhCommit[];
			versions = await Promise.all(commits.map((c) => versionAt(c.sha)));
			sessionStorage.setItem('en_commits', JSON.stringify({ ts: Date.now(), data: commits, versions }));
		}
		const ul = el('ul', { class: 'commits' });
		commits.forEach((c, i) => {
			const date = (c.commit.committer?.date ?? c.commit.author?.date ?? '').slice(0, 10);
			const ver = versions?.[i] ? ` ${versions[i]}` : '';
			ul.append(
				el(
					'li',
					{},
					el('a', { href: c.html_url, target: '_blank', rel: 'noopener' }, c.sha.slice(0, 7)),
					`${ver} ${date} ${c.commit.message.split('\n')[0]}`,
				),
			);
		});
		clear(container).append(ul);
	} catch {
		clear(container).append(el('p', { class: 'hint' }, 'Could not load commits.'));
	}
}

function settingsView(): HTMLElement {
	const s = store.getSettings();
	const token = el('input', {
		class: 'field',
		type: 'password',
		value: s.token,
		autocapitalize: 'off',
		autocorrect: 'off',
		autocomplete: 'off',
		spellcheck: 'false',
		'aria-label': 'Evernote token',
	});
	const show = el('input', {
		type: 'checkbox',
		onchange: () => {
			token.type = show.checked ? 'text' : 'password';
		},
	});
	const apiBase = el('input', {
		class: 'field',
		type: 'url',
		value: s.apiBase,
		placeholder: 'https://your-cors-proxy.example',
		autocapitalize: 'off',
		autocorrect: 'off',
		spellcheck: 'false',
		'aria-label': 'API base URL',
	});
	const commitList = el('div', {}, el('p', { class: 'hint' }, 'Loading…'));
	void loadCommits(commitList);
	return el(
		'section',
		{ class: 'settings' },
		header('Settings', true),
		el('label', {}, 'Evernote token'),
		token,
		el('label', { class: 'check' }, show, ' show token'),
		el('label', {}, 'API base URL'),
		apiBase,
		el(
			'p',
			{ class: 'hint' },
			'Browsers cannot call the Evernote API directly (no CORS headers), so point this at your own tiny proxy — see the ',
			el('a', { href: 'https://github.com/vitaly-zdanevich/evernote-pwa#cors-proxy', target: '_blank', rel: 'noopener' }, 'README'),
			'.',
		),
		el(
			'button',
			{
				class: 'primary',
				type: 'button',
				onclick: () => {
					store.saveSettings({
						token: token.value.trim(),
						apiBase: apiBase.value.trim().replace(/\/+$/, ''),
					});
					store.setNoteStoreUrl('');
					location.hash = '';
					void sync.refresh();
				},
			},
			'Save',
		),
		el('label', {}, 'Last 10 commits'),
		commitList,
		el(
			'p',
			{ class: 'hint version' },
			`v${__APP_VERSION__} · `,
			el('a', { href: GITHUB_URL, target: '_blank', rel: 'noopener' }, 'source'),
		),
	);
}
