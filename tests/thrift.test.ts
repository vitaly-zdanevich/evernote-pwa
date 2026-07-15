import { describe, expect, it } from 'vitest';
import { MSG_CALL, T, ThriftReader, ThriftWriter } from '../src/thrift';

describe('thrift binary protocol', () => {
	it('round-trips a call message with a nested struct', () => {
		const w = new ThriftWriter();
		w.messageBegin('getNote', 7);
		w.field(T.STRING, 1).string('token');
		w.field(T.STRUCT, 2);
		w.field(T.I32, 1).i32(2);
		w.field(T.BOOL, 2).bool(false);
		w.stop();
		w.field(T.I32, 3).i32(-5);
		w.stop();

		const r = new ThriftReader(w.bytes());
		const msg = r.messageBegin();
		expect(msg).toEqual({ name: 'getNote', type: MSG_CALL, seqid: 7 });
		const args = r.struct();
		expect(args.get(1)).toBe('token');
		const filter = args.get(2) as Map<number, unknown>;
		expect(filter.get(1)).toBe(2);
		expect(filter.get(2)).toBe(false);
		expect(args.get(3)).toBe(-5);
	});

	it('round-trips i64 values without BigInt', () => {
		const values = [0, 1, -1, 1736899200000, 2 ** 52 + 3, -(2 ** 52)];
		const w = new ThriftWriter();
		for (const v of values) w.i64(v);
		const r = new ThriftReader(w.bytes());
		for (const v of values) expect(r.i64()).toBe(v);
	});

	it('round-trips non-ASCII strings', () => {
		const w = new ThriftWriter();
		w.string('Привет 🐘 ноутбук');
		const r = new ThriftReader(w.bytes());
		expect(r.string()).toBe('Привет 🐘 ноутбук');
	});

	it('reads lists of structs and skips unknown field types', () => {
		const w = new ThriftWriter();
		w.field(T.LIST, 3).byte(T.STRUCT).i32(2);
		for (const guid of ['a', 'b']) {
			w.field(T.STRING, 1).string(guid);
			w.field(T.I64, 7).i64(1700000000000);
			w.field(T.DOUBLE, 30);
			w.i32(0x3ff00000).i32(0); // 1.0 as raw double
			w.stop();
		}
		w.field(T.MAP, 9).byte(T.STRING).byte(T.I32).i32(1);
		w.string('k').i32(42);
		w.stop();

		const s = new ThriftReader(w.bytes()).struct();
		const list = s.get(3) as Map<number, unknown>[];
		expect(list).toHaveLength(2);
		expect(list[0].get(1)).toBe('a');
		expect(list[1].get(7)).toBe(1700000000000);
		expect(list[0].get(30)).toBe(1);
		expect(s.get(9)).toEqual([['k', 42]]);
	});

	it('rejects garbage that is not a thrift message', () => {
		const bytes = new TextEncoder().encode('<html>proxy error</html>');
		expect(() => new ThriftReader(bytes).messageBegin()).toThrow(/Thrift/);
	});
});
