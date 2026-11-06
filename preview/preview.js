import { deleteShot, getShot } from '../scripts/storage.js';
import { copyImageBlob } from '../scripts/clipboard.js';
import { buildFilename, downloadBlob } from '../scripts/download.js';
import {
  hasLensConsent,
  openLensHome,
  rememberLensConsent,
  searchWithGoogleLens,
} from '../scripts/visual-search.js';

const $ = (id) => document.getElementById(id);
const els = {
  meta: $('meta'),
  kind: $('meta-kind'),
  dims: $('meta-dims'),
  size: $('meta-size'),
  host: $('meta-host'),
  note: $('note'),
  loading: $('loading'),
  empty: $('empty'),
  emptyTitle: $('empty-title'),
  emptyText: $('empty-text'),
  shot: $('shot'),
  zoom: $('btn-zoom'),
  zoomLabel: $('zoom-label'),
  copy: $('btn-copy'),
  save: $('btn-save'),
  search: $('btn-search'),
  close: $('btn-close'),
  toasts: $('toasts'),
  consent: $('consent'),
  consentRemember: $('consent-remember'),
};

let record = null;
let objectUrl = null;
let fitClass = 'fit';
let actualSize = false;

// ---------------------------------------------------------------- helpers

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function toast(message, { type = '', duration = 3200, action } = {}) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const span = document.createElement('span');
  span.textContent = message;
  t.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      action.onClick();
      remove();
    });
    t.appendChild(b);
  }
  els.toasts.appendChild(t);
  const timer = setTimeout(remove, duration);
  function remove() {
    clearTimeout(timer);
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 220);
  }
}

function setBusy(btn, busy, busyLabel) {
  const label = btn.querySelector('.label');
  if (busy) {
    btn.dataset.label = label.textContent;
    btn.disabled = true;
    if (busyLabel) label.textContent = busyLabel;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) label.textContent = btn.dataset.label;
  }
}

function flashDone(btn, text) {
  const label = btn.querySelector('.label');
  const original = btn.dataset.label || label.textContent;
  btn.classList.add('done');
  label.textContent = text;
  setTimeout(() => {
    btn.classList.remove('done');
    label.textContent = original;
  }, 1800);
}

function showEmpty(title, text) {
  els.loading.hidden = true;
  els.shot.hidden = true;
  els.zoom.hidden = true;
  els.emptyTitle.textContent = title;
  els.emptyText.textContent = text;
  els.empty.hidden = false;
}

// ---------------------------------------------------------------- zoom

function applyZoom() {
  els.shot.classList.remove('fit', 'fit-width', 'actual');
  els.shot.classList.add(actualSize ? 'actual' : fitClass);
  els.zoomLabel.textContent = actualSize ? (record.kind === 'fullpage' ? 'Fit width' : 'Fit') : '100%';
}

function toggleZoom() {
  actualSize = !actualSize;
  applyZoom();
}

// ---------------------------------------------------------------- actions

async function onCopy() {
  if (!record) return;
  setBusy(els.copy, true, 'Copying…');
  try {
    await copyImageBlob(record.blob);
    setBusy(els.copy, false);
    flashDone(els.copy, 'Copied!');
    toast('Image copied to the clipboard.', { type: 'success' });
  } catch (e) {
    setBusy(els.copy, false);
    toast(e.message, { type: 'error', duration: 6000 });
  }
}

async function onSave() {
  if (!record) return;
  setBusy(els.save, true, 'Saving…');
  try {
    const filename = buildFilename({ kind: record.kind, host: record.host });
    await downloadBlob(record.blob, filename);
    setBusy(els.save, false);
    flashDone(els.save, 'Saved!');
    toast(`Saved as ${filename}`, { type: 'success', duration: 4500 });
  } catch (e) {
    setBusy(els.save, false);
    toast(e.message, { type: 'error', duration: 6000 });
  }
}

