import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import ffprobePath from 'ffprobe-static';
import { parseTiff } from './exif.js';

const run = promisify(execFile);
const FFPROBE = ffprobePath.path;

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.heic', '.heif', '.avif', '.bmp']);

export function kindOf(file) {
  return IMAGE_EXT.has(path.extname(file).toLowerCase()) ? 'image' : 'video';
}

function isJpeg(buf) {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
}
function isPng(buf) {
  return buf.length > 8 && buf.toString('latin1', 1, 4) === 'PNG';
}

// Walk JPEG marker segments, reporting every metadata block we can name.
function inspectJpeg(buf) {
  const items = [];
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) break;
    const marker = buf[pos + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break; // image data starts
    const len = buf.readUInt16BE(pos + 2);
    const body = buf.subarray(pos + 4, pos + 2 + len);
    const head = body.toString('latin1', 0, 30);

    if (marker === 0xe1 && head.startsWith('Exif\0')) {
      const { found } = parseTiff(body, 6) || { found: [] };
      if (found.length) items.push(...found);
      else items.push({ label: 'EXIF block', value: `${len} bytes` });
    } else if (marker === 0xe1 && head.includes('ns.adobe.com/xap')) {
      items.push({ label: 'XMP metadata', value: `${len} bytes (editing history, author)` });
    } else if (marker === 0xe2 && head.startsWith('ICC_PROFILE')) {
      items.push({ label: 'ICC colour profile', value: `${len} bytes` });
    } else if (marker === 0xed) {
      items.push({ label: 'IPTC / Photoshop data', value: `${len} bytes`, critical: true });
    } else if (marker === 0xfe) {
      items.push({ label: 'Comment', value: body.toString('latin1').slice(0, 120) });
    }
    pos += 2 + len;
  }
  return items;
}

const PNG_META_CHUNKS = { tEXt: 'Text', zTXt: 'Compressed text', iTXt: 'International text', eXIf: 'EXIF', tIME: 'Last modified', pHYs: 'Physical dimensions' };

function inspectPng(buf) {
  const items = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (type === 'IEND') break;
    if (PNG_META_CHUNKS[type]) {
      const body = buf.subarray(pos + 8, pos + 8 + len);
      if (type === 'eXIf') {
        const { found } = parseTiff(body, 0) || { found: [] };
        items.push(...(found.length ? found : [{ label: 'EXIF chunk', value: `${len} bytes` }]));
      } else if (type === 'tEXt' || type === 'iTXt') {
        const text = body.toString('latin1').replace(/\0+/g, ': ').slice(0, 120);
        items.push({ label: PNG_META_CHUNKS[type], value: text });
      } else {
        items.push({ label: PNG_META_CHUNKS[type], value: `${len} bytes` });
      }
    }
    pos += 12 + len;
    if (len < 0 || pos > buf.length) break;
  }
  return items;
}

async function inspectWithFfprobe(file) {
  const items = [];
  try {
    const { stdout } = await run(FFPROBE, [
      '-v', 'quiet', '-print_format', 'json',
      '-show_format', '-show_streams', '-show_chapters', file,
    ], { maxBuffer: 1024 * 1024 * 16 });
    const data = JSON.parse(stdout);
    // Container format fields, not metadata — they name the file type, not its origin.
    const STRUCTURAL = new Set(['major_brand', 'minor_version', 'compatible_brands', 'duration']);
    const push = (tags, prefix) => {
      for (const [k, v] of Object.entries(tags || {})) {
        if (!v || String(v).trim() === '') continue;
        const key = k.toLowerCase();
        if (STRUCTURAL.has(key)) continue;
        if (key === 'language' && String(v) === 'und') continue;
        const critical = /location|gps|make|model|device|serial|artist|author|owner|album_artist/.test(key);
        items.push({ label: prefix ? `${prefix} — ${k}` : k, value: String(v).slice(0, 160), critical });
      }
    };
    push(data.format?.tags, '');
    for (const s of data.streams || []) push(s.tags, `${s.codec_type} stream`);
    if (data.chapters?.length) items.push({ label: 'Chapters', value: `${data.chapters.length} chapter markers` });
  } catch { /* unreadable by ffprobe — leave list empty */ }
  return items;
}

export async function inspect(file) {
  const buf = await fs.readFile(file, { length: 512 * 1024 }).catch(() => null);
  const head = buf || Buffer.alloc(0);
  let items = [];
  if (isJpeg(head)) items = inspectJpeg(await fs.readFile(file));
  else if (isPng(head)) items = inspectPng(await fs.readFile(file));
  else items = await inspectWithFfprobe(file);
  return items;
}
