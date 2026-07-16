import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { T, ThriftReader, ThriftWriter } from '../src/thrift';

const PROLOG =
	'<?xml version="1.0" encoding="UTF-8"?>' +
	'<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">';

// 1x1 red PNG for image-hydration checks
const TINY_PNG =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

interface SeedNote {
	guid: string;
	title: string;
	updated: number;
	enml: string | null;
	dirty: boolean;
	notebookGuid?: string;
	tagGuids?: string[];
}

function note(guid: string, title: string, body: string, extra: Partial<SeedNote> = {}): SeedNote {
	return {
		guid,
		title,
		updated: Date.now(),
		enml: `${PROLOG}<en-note>${body}</en-note>`,
		dirty: false,
		...extra,
	};
}

interface Seed {
	notes?: SeedNote[];
	names?: { notebooks: Record<string, string>; tags: Record<string, string> };
	settings?: { token: string; apiBase: string };
	extraLocalStorage?: Record<string, string>;
}

/** Plant state (IndexedDB + localStorage) from a neutral same-origin page —
 * the app itself must not be running or its open DB connection blocks the
 * deleteDatabase call — then load the app seeded. */
async function seed(page: Page, data: Seed = {}): Promise<void> {
	// sw.js renders as plain text in every browser (an .ico can trigger a
	// download navigation in Chromium when request routing is active)
	await page.goto('/sw.js');
	await page.evaluate(
		async (s) => {
			localStorage.clear();
			localStorage.setItem('en_settings', JSON.stringify(s.settings));
			localStorage.setItem('en_names', JSON.stringify(s.names));
			for (const [k, v] of Object.entries(s.extraLocalStorage)) localStorage.setItem(k, v);
			await new Promise((resolve) => {
				const del = indexedDB.deleteDatabase('enpwa');
				del.onsuccess = del.onerror = del.onblocked = () => resolve(null);
			});
			await new Promise((resolve, reject) => {
				const open = indexedDB.open('enpwa', 1);
				open.onupgradeneeded = () => {
					open.result.createObjectStore('notes', { keyPath: 'guid' });
					open.result.createObjectStore('images');
				};
				open.onsuccess = () => {
					const tx = open.result.transaction('notes', 'readwrite');
					s.notes.forEach((n, i) => tx.objectStore('notes').put({ ...n, order: i }));
					tx.oncomplete = () => {
						open.result.close();
						resolve(null);
					};
					tx.onerror = () => reject(new Error(String(tx.error)));
				};
				open.onerror = () => reject(new Error(String(open.error)));
			});
		},
		{
			notes: data.notes ?? [],
			names: data.names ?? { notebooks: {}, tags: {} },
			settings: data.settings ?? { token: 'tok', apiBase: 'https://mock.test' },
			extraLocalStorage: data.extraLocalStorage ?? {},
		},
	);
	await page.goto('/');
}

function readNotes(page: Page): Promise<SeedNote[]> {
	return page.evaluate(
		() =>
			new Promise((resolve) => {
				const open = indexedDB.open('enpwa', 1);
				open.onsuccess = () => {
					const req = open.result.transaction('notes').objectStore('notes').getAll();
					req.onsuccess = () => {
						open.result.close();
						resolve(req.result);
					};
				};
			}),
	);
}

function thriftReply(name: string, build: (w: ThriftWriter) => void): Buffer {
	const w = new ThriftWriter();
	w.i32((0x80010000 | 2) | 0)
		.string(name)
		.i32(1);
	build(w);
	return Buffer.from(w.bytes());
}

test('boots to the token hint on pure black', async ({ page }) => {
	await page.goto('/');
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await expect(page.getByText('Add your Evernote token')).toBeVisible();
	await expect(page.getByRole('button', { name: 'New note' })).toBeVisible();
	const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
	expect(bg).toBe('rgb(0, 0, 0)');
});

