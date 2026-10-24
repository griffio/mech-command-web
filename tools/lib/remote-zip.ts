// Reads single files out of a large zip on a web server using HTTP range
// requests: only the central directory and the wanted entries are downloaded.
import { inflateRawSync } from 'node:zlib';

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export class RemoteZip {
  /** Entries by lower-case path. */
  readonly entries = new Map<string, Entry>();
  private url = '';
  private length = 0;

  private constructor(private readonly sourceUrl: string) {}

  static async open(url: string): Promise<RemoteZip> {
    const zip = new RemoteZip(url);
    await zip.resolve();
    await zip.readDirectory();
    return zip;
  }

  async extract(name: string): Promise<Buffer> {
    const entry = this.entries.get(name.toLowerCase());
    if (!entry) throw new Error(`${name} is not in ${this.sourceUrl}`);
    const header = await this.range(entry.localOffset, 30);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`${name}: bad local header`);
    const dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const data = await this.range(dataStart, entry.compressedSize);
    const out = entry.method === 0 ? data : entry.method === 8 ? inflateRawSync(data) : null;
    if (!out) throw new Error(`${name}: unsupported compression method ${entry.method}`);
    if (out.length !== entry.size) throw new Error(`${name}: expected ${entry.size} bytes, got ${out.length}`);
    return out;
  }

  /** GitHub release links redirect to short-lived signed URLs; follow once and keep the result. */
  private async resolve() {
    const res = await fetch(this.sourceUrl, { method: 'HEAD', redirect: 'follow' });
    if (!res.ok) throw new Error(`${this.sourceUrl}: HTTP ${res.status}`);
    this.url = res.url;
    this.length = Number(res.headers.get('content-length'));
  }

  private async range(start: number, size: number, retry = true): Promise<Buffer> {
    const res = await fetch(this.url, { headers: { Range: `bytes=${start}-${start + size - 1}` } });
    if (res.status === 403 && retry) {
      await this.resolve(); // the signed URL expired
      return this.range(start, size, false);
    }
    if (res.status !== 206) throw new Error(`range request failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private async readDirectory() {
    const tailSize = Math.min(this.length, 65557 + 20);
    const tail = await this.range(this.length - tailSize, tailSize);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('end of central directory not found');
    let count = tail.readUInt16LE(eocd + 10);
    let dirSize = tail.readUInt32LE(eocd + 12);
    let dirOffset = tail.readUInt32LE(eocd + 16);
    if (dirOffset === 0xffffffff || dirSize === 0xffffffff || count === 0xffff) {
      // Zip64: the locator just before the EOCD points at the Zip64 record.
      const locator = eocd - 20;
      if (tail.readUInt32LE(locator) !== 0x07064b50) throw new Error('zip64 locator not found');
      const record = await this.range(Number(tail.readBigUInt64LE(locator + 8)), 56);
      count = Number(record.readBigUInt64LE(32));
      dirSize = Number(record.readBigUInt64LE(40));
      dirOffset = Number(record.readBigUInt64LE(48));
    }

    const dir = await this.range(dirOffset, dirSize);
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (dir.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
      const nameLength = dir.readUInt16LE(p + 28);
      const extraLength = dir.readUInt16LE(p + 30);
      const commentLength = dir.readUInt16LE(p + 32);
      const name = dir.toString('utf8', p + 46, p + 46 + nameLength);
      let compressedSize = dir.readUInt32LE(p + 20);
      let size = dir.readUInt32LE(p + 24);
      let localOffset = dir.readUInt32LE(p + 42);
      // Zip64 extra field holds the 64-bit values for any field saturated above.
      let e = p + 46 + nameLength;
      const extraEnd = e + extraLength;
      while (e + 4 <= extraEnd) {
        const id = dir.readUInt16LE(e);
        const len = dir.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) {
            size = Number(dir.readBigUInt64LE(q));
            q += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(dir.readBigUInt64LE(q));
            q += 8;
          }
          if (localOffset === 0xffffffff) localOffset = Number(dir.readBigUInt64LE(q));
        }
        e += 4 + len;
      }
      this.entries.set(name.toLowerCase(), { name, method: dir.readUInt16LE(p + 10), compressedSize, size, localOffset });
      p = extraEnd + commentLength;
    }
  }
}
