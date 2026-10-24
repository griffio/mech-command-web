// Reader for MC2 PacketFiles (.pak): mclib/packet.cpp.
//
// Layout: uint32 0xFEEDFACE, then a table of uint32 offsets (the first entry is
// also the table size). The top 3 bits of each offset are the storage type.
import { inflateSync } from 'node:zlib';

const STORAGE_RAW = 0;
const STORAGE_ZLIB = 4;
const STORAGE_NUL = 7;
const TYPE_SHIFT = 29;
const OFFSET_MASK = (1 << TYPE_SHIFT) - 1;

export function readPak(file: Buffer): Buffer[] {
  const magic = file.readUInt32LE(0);
  if (magic !== 0xfeedface) throw new Error(`not a packet file (magic ${magic.toString(16)})`);
  const count = file.readUInt32LE(4) / 4 - 2;
  const table: number[] = [];
  for (let i = 0; i < count; i++) table.push(file.readUInt32LE(8 + i * 4));

  return table.map((entry, i) => {
    const type = entry >>> TYPE_SHIFT;
    const start = entry & OFFSET_MASK;
    const end = i + 1 < count ? table[i + 1] & OFFSET_MASK : file.length;
    const raw = file.subarray(start, end);
    switch (type) {
      case STORAGE_RAW:
        return raw;
      case STORAGE_ZLIB: {
        const size = raw.readUInt32LE(0);
        const body = inflateSync(raw.subarray(4));
        if (body.length !== size) throw new Error(`packet ${i}: expected ${size} bytes, got ${body.length}`);
        return body;
      }
      case STORAGE_NUL:
        return Buffer.alloc(0);
      default:
        throw new Error(`packet ${i}: unsupported storage type ${type}`);
    }
  });
}
