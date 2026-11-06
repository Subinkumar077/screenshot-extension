// Service worker (Manifest V3, ES module). Coordinates the popup, the page
// overlay and the preview page. Nothing here talks to the network.
//
//   popup  --START_AREA / START_FULLPAGE / CANCEL / GET_STATUS-->  background
//   content --AREA_CAPTURE {rect,vw,vh}-->                         background
//   background --PROGRESS / JOB_DONE / JOB_FAILED-->               popup
//   background --(IndexedDB blob + tab)-->                         preview page

import { captureArea } from './scripts/capture.js';
import { captureFullPage } from './scripts/fullpage.js';
import {
  ErrorCode,
  ShotError,
  isFileUrl,
  isRestrictedUrl,
  RESTRICTED_MESSAGE,
  FILE_ACCESS_MESSAGE,
  serializeError,
  toShotError,
} from './scripts/errors.js';
import { newShotId, putShot, pruneShots } from './scripts/storage.js';

/** Running full-page jobs, keyed by tab id. */
const jobs = new Map();
let selectionCssPromise = null;

// ---------------------------------------------------------------- helpers

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new ShotError(ErrorCode.NAVIGATED, 'That tab is no longer available.');
  }
}

async function assertCapturable(tab) {
  if (isRestrictedUrl(tab.url)) throw new ShotError(ErrorCode.RESTRICTED, RESTRICTED_MESSAGE);
  if (isFileUrl(tab.url)) {
    const allowed = await new Promise((resolve) => {
      try {
        chrome.extension.isAllowedFileSchemeAccess(resolve);
      } catch {
        resolve(false);
      }
    });
    if (!allowed) throw new ShotError(ErrorCode.FILE_ACCESS, FILE_ACCESS_MESSAGE);
  }
}

async function openPreview({ blob, width, height, kind, tab, note }) {
  const id = newShotId();
  try {
    await putShot({
      id,
      blob,
      kind,
      width,
      height,
      bytes: blob.size,
      createdAt: Date.now(),
      host: hostOf(tab.url),
      pageTitle: tab.title || '',
      note: note || '',
    });
  } catch (e) {
    throw new ShotError(
      ErrorCode.STORAGE,
      'The screenshot could not be stored locally (is the disk full or private browsing blocking storage?).',
      e
    );
  }
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`preview/preview.html?id=${encodeURIComponent(id)}`),
    index: tab.index + 1,
    openerTabId: tab.id,
    active: true,
  });
  // Housekeeping: never let temporary screenshots pile up.
  pruneShots({ keep: 5, exceptId: id }).catch(() => {});
}

/** Shows a short error toast inside the page (used when no popup is open to display it). */
async function toastInPage(tabId, message) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [message],
      func: (msg) => {
        const host = document.createElement('div');
        host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;';
        const root = host.attachShadow({ mode: 'closed' });
        const box = document.createElement('div');
        box.textContent = msg;
        box.style.cssText =
          'font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#ffd9db;background:#2a1d24;' +
          'border:1px solid #e5484d;padding:10px 14px;border-radius:10px;max-width:340px;box-shadow:0 10px 30px rgba(0,0,0,.4)';
        root.appendChild(box);
        document.documentElement.appendChild(host);
        setTimeout(() => host.remove(), 6000);
      },
    });
  } catch {
    /* page not scriptable: badge still shows the failure */
  }
}

function broadcast(message) {
  // Rejects when the popup is closed; that is expected.
  chrome.runtime.sendMessage(message).catch(() => {});
}

function setBadge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

// ---------------------------------------------------------------- area capture

async function loadSelectionCss() {
  if (!selectionCssPromise) {
    selectionCssPromise = fetch(chrome.runtime.getURL('content/selection.css')).then((r) => r.text());
  }
  return selectionCssPromise;
}

async function startAreaSelection(tabId) {
  const tab = await getTab(tabId);
  await assertCapturable(tab);
  if (jobs.has(tabId)) throw new ShotError(ErrorCode.BUSY, 'A full-page capture is already running on this tab.');
  const css = await loadSelectionCss();
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [css],
      func: (cssText) => {
        window.__SX_CSS = cssText;
      },
    });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
  } catch (e) {
    throw toShotError(e, { url: tab.url });
  }
}

