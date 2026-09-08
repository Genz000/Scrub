// TIFF/EXIF reader. Works on a DataView so it runs in the browser with no dependencies.

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

function readValue(view, offset, type, count, le, tiffStart) {
  const size = TYPE_SIZE[type] || 1;
  const total = size * count;
  let at = offset;
  if (total > 4) {
    at = tiffStart + view.getUint32(offset, le);
  }
  if (at < 0 || at + total > view.byteLength) return null;

  if (type === 2) {
    let s = '';
    for (let i = 0; i < total; i++) {
      const c = view.getUint8(at + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  const out = [];
  for (let i = 0; i < count && i < 8; i++) {
    const p = at + i * size;
    if (type === 1 || type === 6 || type === 7) out.push(view.getUint8(p));
    else if (type === 3) out.push(view.getUint16(p, le));
    else if (type === 4 || type === 9) out.push(view.getUint32(p, le));
    else if (type === 5 || type === 10) {
      const n = view.getUint32(p, le);
      const d = view.getUint32(p + 4, le);
      out.push(d ? n / d : 0);
    } else return null;
  }
  return out;
}

function toDegrees(v) {
  if (!Array.isArray(v) || v.length < 3) return null;
  return v[0] + v[1] / 60 + v[2] / 3600;
}

// tiffStart is the byte offset of the "II"/"MM" byte-order marker.
export function parseTiff(view, tiffStart) {
  const found = [];
  if (tiffStart + 8 > view.byteLength) return found;

  const b0 = view.getUint8(tiffStart);
  const b1 = view.getUint8(tiffStart + 1);
  const le = b0 === 0x49 && b1 === 0x49;
  const be = b0 === 0x4d && b1 === 0x4d;
  if (!le && !be) return found;

  const gps = {};

  const walk = (ifdOffset, kind, depth) => {
    if (depth > 3 || ifdOffset + 2 > view.byteLength) return;
    const count = view.getUint16(ifdOffset, le);
    if (count > 512) return;

    for (let i = 0; i < count; i++) {
      const entry = ifdOffset + 2 + i * 12;
      if (entry + 12 > view.byteLength) return;
      const tag = view.getUint16(entry, le);
      const type = view.getUint16(entry + 2, le);
      const num = view.getUint32(entry + 4, le);

      if (tag === 0x8769 || tag === 0x8825) {
        walk(tiffStart + view.getUint32(entry + 8, le), tag === 0x8825 ? 'gps' : 'exif', depth + 1);
        continue;
      }

      const name = kind === 'gps' ? GPS_TAGS[tag] : TAGS[tag];
      if (!name) continue;
      const value = readValue(view, entry + 8, type, num, le, tiffStart);
      if (value === null || value === '') continue;
      if (kind === 'gps') gps[tag] = value;
      else found.push({ label: name, value: Array.isArray(value) ? value.join(', ') : String(value) });
    }

    const next = view.getUint32(ifdOffset + 2 + count * 12, le);
    if (next) walk(tiffStart + next, kind, depth + 1);
  };

  try {
    walk(tiffStart + view.getUint32(tiffStart + 4, le), 'ifd0', 0);
  } catch {
    return found;
  }

  const lat = toDegrees(gps[0x0002]);
  const lon = toDegrees(gps[0x0004]);
  if (lat != null && lon != null) {
    const latSign = gps[0x0001] === 'S' ? -1 : 1;
    const lonSign = gps[0x0003] === 'W' ? -1 : 1;
    found.unshift({
      label: 'GPS location',
      value: `${(lat * latSign).toFixed(6)}, ${(lon * lonSign).toFixed(6)}`,
      critical: true,
    });
  }
  if (gps[0x0006] != null) {
    found.push({ label: 'GPS altitude', value: `${Number(gps[0x0006]).toFixed(1)} m`, critical: true });
  }
  return found;
}
