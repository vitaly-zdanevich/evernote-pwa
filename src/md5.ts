// Minimal MD5 (RFC 1321). Evernote identifies resources by their MD5 and
// WebCrypto does not offer it. Only used for images the user adds.

const S = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
	5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
	4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
	6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

export function md5Hex(data: Uint8Array): string {
	const bitLen = data.length * 8;
	const padded = new Uint8Array((((data.length + 8) >> 6) + 1) * 64);
	padded.set(data);
	padded[data.length] = 0x80;
	const dv = new DataView(padded.buffer);
	dv.setUint32(padded.length - 8, bitLen >>> 0, true);
	dv.setUint32(padded.length - 4, Math.floor(bitLen / 4294967296), true);

	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;
	const m = new Uint32Array(16);

	for (let off = 0; off < padded.length; off += 64) {
		for (let i = 0; i < 16; i++) m[i] = dv.getUint32(off + i * 4, true);
		let a = a0;
		let b = b0;
		let c = c0;
		let d = d0;
		for (let i = 0; i < 64; i++) {
			let f: number;
			let g: number;
			if (i < 16) {
				f = (b & c) | (~b & d);
				g = i;
			} else if (i < 32) {
				f = (d & b) | (~d & c);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				f = b ^ c ^ d;
				g = (3 * i + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * i) % 16;
			}
			f = (f + a + K[i] + m[g]) | 0;
			a = d;
			d = c;
			c = b;
			b = (b + ((f << S[i]) | (f >>> (32 - S[i])))) | 0;
		}
		a0 = (a0 + a) | 0;
		b0 = (b0 + b) | 0;
		c0 = (c0 + c) | 0;
		d0 = (d0 + d) | 0;
	}

	const out = new Uint8Array(16);
	const odv = new DataView(out.buffer);
	odv.setUint32(0, a0 >>> 0, true);
	odv.setUint32(4, b0 >>> 0, true);
	odv.setUint32(8, c0 >>> 0, true);
	odv.setUint32(12, d0 >>> 0, true);
	let hex = '';
	for (const byte of out) hex += byte.toString(16).padStart(2, '0');
	return hex;
}
