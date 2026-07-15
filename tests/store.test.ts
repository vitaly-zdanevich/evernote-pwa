import { describe, expect, it } from 'vitest';
import { mergeNotes } from '../src/store';
import type { NoteRecord } from '../src/store';

function rec(guid: string, patch: Partial<NoteRecord> = {}): NoteRecord {
	return { guid, title: 't-' + guid, updated: 100, enml: '<en-note/>', dirty: false, ...patch };
}

describe('mergeNotes', () => {
	it('adds unknown server notes with content pending', () => {
		const out = mergeNotes([], [{ guid: 'a', title: 'A', updated: 5 }]);
		expect(out).toEqual([{ guid: 'a', title: 'A', updated: 5, enml: null, dirty: false }]);
	});

	it('keeps cached content when the server has nothing newer', () => {
		const local = [rec('a', { updated: 100 })];
		const out = mergeNotes(local, [{ guid: 'a', title: 'ignored', updated: 100 }]);
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

	it('keeps dirty notes that fell out of the latest-10 list, drops clean ones', () => {
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
});
