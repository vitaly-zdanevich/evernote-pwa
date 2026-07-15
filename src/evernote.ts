// EDAM API calls over the minimal Thrift client. Field IDs match the official
// Evernote IDL (verified against the generated `evernote` 0.1.2 Rust crate).

import { MSG_EXCEPTION, T, ThriftReader, ThriftWriter, num, str, structField } from './thrift';
import type { TStruct } from './thrift';

export interface NoteMeta {
	guid: string;
	title: string;
	updated: number;
}

export interface Note extends NoteMeta {
	content: string;
}

export class EvernoteError extends Error {
	constructor(
		message: string,
		readonly code?: number,
		readonly rateLimitSeconds?: number,
	) {
		super(message);
	}
}

const ERROR_NAMES: Record<number, string> = {
	1: 'Unknown error',
	2: 'Bad data format',
	3: 'Permission denied',
	4: 'Evernote internal error',
	5: 'Data required',
	6: 'Limit reached',
	7: 'Quota reached',
	8: 'Invalid token',
	9: 'Token expired',
	10: 'Data conflict',
	11: 'Note content rejected (ENML validation)',
	12: 'Shard unavailable',
	19: 'Rate limit reached',
};

function edamError(exc: unknown): EvernoteError {
	const code = num(structField(exc, 1));
	if (code === undefined) {
		// EDAMNotFoundException { 1: identifier, 2: key }
		const what = [str(structField(exc, 1)), str(structField(exc, 2))].filter(Boolean).join(' ');
		return new EvernoteError(`Not found: ${what || 'object'}`);
	}
	const detail = str(structField(exc, 2));
	const rate = num(structField(exc, 3));
	const name = ERROR_NAMES[code] ?? `Evernote error ${code}`;
	return new EvernoteError(detail ? `${name}: ${detail}` : name, code, rate);
}

let seq = 0;

async function call(
	url: string,
	method: string,
	writeArgs: (w: ThriftWriter) => void,
): Promise<TStruct> {
	const w = new ThriftWriter();
	w.messageBegin(method, ++seq);
	writeArgs(w);
	w.stop();
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-thrift' },
		body: w.bytes(),
	});
	if (!res.ok) throw new EvernoteError(`Evernote HTTP ${res.status}`);
	const r = new ThriftReader(await res.arrayBuffer());
	const msg = r.messageBegin();
	if (msg.type === MSG_EXCEPTION) {
		const app = r.struct();
		throw new EvernoteError(str(app.get(1)) ?? `Evernote rejected ${method}`);
	}
	const reply = r.struct();
	for (const [id, value] of reply) if (id !== 0) throw edamError(value);
	return reply;
}

/**
 * UserStore.getUserUrls, rewritten onto `apiBase` so every request keeps
 * going through the same origin/CORS proxy.
 */
export async function fetchNoteStoreUrl(apiBase: string, token: string): Promise<string> {
	const reply = await call(apiBase + '/edam/user', 'getUserUrls', (w) => {
		w.field(T.STRING, 1).string(token);
	});
	const direct = str(structField(reply.get(0), 1));
	if (!direct) throw new EvernoteError('Evernote returned no note store URL');
	return apiBase + new URL(direct).pathname;
}

const SORT_BY_UPDATED = 2;

/** NoteStore.findNotesMetadata: the latest edited notes, newest first. */
export async function listNotes(
	noteStoreUrl: string,
	token: string,
	max: number,
): Promise<NoteMeta[]> {
	const reply = await call(noteStoreUrl, 'findNotesMetadata', (w) => {
		w.field(T.STRING, 1).string(token);
		w.field(T.STRUCT, 2); // NoteFilter
		w.field(T.I32, 1).i32(SORT_BY_UPDATED);
		w.field(T.BOOL, 2).bool(false); // descending
		w.stop();
		w.field(T.I32, 3).i32(0); // offset
		w.field(T.I32, 4).i32(max);
		w.field(T.STRUCT, 5); // NotesMetadataResultSpec
		w.field(T.BOOL, 2).bool(true); // includeTitle
		w.field(T.BOOL, 7).bool(true); // includeUpdated
		w.stop();
	});
	const notes = structField(reply.get(0), 3);
	if (!Array.isArray(notes)) return [];
	return notes
		.map((n) => ({
			guid: str(structField(n, 1)) ?? '',
			title: str(structField(n, 2)) ?? 'Untitled',
			updated: num(structField(n, 7)) ?? 0,
		}))
		.filter((n) => n.guid);
}

/** NoteStore.getNote with content, without resource data. */
export async function getNote(noteStoreUrl: string, token: string, guid: string): Promise<Note> {
	const reply = await call(noteStoreUrl, 'getNote', (w) => {
		w.field(T.STRING, 1).string(token);
		w.field(T.STRING, 2).string(guid);
		w.field(T.BOOL, 3).bool(true); // withContent
		w.field(T.BOOL, 4).bool(false);
		w.field(T.BOOL, 5).bool(false);
		w.field(T.BOOL, 6).bool(false);
	});
	const n = reply.get(0);
	return {
		guid: str(structField(n, 1)) ?? guid,
		title: str(structField(n, 2)) ?? 'Untitled',
		content: str(structField(n, 3)) ?? '',
		updated: num(structField(n, 7)) ?? 0,
	};
}

/**
 * NoteStore.updateNote with only guid/title/content set: Evernote keeps
 * resources, tags and everything else unchanged for omitted fields.
 * Returns the new server-side `updated` timestamp.
 */
export async function updateNote(
	noteStoreUrl: string,
	token: string,
	note: { guid: string; title: string; content: string },
): Promise<number> {
	const reply = await call(noteStoreUrl, 'updateNote', (w) => {
		w.field(T.STRING, 1).string(token);
		w.field(T.STRUCT, 2); // Note
		w.field(T.STRING, 1).string(note.guid);
		w.field(T.STRING, 2).string(note.title);
		w.field(T.STRING, 3).string(note.content);
		w.stop();
	});
	return num(structField(reply.get(0), 7)) ?? Date.now();
}
