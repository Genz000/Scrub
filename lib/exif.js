// Minimal EXIF/TIFF reader — enough to show a human what a file is leaking.

const TAGS = {
  0x010f: 'Camera make',
  0x0110: 'Camera model',
  0x0131: 'Software',
  0x0132: 'Date modified',
  0x013b: 'Artist',
  0x8298: 'Copyright',
  0x010e: 'Image description',
  0x9003: 'Date taken',
  0x9004: 'Date digitized',
  0x927c: 'Maker note',
  0x9286: 'User comment',
  0xa430: 'Camera owner',
  0xa431: 'Body serial number',
  0xa433: 'Lens make',
  0xa434: 'Lens model',
  0xa435: 'Lens serial number',
  0x829a: 'Exposure time',
  0x829d: 'F number',
  0x8827: 'ISO',
};

const GPS_TAGS = {
  0x0001: 'GPS latitude ref',
  0x0002: 'GPS latitude',
  0x0003: 'GPS longitude ref',
  0x0004: 'GPS longitude',
  0x0006: 'GPS altitude',
  0x0012: 'GPS map datum',
  0x001d: 'GPS date',
};

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function readValue(buf, offset, type, count, le, tiffStart) {
  const size = TYPE_SIZE[type] || 1;
  const total = size * count;
  let dataOffset = offset;
  if (total > 4) {
    const ptr = le ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
    dataOffset = tiffStart + ptr;
  }
  if (dataOffset < 0 || dataOffset + total > buf.length) return null;

  if (type === 2) {
    return buf.toString('latin1', dataOffset, dataOffset + total).replace(/\0.*$/, '').trim();
  }
  const out = [];
  for (let i = 0; i < count && i < 8; i++) {
    const at = dataOffset + i * size;
    try {
      if (type === 1 || type === 6 || type === 7) out.push(buf.readUInt8(at));
      else if (type === 3) out.push(le ? buf.readUInt16LE(at) : buf.readUInt16BE(at));
      else if (type === 4 || type === 9) out.push(le ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
      else if (type === 5 || type === 10) {
        const n = le ? buf.readUInt32LE(at) : buf.readUInt32BE(at);
        const d = le ? buf.readUInt32LE(at + 4) : buf.readUInt32BE(at + 4);
        out.push(d ? n / d : 0);
      } else return null;
    } catch { return null; }
  }
  return out;
}

function toDegrees(v) {
  if (!Array.isArray(v) || v.length < 3) return null;
  return v[0] + v[1] / 60 + v[2] / 3600;
}

// Walks a TIFF header (as found inside a JPEG APP1 segment) and pulls known tags.
export function parseTiff(buf, tiffStart) {
  const found = [];
  if (tiffStart + 8 > buf.length) return found;
  const order = buf.toString('latin1', tiffStart, tiffStart + 2);
  if (order !== 'II' && order !== 'MM') return found;
  const le = order === 'II';
  const read32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const read16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));

  const gps = {};
  let total = 0;

  const walk = (ifdOffset, kind, depth) => {
    if (depth > 3 || ifdOffset + 2 > buf.length) return;
    const count = read16(ifdOffset);
    if (count > 512) return;
    for (let i = 0; i < count; i++) {
      const entry = ifdOffset + 2 + i * 12;
      if (entry + 12 > buf.length) return;
      const tag = read16(entry);
      const type = read16(entry + 2);
      const num = read32(entry + 4);
      total++;

      if (tag === 0x8769 || tag === 0x8825) {
        const sub = tiffStart + read32(entry + 8);
        walk(sub, tag === 0x8825 ? 'gps' : 'exif', depth + 1);
        continue;
      }
      const name = kind === 'gps' ? GPS_TAGS[tag] : TAGS[tag];
      if (!name) continue;
      const value = readValue(buf, entry + 8, type, num, le, tiffStart);
      if (value === null || value === '') continue;
      if (kind === 'gps') gps[tag] = value;
      else found.push({ label: name, value: Array.isArray(value) ? value.join(', ') : String(value) });
    }
    const next = read32(ifdOffset + 2 + count * 12);
    if (next) walk(tiffStart + next, kind, depth + 1);
  };

  walk(tiffStart + read32(tiffStart + 4), 'ifd0', 0);

  const lat = toDegrees(gps[0x0002]);
  const lon = toDegrees(gps[0x0004]);
  if (lat != null && lon != null) {
    const latRef = gps[0x0001] === 'S' ? -1 : 1;
    const lonRef = gps[0x0003] === 'W' ? -1 : 1;
    found.unshift({
      label: 'GPS location',
      value: `${(lat * latRef).toFixed(6)}, ${(lon * lonRef).toFixed(6)}`,
      critical: true,
    });
  }
  if (gps[0x0006] != null) {
    found.push({ label: 'GPS altitude', value: `${Number(gps[0x0006]).toFixed(1)} m`, critical: true });
  }
  return { found, total };
}
