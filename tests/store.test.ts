import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	applyCreatedGuid,
	createLocalNote,
	dropUntouchedLocalNotes,
	getNotes,
	initStore,
	isLocalGuid,
	mergeNotes,
	patchNote,
	saveNotes,
} from '../src/store';
import type { NoteRecord } from '../src/store';

// no indexedDB in the node test environment: the store runs memory-only,
// which is exactly the fallback path it must support anyway
function stubLocalStorage(seed: Record<string, string> = {}): Map<string, string> {
	const m = new Map<string, string>(Object.entries(seed));
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, String(v)),
		removeItem: (k: string) => void m.delete(k),
	});
	return m;
}

beforeEach(() => saveNotes([]));
afterEach(() => vi.unstubAllGlobals());

function rec(guid: string, patch: Partial<NoteRecord> = {}): NoteRecord {
	return { guid, title: 't-' + guid, updated: 100, enml: '<en-note/>', dirty: false, ...patch };
}

describe('initStore', () => {
	it('migrates the legacy localStorage cache, keeping unsynced edits', async () => {
		const legacy = [rec('a', { dirty: true, enml: '<en-note>pending</en-note>' })];
		const storage = stubLocalStorage({ en_notes: JSON.stringify(legacy) });
		await initStore();
		expect(getNotes()).toEqual(legacy);
		expect(storage.has('en_notes')).toBe(false); // migrated once, then removed
	});

	it('starts empty without any stored state', async () => {
		stubLocalStorage();
		await initStore();
		expect(getNotes()).toEqual([]);
	});
});

describe('mergeNotes', () => {
	it('adds unknown server notes with content pending', () => {
		const out = mergeNotes([], [{ guid: 'a', title: 'A', updated: 5 }]);
		expect(out).toEqual([{ guid: 'a', title: 'A', updated: 5, enml: null, dirty: false }]);
	});

	it('keeps cached content when the server has nothing newer', () => {
		const local = [rec('a', { updated: 100 })];
		const out = mergeNotes(local, [{ guid: 'a', title: 't-a', updated: 100 }]);
		expect(out).toEqual(local);
	});

	it('refetches content when the server copy is newer', () => {
		const out = mergeNotes([rec('a', { updated: 100 })], [{ guid: 'a', title: 'New', updated: 200 }]);
		expect(out[0]).toMatchObject({ guid: 'a', title: 'New', updated: 200, enml: null });
	});

	it('never clobbers unsynced local edits', () => {
		const local = [rec('a', { dirty: true, title: 'local edit', enml: '<en-note>mine</en-note>' })];
		const out = mergeNotes(local, [{ guid: 'a', title: 'server', updated: 999 }]);
		expect(out).toEqual(local);
	});

	it('keeps dirty notes that fell out of the latest list, drops clean ones', () => {
		const local = [rec('gone-clean'), rec('gone-dirty', { dirty: true })];
		const out = mergeNotes(local, [{ guid: 'b', title: 'B', updated: 1 }]);
		expect(out.map((n) => n.guid)).toEqual(['b', 'gone-dirty']);
	});

	it('orders notes as the server sent them', () => {
		const local = [rec('a'), rec('b')];
		const out = mergeNotes(local, [
			{ guid: 'b', title: 'B', updated: 100 },
			{ guid: 'a', title: 'A', updated: 100 },
		]);
		expect(out.map((n) => n.guid)).toEqual(['b', 'a']);
	});

	it('keeps locally created notes the server does not know about', () => {
		const local = [rec('local-abc', { dirty: false })];
		const out = mergeNotes(local, [{ guid: 'b', title: 'B', updated: 1 }]);
		expect(out.map((n) => n.guid)).toEqual(['b', 'local-abc']);
	});
});

describe('local note creation', () => {
	it('creates an empty local note and prunes it when untouched', () => {
		const rec = createLocalNote();
		expect(isLocalGuid(rec.guid)).toBe(true);
		expect(rec.dirty).toBe(false);
		expect(getNotes()).toHaveLength(1);
		dropUntouchedLocalNotes();
		expect(getNotes()).toHaveLength(0);
	});

	it('keeps a local note once it was edited', () => {
		const rec = createLocalNote();
		patchNote(rec.guid, { dirty: true, title: 'typed' });
		dropUntouchedLocalNotes();
		expect(getNotes()).toHaveLength(1);
	});
});

describe('applyCreatedGuid', () => {
	const created = { guid: 'server-1', updated: 500 };

	it('swaps in the server guid and marks the note synced when clean', () => {
		const out = applyCreatedGuid([rec('local-x', { dirty: true, updated: 5 })], 'local-x', created, true);
		expect(out[0]).toMatchObject({ guid: 'server-1', dirty: false, updated: 500 });
	});

	it('keeps the note dirty when the user typed during the request', () => {
		const out = applyCreatedGuid([rec('local-x', { dirty: true, updated: 5 })], 'local-x', created, false);
		expect(out[0]).toMatchObject({ guid: 'server-1', dirty: true, updated: 5 });
	});
});
