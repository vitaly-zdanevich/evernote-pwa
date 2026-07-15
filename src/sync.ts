// Sync engine: every edit is persisted locally first, then pushed to
// Evernote. Uploads run one at a time; failures retry on a timer and when
// the app comes back online or into view. Last write wins (proof of concept).

import * as api from './evernote';
import {
	MAX_NOTES,
	getNoteStoreUrl,
	getNotes,
	getSettings,
	mergeNotes,
	patchNote,
	saveNotes,
	setNoteStoreUrl,
} from './store';

export type SyncState = 'synced' | 'syncing' | 'error';

const RETRY_SECONDS = 30;

const listeners = new Set<() => void>();
const revs = new Map<string, number>();
let uploading = false;
let refreshing = false;
let refreshError = '';
let retryTimer: ReturnType<typeof setTimeout> | undefined;

export function onChange(cb: () => void): void {
	listeners.add(cb);
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

/** Called by the editor after each (debounced) edit. */
export function noteEdited(guid: string, title: string, enml: string): void {
	revs.set(guid, (revs.get(guid) ?? 0) + 1);
	patchNote(guid, { title, enml, dirty: true, error: undefined });
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
				const updated = await api.updateNote(url, token, {
					guid: note.guid,
					title: note.title,
					content: note.enml as string,
				});
				// an edit made while the request was in flight keeps the note dirty
				if ((revs.get(note.guid) ?? 0) === sent) {
					patchNote(note.guid, { dirty: false, updated, error: undefined });
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
		const metas = await api.listNotes(url, token, MAX_NOTES);
		saveNotes(mergeNotes(getNotes(), metas));
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
	} catch (e) {
		refreshError = message(e);
		setNoteStoreUrl(''); // in case a stale shard URL is what failed
	} finally {
		refreshing = false;
		emit();
	}
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
