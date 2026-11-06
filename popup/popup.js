import { isFileUrl, isRestrictedUrl, RESTRICTED_MESSAGE, FILE_ACCESS_MESSAGE } from '../scripts/errors.js';

const $ = (id) => document.getElementById(id);
const btnArea = $('btn-area');
const btnFull = $('btn-full');
const btnCancel = $('btn-cancel');
const notice = $('notice');
const viewActions = $('view-actions');
const viewProgress = $('view-progress');
const progressText = $('progress-text');
const progressFill = $('progress-fill');
const progressBar = $('progress-bar');

let tab = null;

function showNotice(message, isError = true) {
  notice.textContent = message;
  notice.classList.toggle('error', isError);
  notice.hidden = false;
}

function setCardsDisabled(disabled) {
  btnArea.disabled = disabled;
  btnFull.disabled = disabled;
}

function showProgress(percent, text) {
  viewActions.hidden = true;
  viewProgress.hidden = false;
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  progressFill.style.width = `${p}%`;
  progressBar.setAttribute('aria-valuenow', String(p));
  if (text) progressText.textContent = text;
}

function showActions() {
  viewProgress.hidden = true;
  viewActions.hidden = false;
  btnCancel.disabled = false;
}

async function send(message) {
  try {
    const res = await chrome.runtime.sendMessage(message);
    return res || { ok: false, error: { message: 'The extension did not respond. Please try again.' } };
  } catch {
    return { ok: false, error: { message: 'The extension did not respond. Please try again.' } };
  }
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) {
    showNotice('No active tab was found.');
    setCardsDisabled(true);
    return;
  }

  if (isRestrictedUrl(tab.url)) {
    showNotice(RESTRICTED_MESSAGE);
    setCardsDisabled(true);
    return;
  }
  if (isFileUrl(tab.url)) {
    const allowed = await new Promise((resolve) => {
      try {
        chrome.extension.isAllowedFileSchemeAccess(resolve);
      } catch {
        resolve(false);
      }
    });
    if (!allowed) {
      showNotice(FILE_ACCESS_MESSAGE);
      setCardsDisabled(true);
      return;
    }
  }

  // If a full-page capture is already running on this tab, show its progress.
  const status = await send({ type: 'GET_STATUS', tabId: tab.id });
  if (status.ok && status.job) showProgress(status.job.percent, status.job.text);
}

btnArea.addEventListener('click', async () => {
  setCardsDisabled(true);
  notice.hidden = true;
  const res = await send({ type: 'START_AREA', tabId: tab.id });
  if (res.ok) {
    window.close(); // the page is now in selection mode
    return;
  }
  showNotice(res.error.message);
  setCardsDisabled(false);
});

btnFull.addEventListener('click', async () => {
  setCardsDisabled(true);
  notice.hidden = true;
  showProgress(0, 'Starting…');
  const res = await send({ type: 'START_FULLPAGE', tabId: tab.id });
  if (!res.ok) {
    showActions();
    showNotice(res.error.message);
    setCardsDisabled(false);
  }
});

btnCancel.addEventListener('click', async () => {
  btnCancel.disabled = true;
  progressText.textContent = 'Cancelling…';
  await send({ type: 'CANCEL', tabId: tab.id });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!tab || !msg || msg.tabId !== tab.id) return;
  if (msg.type === 'PROGRESS') {
    showProgress(msg.percent, msg.text);
  } else if (msg.type === 'JOB_DONE') {
    window.close();
  } else if (msg.type === 'JOB_FAILED') {
    showActions();
    setCardsDisabled(false);
    if (msg.error && msg.error.code !== 'CANCELLED') showNotice(msg.error.message);
  }
});

init();
