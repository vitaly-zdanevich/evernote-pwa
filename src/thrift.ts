// Minimal Thrift binary protocol (strict), just enough for the EDAM calls
// this app makes. Field IDs come from the official IDL; see src/evernote.ts.

export const T = {
	STOP: 0,
	BOOL: 2,
	BYTE: 3,
	DOUBLE: 4,
	I16: 6,
	I32: 8,
	I64: 10,
	STRING: 11,
	STRUCT: 12,
	MAP: 13,
	SET: 14,
	LIST: 15,
} as const;

const VERSION_1 = 0x80010000;
export const MSG_CALL = 1;
export const MSG_REPLY = 2;
export const MSG_EXCEPTION = 3;

/** Generic decoded struct: field id -> value. */
export type TStruct = Map<number, unknown>;

export class ThriftWriter {
	private buf = new Uint8Array(256);
	private len = 0;

	private ensure(n: number): void {
		if (this.len + n <= this.buf.length) return;
		const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
		next.set(this.buf);
		this.buf = next;
	}

	byte(v: number): this {
		this.ensure(1);
		this.buf[this.len++] = v & 0xff;
		return this;
	}

	i16(v: number): this {
		this.ensure(2);
		this.buf[this.len++] = (v >> 8) & 0xff;
		this.buf[this.len++] = v & 0xff;
		return this;
	}

	i32(v: number): this {
		this.ensure(4);
		this.buf[this.len++] = (v >> 24) & 0xff;
		this.buf[this.len++] = (v >> 16) & 0xff;
		this.buf[this.len++] = (v >> 8) & 0xff;
		this.buf[this.len++] = v & 0xff;
		return this;
	}

	/** Safe for |v| < 2^53, which covers EDAM timestamps. */
	i64(v: number): this {
		const hi = Math.floor(v / 4294967296);
		const lo = v - hi * 4294967296;
		return this.i32(hi).i32(lo);
	}

	bool(v: boolean): this {
		return this.byte(v ? 1 : 0);
	}

	string(s: string): this {
		return this.binary(new TextEncoder().encode(s));
	}

	binary(b: Uint8Array): this {
		this.i32(b.length);
		this.ensure(b.length);
		this.buf.set(b, this.len);
		this.len += b.length;
		return this;
	}

	field(type: number, id: number): this {
		return this.byte(type).i16(id);
	}

	stop(): this {
		return this.byte(T.STOP);
	}

	messageBegin(name: string, seqid: number): this {
		return this.i32(VERSION_1 | MSG_CALL).string(name).i32(seqid);
	}

	bytes(): Uint8Array<ArrayBuffer> {
		return this.buf.slice(0, this.len);
	}
}

export class ThriftReader {
	private dv: DataView;
	private pos = 0;

	constructor(data: ArrayBuffer | Uint8Array) {
		const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
		this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	}

	byte(): number {
		return this.dv.getInt8(this.pos++);
	}

	i16(): number {
		const v = this.dv.getInt16(this.pos);
		this.pos += 2;
		return v;
	}

	i32(): number {
		const v = this.dv.getInt32(this.pos);
		this.pos += 4;
		return v;
	}

	/** Exact for |v| < 2^53; avoids BigInt for old WebKit. */
	i64(): number {
		const hi = this.i32();
		const lo = this.dv.getUint32(this.pos);
		this.pos += 4;
		return hi * 4294967296 + lo;
	}

	double(): number {
		const v = this.dv.getFloat64(this.pos);
		this.pos += 8;
		return v;
	}

	string(): string {
		const len = this.i32();
		const v = new TextDecoder().decode(
			new Uint8Array(this.dv.buffer, this.dv.byteOffset + this.pos, len),
		);
		this.pos += len;
		return v;
	}

	messageBegin(): { name: string; type: number; seqid: number } {
		const head = this.i32();
		if ((head & 0xffff0000) >>> 0 !== (VERSION_1 >>> 0)) {
			throw new Error('Bad Thrift response header');
		}
		return { type: head & 0xff, name: this.string(), seqid: this.i32() };
	}

	/** Reads any value of the given type into plain JS data. */
	value(type: number): unknown {
		switch (type) {
			case T.BOOL:
				return this.byte() !== 0;
			case T.BYTE:
				return this.byte();
			case T.DOUBLE:
				return this.double();
			case T.I16:
				return this.i16();
			case T.I32:
				return this.i32();
			case T.I64:
				return this.i64();
			case T.STRING:
				return this.string();
			case T.STRUCT:
				return this.struct();
			case T.MAP: {
				const kt = this.byte();
				const vt = this.byte();
				const size = this.i32();
				const out: [unknown, unknown][] = [];
				for (let i = 0; i < size; i++) out.push([this.value(kt), this.value(vt)]);
				return out;
			}
			case T.SET:
			case T.LIST: {
				const et = this.byte();
				const size = this.i32();
				const out: unknown[] = [];
				for (let i = 0; i < size; i++) out.push(this.value(et));
				return out;
			}
			default:
				throw new Error(`Unknown Thrift type ${type}`);
		}
	}

	struct(): TStruct {
		const out: TStruct = new Map();
		for (;;) {
			const type = this.byte();
			if (type === T.STOP) return out;
			const id = this.i16();
			out.set(id, this.value(type));
		}
	}
}

export function str(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined;
}

export function num(v: unknown): number | undefined {
	return typeof v === 'number' ? v : undefined;
}

export function structField(s: unknown, id: number): unknown {
	return s instanceof Map ? s.get(id) : undefined;
}
