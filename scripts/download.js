// Saves a PNG blob through the browser's normal download flow.

const pad = (n) => String(n).padStart(2, '0');

/** e.g. Snapshot_full-page_example.com_2026-11-06_09-18-33.png */
export function buildFilename({ kind, host, date = new Date() }) {
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  const label = kind === 'fullpage' ? 'full-page' : 'area';
  const safeHost = String(host || '')
    .replace(/[^a-z0-9.-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return ['Snapshot', label, safeHost, stamp].filter(Boolean).join('_') + '.png';
}

function anchorDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Starts the download and waits until the browser reports success or failure.
 * Object URLs are revoked afterwards so memory is released.
 */
export async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const revokeLater = (ms) => setTimeout(() => URL.revokeObjectURL(url), ms);

  if (!chrome.downloads || !chrome.downloads.download) {
    anchorDownload(url, filename);
    revokeLater(30000);
    return;
  }

  try {
    const id = await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
    if (id === undefined) throw new Error('The browser did not start the download.');

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(done, 20000); // very large files: assume it is in progress
      function done(err) {
        clearTimeout(timeout);
        chrome.downloads.onChanged.removeListener(onChanged);
        err ? reject(err) : resolve();
      }
      function onChanged(delta) {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === 'complete') done();
        else if (delta.state.current === 'interrupted') {
          done(new Error('The download was interrupted. Check your download settings and free disk space.'));
        }
      }
      chrome.downloads.onChanged.addListener(onChanged);
      // The download may already have finished before the listener attached.
      chrome.downloads.search({ id }, (items) => {
        const item = items && items[0];
        if (!item) return;
        if (item.state === 'complete') done();
        else if (item.state === 'interrupted') done(new Error('The download was interrupted.'));
      });
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/invalid filename|filename/i.test(msg)) {
      throw new Error('The browser rejected the file name. Try again.');
    }
    throw new Error(msg || 'The download failed.');
  } finally {
    revokeLater(5000);
  }
}