test('list shows notes with notebook and tags', async ({ page }) => {
	await seed(page, {
		notes: [
			note('g1', 'Trip plan', '<div>Pack</div>', { notebookGuid: 'nb1', tagGuids: ['t1', 't2'] }),
			note('g2', 'Recipe', '<div>Beets</div>', { updated: Date.now() - 86400000, notebookGuid: 'nb2' }),
		],
		names: {
			notebooks: { nb1: 'Travel', nb2: 'Kitchen' },
			tags: { t1: 'summer', t2: 'family' },
		},
	});
	const rows = page.locator('.notes li');
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0)).toContainText('Trip plan');
	await expect(rows.nth(0)).toContainText('Travel · summer, family');
	await expect(rows.nth(1)).toContainText('Kitchen');
});

test('editor renders every formatting kind we have regressed on', async ({ page }) => {
	const body =
		'<h1>Big heading</h1>' +
		'<div>Some <b>bold</b> and <i>italic</i> text with a <a href="https://gentoo.org">link</a></div>' +
		'<div><en-todo checked="true"/>buy milk</div>' +
		'<div><en-todo/>call the bank</div>' +
		'<table><tr><td>Mon</td><td>Tue</td></tr></table>' +
		'<div style="font-family: Monaco, monospace;-en-codeblock:true;"><div>terraform apply</div></div>';
	await seed(page, {
		notes: [note('g1', 'Formats', body, { notebookGuid: 'nb1', tagGuids: ['t1'] })],
		names: { notebooks: { nb1: 'Travel', nb2: 'Work' }, tags: { t1: 'summer' } },
	});
	await page.goto('/#n/g1');

	// note h1 must keep its real size (the app-header h1 rule once bled in)
	const h1Size = await page
		.locator('.body h1')
		.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
	expect(h1Size).toBeGreaterThan(28);

	// checkbox labels once vanished (parser nests them inside en-todo)
	const boxes = page.locator('.body input[data-en-todo]');
	await expect(boxes).toHaveCount(2);
	await expect(boxes.nth(0)).toBeChecked();
	await expect(boxes.nth(1)).not.toBeChecked();
	await expect(page.locator('.body')).toContainText('buy milk');
	await expect(page.locator('.body')).toContainText('call the bank');

	// tables must show a grid even without inline styles
	const cellBorder = await page
		.locator('.body td')
		.first()
		.evaluate((el) => getComputedStyle(el).borderTopWidth);
	expect(cellBorder).toBe('1px');

	// code blocks: dark background + monospace must beat inline styles
	const code = page.locator('.body div[style*="-en-codeblock"]');
	const codeStyle = await code.evaluate((el) => {
		const s = getComputedStyle(el);
		return { bg: s.backgroundColor, font: s.fontFamily };
	});
	expect(codeStyle.bg).toBe('rgb(43, 43, 43)');
	expect(codeStyle.font.toLowerCase()).toContain('mono');

	await expect(page.locator('.body b')).toHaveText('bold');
	await expect(page.locator('.body a[href="https://gentoo.org"]')).toBeVisible();

	// context line: notebook picker + editable tags
	await expect(page.locator('.nbselect')).toHaveValue('nb1');
	await expect(page.locator('.tagsinput')).toHaveValue('summer');
});

