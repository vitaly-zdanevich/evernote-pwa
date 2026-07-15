import { describe, expect, it } from 'vitest';
import { enmlToHtml, htmlToEnml } from '../src/enml';
import type { XmlNode } from '../src/enml';

function elem(name: string, attrs: Record<string, string> = {}, ...kids: XmlNode[]): XmlNode {
	return {
		nodeType: 1,
		nodeName: name,
		attributes: Object.entries(attrs).map(([n, v]) => ({ name: n, value: v })),
		childNodes: kids,
	};
}

function text(data: string): XmlNode {
	return { nodeType: 3, nodeName: '#text', data, childNodes: [] };
}

const SAMPLE =
	'<?xml version="1.0" encoding="UTF-8"?>' +
	'<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">' +
	'<en-note style="background:#fff;"><div>Hello <b>bold</b></div><en-media type="image/png" hash="abc"/></en-note>';

describe('enmlToHtml', () => {
	it('extracts the editable body and the en-note attributes', () => {
		const { attrs, html } = enmlToHtml(SAMPLE);
		expect(attrs).toBe(' style="background:#fff;"');
		expect(html).toBe('<div>Hello <b>bold</b></div><en-media type="image/png" hash="abc"/>');
	});

	it('handles a self-closed empty note', () => {
		expect(enmlToHtml('<?xml version="1.0"?><en-note/>')).toEqual({ attrs: '', html: '' });
	});

	it('returns nothing for content without en-note', () => {
		expect(enmlToHtml('<html>nope</html>').html).toBe('');
	});
});

describe('htmlToEnml', () => {
	it('serializes a tree back to valid ENML with the original attributes', () => {
		const root = elem(
			'DIV',
			{},
			elem('DIV', {}, text('Hello '), elem('B', {}, text('bold'))),
			elem('EN-MEDIA', { type: 'image/png', hash: 'abc' }),
		);
		expect(htmlToEnml(root, ' style="x"')).toBe(
			'<?xml version="1.0" encoding="UTF-8"?>' +
				'<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">' +
				'<en-note style="x"><div>Hello <b>bold</b></div>' +
				'<en-media type="image/png" hash="abc"/></en-note>',
		);
	});

	it('escapes text and attribute values', () => {
		const root = elem('div', {}, elem('a', { href: 'x?a=1&b="2"' }, text('1 < 2 & 3 > 0')));
		expect(htmlToEnml(root)).toContain(
			'<a href="x?a=1&amp;b=&quot;2&quot;">1 &lt; 2 &amp; 3 &gt; 0</a>',
		);
	});

	it('strips attributes and elements the ENML DTD prohibits', () => {
		const root = elem(
			'div',
			{},
			elem('div', { class: 'x', id: 'y', onclick: 'evil()', style: 'color:red' }, text('keep')),
			elem('script', {}, text('alert(1)')),
		);
		expect(htmlToEnml(root)).toContain('<div style="color:red">keep</div>');
		expect(htmlToEnml(root)).not.toContain('script');
		expect(htmlToEnml(root)).not.toContain('onclick');
	});

	it('self-closes empty elements for XML validity', () => {
		const root = elem('div', {}, text('a'), elem('br'), text('b'), elem('div'));
		expect(htmlToEnml(root)).toContain('a<br/>b<div/>');
	});

	it('drops XML-invalid control characters', () => {
		const root = elem('div', {}, text('a\u0000b\u0007c'));
		expect(htmlToEnml(root)).toContain('<en-note>abc</en-note>');
	});
});
