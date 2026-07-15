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

	it('turns hydrated images back into en-media and drops foreign images', () => {
		const root = elem(
			'div',
			{},
			elem('IMG', {
				src: 'blob:https://x/123',
				'data-en-hash': 'abc123',
				'data-en-type': 'image/jpeg',
				width: '640',
			}),
			elem('img', { src: 'https://elsewhere.example/x.png' }),
		);
		expect(htmlToEnml(root)).toContain(
			'<en-note><en-media hash="abc123" type="image/jpeg" width="640"/></en-note>',
		);
	});

	it('strips data- attributes from regular elements', () => {
		const root = elem('div', {}, elem('div', { 'data-foo': 'x', style: 'color:red' }, text('hi')));
		expect(htmlToEnml(root)).toContain('<div style="color:red">hi</div>');
	});

	it('drops XML-invalid control characters', () => {
		const root = elem('div', {}, text('a\u0000b\u0007c'));
		expect(htmlToEnml(root)).toContain('<en-note>abc</en-note>');
	});
});

describe('tables', () => {
	it('extracts table markup from ENML for the editor', () => {
		const enml =
			'<?xml version="1.0"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">' +
			'<en-note><table width="100%"><tr><td>a</td><td/></tr></table></en-note>';
		expect(enmlToHtml(enml).html).toBe('<table width="100%"><tr><td>a</td><td/></tr></table>');
	});

	it('round-trips a browser-normalized table back to valid ENML', () => {
		// contenteditable gives uppercase node names and an inserted TBODY
		const tree = elem(
			'div',
			{},
			elem(
				'TABLE',
				{ style: 'width:640px', border: '1' },
				elem(
					'TBODY',
					{},
					elem('TR', {}, elem('TD', { colspan: '2', style: 'background:#eee' }, text('Header'))),
					elem('TR', {}, elem('TD', {}, text('a & b')), elem('TD', {})),
				),
			),
		);
		expect(htmlToEnml(tree)).toContain(
			'<table style="width:640px" border="1"><tbody>' +
				'<tr><td colspan="2" style="background:#eee">Header</td></tr>' +
				'<tr><td>a &amp; b</td><td/></tr>' +
				'</tbody></table>',
		);
	});

	it('keeps caption and colgroup, self-closing the void col element', () => {
		const tree = elem(
			'div',
			{},
			elem(
				'TABLE',
				{},
				elem('CAPTION', {}, text('Budget')),
				elem('COLGROUP', {}, elem('COL', { width: '120' }), elem('COL', { width: '80' })),
				elem('TBODY', {}, elem('TR', {}, elem('TD', {}, text('x')), elem('TD', {}, text('y')))),
			),
		);
		const out = htmlToEnml(tree);
		expect(out).toContain('<caption>Budget</caption>');
		expect(out).toContain('<colgroup><col width="120"/><col width="80"/></colgroup>');
	});

	it('strips prohibited attributes from table parts but keeps layout ones', () => {
		const tree = elem(
			'div',
			{},
			elem(
				'TABLE',
				{ class: 'grid', cellpadding: '4' },
				elem(
					'TBODY',
					{},
					elem('TR', { class: 'row' }, elem('TD', { id: 'c1', rowspan: '2', valign: 'top' }, text('x'))),
				),
			),
		);
		const out = htmlToEnml(tree);
		expect(out).toContain('<table cellpadding="4"><tbody><tr><td rowspan="2" valign="top">x</td></tr></tbody></table>');
		expect(out).not.toContain('class');
		expect(out).not.toContain('id=');
	});

	it('keeps the real Evernote 10 table shape intact', () => {
		// desktop clients emit styled cells wrapping content in divs
		const cellStyle = 'border: 1px solid rgb(211, 211, 211); padding: 10px;';
		const tree = elem(
			'div',
			{},
			elem(
				'TABLE',
				{ style: 'border-collapse: collapse; min-width: 100%;' },
				elem('COLGROUP', {}, elem('COL', { style: 'width: 205px;' })),
				elem(
					'TBODY',
					{},
					elem('TR', {}, elem('TD', { style: cellStyle }, elem('DIV', {}, text('cell')))),
				),
			),
		);
		expect(htmlToEnml(tree)).toContain(
			'<table style="border-collapse: collapse; min-width: 100%;">' +
				'<colgroup><col style="width: 205px;"/></colgroup>' +
				`<tbody><tr><td style="${cellStyle}"><div>cell</div></td></tr></tbody></table>`,
		);
	});
});

describe('code blocks', () => {
	it('preserves the -en-codeblock style marker exactly on round trip', () => {
		const style =
			'box-sizing: border-box; padding: 8px; font-family: Monaco, Menlo, Consolas, "Courier New", monospace;' +
			' background-color: rgb(251, 250, 248);-en-codeblock:true;';
		const tree = elem(
			'div',
			{},
			elem('DIV', { style }, elem('DIV', {}, text('set -euo pipefail')), elem('DIV', {}, text('terraform apply'))),
		);
		const out = htmlToEnml(tree);
		// the marker must survive byte-for-byte (other clients detect it), quotes escaped for XML
		expect(out).toContain('-en-codeblock:true;');
		expect(out).toContain('font-family: Monaco, Menlo, Consolas, &quot;Courier New&quot;, monospace;');
		expect(out).toContain('<div>set -euo pipefail</div><div>terraform apply</div>');
	});

	it('extracts codeblock markup from ENML for the editor', () => {
		const enml =
			'<?xml version="1.0"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">' +
			'<en-note><div style="-en-codeblock:true;"><div>x = 1</div></div><pre>fn main() {}</pre></en-note>';
		expect(enmlToHtml(enml).html).toBe('<div style="-en-codeblock:true;"><div>x = 1</div></div><pre>fn main() {}</pre>');
	});

	it('keeps pre and code elements', () => {
		const tree = elem('div', {}, elem('PRE', {}, text('a < b')), elem('P', {}, elem('CODE', {}, text('npm ci'))));
		const out = htmlToEnml(tree);
		expect(out).toContain('<pre>a &lt; b</pre>');
		expect(out).toContain('<code>npm ci</code>');
	});
});

describe('audio players', () => {
	it('drops the display-only audio element but keeps its en-media on save', () => {
		const tree = elem(
			'div',
			{},
			elem('EN-MEDIA', { type: 'audio/wav', hash: 'ff00', class: 'played' }),
			elem('AUDIO', { controls: '', src: 'blob:https://x/1', contenteditable: 'false' }),
		);
		const out = htmlToEnml(tree);
		expect(out).toContain('<en-media type="audio/wav" hash="ff00"/>');
		expect(out).not.toContain('audio>');
		expect(out).not.toContain('blob:');
		expect(out).not.toContain('class');
	});
});

describe('headings and links', () => {
	it('keeps h1-h6 and anchors through the round trip', () => {
		const tree = elem(
			'div',
			{},
			elem('H1', {}, text('Title')),
			elem('H2', {}, text('Sub')),
			elem('H3', {}, text('Third')),
			elem('H4', {}, text('Fourth')),
			elem('A', { href: 'https://example.org/a?b=1' }, text('link')),
		);
		const out = htmlToEnml(tree);
		expect(out).toContain('<h1>Title</h1><h2>Sub</h2><h3>Third</h3><h4>Fourth</h4>');
		expect(out).toContain('<a href="https://example.org/a?b=1">link</a>');
	});
});
