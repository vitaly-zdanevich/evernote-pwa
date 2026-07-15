// Sync engine: every edit is persisted locally first, then pushed to
// Evernote. Uploads run one at a time; failures retry on a timer and when
// the app comes back online or into view. Last write wins (proof of concept).

import * as api from './evernote';
import {
	MAX_NOTES,
	applyCreatedGuid,
	getCachedImage,
	getLastUpdateCount,
	getNote,
	getNoteStoreUrl,
	getNotes,
	getSettings,
	isLocalGuid,
	mergeNotes,
	patchNote,
	pruneImages,
	saveNames,
	saveNotes,
	setLastUpdateCount,
	setNoteStoreUrl,
} from './store';
import type { NoteRecord } from './store';

export type SyncState = 'synced' | 'syncing' | 'error';

const RETRY_SECONDS = 30;

const listeners = new Set<() => void>();
const revs = new Map<string, number>();
let uploading = false;
let refreshing = false;
let refreshError = '';
let retryTimer: ReturnType<typeof setTimeout> | undefined;

const guidListeners = new Set<(from: string, to: string) => void>();

export function onChange(cb: () => void): void {
	listeners.add(cb);
}

/** Fired when createNote replaces a local guid with the server one. */
export function onGuidChange(cb: (from: string, to: string) => void): void {
	guidListeners.add(cb);
}

