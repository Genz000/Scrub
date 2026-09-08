const $ = (sel) => document.querySelector(sel);

const list = $('#list');
const results = $('#results');
const tpl = $('#card-tpl');
const fetchStatus = $('#fetch-status');
const cards = new Map(); // id -> { el, data }

function bytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function setStatus(text, kind) {
  fetchStatus.hidden = false;
  fetchStatus.className = `status${kind === 'error' ? ' error' : ''}`;
  fetchStatus.textContent = text;
}

function setProgress(percent) {
  fetchStatus.hidden = false;
  fetchStatus.className = 'status';
  fetchStatus.innerHTML = '';
  const label = document.createElement('div');
  label.textContent = `Downloading — ${percent.toFixed(0)}%`;
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  fill.style.width = `${percent}%`;
  bar.append(fill);
  fetchStatus.append(label, bar);
}

function renderTags(container, tags, emptyText) {
  container.innerHTML = '';
  if (!tags || !tags.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = emptyText;
    container.append(p);
    return;
  }
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
  container.append(wrap);
}

function render(data) {
  let entry = cards.get(data.id);
  if (!entry) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    list.append(el);
    entry = { el };
    cards.set(data.id, entry);
  }
  entry.data = data;
  const { el } = entry;

  const ext = (data.name.split('.').pop() || '').slice(0, 4);
  el.querySelector('.badge').textContent = ext;
  el.querySelector('.name').textContent = data.name;

  const meta = el.querySelector('.meta');
  const actions = el.querySelector('.card-actions');
  actions.innerHTML = '';

  if (!data.after) {
    const count = data.before.length;
    el.querySelector('.sub').textContent =
      `${bytes(data.size)} · ${count ? `${count} metadata ${count === 1 ? 'entry' : 'entries'} found` : 'no metadata found'}`;

    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Strip';
    btn.addEventListener('click', () => clean(data.id, btn));
    actions.append(btn);

    const title = document.createElement('p');
    title.className = 'meta-title';
    title.textContent = 'Currently embedded';
    meta.innerHTML = '';
    meta.append(title);
    const box = document.createElement('div');
    renderTags(box, data.before, 'Nothing readable found — it will still be re-written clean.');
    meta.append(box);
  } else {
    el.querySelector('.sub').textContent =
      `${bytes(data.cleanSize)} · ${data.mode === 'lossless' ? 'lossless rewrite' : 'stream copy, no re-encode'}`;

    const a = document.createElement('button');
    a.className = 'primary';
    a.textContent = 'Download clean file';
    a.addEventListener('click', () => { window.location.href = `/api/download/${data.id}`; });
    actions.append(a);

    meta.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'clean-note';
    const removed = data.before.length - data.after.length;
    note.textContent = data.after.length === 0
      ? `Clean — ${data.before.length} ${data.before.length === 1 ? 'entry' : 'entries'} removed, none remaining.`
      : `${removed} removed, ${data.after.length} remaining (see below).`;
    meta.append(note);

    if (data.after.length) {
      const title = document.createElement('p');
      title.className = 'meta-title';
      title.style.marginTop = '12px';
      title.textContent = 'Still present';
      const box = document.createElement('div');
      renderTags(box, data.after, '');
      meta.append(title, box);
    }
  }
  results.hidden = false;
}

async function clean(id, btn) {
  btn.disabled = true;
  btn.textContent = 'Stripping…';
  try {
    const res = await fetch('/api/clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    render(data);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Strip';
    setStatus(`Could not strip that file: ${err.message}`, 'error');
  }
}

// --- input: files ------------------------------------------------------------

const drop = $('#drop');
const fileInput = $('#file-input');

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) sendFiles(fileInput.files);
  fileInput.value = '';
});

for (const evt of ['dragenter', 'dragover']) {
  drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.add('over'); });
}
for (const evt of ['dragleave', 'drop']) {
  drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.remove('over'); });
}
drop.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) sendFiles(e.dataTransfer.files);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

async function sendFiles(files) {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  setStatus(`Reading ${files.length} file${files.length === 1 ? '' : 's'}…`);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    data.items.forEach(render);
    fetchStatus.hidden = true;
  } catch (err) {
    setStatus(`Upload failed: ${err.message}`, 'error');
  }
}

// --- input: link -------------------------------------------------------------

const linkForm = $('#link-form');
const fetchBtn = $('#fetch-btn');

linkForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#url').value.trim();
  if (!url) return;
  fetchBtn.disabled = true;
  fetchBtn.textContent = 'Fetching…';
  setStatus('Contacting the site…');

  try {
    const res = await fetch('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, cookiesFrom: $('#cookies-from').value || undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    listen(data.jobId);
  } catch (err) {
    setStatus(err.message, 'error');
    resetFetchBtn();
  }
});

function resetFetchBtn() {
  fetchBtn.disabled = false;
  fetchBtn.textContent = 'Fetch';
}

function listen(jobId) {
  const source = new EventSource(`/api/progress/${jobId}`);
  source.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'progress') setProgress(ev.percent);
    else if (ev.type === 'log') setStatus(ev.message);
    else if (ev.type === 'done') {
      source.close();
      resetFetchBtn();
      $('#url').value = '';
      fetchStatus.hidden = true;
      ev.items.forEach(render);
    } else if (ev.type === 'error') {
      source.close();
      resetFetchBtn();
      setStatus(ev.message, 'error');
    }
  };
  source.onerror = () => { source.close(); resetFetchBtn(); };
}

// --- bulk actions ------------------------------------------------------------

$('#clean-all').addEventListener('click', async () => {
  for (const [id, entry] of cards) {
    if (entry.data.after) continue;
    const btn = entry.el.querySelector('.card-actions button');
    if (btn) await clean(id, btn);
  }
});

$('#clear-all').addEventListener('click', async () => {
  await fetch('/api/clear', { method: 'POST' });
  cards.clear();
  list.innerHTML = '';
  results.hidden = true;
  fetchStatus.hidden = true;
});
