const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const IMG = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i;
const COMPRESSIBLE = /\.(jpe?g|png|webp|bmp)$/i;
const TRASH = '_Recently Deleted';
const INDEX = '_index.json';
const DAY = 86400000;
const fmt = n => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB';

let root, trashDir, trashIndex = {}, files = [], idx = 0, pending = [], history = [], curUrl = null, urls = [];

/* ---------- helpers ---------- */
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3500);
}
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('swipecleaner', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kvGet(k) {
  try { const db = await idb(); return await new Promise(res => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); }
  catch { return null; }
}
async function kvSet(k, v) {
  const db = await idb();
  return new Promise(res => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); });
}
async function exists(dir, name) { try { await dir.getFileHandle(name); return true; } catch { return false; } }
async function uniqueName(dir, name) {
  if (!(await exists(dir, name))) return name;
  const i = name.lastIndexOf('.'), b = i > 0 ? name.slice(0, i) : name, e = i > 0 ? name.slice(i) : '';
  for (let n = 1; ; n++) { const c = `${b} (${n})${e}`; if (!(await exists(dir, c))) return c; }
}
async function writeFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); await w.write(data); await w.close();
  return fh;
}

/* ---------- folder + scanning ---------- */
async function scan(dir, path, out) {
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'directory') {
      if (name === TRASH || name.startsWith('.')) continue;
      await scan(h, [...path, name], out);
    } else if (IMG.test(name)) {
      const f = await h.getFile();
      out.push({ name, handle: h, dir, path, size: f.size, modified: f.lastModified });
    }
  }
}
async function loadTrash() {
  trashDir = await root.getDirectoryHandle(TRASH, { create: true });
  try { trashIndex = JSON.parse(await (await (await trashDir.getFileHandle(INDEX)).getFile()).text()); } catch { trashIndex = {}; }
  const present = new Set();
  for await (const [name, h] of trashDir.entries()) {
    if (h.kind === 'file' && name !== INDEX) {
      present.add(name);
      if (!trashIndex[name]) trashIndex[name] = { orig: name, path: [], date: (await h.getFile()).lastModified };
    }
  }
  for (const k of Object.keys(trashIndex)) if (!present.has(k)) delete trashIndex[k];
  await saveIndex();
}
const saveIndex = () => writeFile(trashDir, INDEX, JSON.stringify(trashIndex));

async function init() {
  $('#welcome').classList.add('hidden');
  $('#tabs').classList.remove('hidden');
  toast('Scanning folder…');
  await loadTrash();
  const out = []; await scan(root, [], out);
  out.sort((a, b) => b.modified - a.modified);
  files = out; idx = 0; pending = []; history = [];
  updateBadges(); switchTab('swipe'); showCurrent();
  toast(`Found ${files.length} photos`);
}
async function chooseFolder() {
  try {
    root = await showDirectoryPicker({ mode: 'readwrite', startIn: 'pictures' });
    await kvSet('root', root); await init();
  } catch (e) { if (e.name !== 'AbortError') toast('Could not open folder: ' + e.message); }
}
async function tryResume() {
  const h = await kvGet('root'); if (!h) return;
  const b = $('#btnResume'); b.textContent = `Reopen "${h.name}"`; b.classList.remove('hidden');
  b.onclick = async () => {
    if ((await h.requestPermission({ mode: 'readwrite' })) === 'granted') { root = h; await init(); }
    else toast('Permission denied');
  };
}

/* ---------- tabs ---------- */
function switchTab(name) {
  $$('.tab').forEach(t => t.classList.add('hidden'));
  $('#tab-' + name).classList.remove('hidden');
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'pending') renderPending();
  if (name === 'trash') renderTrash();
  if (name === 'compress') renderCompressStats();
}
function updateBadges() {
  $('#bPending').textContent = pending.length;
  $('#bTrash').textContent = Object.keys(trashIndex).length;
}

/* ---------- swipe ---------- */
const card = $('#card');
async function showCurrent() {
  if (curUrl) { URL.revokeObjectURL(curUrl); curUrl = null; }
  const item = files[idx];
  $('#count').textContent = `${Math.min(idx, files.length)} / ${files.length} reviewed`;
  if (!item) { $('#stage').classList.add('hidden'); $('.controls').classList.add('hidden'); $('#meta').textContent = ''; $('#done').classList.remove('hidden'); return; }
  $('#done').classList.add('hidden'); $('#stage').classList.remove('hidden'); $('.controls').classList.remove('hidden');
  const f = await item.handle.getFile();
  if (files[idx] !== item) return;
  curUrl = URL.createObjectURL(f);
  const img = $('#photo'); img.style.display = ''; $('#nopreview').style.display = 'none';
  img.src = curUrl;
  $('#meta').textContent = `${[...item.path, item.name].join('\\')} · ${fmt(item.size)}`;
  resetCard(true);
}
$('#photo').onerror = () => { $('#photo').style.display = 'none'; $('#nopreview').style.display = 'block'; };

