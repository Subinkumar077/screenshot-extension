// Viewport capture + area cropping.

import { ErrorCode, ShotError, toShotError } from './errors.js';
import {
  LIMITS,
  cropBitmapToPng,
  cropRectToBitmap,
  dataUrlToBitmap,
} from './image-processing.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// chrome.tabs.captureVisibleTab is limited to ~2 calls per second.
const MIN_INTERVAL_MS = 600;
let lastCaptureAt = 0;

const isRetryable = (e) =>
  /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota|tabs cannot be edited right now/i.test(String((e && e.message) || e));

/** Captures the visible part of the active tab as a PNG data URL (throttled, with retry). */
export async function captureVisibleTab(windowId) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCaptureAt);
    if (wait > 0) await sleep(wait);
    lastCaptureAt = Date.now();
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      if (!dataUrl || dataUrl.length < 100) {
        throw new ShotError(ErrorCode.CAPTURE_FAILED, 'The browser returned an empty screenshot.');
      }
      return dataUrl;
    } catch (e) {
      lastErr = e;
      if (isRetryable(e) && attempt < 3) {
        await sleep(700);
        continue;
      }
      break;
    }
  }
  throw toShotError(lastErr);
}

/**
 * Captures the viewport and crops it to `rect` (CSS px, viewport coordinates).
 * The scale between CSS pixels and screenshot pixels is measured from the
 * returned bitmap, so devicePixelRatio and browser zoom are handled together.
 */
export async function captureArea({ windowId, rect, vw, vh }) {
  if (!rect || !(rect.w >= LIMITS.MIN_SELECTION) || !(rect.h >= LIMITS.MIN_SELECTION)) {
    throw new ShotError(ErrorCode.TOO_SMALL, 'That selection is too small. Drag a larger area and try again.');
  }
  const dataUrl = await captureVisibleTab(windowId);
  const bitmap = await dataUrlToBitmap(dataUrl);
  try {
    const crop = cropRectToBitmap(rect, vw, vh, bitmap.width, bitmap.height);
    if (crop.sw < 2 || crop.sh < 2) {
      throw new ShotError(ErrorCode.TOO_SMALL, 'That selection is too small. Drag a larger area and try again.');
    }
    const blob = await cropBitmapToPng(bitmap, crop);
    return { blob, width: crop.sw, height: crop.sh };
  } finally {
    bitmap.close();
  }
}
