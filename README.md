# Scrub

Strips metadata from images and video. Runs entirely on your own machine — nothing is
uploaded anywhere, and the only outbound connection is the one that fetches a link you paste.

## Setup

Node 18 or newer. There is nothing to install system-wide — ffmpeg and yt-dlp both arrive as
npm packages.

```bash
YOUTUBE_DL_SKIP_PYTHON_CHECK=1 npm install
```

That flag is needed because the yt-dlp npm wrapper looks for Python during install. The
Windows and macOS yt-dlp builds it downloads are self-contained and never call Python, so
skipping the check is safe. On Windows PowerShell:

```powershell
$env:YOUTUBE_DL_SKIP_PYTHON_CHECK=1; npm install
```

Then:

```bash
npm start
```

and open http://localhost:5320

## Two ways in

**Paste a link.** Handled by yt-dlp, which supports Facebook, Instagram, TikTok, X,
YouTube, Reddit and around a thousand other sites. Public posts work directly. For a
private or login-only video, open the "Video is private or login-only?" section and pick a
browser — yt-dlp then reuses that browser's session cookies, so it can see exactly what you
can see. Close the browser first; Chrome locks its cookie database while running.

**Drop files.** Photos and videos straight from disk, up to 40 at a time.

Either way you see what the file currently carries — GPS coordinates, camera make and model,
serial numbers, software, author, timestamps — then hit Strip and download the clean copy.

## How the stripping works

Nothing is re-encoded, so quality is never touched.

- **JPEG** — the file is rebuilt from its image segments alone, dropping every APP marker
  (EXIF, XMP, ICC, IPTC/Photoshop) and comments. Pixel data is copied verbatim.
- **PNG** — metadata chunks (`tEXt`, `zTXt`, `iTXt`, `eXIf`, `tIME`, `pHYs`) are removed and
  the rest of the chunks pass through untouched.
- **Video and everything else** — ffmpeg with `-c copy`, so the audio and video streams are
  copied bit for bit while container tags, per-stream tags, chapters and handler names are
  cleared.

Verified on the fixtures: the cleaned JPEG and PNG decode to pixel-identical output, and the
cleaned MP4's video stream has the same MD5 as the original.

One thing that cannot be removed: after processing, MKV files carry `encoder=Lavf`, because
Matroska requires a writing-application field. It identifies the tool, not you.

## What this does not do

Metadata is not the only way a file identifies its source. Watermarks, a platform's own
re-encoding fingerprints, and the visible content itself all survive stripping. Scrub removes
the embedded tags, which is the part that leaks your location, device and name.

## Layout

- `server.js` — HTTP API and yt-dlp process handling
- `lib/exif.js` — TIFF/EXIF reader, including GPS coordinate conversion
- `lib/meta.js` — inspects a file and reports what it carries
- `lib/strip.js` — the removal logic
- `public/` — the interface

Working files land in `work/` and are wiped by the Clear button.
