// Persistence: notes and images live in IndexedDB (async, roomy, and keeps
// multi-megabyte ENML serialization off the main thread); the tiny settings
// stay in localStorage. Note reads are served from an in-memory copy loaded
// once by initStore(), so callers stay synchronous; every change is written
// through to IndexedDB in the background.

import { EMPTY_ENML } from './enml';

export const MAX_NOTES = 20;

const SETTINGS_KEY = 'en_settings';
const STORE_URL_KEY = 'en_notestore_url';
const DB_NAME = 'enpwa';

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
	notebookGuid?: string;
	tagGuids?: string[];
	/**
	 * Tag names as edited on this device; sent with the next sync (the
	 * server creates missing tags) and shown until a pull confirms them.
	 * undefined = tags untouched locally.
	 */
	tagNames?: string[];
	/** MD5 hex of images added locally, uploaded with the next note sync. */
	pendingResources?: string[];
	/** Notebook chosen on this device; sent (as a move) with the next sync. */
	pendingNotebook?: string;
}

let db: IDBDatabase | null = null;
let notes: NoteRecord[] = [];

function readJson<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch {
		return fallback;
	}
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			req.result.createObjectStore('notes', { keyPath: 'guid' });
			req.result.createObjectStore('images');
		};
		req.onsuccess = () => {
			// another context (tab, test) may delete/upgrade the database;
			// holding the connection open would block it forever
			req.result.onversionchange = () => {
				req.result.close();
				db = null;
			};
			resolve(req.result);
		};
		req.onerror = () => reject(req.error);
	});
}

function readAllNotes(d: IDBDatabase): Promise<NoteRecord[]> {
	return new Promise((resolve) => {
		const req = d.transaction('notes').objectStore('notes').getAll();
		req.onsuccess = () => {
			const rows = (req.result ?? []) as (NoteRecord & { order?: number })[];
			rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
			for (const row of rows) delete row.order;
			resolve(rows);
		};
		req.onerror = () => resolve([]);
	});
}

/**
 * Must complete before anything reads notes. Falls back to memory-only
 * when IndexedDB is unavailable.
 */
export async function initStore(): Promise<void> {
	try {
		if (typeof indexedDB !== 'undefined') db = await openDb();
	} catch {
		db = null;
	}
	notes = db ? await readAllNotes(db) : [];
}

function persistAll(): void {
	if (!db) return;
	const store = db.transaction('notes', 'readwrite').objectStore('notes');
	store.clear();
	notes.forEach((n, i) => store.put({ ...n, order: i }));
}

function persistOne(guid: string): void {
	if (!db) return;
	const i = notes.findIndex((n) => n.guid === guid);
	if (i < 0) return;
	db.transaction('notes', 'readwrite').objectStore('notes').put({ ...notes[i], order: i });
}

export function getSettings(): Settings {
	// empty apiBase = same origin: the Vite dev server proxies /edam and /shard,
	// and a self-hosted copy can do the same behind its own reverse proxy
	return { token: '', apiBase: '', ...readJson<Partial<Settings>>(SETTINGS_KEY, {}) };
}

export function saveSettings(patch: Partial<Settings>): void {
	localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...getSettings(), ...patch }));
}

interface Names {
	notebooks: Record<string, string>;
	tags: Record<string, string>;
}

const NAMES_KEY = 'en_names';
let namesCache: Names | null = null;

function getNames(): Names {
	namesCache ??= { notebooks: {}, tags: {}, ...readJson<Partial<Names>>(NAMES_KEY, {}) };
	return namesCache;
}

export function saveNames(names: Names): void {
	namesCache = names;
	try {
		localStorage.setItem(NAMES_KEY, JSON.stringify(names));
	} catch {
		// the in-memory copy still serves this session
	}
}

export function notebookName(guid?: string): string {
	return (guid && getNames().notebooks[guid]) || '';
}

