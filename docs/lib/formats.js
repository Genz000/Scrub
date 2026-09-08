import { parseTiff } from './exif.js';

const td = new TextDecoder('latin1');

function str(bytes, at, len) {
  return td.decode(bytes.subarray(at, at + len));
}

export function detect(bytes) {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (str(bytes, 1, 3) === 'PNG') return 'png';
  if (str(bytes, 0, 4) === 'RIFF' && str(bytes, 8, 4) === 'WEBP') return 'webp';
  if (str(bytes, 4, 4) === 'ftyp') {
    const brand = str(bytes, 8, 4);
    // HEIC/AVIF are also ISO-BMFF, but there the `meta` box carries the image itself
    // rather than metadata, so the MP4 path would destroy the file.
    if (/^(heic|heix|hevc|mif1|msf1|avif|avis)/.test(brand)) return 'heic';
    return 'mp4';
  }
  return null;
}

// --- JPEG -------------------------------------------------------------------

function walkJpeg(bytes, onSegment) {
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) break;
    const marker = bytes[pos + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      onSegment(marker, pos, 2, null);
      pos += 2;
      continue;
    }
    if (marker === 0xda) { onSegment(marker, pos, bytes.length - pos, null); return; }
    if (marker === 0xd9) return;
    const len = (bytes[pos + 2] << 8) | bytes[pos + 3];
    onSegment(marker, pos, 2 + len, bytes.subarray(pos + 4, pos + 2 + len));
    pos += 2 + len;
  }
}

function inspectJpeg(bytes) {
  const items = [];
  walkJpeg(bytes, (marker, _pos, size, body) => {
    if (!body) return;
    const head = str(body, 0, Math.min(30, body.length));
    if (marker === 0xe1 && head.startsWith('Exif\0')) {
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      const found = parseTiff(view, 6);
      if (found.length) items.push(...found);
      else items.push({ label: 'EXIF block', value: `${size} bytes` });
    } else if (marker === 0xe1 && head.includes('ns.adobe.com/xap')) {
      items.push({ label: 'XMP metadata', value: `${size} bytes (editing history, author)` });
    } else if (marker === 0xe2 && head.startsWith('ICC_PROFILE')) {
      items.push({ label: 'ICC colour profile', value: `${size} bytes` });
    } else if (marker === 0xed) {
      items.push({ label: 'IPTC / Photoshop data', value: `${size} bytes`, critical: true });
    } else if (marker === 0xfe) {
      items.push({ label: 'Comment', value: td.decode(body).slice(0, 120) });
    }
  });
  return items;
}

function stripJpeg(bytes) {
  const keep = [];
  walkJpeg(bytes, (marker, pos, size) => {
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) keep.push(bytes.subarray(pos, pos + size));
  });
  return concat([bytes.subarray(0, 2), ...keep]);
}

// --- PNG --------------------------------------------------------------------

const PNG_META = {
  tEXt: 'Text', zTXt: 'Compressed text', iTXt: 'International text',
  eXIf: 'EXIF', tIME: 'Last modified', pHYs: 'Physical dimensions',
};

function walkPng(bytes, onChunk) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos);
    const type = str(bytes, pos + 4, 4);
    const end = pos + 12 + len;
    if (end > bytes.length) break;
    onChunk(type, pos, end, bytes.subarray(pos + 8, pos + 8 + len));
    if (type === 'IEND') return;
    pos = end;
  }
}

function inspectPng(bytes) {
  const items = [];
  walkPng(bytes, (type, _s, _e, body) => {
    if (!PNG_META[type]) return;
    if (type === 'eXIf') {
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      const found = parseTiff(view, 0);
      items.push(...(found.length ? found : [{ label: 'EXIF chunk', value: `${body.length} bytes` }]));
    } else if (type === 'tEXt' || type === 'iTXt') {
      items.push({ label: PNG_META[type], value: td.decode(body).replace(/\0+/g, ': ').slice(0, 120) });
    } else {
      items.push({ label: PNG_META[type], value: `${body.length} bytes` });
    }
  });
  return items;
}

function stripPng(bytes) {
  const drop = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'pHYs', 'sPLT', 'hIST']);
  const keep = [bytes.subarray(0, 8)];
  walkPng(bytes, (type, start, end) => {
    if (!drop.has(type)) keep.push(bytes.subarray(start, end));
  });
  return concat(keep);
}

// --- WebP (RIFF) ------------------------------------------------------------

function walkWebp(bytes, onChunk) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const type = str(bytes, pos, 4);
    const len = view.getUint32(pos + 4, true);
    const padded = len + (len % 2); // RIFF chunks are word-aligned
    const end = pos + 8 + padded;
    if (end > bytes.length) break;
    onChunk(type, pos, end, bytes.subarray(pos + 8, pos + 8 + len));
    pos = end;
  }
}

