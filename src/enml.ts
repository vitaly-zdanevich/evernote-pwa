// ENML <-> HTML. Evernote note content is XML (<en-note> wrapping an XHTML
// subset), so it renders as HTML directly; going back we must emit valid XML
// and drop what the ENML DTD prohibits, or updateNote is rejected.

const ENML_PROLOG =
	'<?xml version="1.0" encoding="UTF-8"?>' +
	'<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">';

/** A new empty note: one paragraph so contenteditable shows a caret line. */
export const EMPTY_ENML = ENML_PROLOG + '<en-note><div><br/></div></en-note>';

export interface EnmlBody {
	/** Raw attribute string of the original <en-note> tag, kept for round-trip. */
	attrs: string;
	html: string;
}

export function enmlToHtml(enml: string): EnmlBody {
	const open = /<en-note\b([^>]*?)(\/?)>/.exec(enml);
	if (!open) return { attrs: '', html: '' };
	if (open[2]) return { attrs: open[1], html: '' };
	const start = open.index + open[0].length;
	const end = enml.lastIndexOf('</en-note>');
	return { attrs: open[1], html: end >= start ? enml.slice(start, end) : '' };
}

// Prohibited by the ENML DTD (should never appear in a contenteditable that
// started from ENML, but dropping them beats a rejected sync). audio/video
// players are inserted by the editor for en-media playback and are
// display-only: the en-media element itself stays and round-trips.
const BANNED_ELEMENTS = new Set([
	'applet', 'audio', 'base', 'basefont', 'bgsound', 'blink', 'body', 'button', 'dir',
	'embed', 'fieldset', 'form', 'frame', 'frameset', 'head', 'html', 'iframe', 'ilayer',
	'input', 'isindex', 'label', 'layer', 'legend', 'link', 'marquee', 'menu', 'meta',
	'noframes', 'noscript', 'object', 'optgroup', 'option', 'param', 'plaintext', 'script',
	'select', 'source', 'style', 'textarea', 'track', 'video', 'xml',
]);

const BANNED_ATTRS = new Set(['id', 'class', 'accesskey', 'data', 'dynsrc', 'tabindex', 'contenteditable']);

function attr(node: XmlNode, name: string): string | undefined {
	const attrs = node.attributes;
	if (!attrs) return undefined;
	for (let i = 0; i < attrs.length; i++) {
		if (attrs[i].name.toLowerCase() === name) return attrs[i].value;
	}
	return undefined;
}
const XML_NAME = /^[a-zA-Z_][a-zA-Z0-9_:.-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function escText(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(CONTROL_CHARS, '');
}

function escAttr(s: string): string {
	return escText(s).replace(/"/g, '&quot;');
}

/**
 * The subset of the DOM Node interface the serializer touches; real DOM nodes
 * satisfy it, and tests can pass plain objects (vitest runs without a DOM).
 */
export interface XmlNode {
	nodeType: number;
	nodeName: string;
	data?: string | null;
	attributes?: ArrayLike<{ name: string; value: string }>;
	childNodes: ArrayLike<XmlNode>;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** The editor shows en-media images as <img>; turn them back on save. */
function serializeImg(node: XmlNode): string {
	const hash = attr(node, 'data-en-hash');
	// pasted/foreign images cannot be uploaded as resources, so they are dropped
	if (!hash) return '';
	let out = `<en-media hash="${escAttr(hash)}" type="${escAttr(attr(node, 'data-en-type') ?? 'image/png')}"`;
	for (const dim of ['width', 'height']) {
		const value = attr(node, dim);
		if (value) out += ` ${dim}="${escAttr(value)}"`;
	}
	return out + '/>';
}

function serializeNode(node: XmlNode): string {
	if (node.nodeType === TEXT_NODE) return escText(node.data ?? '');
	if (node.nodeType !== ELEMENT_NODE) return '';
	const tag = node.nodeName.toLowerCase();
	if (tag === 'img') return serializeImg(node);
	if (BANNED_ELEMENTS.has(tag) || !XML_NAME.test(tag)) return '';
	let out = '<' + tag;
	const attrs = node.attributes;
	if (attrs) {
		for (let i = 0; i < attrs.length; i++) {
			const name = attrs[i].name.toLowerCase();
			if (BANNED_ATTRS.has(name) || name.startsWith('on') || name.startsWith('data-') || !XML_NAME.test(name)) {
				continue;
			}
			out += ` ${name}="${escAttr(attrs[i].value)}"`;
		}
	}
	const inner = serializeChildren(node);
	return inner ? `${out}>${inner}</${tag}>` : out + '/>';
}

export function serializeChildren(node: XmlNode): string {
	let out = '';
	for (let i = 0; i < node.childNodes.length; i++) out += serializeNode(node.childNodes[i]);
	return out;
}

export function htmlToEnml(root: XmlNode, attrs = ''): string {
	return `${ENML_PROLOG}<en-note${attrs}>${serializeChildren(root)}</en-note>`;
}
