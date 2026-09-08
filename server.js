import express from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inspect, kindOf } from './lib/meta.js';
import { strip } from './lib/strip.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(__dirname, 'work');
const YTDLP = path.join(
  __dirname, 'node_modules', 'youtube-dl-exec', 'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);
const PORT = 5320;

await fs.mkdir(WORK, { recursive: true });

const items = new Map();   // id -> file record
const jobs = new Map();    // jobId -> { events, done, listeners }

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, WORK),
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname) || '.bin'}`),
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
});

function safeName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 120) || 'file';
}

async function register(srcPath, displayName) {
  const id = randomUUID();
  const stat = await fs.stat(srcPath);
  const item = {
    id,
    name: safeName(displayName),
    srcPath,
    size: stat.size,
    kind: kindOf(displayName),
    before: await inspect(srcPath),
    after: null,
    cleanPath: null,
    mode: null,
  };
  items.set(id, item);
  return item;
}

function publicItem(it) {
  return {
    id: it.id,
    name: it.name,
    size: it.size,
    kind: it.kind,
    before: it.before,
    after: it.after,
    mode: it.mode,
    cleanSize: it.cleanSize ?? null,
  };
}

app.post('/api/upload', upload.array('files', 40), async (req, res) => {
  try {
    const out = [];
    for (const f of req.files || []) out.push(publicItem(await register(f.path, f.originalname)));
    res.json({ items: out });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// --- Link download (yt-dlp), progress streamed over SSE ---------------------

function emit(job, event) {
  job.events.push(event);
  for (const send of job.listeners) send(event);
}

app.post('/api/fetch', (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'That does not look like an http(s) link.' });
  }
  const jobId = randomUUID();
  const job = { events: [], done: false, listeners: new Set() };
  jobs.set(jobId, job);
  res.json({ jobId });

  const dir = path.join(WORK, jobId);
  fsSync.mkdirSync(dir, { recursive: true });

  const args = [
    url,
    '-o', path.join(dir, '%(title).80s.%(ext)s'),
    '--no-playlist',
    '--newline',
    '--no-warnings',
    '-f', 'bv*+ba/b',
    '--merge-output-format', 'mp4',
  ];
  if (req.body?.cookiesFrom) args.push('--cookies-from-browser', String(req.body.cookiesFrom));

  const child = spawn(YTDLP, args, { windowsHide: true });
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m) emit(job, { type: 'progress', percent: Number(m[1]) });
      else if (line.trim()) emit(job, { type: 'log', message: line.trim() });
    }
  });
  child.stderr.on('data', (c) => { stderr += String(c); });
  child.on('error', (err) => {
    emit(job, { type: 'error', message: String(err.message || err) });
    job.done = true;
  });

  child.on('close', async (code) => {
    try {
      if (code !== 0) {
        throw new Error(stderr.split('\n').filter(Boolean).pop() || `yt-dlp exited with code ${code}`);
      }
      const files = (await fs.readdir(dir)).filter((f) => !f.endsWith('.part'));
      if (!files.length) throw new Error('Nothing was downloaded.');
      const out = [];
      for (const f of files) out.push(publicItem(await register(path.join(dir, f), f)));
      emit(job, { type: 'done', items: out });
    } catch (err) {
      emit(job, { type: 'error', message: String(err.message || err) });
    }
    job.done = true;
  });
});

app.get('/api/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event) => res.write('data: ' + JSON.stringify(event) + '\n\n');
  job.events.forEach(send);
  if (job.done) return res.end();
  job.listeners.add(send);
  req.on('close', () => job.listeners.delete(send));
});

// --- Strip and download -----------------------------------------------------

app.post('/api/clean', async (req, res) => {
  const it = items.get(String(req.body?.id));
  if (!it) return res.status(404).json({ error: 'Unknown file.' });
  try {
    const ext = path.extname(it.name) || '.bin';
    const base = path.basename(it.name, ext);
    it.cleanPath = path.join(WORK, `${it.id}-clean${ext}`);
    it.mode = await strip(it.srcPath, it.cleanPath);
    it.after = await inspect(it.cleanPath);
    it.cleanSize = (await fs.stat(it.cleanPath)).size;
    it.cleanName = `${base}-clean${ext}`;
    res.json(publicItem(it));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/download/:id', (req, res) => {
  const it = items.get(req.params.id);
  if (!it || !it.cleanPath) return res.status(404).end();
  res.download(it.cleanPath, it.cleanName || it.name);
});

app.post('/api/clear', async (_req, res) => {
  items.clear();
  jobs.clear();
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  res.json({ ok: true });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Scrub running at http://localhost:${PORT}`);
});