function inspectWebp(bytes) {
  const items = [];
  walkWebp(bytes, (type, _s, _e, body) => {
    if (type === 'EXIF') {
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      const found = parseTiff(view, 0);
      items.push(...(found.length ? found : [{ label: 'EXIF chunk', value: `${body.length} bytes` }]));
    } else if (type === 'XMP ') {
      items.push({ label: 'XMP metadata', value: `${body.length} bytes` });
    } else if (type === 'ICCP') {
      items.push({ label: 'ICC colour profile', value: `${body.length} bytes` });
    }
  });
  return items;
}

function stripWebp(bytes) {
  const drop = new Set(['EXIF', 'XMP ', 'ICCP']);
  const keep = [];
  walkWebp(bytes, (type, start, end) => {
    if (!drop.has(type)) keep.push(bytes.subarray(start, end));
  });
  const body = concat(keep);
  const out = new Uint8Array(12 + body.length);
  out.set(bytes.subarray(0, 12));
  out.set(body, 12);
  // RIFF size counts everything after the first 8 bytes.
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

// --- MP4 / MOV (ISO base media) ---------------------------------------------

const MP4_CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'udta', 'ilst',
]);
const MP4_EPOCH_OFFSET = 2082844800; // seconds between 1904-01-01 and 1970-01-01

// Video sample entries carry a 32-byte "compressorname" field, where encoders write
// their own name and version. Its offset within the entry is fixed by the spec.
const VIDEO_SAMPLE_ENTRIES = new Set([
  'avc1', 'avc3', 'hvc1', 'hev1', 'mp4v', 'av01', 'vp08', 'vp09', 's263', 'dvav', 'dvhe',
]);
const COMPRESSORNAME_OFFSET = 50;
const COMPRESSORNAME_LENGTH = 32;

// stsd is a full box: version/flags(4) and entry_count(4) before the sample entries.
function eachSampleEntry(bytes, view, stsd, fn) {
  let pos = stsd.contentStart + 8;
  while (pos + 8 <= stsd.end) {
    const size = view.getUint32(pos);
    const type = str(bytes, pos + 4, 4);
    if (size < 8 || pos + size > stsd.end) return;
    if (VIDEO_SAMPLE_ENTRIES.has(type) && pos + COMPRESSORNAME_OFFSET + COMPRESSORNAME_LENGTH <= pos + size) {
      fn(pos + COMPRESSORNAME_OFFSET);
    }
    pos += size;
  }
}

function readCompressorName(bytes, at) {
  // A Pascal-style string: one length byte, then the characters.
  const len = Math.min(bytes[at], COMPRESSORNAME_LENGTH - 1);
  return len ? td.decode(bytes.subarray(at + 1, at + 1 + len)).trim() : '';
}

function walkMp4(bytes, view, start, end, parent, visit) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = str(bytes, pos + 4, 4);
    let header = 8;
    if (size === 1) {
      // 64-bit size: the high word is always 0 for files a browser can hold.
      size = view.getUint32(pos + 8) * 4294967296 + view.getUint32(pos + 12);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) return;

    visit({ type, start: pos, end: pos + size, contentStart: pos + header, parent });

    if (MP4_CONTAINERS.has(type)) {
      walkMp4(bytes, view, pos + header, pos + size, type, visit);
    } else if (type === 'meta') {
      // `meta` is a full box: 4 bytes of version/flags before its children.
      walkMp4(bytes, view, pos + header + 4, pos + size, type, visit);
    }
    pos += size;
  }
}

function readTimes(view, box) {
  const version = view.getUint8(box.contentStart);
  const at = box.contentStart + 4;
  const created = version === 1
    ? view.getUint32(at + 4) // low word is plenty for real dates
    : view.getUint32(at);
  return created;
}

