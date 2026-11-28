import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { crc32 } from 'node:zlib';

/**
 * A streaming .zip writer for folder downloads: files are stored as they are (no compression; most are PDFs and
 * spreadsheets already compressed) and written straight to `out`, so a folder of any size never sits in memory.
 * Each file's CRC is only known after its bytes, so it follows them in a data descriptor. ZIP64 is used for any
 * file or offset past 4 GB, which every current unzip tool reads.
 */
export class ZipWriter {
  private offset = 0;
  private entries: { name: Buffer; crc: number; size: number; offset: number; zip64: boolean; time: number; date: number }[] = [];
  /** `limit` is where ZIP64 starts: 4 GB, or lower in tests to check that path without writing 4 GB. */
  constructor(private out: Writable, private limit = 0xffffffff) {}

  private async write(b: Buffer) {
    this.offset += b.length;
    if (!this.out.write(b)) await once(this.out, 'drain');
  }

  /** Adds one file: `send` writes its bytes to the given sink; `size` is its length, known in advance. */
  async add(path: string, size: number, modified: Date, send: (sink: { write: (chunk: Buffer) => Promise<void> }) => Promise<void>) {
    const name = Buffer.from(path, 'utf8');
    const zip64 = size >= this.limit || this.offset >= this.limit;
    const time = (modified.getHours() << 11) | (modified.getMinutes() << 5) | (modified.getSeconds() >> 1);
    const date = ((Math.max(modified.getFullYear(), 1980) - 1980) << 9) | ((modified.getMonth() + 1) << 5) | modified.getDate();
    const start = this.offset;
    const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0); // sizes follow the data, so zeros here
    if (zip64) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(16, 2); }
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(zip64 ? 45 : 20, 4);
    head.writeUInt16LE(0x0808, 6); // bit 3: sizes and CRC after the data; bit 11: UTF-8 names
    head.writeUInt16LE(0, 8); // stored
    head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12);
    head.writeUInt32LE(0, 14);
    head.writeUInt32LE(zip64 ? 0xffffffff : 0, 18); head.writeUInt32LE(zip64 ? 0xffffffff : 0, 22);
    head.writeUInt16LE(name.length, 26); head.writeUInt16LE(extra.length, 28);
    await this.write(Buffer.concat([head, name, extra]));

    let crc = 0, written = 0;
    await send({ write: async (chunk) => { crc = crc32(chunk, crc); written += chunk.length; await this.write(chunk); } });
    if (written !== size) throw new Error(`${path}: expected ${size} bytes, got ${written}`);

    const desc = Buffer.alloc(zip64 ? 24 : 16);
    desc.writeUInt32LE(0x08074b50, 0); desc.writeUInt32LE(crc >>> 0, 4);
    if (zip64) { desc.writeBigUInt64LE(BigInt(size), 8); desc.writeBigUInt64LE(BigInt(size), 16); }
    else { desc.writeUInt32LE(size, 8); desc.writeUInt32LE(size, 12); }
    await this.write(desc);
    this.entries.push({ name, crc: crc >>> 0, size, offset: start, zip64, time, date });
  }

  /** Writes the central directory and ends the zip. */
  async finish() {
    const dirStart = this.offset;
    for (const e of this.entries) {
      const extra = e.zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
      if (e.zip64) {
        extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(24, 2);
        extra.writeBigUInt64LE(BigInt(e.size), 4); extra.writeBigUInt64LE(BigInt(e.size), 12); extra.writeBigUInt64LE(BigInt(e.offset), 20);
      }
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(45, 4); c.writeUInt16LE(e.zip64 ? 45 : 20, 6);
      c.writeUInt16LE(0x0808, 8); c.writeUInt16LE(0, 10);
      c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.zip64 ? 0xffffffff : e.size, 20); c.writeUInt32LE(e.zip64 ? 0xffffffff : e.size, 24);
      c.writeUInt16LE(e.name.length, 28); c.writeUInt16LE(extra.length, 30);
      c.writeUInt32LE(e.zip64 ? 0xffffffff : e.offset, 42);
      await this.write(Buffer.concat([c, e.name, extra]));
    }
    const dirSize = this.offset - dirStart;
    const big = this.entries.length >= 0xffff || dirStart >= this.limit || dirSize >= this.limit;
    if (big) {
      const z = Buffer.alloc(56), zStart = this.offset;
      z.writeUInt32LE(0x06064b50, 0); z.writeBigUInt64LE(44n, 4);
      z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14);
      z.writeBigUInt64LE(BigInt(this.entries.length), 24); z.writeBigUInt64LE(BigInt(this.entries.length), 32);
      z.writeBigUInt64LE(BigInt(dirSize), 40); z.writeBigUInt64LE(BigInt(dirStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(zStart), 8); loc.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([z, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(this.entries.length, 0xffff), 8); end.writeUInt16LE(Math.min(this.entries.length, 0xffff), 10);
    end.writeUInt32LE(big ? 0xffffffff : dirSize, 12); end.writeUInt32LE(big ? 0xffffffff : dirStart, 16);
    await this.write(end);
    this.out.end();
  }
}
