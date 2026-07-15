import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvernoteError, createNote, fetchNoteStoreUrl, listNotes, updateNote } from '../src/evernote';
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
			w.stop();
			w.stop();
		});

		const updated = await updateNote('https://x.test/ns', 'tok', {
			guid: 'g',
			title: 'T',
			content: '<en-note>x</en-note>',
		});
		expect(updated).toBe(1800000000123);

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
			w.stop();
			w.stop();
		});

		const created = await createNote('https://x.test/ns', 'tok', {
			title: 'New',
			content: '<en-note/>',
		});
		expect(created).toEqual({ guid: 'server-guid', updated: 1800000000456 });

		const { name, args } = sentArgs();
		expect(name).toBe('createNote');
		const note = args.get(2) as Map<number, unknown>;
		expect(note.has(1)).toBe(false); // no guid: the server assigns it
		expect(note.get(2)).toBe('New');
		expect(note.get(3)).toBe('<en-note/>');
	});

	it('reports HTTP failures', async () => {
		serve('updateNote', MSG_REPLY, (w) => w.stop(), 502);
		await expect(
			updateNote('https://x.test/ns', 'tok', { guid: 'g', title: 't', content: 'c' }),
		).rejects.toThrow('Evernote HTTP 502');
	});
});
