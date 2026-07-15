// EDAM API calls over the minimal Thrift client. Field IDs match the official
// Evernote IDL (verified against the generated `evernote` 0.1.2 Rust crate).

import { MSG_EXCEPTION, T, ThriftReader, ThriftWriter, num, str, structField } from './thrift';
import type { TStruct } from './thrift';

export interface NoteMeta {
	guid: string;
	title: string;
	updated: number;
	notebookGuid?: string;
	tagGuids?: string[];
}

export interface NamedEntity {
	guid: string;
	name: string;
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
		w.field(T.BOOL, 11).bool(true); // includeNotebookGuid
		w.field(T.BOOL, 12).bool(true); // includeTagGuids
		w.stop();
	});
	const notes = structField(reply.get(0), 3);
	if (!Array.isArray(notes)) return [];
	return notes
		.map((n) => {
			const tags = structField(n, 12);
			return {
				guid: str(structField(n, 1)) ?? '',
				title: str(structField(n, 2)) ?? 'Untitled',
				updated: num(structField(n, 7)) ?? 0,
				notebookGuid: str(structField(n, 11)),
				tagGuids: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : undefined,
			};
		})
		.filter((n) => n.guid);
}

async function listNamed(noteStoreUrl: string, token: string, method: string): Promise<NamedEntity[]> {
	const reply = await call(noteStoreUrl, method, (w) => {
		w.field(T.STRING, 1).string(token);
	});
	const list = reply.get(0);
	if (!Array.isArray(list)) return [];
	return list
		.map((s) => ({ guid: str(structField(s, 1)) ?? '', name: str(structField(s, 2)) ?? '' }))
		.filter((e) => e.guid && e.name);
}

export function listNotebooks(noteStoreUrl: string, token: string): Promise<NamedEntity[]> {
	return listNamed(noteStoreUrl, token, 'listNotebooks');
}

export function listTags(noteStoreUrl: string, token: string): Promise<NamedEntity[]> {
	return listNamed(noteStoreUrl, token, 'listTags');
}

/** NoteStore.getSyncState: the account-wide change counter, one tiny call. */
export async function getUpdateCount(noteStoreUrl: string, token: string): Promise<number> {
	const reply = await call(noteStoreUrl, 'getSyncState', (w) => {
		w.field(T.STRING, 1).string(token);
	});
	return num(structField(reply.get(0), 3)) ?? -1;
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

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length >> 1);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/** An image the user added, to be attached to its note on the next sync. */
export interface NewResource {
	bytes: Uint8Array;
	mime: string;
	hashHex: string;
}

/**
 * Note.resources (field 13). Sending the list REPLACES the note's resource
 * set, so existing resources must ride along as guid-only stubs — the
 * service keeps their data. New ones carry the full body.
 */
function writeResources(w: ThriftWriter, keepGuids: string[], added: NewResource[]): void {
	w.field(T.LIST, 13).byte(T.STRUCT).i32(keepGuids.length + added.length);
	for (const guid of keepGuids) {
		w.field(T.STRING, 1).string(guid);
		w.stop();
	}
	for (const r of added) {
		w.field(T.STRUCT, 3); // Data
		w.field(T.STRING, 1).binary(hexToBytes(r.hashHex)); // bodyHash
		w.field(T.I32, 2).i32(r.bytes.length);
		w.field(T.STRING, 3).binary(r.bytes);
		w.stop();
		w.field(T.STRING, 4).string(r.mime);
		w.stop();
	}
}

/**
 * Note.tagNames (field 15): the server replaces the note's tags with tags
 * of these names, creating missing ones. Left out entirely = unchanged.
 */
function writeTagNames(w: ThriftWriter, names: string[] | undefined): void {
	if (!names) return;
	w.field(T.LIST, 15).byte(T.STRING).i32(names.length);
	for (const name of names) w.string(name);
}

/** Guids of the resources currently attached to a note (metadata only). */
export async function getNoteResourceGuids(
	noteStoreUrl: string,
	token: string,
	guid: string,
): Promise<string[]> {
	const reply = await call(noteStoreUrl, 'getNote', (w) => {
		w.field(T.STRING, 1).string(token);
		w.field(T.STRING, 2).string(guid);
		w.field(T.BOOL, 3).bool(false); // withContent
		w.field(T.BOOL, 4).bool(false);
		w.field(T.BOOL, 5).bool(false);
		w.field(T.BOOL, 6).bool(false);
	});
	const resources = structField(reply.get(0), 13);
	if (!Array.isArray(resources)) return [];
	return resources.map((r) => str(structField(r, 1)) ?? '').filter(Boolean);
}