function mp4Date(seconds) {
  if (!seconds) return null;
  const d = new Date((seconds - MP4_EPOCH_OFFSET) * 1000);
  if (isNaN(d) || d.getFullYear() < 1990 || d.getFullYear() > 2100) return null;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function inspectMp4(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const items = [];
  const seen = new Set();

  walkMp4(bytes, view, 0, bytes.length, null, (box) => {
    if (box.type === 'mvhd') {
      const when = mp4Date(readTimes(view, box));
      if (when) items.push({ label: 'Recorded', value: when, critical: true });
    }
    if (box.type === 'stsd') {
      eachSampleEntry(bytes, view, box, (at) => {
        const name = readCompressorName(bytes, at);
        if (name && !seen.has('enc:' + name)) {
          seen.add('enc:' + name);
          items.push({ label: 'Encoder name', value: name });
        }
      });
      return;
    }
    if (box.type === 'hdlr') {
      const name = str(bytes, box.contentStart + 24, box.end - box.contentStart - 24).replace(/\0/g, '').trim();
      if (name && !seen.has('hdlr:' + name)) {
        seen.add('hdlr:' + name);
        items.push({ label: 'Track handler name', value: name });
      }
    }
    // 3GPP location box: version/flags(4), language(2), a null-terminated name,
    // then role(1) and 16.16 fixed-point longitude, latitude, altitude.
    if (box.type === 'loci') {
      let p = box.contentStart + 6;
      while (p < box.end && bytes[p] !== 0) p++;
      p += 1 + 1;
      if (p + 8 <= box.end) {
        const lon = view.getInt32(p) / 65536;
        const lat = view.getInt32(p + 4) / 65536;
        items.push({
          label: 'GPS location',
          value: `${lat.toFixed(6)}, ${lon.toFixed(6)}`,
          critical: true,
        });
      }
      return;
    }

    // ©-prefixed atoms carry location, make, model and author. They sit either
    // directly in udta (2-byte size + 2-byte language, then text) or inside
    // meta/ilst, where the text is wrapped in a `data` box with a 16-byte header.
    if (box.parent === 'udta' || box.parent === 'ilst') {
      if (MP4_CONTAINERS.has(box.type) || box.type === 'meta') return;
      const skip = box.parent === 'ilst' ? 16 : 4;
      const raw = bytes.subarray(Math.min(box.contentStart + skip, box.end), box.end);
      const text = td.decode(raw).replace(/[\x00-\x1f]+/g, ' ').trim();
      if (!text || text.length > 200) return;

      const key = box.type.replace(/\xa9/g, '');
      const labels = {
        xyz: 'GPS location', mak: 'Camera make', mod: 'Camera model',
        swr: 'Software', nam: 'Title', ART: 'Artist', cmt: 'Comment',
        day: 'Date', too: 'Encoder', des: 'Description', albm: 'Album',
        auth: 'Author', gps: 'GPS location',
      };
      const label = labels[key] || `Tag "${key}"`;
      if (seen.has(label + text)) return;
      seen.add(label + text);
      items.push({ label, value: text, critical: /GPS|Camera|Artist|Author/.test(label) });
    }
  });
  return items;
}

// Metadata boxes are overwritten in place with zero-filled `free` boxes of the same
// size. MP4 sample tables reference absolute file offsets, so removing bytes outright
// would desynchronise them and break playback; padding keeps every offset valid.
function stripMp4(bytes) {
  const out = bytes.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const nuke = [];

  walkMp4(out, view, 0, out.length, null, (box) => {
    if (box.type === 'udta' || (box.type === 'meta' && (box.parent === 'moov' || box.parent === 'trak'))) {
      nuke.push(box);
    } else if (box.type === 'stsd') {
      eachSampleEntry(out, view, box, (at) => out.fill(0, at, at + COMPRESSORNAME_LENGTH));
    } else if (box.type === 'hdlr') {
      out.fill(0, box.contentStart + 24, box.end);
    } else if (box.type === 'mvhd' || box.type === 'tkhd' || box.type === 'mdhd') {
      const version = view.getUint8(box.contentStart);
      const at = box.contentStart + 4;
      out.fill(0, at, at + (version === 1 ? 16 : 8)); // creation + modification times
    }
  });

  // Outermost first, so a nested box inside one already blanked is simply covered.
  for (const box of nuke) {
    if (box.end - box.start < 8) continue;
    out.fill(0, box.start, box.end);
    view.setUint32(box.start, box.end - box.start);
    out.set([0x66, 0x72, 0x65, 0x65], box.start + 4); // "free"
  }
  return out;
}

// --- shared -----------------------------------------------------------------

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const HANDLERS = {
  jpeg: { inspect: inspectJpeg, strip: stripJpeg, note: 'lossless rewrite' },
  png: { inspect: inspectPng, strip: stripPng, note: 'lossless rewrite' },
  webp: { inspect: inspectWebp, strip: stripWebp, note: 'lossless rewrite' },
  mp4: { inspect: inspectMp4, strip: stripMp4, note: 'in-place, streams untouched' },
};

export const SUPPORTED = Object.keys(HANDLERS);

export function inspect(bytes) {
  const format = detect(bytes);
  const handler = HANDLERS[format];
  if (!handler) return { format, items: null };
  try {
    return { format, items: handler.inspect(bytes) };
  } catch {
    return { format, items: [] };
  }
}

export function strip(bytes) {
  const format = detect(bytes);
  const handler = HANDLERS[format];
  if (!handler) throw new Error('unsupported format');
  return { bytes: handler.strip(bytes), note: handler.note };
}