/** All known notebooks from the cached name map, for the picker. */
export function notebookList(): { guid: string; name: string }[] {
	return Object.entries(getNames().notebooks)
		.map(([guid, name]) => ({ guid, name }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function tagNames(guids?: string[]): string[] {
	const tags = getNames().tags;
	return (guids ?? []).map((g) => tags[g]).filter(Boolean);
}

/** Comma-separated user input -> clean tag names (EDAM forbids commas). */
export function parseTags(input: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of input.split(',')) {
		const name = raw.trim().slice(0, 100);
		const key = name.toLowerCase();
		if (name && !seen.has(key)) {
			seen.add(key);
			out.push(name);
		}
	}
	return out;
}

const UPDATE_COUNT_KEY = 'en_update_count';

/** Account-wide change counter as of the last completed pull. */
export function getLastUpdateCount(): number {
	try {
		return Number(localStorage.getItem(UPDATE_COUNT_KEY) ?? -1);
	} catch {
		return -1;
	}
}

export function setLastUpdateCount(count: number): void {
	try {
		if (count > getLastUpdateCount()) localStorage.setItem(UPDATE_COUNT_KEY, String(count));
	} catch {
		// harmless: the next refresh just pulls again
	}
}

export function getNoteStoreUrl(): string {
	return localStorage.getItem(STORE_URL_KEY) ?? '';
}

export function setNoteStoreUrl(url: string): void {
	if (url) localStorage.setItem(STORE_URL_KEY, url);
	else localStorage.removeItem(STORE_URL_KEY);
}

export function getNotes(): NoteRecord[] {
	return notes;
}

export function saveNotes(list: NoteRecord[]): void {
	notes = list;
	persistAll();
}

export function getNote(guid: string): NoteRecord | undefined {
	return notes.find((n) => n.guid === guid);
}

export function patchNote(guid: string, patch: Partial<NoteRecord>): void {
	notes = notes.map((n) => (n.guid === guid ? { ...n, ...patch } : n));
	persistOne(guid);
}

/** Notes created on this device that the server does not know about yet. */
export function isLocalGuid(guid: string): boolean {
	return guid.startsWith('local-');
}

/** A new note; it stays local until its first edit reaches the server. */
export function createLocalNote(): NoteRecord {
	const rec: NoteRecord = {
		guid: 'local-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
		title: '',
		updated: Date.now(),
		enml: EMPTY_ENML,
		dirty: false,
	};
	saveNotes([rec, ...notes]);
	return rec;
}

/** New notes that were never edited are discarded, not synced. */
export function dropUntouchedLocalNotes(): void {
	const kept = notes.filter((n) => !(isLocalGuid(n.guid) && !n.dirty));
	if (kept.length !== notes.length) saveNotes(kept);
}

/**
 * The server assigned a real guid to a locally created note. `clean` is
 * false when the user kept typing while createNote was in flight, so the
 * newer content still needs an upload. Pure, tested.
 */
export function applyCreatedGuid(
	list: NoteRecord[],
	from: string,
	created: { guid: string; updated: number },
	clean: boolean,
): NoteRecord[] {
	return list.map((n) =>
		n.guid === from
			? { ...n, guid: created.guid, updated: clean ? created.updated : n.updated, dirty: !clean, error: undefined }
			: n,
	);
}

/**
 * Merge the server's latest-notes list into the local cache. Pure, tested.
 * - notes with unsynced local edits are kept as-is (their upload wins later);
 * - server metadata (title, notebook, tags) always refreshes clean notes,
 *   and a newer server copy also drops the cached content for a refetch;
 * - dirty and locally created notes missing from the server list are kept.
 */
export function mergeNotes(
	local: NoteRecord[],
	server: { guid: string; title: string; updated: number; notebookGuid?: string; tagGuids?: string[] }[],
): NoteRecord[] {
	const merged = server.map((meta): NoteRecord => {
		const known = local.find((n) => n.guid === meta.guid);
		if (!known) return { enml: null, dirty: false, ...meta };
		if (known.dirty) return known;
		// the pull's tagGuids are authoritative again: drop the local override
		return { ...known, ...meta, tagNames: undefined, enml: meta.updated > known.updated ? null : known.enml };
	});
	const kept = new Set(merged.map((n) => n.guid));
	return merged.concat(local.filter((n) => (n.dirty || isLocalGuid(n.guid)) && !kept.has(n.guid)));
}

/** Cached image bytes for an en-media hash, if previously downloaded. */
export function getCachedImage(hash: string): Promise<Blob | undefined> {
	return new Promise((resolve) => {
		if (!db) return resolve(undefined);
		const req = db.transaction('images').objectStore('images').get(hash);
		req.onsuccess = () => resolve(req.result as Blob | undefined);
		req.onerror = () => resolve(undefined);
	});
}

export function cacheImage(hash: string, blob: Blob): void {
	if (db) db.transaction('images', 'readwrite').objectStore('images').put(blob, hash);
}

/** Drops cached images that no cached note references anymore. */
export function pruneImages(): void {
	if (!db) return;
	const used = new Set<string>();
	for (const n of notes) {
		for (const m of (n.enml ?? '').matchAll(/hash="([0-9a-f]+)"/g)) used.add(m[1]);
	}
	const store = db.transaction('images', 'readwrite').objectStore('images');
	const req = store.getAllKeys();
	req.onsuccess = () => {
		for (const key of req.result) if (!used.has(String(key))) store.delete(key);
	};
}
