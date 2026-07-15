// localStorage persistence: settings, the note-store URL and the note cache.
// Notes are cached with full ENML so the app opens and edits offline.

export const DEFAULT_API_BASE = 'https://www.evernote.com';
export const MAX_NOTES = 10;

const SETTINGS_KEY = 'en_settings';
const NOTES_KEY = 'en_notes';
const STORE_URL_KEY = 'en_notestore_url';

export interface Settings {
	token: string;
	apiBase: string;
}

export interface NoteRecord {
	guid: string;
	title: string;
	updated: number;
	/** Full ENML document; null until the content has been fetched. */
	enml: string | null;
	/** True when a local edit has not reached the server yet. */
	dirty: boolean;
	error?: string;
}

function readJson<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch {
		return fallback;
	}
}

// dev default is same-origin: the Vite dev server proxies /edam and /shard
const defaultApiBase = import.meta.env.DEV ? '' : DEFAULT_API_BASE;

export function getSettings(): Settings {
	return { token: '', apiBase: defaultApiBase, ...readJson<Partial<Settings>>(SETTINGS_KEY, {}) };
}

export function saveSettings(patch: Partial<Settings>): void {
	localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...getSettings(), ...patch }));
}

export function getNoteStoreUrl(): string {
	return localStorage.getItem(STORE_URL_KEY) ?? '';
}

export function setNoteStoreUrl(url: string): void {
	if (url) localStorage.setItem(STORE_URL_KEY, url);
	else localStorage.removeItem(STORE_URL_KEY);
}

export function getNotes(): NoteRecord[] {
	const list = readJson<NoteRecord[]>(NOTES_KEY, []);
	return Array.isArray(list) ? list : [];
}

export function saveNotes(list: NoteRecord[]): void {
	localStorage.setItem(NOTES_KEY, JSON.stringify(list));
}

export function getNote(guid: string): NoteRecord | undefined {
	return getNotes().find((n) => n.guid === guid);
}

export function patchNote(guid: string, patch: Partial<NoteRecord>): void {
	saveNotes(getNotes().map((n) => (n.guid === guid ? { ...n, ...patch } : n)));
}

/**
 * Merge the server's latest-notes list into the local cache. Pure, tested.
 * - notes with unsynced local edits are kept as-is (their upload wins later);
 * - server-side newer notes drop their cached content so it is refetched;
 * - dirty notes that fell out of the server list are kept so they still sync.
 */
export function mergeNotes(
	local: NoteRecord[],
	server: { guid: string; title: string; updated: number }[],
): NoteRecord[] {
	const merged = server.map((meta): NoteRecord => {
		const known = local.find((n) => n.guid === meta.guid);
		if (!known) return { ...meta, enml: null, dirty: false };
		if (known.dirty) return known;
		if (meta.updated > known.updated) return { ...known, ...meta, enml: null };
		return known;
	});
	const kept = new Set(merged.map((n) => n.guid));
	return merged.concat(local.filter((n) => n.dirty && !kept.has(n.guid)));
}
