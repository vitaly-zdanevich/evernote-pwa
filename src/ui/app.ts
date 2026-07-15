import { enmlToHtml, htmlToEnml } from '../enml';
import type { XmlNode } from '../enml';
import * as store from '../store';
import * as sync from '../sync';
import { clear, el } from './dom';

const SAVE_DEBOUNCE_MS = 1000;

let root: HTMLElement;

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

function listView(): HTMLElement {
	const notes = [...store.getNotes()].sort((a, b) => b.updated - a.updated);
	const err = sync.lastRefreshError();
	const hasToken = Boolean(store.getSettings().token);
	return el(
		'section',
		{},
		header(
			'Notes',
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
			...notes.map((n) =>
				el(
					'li',
					{},
					el(
						'a',
						{ href: '#n/' + encodeURIComponent(n.guid) },
						n.dirty || n.error ? dot(n.error ? 'error' : 'syncing') : null,
						el('span', { class: 't' }, n.title || 'Untitled'),
						el('span', { class: 'd' }, fmtDate(n.updated)),
					),
				),
			),
		),
		hasToken && !notes.length && !err ? el('p', { class: 'hint' }, 'Loading your 10 latest notes…') : null,
	);
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
	let body: HTMLElement;
	if (rec.enml === null) {
		editorLoading = true;
		body = el('div', { class: 'body hint' }, 'Loading…');
	} else {
		const parsed = enmlToHtml(rec.enml);
		editorAttrs = parsed.attrs;
		body = el('div', { class: 'body', contenteditable: 'true' });
		body.innerHTML = parsed.html;
		body.addEventListener('input', scheduleSave);
		editorBody = body;
	}
	return el('section', { class: 'editor' }, header('', true, toolbar), editorTitle, body);
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
		placeholder: store.DEFAULT_API_BASE,
		autocapitalize: 'off',
		autocorrect: 'off',
		spellcheck: 'false',
		'aria-label': 'API base URL',
	});
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
		el(
			'p',
			{ class: 'hint version' },
			`v${__APP_VERSION__} · `,
			el('a', { href: 'https://github.com/vitaly-zdanevich/evernote-pwa', target: '_blank', rel: 'noopener' }, 'source'),
		),
	);
}