async function runVisualSearch() {
  setBusy(els.search, true, 'Opening…');
  // Best effort: lets the user paste into Lens if the upload does not return results.
  let copied = false;
  try {
    await copyImageBlob(record.blob);
    copied = true;
  } catch {
    /* clipboard is only a fallback here */
  }
  try {
    await searchWithGoogleLens(record.blob);
    toast(
      copied
        ? 'Sent to Google Lens. No results? Press Ctrl/⌘+V on the Lens page.'
        : 'Sent to Google Lens in a new tab.',
      { duration: 7000, action: { label: 'Open Lens', onClick: openLensHome } }
    );
  } catch (e) {
    toast(`Visual Search failed: ${e.message || 'unknown error'}`, {
      type: 'error',
      duration: 8000,
      action: { label: 'Open Lens', onClick: openLensHome },
    });
  } finally {
    setBusy(els.search, false);
  }
}

function onSearch() {
  if (!record || record.kind !== 'area') return;
  if (hasLensConsent()) {
    runVisualSearch();
  } else {
    els.consent.showModal();
  }
}

els.consent.addEventListener('close', () => {
  if (els.consent.returnValue !== 'ok') return;
  if (els.consentRemember.checked) rememberLensConsent();
  runVisualSearch();
});

async function onClose() {
  try {
    if (record) await deleteShot(record.id);
  } catch {
    /* cleanup is best effort */
  }
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab && tab.id != null) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch {
    /* fall through */
  }
  window.close();
}

// ---------------------------------------------------------------- boot

async function init() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    showEmpty('Nothing to show', 'Open a screenshot from the Snapshot toolbar icon.');
    return;
  }

  try {
    record = await getShot(id);
  } catch {
    showEmpty('Could not read the screenshot', 'Local storage is unavailable. Take a new screenshot and try again.');
    return;
  }
  if (!record || !record.blob) {
    showEmpty(
      'Screenshot not available',
      'Previews are only kept for a short time (or you already closed this one). Take a new screenshot from the toolbar icon.'
    );
    return;
  }

  objectUrl = URL.createObjectURL(record.blob);
  fitClass = record.kind === 'fullpage' ? 'fit-width' : 'fit';

  els.shot.addEventListener(
    'load',
    () => {
      els.loading.hidden = true;
      els.shot.hidden = false;
      els.zoom.hidden = false;
      applyZoom();
      els.copy.disabled = false;
      els.save.disabled = false;
      els.search.disabled = false;
    },
    { once: true }
  );
  els.shot.addEventListener(
    'error',
    () => showEmpty('The image could not be displayed', 'The screenshot data looks damaged. Please capture again.'),
    { once: true }
  );
  els.shot.src = objectUrl;

  els.kind.textContent = record.kind === 'fullpage' ? 'Full page' : 'Area';
  els.dims.textContent = `${record.width} × ${record.height} px`;
  els.size.textContent = formatBytes(record.bytes || record.blob.size);
  if (record.host) {
    els.host.textContent = record.host;
    els.host.title = record.pageTitle || record.host;
    els.host.hidden = false;
  }
  els.meta.hidden = false;
  els.search.hidden = record.kind !== 'area';

  if (record.note) {
    els.note.textContent = record.note;
    els.note.hidden = false;
  }
  document.title = `Snapshot – ${record.host || 'preview'}`;
}

els.copy.addEventListener('click', onCopy);
els.save.addEventListener('click', onSave);
els.search.addEventListener('click', onSearch);
els.close.addEventListener('click', onClose);
els.zoom.addEventListener('click', toggleZoom);
els.shot.addEventListener('click', () => {
  if (!els.shot.hidden) toggleZoom();
});

document.addEventListener('keydown', (e) => {
  if (els.consent.open) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (!els.save.disabled) onSave();
  } else if (mod && e.key.toLowerCase() === 'c' && !String(window.getSelection() || '')) {
    e.preventDefault();
    if (!els.copy.disabled) onCopy();
  } else if (e.key === 'Escape') {
    onClose();
  }
});

// Release the object URL when the tab goes away.
window.addEventListener('pagehide', () => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});

init();