test('images hydrate through the resource pipeline', async ({ page }) => {
	const png = Buffer.from(TINY_PNG.split(',')[1], 'base64');
	await page.route('https://mock.test/**', async (route) => {
		if (route.request().url().includes('/res/')) {
			return route.fulfill({ contentType: 'image/png', body: png });
		}
		const data = route.request().postDataBuffer();
		const r = new ThriftReader(new Uint8Array(data ?? Buffer.alloc(0)));
		const { name } = r.messageBegin();
		if (name === 'getResourceByHash') {
			return route.fulfill({
				contentType: 'application/x-thrift',
				body: thriftReply('getResourceByHash', (w) => {
					w.field(T.STRUCT, 0);
					w.field(T.STRING, 1).string('res-1');
					w.field(T.STRING, 4).string('image/png');
					w.stop();
					w.stop();
				}),
			});
		}
		return route.fulfill({
			contentType: 'application/x-thrift',
			body: thriftReply('getSyncState', (w) => {
				w.field(T.STRUCT, 0);
				w.field(T.I32, 3).i32(42);
				w.stop();
				w.stop();
			}),
		});
	});
	await seed(page, {
		notes: [note('g1', 'Photo', '<div><en-media type="image/png" hash="aa11"/>caption</div>')],
		extraLocalStorage: {
			en_notestore_url: 'https://mock.test/shard/s1/notestore',
			en_update_count: '42',
		},
	});
	await page.goto('/#n/g1');
	const img = page.locator('.body img[data-en-hash="aa11"]');
	await expect(img).toBeVisible();
	expect(await img.getAttribute('src')).toMatch(/^blob:/);
	await expect(page.locator('.body')).toContainText('caption'); // not swallowed
});

test('typing persists the edit locally even with the API down', async ({ page }) => {
	await seed(page, { notes: [note('g1', 'Draft', '<div>start</div>')] });
	await page.goto('/#n/g1');
	await page.locator('.body').click();
	await page.keyboard.type(' plus typed words');
	await expect
		.poll(async () => {
			const notes = await readNotes(page);
			return notes.find((n) => n.guid === 'g1');
		})
		.toMatchObject({ dirty: true });
	const stored = (await readNotes(page)).find((n) => n.guid === 'g1');
	expect(stored?.enml).toContain('plus typed words');
});

test('an untouched new note is discarded on going back', async ({ page }) => {
	await seed(page, { notes: [note('g1', 'Existing', '<div>x</div>')] });
	await page.getByRole('button', { name: 'New note' }).click();
	await expect(page.locator('.title')).toBeFocused();
	await page.getByRole('link', { name: 'Back' }).click();
	await expect(page.locator('.notes li')).toHaveCount(1);
});

test('toggling a checkbox syncs valid ENML and the dot goes green', async ({ page }) => {
	const updates: string[] = [];
	await page.route('https://mock.test/**', async (route) => {
		const data = route.request().postDataBuffer();
		const r = new ThriftReader(new Uint8Array(data ?? Buffer.alloc(0)));
		const { name } = r.messageBegin();
		if (name === 'updateNote') {
			const args = r.struct();
			const sentNote = args.get(2) as Map<number, unknown>;
			updates.push(String(sentNote.get(3)));
			return route.fulfill({
				contentType: 'application/x-thrift',
				body: thriftReply('updateNote', (w) => {
					w.field(T.STRUCT, 0);
					w.field(T.I64, 7).i64(Date.now());
					w.field(T.I32, 10).i32(43);
					w.stop();
					w.stop();
				}),
			});
		}
		// boot refresh short-circuits: same updateCount as seeded below
		return route.fulfill({
			contentType: 'application/x-thrift',
			body: thriftReply('getSyncState', (w) => {
				w.field(T.STRUCT, 0);
				w.field(T.I32, 3).i32(42);
				w.stop();
				w.stop();
			}),
		});
	});
	await seed(page, {
		notes: [note('g1', 'Todos', '<div><en-todo/>buy milk</div>')],
		extraLocalStorage: {
			en_notestore_url: 'https://mock.test/shard/s1/notestore',
			en_update_count: '42',
		},
	});
	await page.goto('/#n/g1');
	await page.locator('.body input[data-en-todo]').click();
	await expect(page.locator('.dot.global.syncing')).toBeVisible(); // orange right away
	await expect.poll(() => updates.length, { timeout: 8000 }).toBeGreaterThan(0);
	expect(updates[0]).toContain('<en-todo checked="true"/>buy milk');
	expect(updates[0]).not.toContain('<input');
	await expect(page.locator('.dot.global.synced')).toBeVisible({ timeout: 8000 });
});
