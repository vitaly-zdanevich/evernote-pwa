import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	EvernoteError,
	createNote,
	fetchNoteStoreUrl,
	fetchResourceBlob,
	getResourceMeta,
	getUpdateCount,
	listNotebooks,
	listNotes,
	updateNote,
} from '../src/evernote';
import { T, ThriftReader, ThriftWriter } from '../src/thrift';

const MSG_REPLY = 2;
const MSG_EXCEPTION = 3;

let lastRequest: { url: string; body: Uint8Array } | null = null;

function serve(name: string, type: number, build: (w: ThriftWriter) => void, status = 200): void {
	const w = new ThriftWriter();
	w.i32(0x80010000 | type).string(name).i32(1);
	build(w);
	vi.stubGlobal('fetch', async (url: string, init: { body: Uint8Array }) => {
		lastRequest = { url, body: init.body };
		return new Response(w.bytes(), { status });
	});
}

function sentArgs(): { name: string; args: Map<number, unknown> } {
	const r = new ThriftReader(lastRequest!.body);
	const msg = r.messageBegin();
	return { name: msg.name, args: r.struct() };
}

afterEach(() => vi.unstubAllGlobals());

describe('evernote api', () => {
	it('lists the latest notes and sends the right query', async () => {
		serve('findNotesMetadata', MSG_REPLY, (w) => {
			w.field(T.STRUCT, 0);
			w.field(T.LIST, 3).byte(T.STRUCT).i32(2);
			w.field(T.STRING, 1).string('guid-1');
			w.field(T.STRING, 2).string('First note');
			w.field(T.I64, 7).i64(1700000000001);
			w.stop();
			w.field(T.STRING, 1).string('guid-2');
			w.stop();
			w.stop();
			w.stop();
		});

		const notes = await listNotes('https://x.test/shard/s1/notestore', 'tok', 10);
		expect(notes).toEqual([
			{ guid: 'guid-1', title: 'First note', updated: 1700000000001 },
			{ guid: 'guid-2', title: 'Untitled', updated: 0 },
		]);

		const { name, args } = sentArgs();
		expect(name).toBe('findNotesMetadata');
		expect(args.get(1)).toBe('tok');
		const filter = args.get(2) as Map<number, unknown>;
		expect(filter.get(1)).toBe(2); // order: UPDATED
		expect(filter.get(2)).toBe(false); // descending
		expect(args.get(3)).toBe(0);
		expect(args.get(4)).toBe(10);
		const spec = args.get(5) as Map<number, unknown>;
		expect(spec.get(2)).toBe(true); // includeTitle
		expect(spec.get(7)).toBe(true); // includeUpdated
		expect(spec.get(11)).toBe(true); // includeNotebookGuid
		expect(spec.get(12)).toBe(true); // includeTagGuids
	});

	it('parses notebook and tag guids from the metadata', async () => {
		serve('findNotesMetadata', MSG_REPLY, (w) => {
			w.field(T.STRUCT, 0);
			w.field(T.LIST, 3).byte(T.STRUCT).i32(1);
			w.field(T.STRING, 1).string('g');
			w.field(T.STRING, 11).string('nb-1');
			w.field(T.LIST, 12).byte(T.STRING).i32(2);
			w.string('tag-1').string('tag-2');
			w.stop();
			w.stop();
			w.stop();
		});
		const notes = await listNotes('https://x.test/ns', 'tok', 20);
		expect(notes[0]).toMatchObject({ guid: 'g', notebookGuid: 'nb-1', tagGuids: ['tag-1', 'tag-2'] });
	});

	it('lists notebooks and reads the sync state counter', async () => {
		serve('listNotebooks', MSG_REPLY, (w) => {
			w.field(T.LIST, 0).byte(T.STRUCT).i32(1);
			w.field(T.STRING, 1).string('nb-1');
			w.field(T.STRING, 2).string('Recipes');
			w.stop();
			w.stop();
		});
		expect(await listNotebooks('https://x.test/ns', 'tok')).toEqual([{ guid: 'nb-1', name: 'Recipes' }]);

		serve('getSyncState', MSG_REPLY, (w) => {
			w.field(T.STRUCT, 0);
			w.field(T.I32, 3).i32(51234);
			w.stop();
			w.stop();
		});
		expect(await getUpdateCount('https://x.test/ns', 'tok')).toBe(51234);
	});

	it('maps EDAM exceptions to readable errors', async () => {
		serve('findNotesMetadata', MSG_REPLY, (w) => {
			w.field(T.STRUCT, 1); // EDAMUserException
			w.field(T.I32, 1).i32(9);
			w.field(T.STRING, 2).string('authenticationToken');
			w.stop();
			w.stop();
		});

		const err = await listNotes('https://x.test/ns', 'tok', 10).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(EvernoteError);
		expect((err as EvernoteError).message).toBe('Token expired: authenticationToken');
		expect((err as EvernoteError).code).toBe(9);
	});

	it('surfaces TApplicationException messages', async () => {
		serve('getUserUrls', MSG_EXCEPTION, (w) => {
			w.field(T.STRING, 1).string('Internal error processing getUserUrls');
			w.stop();
		});
		await expect(fetchNoteStoreUrl('https://x.test', 'tok')).rejects.toThrow(
			'Internal error processing getUserUrls',
		);
	});

	it('rewrites the note store URL onto the API base', async () => {
		serve('getUserUrls', MSG_REPLY, (w) => {
			w.field(T.STRUCT, 0);
			w.field(T.STRING, 1).string('https://www.evernote.com/shard/s999/notestore');
			w.stop();
			w.stop();
		});
		const url = await fetchNoteStoreUrl('https://proxy.example', 'tok');
		expect(url).toBe('https://proxy.example/shard/s999/notestore');
	});

	it('sends guid/title/content on update and returns the new timestamp', async () => {
		serve('updateNote', MSG_REPLY, (w) => {
			w.field(T.STRUCT, 0);
			w.field(T.I64, 7).i64(1800000000123);
			w.field(T.I32, 10).i32(4212);
			w.stop();
			w.stop();
		});

		const result = await updateNote('https://x.test/ns', 'tok', {
			guid: 'g',
			title: 'T',
			content: '<en-note>x</en-note>',
		});
		expect(result).toEqual({ updated: 1800000000123, usn: 4212 });

		const { args } = sentArgs();
		const note = args.get(2) as Map<number, unknown>;
		expect(note.get(1)).toBe('g');
		expect(note.get(2)).toBe('T');
		expect(note.get(3)).toBe('<en-note>x</en-note>');
	});

	it('creates a note without sending a guid and returns the assigned one', async () => {
		serve('createNote', MSG_REPLY, (w) => {
			w.field(T.STRUCT, 0);
			w.field(T.STRING, 1).string('server-guid');
			w.field(T.I64, 7).i64(1800000000456);
			w.field(T.I32, 10).i32(4213);
			w.stop();
			w.stop();
		});

		const created = await createNote('https://x.test/ns', 'tok', {
			title: 'New',
			content: '<en-note/>',
		});
		expect(created).toEqual({ guid: 'server-guid', updated: 1800000000456, usn: 4213 });

		const { name, args } = sentArgs();
		expect(name).toBe('createNote');
		const note = args.get(2) as Map<number, unknown>;
		expect(note.has(1)).toBe(false); // no guid: the server assigns it
		expect(note.get(2)).toBe('New');
		expect(note.get(3)).toBe('<en-note/>');
	});

	it('maps an en-media hash to its resource with a binary hash argument', async () => {
		serve('getResourceByHash', MSG_REPLY, (w) => {
			w.field(T.STRUCT, 0);
			w.field(T.STRING, 1).string('res-guid');
			w.field(T.STRING, 4).string('image/png');
			w.stop();
			w.stop();
		});

		// ascii hex keeps the decoded request bytes readable in the assertion
		const hex = Array.from('abcdefghijklmnop', (c) => c.charCodeAt(0).toString(16)).join('');
		const meta = await getResourceMeta('https://x.test/ns', 'tok', 'note-guid', hex);
		expect(meta).toEqual({ guid: 'res-guid', mime: 'image/png' });

		const { name, args } = sentArgs();
		expect(name).toBe('getResourceByHash');
		expect(args.get(2)).toBe('note-guid');
		expect(args.get(3)).toBe('abcdefghijklmnop'); // 16 raw md5 bytes
		expect(args.get(4)).toBe(false); // withData: bytes come from /res/ instead
	});

	it('downloads resource bytes via the shard web API with form auth', async () => {
		let request: { url: string; contentType: string; body: string } | null = null;
		vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string>; body: string }) => {
			request = { url, contentType: init.headers['Content-Type'], body: init.body };
			return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
		});

		const blob = await fetchResourceBlob('https://p.test/shard/s9/notestore', 'to&ken', 'res-1', 'image/gif');
		expect(request).toEqual({
			url: 'https://p.test/shard/s9/res/res-1',
			contentType: 'application/x-www-form-urlencoded',
			body: 'auth=to%26ken',
		});
		expect(blob.type).toBe('image/gif');
		expect(blob.size).toBe(3);
	});

	it('attaches new resources and keeps existing ones as guid stubs', async () => {
		serve('updateNote', MSG_REPLY, (w) => {
			w.field(T.STRUCT, 0);
			w.stop();
			w.stop();
		});

		const hex = Array.from('0123456789abcdef', (c) => c.charCodeAt(0).toString(16)).join('');
		await updateNote(
			'https://x.test/ns',
			'tok',
			{ guid: 'g', title: 'T', content: '<en-note/>' },
			{
				keepGuids: ['keep-1'],
				added: [{ bytes: new TextEncoder().encode('img-bytes'), mime: 'image/jpeg', hashHex: hex }],
			},
		);

		const { args } = sentArgs();
		const note = args.get(2) as Map<number, unknown>;
		const resources = note.get(13) as Map<number, unknown>[];
		expect(resources).toHaveLength(2);
		expect(resources[0].get(1)).toBe('keep-1'); // stub: guid only
		expect(resources[0].has(3)).toBe(false);
		const data = resources[1].get(3) as Map<number, unknown>;
		expect(data.get(1)).toBe('0123456789abcdef'); // md5 bytes
		expect(data.get(2)).toBe(9); // size
		expect(data.get(3)).toBe('img-bytes');
		expect(resources[1].get(4)).toBe('image/jpeg');
	});

	it('reads resource guids from a note', async () => {
		serve('getNote', MSG_REPLY, (w) => {
			w.field(T.STRUCT, 0);
			w.field(T.LIST, 13).byte(T.STRUCT).i32(2);
			w.field(T.STRING, 1).string('r-1');
			w.stop();
			w.field(T.STRING, 1).string('r-2');
			w.stop();
			w.stop();
			w.stop();
		});
		const { getNoteResourceGuids } = await import('../src/evernote');
		expect(await getNoteResourceGuids('https://x.test/ns', 'tok', 'g')).toEqual(['r-1', 'r-2']);
		const { args } = sentArgs();
		expect(args.get(3)).toBe(false); // withContent off: metadata is enough
	});

	it('reports HTTP failures', async () => {
		serve('updateNote', MSG_REPLY, (w) => w.stop(), 502);
		await expect(
			updateNote('https://x.test/ns', 'tok', { guid: 'g', title: 't', content: 'c' }),
		).rejects.toThrow('Evernote HTTP 502');
	});
});
