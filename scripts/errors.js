// Shared error types and friendly-message mapping.
// Used by the service worker, the popup and the preview page.

export const ErrorCode = Object.freeze({
  RESTRICTED: 'RESTRICTED',
  FILE_ACCESS: 'FILE_ACCESS',
  NO_PERMISSION: 'NO_PERMISSION',
  CAPTURE_FAILED: 'CAPTURE_FAILED',
  TOO_SMALL: 'TOO_SMALL',
  TOO_LARGE: 'TOO_LARGE',
  NAVIGATED: 'NAVIGATED',
  TAB_CHANGED: 'TAB_CHANGED',
  CANCELLED: 'CANCELLED',
  BUSY: 'BUSY',
  STORAGE: 'STORAGE',
  UNKNOWN: 'UNKNOWN',
});

export class ShotError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'ShotError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

const RESTRICTED_PROTOCOLS = new Set([
  'chrome:',
  'chrome-extension:',
  'chrome-search:',
  'chrome-untrusted:',
  'edge:',
  'brave:',
  'about:',
  'view-source:',
  'devtools:',
  'moz-extension:',
]);

const RESTRICTED_HOSTS = [
  { host: 'chromewebstore.google.com' },
  { host: 'chrome.google.com', pathPrefix: '/webstore' },
  { host: 'microsoftedge.microsoft.com', pathPrefix: '/addons' },
];

export const RESTRICTED_MESSAGE =
  'Browsers do not allow extensions to capture this kind of page (browser pages, the extension store and similar). Open a regular website and try again.';

export const FILE_ACCESS_MESSAGE =
  'To capture local files, open the extension’s details page and turn on “Allow access to file URLs”.';

/** True when extensions cannot be injected into / capture this URL. */
export function isRestrictedUrl(url) {
  if (!url) return true;
  let u;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (RESTRICTED_PROTOCOLS.has(u.protocol)) return true;
  return RESTRICTED_HOSTS.some(
    (r) => u.hostname === r.host && (!r.pathPrefix || u.pathname.startsWith(r.pathPrefix))
  );
}

export function isFileUrl(url) {
  return typeof url === 'string' && url.startsWith('file:');
}

/** Turns anything thrown by Chrome APIs into a ShotError with a readable message. */
export function toShotError(err, ctx = {}) {
  if (err instanceof ShotError) return err;
  const raw = String((err && err.message) || err || '');

  if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(raw)) {
    return new ShotError(
      ErrorCode.CAPTURE_FAILED,
      'The browser is limiting how fast screenshots can be taken. Please try again in a moment.',
      err
    );
  }
  if (/no tab with id|tab was closed|frame with id .* was removed|the tab was closed/i.test(raw)) {
    return new ShotError(ErrorCode.NAVIGATED, 'The tab was closed or navigated away during the capture.', err);
  }
  if (/cannot access contents of (the )?(url|page)|cannot be scripted|extensions gallery|cannot access a chrome|cannot access .*:\/\//i.test(raw)) {
    if (isFileUrl(ctx.url) || /file:\/\//i.test(raw)) {
      return new ShotError(ErrorCode.FILE_ACCESS, FILE_ACCESS_MESSAGE, err);
    }
    return new ShotError(ErrorCode.RESTRICTED, RESTRICTED_MESSAGE, err);
  }
  if (/activeTab|permission is not in effect|manifest must request permission|not allowed to access/i.test(raw)) {
    return new ShotError(
      ErrorCode.NO_PERMISSION,
      'Snapshot needs you to click its toolbar icon on this tab first. Click the icon and try again.',
      err
    );
  }
  if (/tabs cannot be edited right now|dragging/i.test(raw)) {
    return new ShotError(ErrorCode.CAPTURE_FAILED, 'The browser is busy (a tab is being dragged). Try again.', err);
  }
  if (/image readback failed|failed to capture|cannot capture|capture.*(blocked|failed)/i.test(raw)) {
    return new ShotError(
      ErrorCode.CAPTURE_FAILED,
      'The browser blocked the screenshot of this page. Make sure the window is visible and not minimised, then try again.',
      err
    );
  }
  return new ShotError(ErrorCode.UNKNOWN, raw || 'Something went wrong while taking the screenshot.', err);
}

/** Plain-object form that survives chrome.runtime messaging. */
export function serializeError(err) {
  const e = toShotError(err);
  return { code: e.code, message: e.message };
}