async function handleAreaCapture(msg, sender) {
  const tab = sender.tab;
  if (!tab) throw new ShotError(ErrorCode.UNKNOWN, 'No tab was associated with this request.');
  const fresh = await getTab(tab.id);
  if (!fresh.active) {
    throw new ShotError(ErrorCode.TAB_CHANGED, 'This tab is not visible any more. Switch back to it and try again.');
  }
  const { blob, width, height } = await captureArea({
    windowId: fresh.windowId,
    rect: msg.rect,
    vw: msg.vw,
    vh: msg.vh,
  });
  await openPreview({ blob, width, height, kind: 'area', tab: fresh });
}

// ---------------------------------------------------------------- full-page capture

function startFullPage(tabId) {
  if (jobs.has(tabId)) throw new ShotError(ErrorCode.BUSY, 'A full-page capture is already running on this tab.');
  const job = { tabId, percent: 0, text: 'Starting…', abort: null };
  jobs.set(tabId, job);
  runFullPage(job).catch(() => {});
}

async function runFullPage(job) {
  const { tabId } = job;
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);

  const onRemoved = (id) => {
    if (id === tabId) job.abort = new ShotError(ErrorCode.NAVIGATED, 'The tab was closed during the capture.');
  };
  const onUpdated = (id, info) => {
    if (id === tabId && info.url && !job.abort) {
      job.abort = new ShotError(ErrorCode.NAVIGATED, 'The page navigated away during the capture.');
    }
  };
  chrome.tabs.onRemoved.addListener(onRemoved);
  chrome.tabs.onUpdated.addListener(onUpdated);

  const progress = (percent, text) => {
    job.percent = percent;
    job.text = text;
    setBadge(tabId, `${Math.round(percent)}%`, '#4f5bff');
    broadcast({ type: 'PROGRESS', tabId, percent, text });
  };

  let tab;
  try {
    tab = await getTab(tabId);
    await assertCapturable(tab);
    const result = await captureFullPage(tab, { onProgress: progress, abortReason: () => job.abort });
    // The tab may have changed title/index while we worked.
    const latest = await chrome.tabs.get(tabId).catch(() => tab);
    await openPreview({ ...result, kind: 'fullpage', tab: latest });
    setBadge(tabId, '');
    broadcast({ type: 'JOB_DONE', tabId });
  } catch (e) {
    const err = toShotError(e, { url: tab && tab.url });
    if (err.code !== ErrorCode.CANCELLED) {
      setBadge(tabId, '!', '#e5484d');
      chrome.action.setTitle({ tabId, title: `Snapshot – ${err.message}` }).catch(() => {});
      setTimeout(() => {
        setBadge(tabId, '');
        chrome.action.setTitle({ tabId, title: 'Snapshot' }).catch(() => {});
      }, 10000);
      toastInPage(tabId, err.message);
    } else {
      setBadge(tabId, '');
    }
    broadcast({ type: 'JOB_FAILED', tabId, error: serializeError(err) });
  } finally {
    clearInterval(keepAlive);
    chrome.tabs.onRemoved.removeListener(onRemoved);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    jobs.delete(tabId);
  }
}

// ---------------------------------------------------------------- message router

async function handleMessage(msg, sender) {
  switch (msg && msg.type) {
    case 'START_AREA':
      await startAreaSelection(msg.tabId);
      return { ok: true };

    case 'AREA_CAPTURE':
      await handleAreaCapture(msg, sender);
      return { ok: true };

    case 'START_FULLPAGE': {
      const tab = await getTab(msg.tabId);
      await assertCapturable(tab);
      startFullPage(msg.tabId);
      return { ok: true };
    }

    case 'CANCEL': {
      const job = jobs.get(msg.tabId);
      if (job) job.abort = new ShotError(ErrorCode.CANCELLED, 'Capture cancelled.');
      return { ok: true };
    }

    case 'GET_STATUS': {
      const job = jobs.get(msg.tabId);
      return { ok: true, job: job ? { percent: job.percent, text: job.text } : null };
    }

    default:
      return undefined; // not for us (e.g. PROGRESS broadcasts)
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !['START_AREA', 'AREA_CAPTURE', 'START_FULLPAGE', 'CANCEL', 'GET_STATUS'].includes(msg.type)) {
    return false;
  }
  // Only our own extension pages / content scripts may drive the worker.
  if (sender.id !== chrome.runtime.id) return false;
  handleMessage(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: serializeError(e) }));
  return true; // async response
});
