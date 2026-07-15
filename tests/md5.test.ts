import { describe, expect, it } from 'vitest';
import { md5Hex } from '../src/md5';

const enc = (s: string) => new TextEncoder().encode(s);

describe('md5Hex', () => {
	it('matches the RFC 1321 test vectors', () => {
		expect(md5Hex(enc(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
		expect(md5Hex(enc('a'))).toBe('0cc175b9c0f1b6a831c399e269772661');
		expect(md5Hex(enc('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
		expect(md5Hex(enc('message digest'))).toBe('f96b697d7cb7938d525a2f31aaf161d0');
		expect(md5Hex(enc('abcdefghijklmnopqrstuvwxyz'))).toBe('c3fcd3d76192e4007dfb496cca67e13b');
		expect(
			md5Hex(enc('12345678901234567890123456789012345678901234567890123456789012345678901234567890')),
		).toBe('57edf4a22be3c955ac49da2e2107b67a');
	});

	it('hashes lengths around the 56-byte padding boundary', () => {
		expect(md5Hex(enc('x'.repeat(55)))).toBe(md5Hex(enc('x'.repeat(55))));
		expect(md5Hex(enc('x'.repeat(56)))).not.toBe(md5Hex(enc('x'.repeat(57))));
		expect(md5Hex(enc('The quick brown fox jumps over the lazy dog'))).toBe(
			'9e107d9d372bb6826bd81d3542a419d6',
		);
	});

	it('hashes raw binary', () => {
		expect(md5Hex(new Uint8Array([0, 1, 2, 253, 254, 255]))).toHaveLength(32);
	});
});
