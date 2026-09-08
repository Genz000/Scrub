import { inspect, strip, detect } from './lib/formats.js';

const $ = (sel) => document.querySelector(sel);
const list = $('#list');
const results = $('#results');
const tpl = $('#card-tpl');
const entries = new Map();
let seq = 0;

function bytesLabel(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const UNSUPPORTED_NOTE = {
  heic: 'HEIC and AVIF store the picture inside the same box as the metadata, so stripping them safely needs ffmpeg.',
  null: 'This format is not one the browser version can rewrite safely.',
};

function renderTags(host, tags) {
  const wrap = document.createElement('div');
  wrap.className = 'tags';
  for (const t of tags.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = `tag${t.critical ? ' critical' : ''}`;
    const b = document.createElement('b');
    b.textContent = t.label;
    const s = document.createElement('span');
    s.textContent = t.value;
    row.append(b, s);
    wrap.append(row);
  }
  if (tags.length > 12) {
    const more = document.createElement('div');
    more.className = 'tag more';
    more.textContent = `+ ${tags.length - 12} more`;
    wrap.append(more);
  }
  host.append(wrap);
}

function render(entry) {
  const { el, state } = entry;
  const ext = (state.name.split('.').pop() || '?').slice(0, 4);
  el.querySelector('.badge').textContent = ext;
  el.querySelector('.name').textContent = state.name;

  const actions = el.querySelector('.card-actions');
  const meta = el.querySelector('.meta');
  actions.innerHTML = '';
  meta.innerHTML = '';

  if (state.unsupported) {
    el.querySelector('.sub').textContent = `${bytesLabel(state.size)} · not supported here`;
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = UNSUPPORTED_NOTE[state.format] || UNSUPPORTED_NOTE.null;
    meta.append(p);
    return;
  }

  if (!state.cleaned) {
    const n = state.before.length;
    el.querySelector('.sub').textContent =
      `${bytesLabel(state.size)} · ${n ? `${n} metadata ${n === 1 ? 'entry' : 'entries'} found` : 'no metadata found'}`;

    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Strip';
    btn.addEventListener('click', () => clean(entry, btn));
    actions.append(btn);

    const title = document.createElement('p');
    title.className = 'meta-title';
    title.textContent = 'Currently embedded';
    meta.append(title);
    if (state.before.length) renderTags(meta, state.before);
    else {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'Nothing readable found. Stripping still rewrites it clean.';
      meta.append(p);
    }
    return;
  }

  el.querySelector('.sub').textContent = `${bytesLabel(state.cleanSize)} · ${state.note}`;

  const dl = document.createElement('button');
  dl.className = 'primary';
  dl.textContent = 'Download clean file';
  dl.addEventListener('click', () => download(state));
  actions.append(dl);

  const note = document.createElement('div');
  note.className = 'clean-note';
  const removed = state.before.length - state.after.length;
  note.textContent = state.after.length === 0
    ? `Clean — ${state.before.length} ${state.before.length === 1 ? 'entry' : 'entries'} removed, none remaining.`
    : `${removed} removed, ${state.after.length} remaining.`;
  meta.append(note);

  if (state.after.length) {
    const title = document.createElement('p');
    title.className = 'meta-title';
    title.style.marginTop = '12px';
    title.textContent = 'Still present';
    meta.append(title);
    renderTags(meta, state.after);
  }
}

function clean(entry, btn) {
  const { state } = entry;
  btn.disabled = true;
  btn.textContent = 'Stripping…';
  // Yield once so the button repaints before the synchronous work starts.
  setTimeout(() => {
    try {
      const { bytes, note } = strip(state.bytes);
      state.clean = bytes;
      state.cleanSize = bytes.length;
      state.note = note;
      state.after = inspect(bytes).items || [];
      state.cleaned = true;
      render(entry);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Strip';
      const p = document.createElement('p');
      p.className = 'empty error';
      p.textContent = `Could not strip this file: ${err.message}`;
      entry.el.querySelector('.meta').append(p);
    }
  }, 16);
}

function download(state) {
  const dot = state.name.lastIndexOf('.');
  const base = dot > 0 ? state.name.slice(0, dot) : state.name;
  const ext = dot > 0 ? state.name.slice(dot) : '';
  const blob = new Blob([state.clean], { type: state.type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${base}-clean${ext}`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function addFiles(files) {
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { format, items } = inspect(bytes);
    const el = tpl.content.firstElementChild.cloneNode(true);
    list.append(el);
    const entry = {
      el,
      state: {
        id: ++seq,
        name: file.name,
        size: file.size,
        type: file.type,
        bytes,
        format,
        before: items || [],
        unsupported: items === null,
        cleaned: false,
      },
    };
    entries.set(entry.state.id, entry);
    render(entry);
    results.hidden = false;
  }
}

// --- input -------------------------------------------------------------------

const drop = $('#drop');
const fileInput = $('#file-input');

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) addFiles(fileInput.files);
  fileInput.value = '';
});

for (const evt of ['dragenter', 'dragover']) {
  drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.add('over'); });
}
for (const evt of ['dragleave', 'drop']) {
  drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.remove('over'); });
}
drop.addEventListener('drop', (e) => {
  if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('#clean-all').addEventListener('click', () => {
  for (const entry of entries.values()) {
    if (entry.state.cleaned || entry.state.unsupported) continue;
    const btn = entry.el.querySelector('.card-actions button');
    if (btn) clean(entry, btn);
  }
});

$('#clear-all').addEventListener('click', () => {
  entries.clear();
  list.innerHTML = '';
  results.hidden = true;
});
