import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

const run = promisify(execFile);

// JPEG: rebuild the file from its image segments only. Pixel data is untouched.
function stripJpeg(buf) {
  const out = [buf.subarray(0, 2)];
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) break;
    const marker = buf[pos + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(buf.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    if (marker === 0xda) { out.push(buf.subarray(pos)); return Buffer.concat(out); }
    const len = buf.readUInt16BE(pos + 2);
    const drop =
      (marker >= 0xe1 && marker <= 0xef) || // APP1..APP15: EXIF, XMP, ICC, IPTC
      marker === 0xfe;                       // COM: comments
    if (!drop) out.push(buf.subarray(pos, pos + 2 + len));
    pos += 2 + len;
  }
  return Buffer.concat(out);
}

const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'pHYs', 'sPLT', 'hIST']);

// PNG: copy every chunk except the metadata-bearing ones, then recompute nothing —
// PNG chunk CRCs are per-chunk, so removal stays valid.
function stripPng(buf) {
  const out = [buf.subarray(0, 8)];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + len;
    if (end > buf.length) break;
    if (!PNG_DROP.has(type)) out.push(buf.subarray(pos, end));
    if (type === 'IEND') break;
    pos = end;
  }
  return Buffer.concat(out);
}

async function stripWithFfmpeg(input, output) {
  const ext = path.extname(output).toLowerCase();
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-map', '0',
    '-map_metadata', '-1',
    '-map_metadata:s:v', '-1',   // per-stream tags survive a global wipe
    '-map_metadata:s:a', '-1',
    '-map_chapters', '-1',
    '-c', 'copy',
    '-fflags', '+bitexact',      // stops the muxer stamping its own encoder tag
  ];
  if (ext === '.mp4' || ext === '.m4v' || ext === '.mov') {
    // Blanks the "VideoHandler"/"SoundHandler" strings, which some devices
    // replace with a model or owner name.
    args.push('-movflags', '+faststart', '-empty_hdlr_name', '1');
  }
  args.push(output);
  try {
    await run(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 16 });
  } catch (err) {
    // Some containers refuse a straight stream copy (e.g. odd image formats).
    // Fall back to a re-encode, which still drops every tag.
    const fallback = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-map_metadata', '-1', output];
    await run(ffmpegPath, fallback, { maxBuffer: 1024 * 1024 * 16 });
  }
}

export async function strip(input, output) {
  const buf = await fs.readFile(input);
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const png = buf.toString('latin1', 1, 4) === 'PNG';

  if (jpeg) {
    await fs.writeFile(output, stripJpeg(buf));
    return 'lossless';
  }
  if (png) {
    await fs.writeFile(output, stripPng(buf));
    return 'lossless';
  }
  await stripWithFfmpeg(input, output);
  return 'stream copy';
}