function keep() { const it = files[idx]; if (!it) return; history.push({ item: it, deleted: false }); idx++; showCurrent(); }
function mark() { const it = files[idx]; if (!it) return; pending.push(it); history.push({ item: it, deleted: true }); idx++; updateBadges(); showCurrent(); }
function undo() {
  const h = history.pop(); if (!h) return;
  if (h.deleted) pending = pending.filter(p => p !== h.item);
  idx = Math.max(0, idx - 1); updateBadges(); showCurrent();
}
function drag(dx) {
  card.style.transform = `translateX(${dx}px) rotate(${dx / 25}deg)`;
  $('#lblKeep').style.opacity = dx > 40 ? 1 : 0; $('#lblDel').style.opacity = dx < -40 ? 1 : 0;
}
function resetCard(instant) {
  card.style.transition = instant ? 'none' : 'transform .2s';
  card.style.transform = ''; $('#lblKeep').style.opacity = 0; $('#lblDel').style.opacity = 0;
}
function fly(dir) {
  if (!files[idx]) return;
  card.style.transition = 'transform .2s';
  card.style.transform = `translateX(${dir * 900}px) rotate(${dir * 20}deg)`;
  setTimeout(() => { dir > 0 ? keep() : mark(); }, 180);
}
let sx = null;
card.addEventListener('pointerdown', e => { sx = e.clientX; card.setPointerCapture(e.pointerId); card.style.transition = 'none'; });
card.addEventListener('pointermove', e => { if (sx !== null) drag(e.clientX - sx); });
card.addEventListener('pointerup', e => {
  if (sx === null) return;
  const dx = e.clientX - sx; sx = null;
  if (dx > 120) fly(1); else if (dx < -120) fly(-1); else resetCard();
});
$('#btnDel').onclick = () => fly(-1);
$('#btnKeep').onclick = () => fly(1);
$('#btnUndo').onclick = undo;
document.addEventListener('keydown', e => {
  if ($('#tab-swipe').classList.contains('hidden')) return;
  if (e.key === 'ArrowLeft') fly(-1);
  else if (e.key === 'ArrowRight') fly(1);
  else if (e.key.toLowerCase() === 'z') undo();
});

/* ---------- To Delete ---------- */
function clearUrls() { urls.forEach(URL.revokeObjectURL); urls = []; }
function thumb(file, label) {
  const d = document.createElement('div'); d.className = 'thumb';
  const img = new Image(); img.loading = 'lazy'; img.decoding = 'async';
  const u = URL.createObjectURL(file); urls.push(u); img.src = u;
  d.append(img);
  if (label) { const c = document.createElement('div'); c.className = 'cap'; c.textContent = label; d.append(c); }
  return d;
}
async function renderPending() {
  clearUrls();
  const g = $('#pendingGrid'); g.innerHTML = '';
  for (const it of pending) {
    const d = thumb(await it.handle.getFile(), `${it.name} · ${fmt(it.size)}`);
    d.onclick = () => { pending = pending.filter(p => p !== it); updateBadges(); renderPending(); };
    g.append(d);
  }
  $('#btnCommit').disabled = !pending.length;
  $('#btnCommit').textContent = `Move ${pending.length} to Recently Deleted`;
}
async function moveToTrash(item) {
  const file = await item.handle.getFile();
  const tname = await uniqueName(trashDir, item.name);
  await writeFile(trashDir, tname, file);
  await item.dir.removeEntry(item.name);
  trashIndex[tname] = { orig: item.name, path: item.path, date: Date.now() };
  await saveIndex();
}
$('#btnCommit').onclick = async () => {
  const btn = $('#btnCommit'); btn.disabled = true;
  const nextItem = files[idx]; let n = 0;
  for (const it of [...pending]) {
    try { await moveToTrash(it); files = files.filter(f => f !== it); pending = pending.filter(p => p !== it); n++; }
    catch (e) { console.error(it.name, e); }
  }
  idx = nextItem ? files.indexOf(nextItem) : files.length; history = [];
  updateBadges(); renderPending(); showCurrent();
  toast(`Moved ${n} photos to Recently Deleted`);
};