/** NoteStore.getResourceByHash without data: maps an en-media hash to its resource. */
export async function getResourceMeta(
	noteStoreUrl: string,
	token: string,
	noteGuid: string,
	hashHex: string,
): Promise<{ guid: string; mime: string }> {
	const reply = await call(noteStoreUrl, 'getResourceByHash', (w) => {
		w.field(T.STRING, 1).string(token);
		w.field(T.STRING, 2).string(noteGuid);
		w.field(T.STRING, 3).binary(hexToBytes(hashHex));
		w.field(T.BOOL, 4).bool(false); // withData
		w.field(T.BOOL, 5).bool(false);
		w.field(T.BOOL, 6).bool(false);
	});
	const resource = reply.get(0);
	const guid = str(structField(resource, 1));
	if (!guid) throw new EvernoteError('Resource not found for image');
	return { guid, mime: str(structField(resource, 4)) ?? 'application/octet-stream' };
}

/**
 * Downloads resource bytes over the shard web API — the documented way to
 * read resource contents outside Thrift: POST auth=<token> to .../res/<guid>.
 * The URL is derived from the note store URL, so it uses the same CORS proxy.
 */
export async function fetchResourceBlob(
	noteStoreUrl: string,
	token: string,
	resourceGuid: string,
	mime: string,
): Promise<Blob> {
	const url = noteStoreUrl.replace(/\/notestore$/, '/res/') + resourceGuid;
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: 'auth=' + encodeURIComponent(token),
	});
	if (!res.ok) throw new EvernoteError(`Resource HTTP ${res.status}`);
	// typed from the resource metadata: proxies may not relay the content type
	return new Blob([await res.arrayBuffer()], { type: mime });
}

/** NoteStore.createNote; the server assigns the guid. */
export async function createNote(
	noteStoreUrl: string,
	token: string,
	note: { title: string; content: string; notebookGuid?: string; tagNames?: string[] },
	resources: NewResource[] = [],
): Promise<{ guid: string; updated: number; usn: number }> {
	const reply = await call(noteStoreUrl, 'createNote', (w) => {
		w.field(T.STRING, 1).string(token);
		w.field(T.STRUCT, 2); // Note, no guid yet
		w.field(T.STRING, 2).string(note.title);
		w.field(T.STRING, 3).string(note.content);
		if (note.notebookGuid) w.field(T.STRING, 11).string(note.notebookGuid);
		if (resources.length) writeResources(w, [], resources);
		writeTagNames(w, note.tagNames);
		w.stop();
	});
	const n = reply.get(0);
	const guid = str(structField(n, 1));
	if (!guid) throw new EvernoteError('Evernote returned no guid for the new note');
	return {
		guid,
		updated: num(structField(n, 7)) ?? Date.now(),
		usn: num(structField(n, 10)) ?? 0,
	};
}

/**
 * NoteStore.updateNote with only guid/title/content set: Evernote keeps
 * resources, tags and everything else unchanged for omitted fields.
 * Returns the new server-side `updated` timestamp and sequence number.
 */
export async function updateNote(
	noteStoreUrl: string,
	token: string,
	note: {
		guid: string;
		title: string;
		content: string;
		/** Setting this moves the note; leave undefined to keep it in place. */
		notebookGuid?: string;
		tagNames?: string[];
	},
	resources?: { keepGuids: string[]; added: NewResource[] },
): Promise<{ updated: number; usn: number }> {
	const reply = await call(noteStoreUrl, 'updateNote', (w) => {
		w.field(T.STRING, 1).string(token);
		w.field(T.STRUCT, 2); // Note
		w.field(T.STRING, 1).string(note.guid);
		w.field(T.STRING, 2).string(note.title);
		w.field(T.STRING, 3).string(note.content);
		if (note.notebookGuid) w.field(T.STRING, 11).string(note.notebookGuid);
		if (resources?.added.length) writeResources(w, resources.keepGuids, resources.added);
		writeTagNames(w, note.tagNames);
		w.stop();
	});
	const n = reply.get(0);
	return {
		updated: num(structField(n, 7)) ?? Date.now(),
		usn: num(structField(n, 10)) ?? 0,
	};
}