function emit(): void {
	for (const cb of listeners) cb();
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export function status(): SyncState {
	const notes = getNotes();
	if (uploading || refreshing || notes.some((n) => n.dirty && !n.error)) return 'syncing';
	if (refreshError || notes.some((n) => n.error)) return 'error';
	return 'synced';
}

export function lastRefreshError(): string {
	return refreshError;
}

/** True while anything is unsaved or in flight; blocks SW-update reloads. */
export function busy(): boolean {
	return uploading || getNotes().some((n) => n.dirty);
}

async function session(): Promise<{ url: string; token: string }> {
	const { token, apiBase } = getSettings();
	if (!token) throw new api.EvernoteError('Add your Evernote token in Settings');
	let url = getNoteStoreUrl();
	if (!url) {
		url = await api.fetchNoteStoreUrl(apiBase, token);
		setNoteStoreUrl(url);
	}
	return { url, token };
}

/** Bytes for the images awaiting upload with this note. */
async function pendingResources(note: NoteRecord): Promise<api.NewResource[]> {
	const out: api.NewResource[] = [];
	for (const hashHex of note.pendingResources ?? []) {
		const blob = await getCachedImage(hashHex);
		// a missing blob (cleared site data) leaves a dangling en-media; skip it
		if (blob) out.push({ bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, hashHex });
	}
	return out;
}

function clearUploaded(guid: string, sent: api.NewResource[]): void {
	const done = new Set(sent.map((r) => r.hashHex));
	const left = (getNote(guid)?.pendingResources ?? []).filter((h) => !done.has(h));
	patchNote(guid, { pendingResources: left.length ? left : undefined });
}

/** Called by the editor after each (debounced) edit. */
export function noteEdited(guid: string, title: string, enml: string): void {
	revs.set(guid, (revs.get(guid) ?? 0) + 1);
	// `updated` is bumped optimistically; the server value replaces it on sync
	patchNote(guid, { title, enml, dirty: true, error: undefined, updated: Date.now() });
	emit();
	void upload();
}

/** Called by the editor when the tags input is committed. */
export function tagsEdited(guid: string, tagNames: string[]): void {
	revs.set(guid, (revs.get(guid) ?? 0) + 1);
	patchNote(guid, { tagNames, dirty: true, error: undefined, updated: Date.now() });
	emit();
	void upload();
}

async function upload(): Promise<void> {
	if (uploading) return;
	uploading = true;
	emit();
	let retryDelay = RETRY_SECONDS;
	try {
		while (navigator.onLine) {
			const note = getNotes().find((n) => n.dirty && !n.error && n.enml !== null);
			if (!note) break;
			const sent = revs.get(note.guid) ?? 0;
			try {
				const { url, token } = await session();
				const added = await pendingResources(note);
				if (isLocalGuid(note.guid)) {
					const created = await api.createNote(
						url,
						token,
						{ title: note.title, content: note.enml as string, tagNames: note.tagNames },
						added,
					);
					// an edit made while the request was in flight keeps the note dirty
					const clean = (revs.get(note.guid) ?? 0) === sent;
					saveNotes(applyCreatedGuid(getNotes(), note.guid, created, clean));
					revs.set(created.guid, revs.get(note.guid) ?? 0);
					revs.delete(note.guid);
					setLastUpdateCount(created.usn);
					for (const cb of guidListeners) cb(note.guid, created.guid);
					clearUploaded(created.guid, added);
				} else {
					const keepGuids = added.length
						? await api.getNoteResourceGuids(url, token, note.guid)
						: [];
					const result = await api.updateNote(
						url,
						token,
						{
							guid: note.guid,
							title: note.title,
							content: note.enml as string,
							tagNames: note.tagNames,
						},
						{ keepGuids, added },
					);
					setLastUpdateCount(result.usn);
					clearUploaded(note.guid, added);
					if ((revs.get(note.guid) ?? 0) === sent) {
						patchNote(note.guid, { dirty: false, updated: result.updated, error: undefined });
					}
				}
			} catch (e) {
				patchNote(note.guid, { error: message(e) });
				if (e instanceof api.EvernoteError && e.rateLimitSeconds) {
					retryDelay = Math.max(retryDelay, e.rateLimitSeconds);
				}
			}
			emit();
		}
	} finally {
		uploading = false;
		if (getNotes().some((n) => n.dirty)) armRetry(retryDelay);
		emit();
	}
}

function armRetry(seconds: number): void {
	retryTimer ??= setTimeout(() => {
		retryTimer = undefined;
		for (const n of getNotes()) if (n.error) patchNote(n.guid, { error: undefined });
		void upload();
	}, seconds * 1000);
}

/** Pull the latest-edited notes and any missing/stale contents. */
export async function refresh(): Promise<void> {
	if (refreshing || !navigator.onLine || !getSettings().token) return;
	refreshing = true;
	refreshError = '';
	emit();
	try {
		const { url, token } = await session();
		// one tiny call: skip the whole pull when nothing changed server-side
		const count = await api.getUpdateCount(url, token);
		const cacheComplete = getNotes().length > 0 && getNotes().every((n) => n.enml !== null);
		if (count >= 0 && count === getLastUpdateCount() && cacheComplete) return;
		const metas = await api.listNotes(url, token, MAX_NOTES);
		saveNotes(mergeNotes(getNotes(), metas));
		emit();
		const [notebooks, tags] = await Promise.all([
			api.listNotebooks(url, token),
			api.listTags(url, token),
		]);
		saveNames({
			notebooks: Object.fromEntries(notebooks.map((n) => [n.guid, n.name])),
			tags: Object.fromEntries(tags.map((t) => [t.guid, t.name])),
		});
		emit();
		for (const meta of getNotes()) {
			if (meta.enml !== null) continue;
			const note = await api.getNote(url, token, meta.guid);
			// skip if the user started editing this note while it was loading
			if (!getNotes().find((n) => n.guid === meta.guid)?.dirty) {
				patchNote(meta.guid, { enml: note.content, title: note.title, updated: note.updated });
			}
			emit();
		}
		pruneImages();
		setLastUpdateCount(count);
	} catch (e) {
		refreshError = message(e);
		setNoteStoreUrl(''); // in case a stale shard URL is what failed
	} finally {
		refreshing = false;
		emit();
	}
}

/** Resolves an en-media image to its bytes; used lazily by the editor. */
export async function fetchImage(noteGuid: string, hashHex: string): Promise<Blob> {
	const { url, token } = await session();
	const meta = await api.getResourceMeta(url, token, noteGuid, hashHex);
	return api.fetchResourceBlob(url, token, meta.guid, meta.mime);
}

export function init(): void {
	addEventListener('online', () => {
		void upload();
		void refresh();
	});
	document.addEventListener('visibilitychange', () => {
		if (!document.hidden) {
			void upload();
			void refresh();
		}
	});
}