/* ---------- Recently Deleted ---------- */
async function renderTrash() {
  clearUrls();
  const g = $('#trashGrid'); g.innerHTML = '';
  const entries = Object.entries(trashIndex).sort((a, b) => b[1].date - a[1].date);
  if (!entries.length) g.innerHTML = '<p class="note">Nothing here.</p>';
  for (const [tname, meta] of entries) {
    let file; try { file = await (await trashDir.getFileHandle(tname)).getFile(); } catch { continue; }
    const left = Math.max(0, 30 - Math.floor((Date.now() - meta.date) / DAY));
    const d = thumb(file, `${meta.orig} · ${left}d left`);
    d.style.cursor = 'default';
    const acts = document.createElement('div'); acts.className = 'acts';
    const r = document.createElement('button'); r.textContent = 'Restore';
    r.onclick = async () => { await restore(tname); renderTrash(); };
    const x = document.createElement('button'); x.textContent = 'Delete'; x.className = 'x';
    x.onclick = async () => { if (confirm('Permanently delete this photo?')) { await purge(tname); renderTrash(); } };
    acts.append(r, x); d.append(acts); g.append(d);
  }
}
async function restore(tname) {
  const meta = trashIndex[tname];
  let d = root; for (const p of meta.path) d = await d.getDirectoryHandle(p, { create: true });
  const name = await uniqueName(d, meta.orig);
  const file = await (await trashDir.getFileHandle(tname)).getFile();
  const fh = await writeFile(d, name, file);
  await trashDir.removeEntry(tname); delete trashIndex[tname]; await saveIndex();
  files.push({ name, handle: fh, dir: d, path: meta.path, size: file.size, modified: Date.now() });
  updateBadges(); toast('Restored ' + name);
}
async function purge(tname) {
  try { await trashDir.removeEntry(tname); } catch {}
  delete trashIndex[tname]; await saveIndex(); updateBadges();
}
$('#btnOld').onclick = async () => {
  const old = Object.keys(trashIndex).filter(k => Date.now() - trashIndex[k].date > 30 * DAY);
  if (!old.length) return toast('No items older than 30 days');
  if (!confirm(`Permanently delete ${old.length} items?`)) return;
  for (const k of old) await purge(k); renderTrash();
};
$('#btnEmpty').onclick = async () => {
  const all = Object.keys(trashIndex); if (!all.length) return;
  if (!confirm(`Permanently delete all ${all.length} items? This cannot be undone.`)) return;
  for (const k of all) await purge(k); renderTrash();
};

/* ---------- Compress ---------- */
const candidates = () => files.filter(f => COMPRESSIBLE.test(f.name) && f.size > 1.5e6 && !pending.includes(f));
function renderCompressStats() {
  const c = candidates();
  $('#cStats').textContent = `${c.length} photos over 1.5 MB (${fmt(c.reduce((s, f) => s + f.size, 0))} total).`;
}
$('#q').oninput = () => { $('#qv').textContent = $('#q').value; };
$('#btnCompress').onclick = async () => {
  const q = +$('#q').value / 100, maxDim = +$('#maxdim').value;
  const list = candidates();
  if (!list.length) return toast('Nothing to compress');
  const btn = $('#btnCompress'), prog = $('#prog'); btn.disabled = true; prog.classList.remove('hidden');
  let saved = 0, changed = 0, done = 0;
  for (const it of list) {
    let moved = false;
    try {
      const file = await it.handle.getFile();
      const bmp = await createImageBitmap(file);
      const s = maxDim ? Math.min(1, maxDim / Math.max(bmp.width, bmp.height)) : 1;
      const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
      const cv = new OffscreenCanvas(w, h), ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h); bmp.close();
      const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: q });
      if (blob.size < file.size * 0.9) {
        await moveToTrash(it); moved = true;
        const name = await uniqueName(it.dir, it.name.replace(/\.[^.]+$/, '') + '.jpg');
        const fh = await writeFile(it.dir, name, blob);
        saved += file.size - blob.size; changed++;
        Object.assign(it, { handle: fh, name, size: blob.size });
      }
    } catch (e) { console.error(it.name, e); if (moved) files = files.filter(f => f !== it); }
    prog.value = ++done / list.length;
  }
  btn.disabled = false; prog.classList.add('hidden');
  $('#cResult').textContent = `Compressed ${changed} photos and saved ${fmt(saved)}. Originals are in Recently Deleted.`;
  updateBadges(); renderCompressStats();
};

/* ---------- wiring ---------- */
$$('#tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
$('#btnPick').onclick = chooseFolder;
$('#btnFolder').onclick = chooseFolder;
tryResume();
