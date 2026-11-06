// Pure geometry helpers + Canvas helpers used for cropping and stitching.
// Everything here works in a service worker (OffscreenCanvas) and in pages.

import { ErrorCode, ShotError } from './errors.js';

export const LIMITS = Object.freeze({
  // Chrome/Edge/Brave cannot create a canvas bigger than 32,767 px per side.
  MAX_DIMENSION: 32767,
  // Conservative pixel budget (~400 MB of RGBA) so we do not exhaust memory.
  MAX_AREA: 100_000_000,
  // Never silently shrink a page below this fraction of its real resolution.
  MIN_OUTPUT_SCALE: 0.3,
  // Selections smaller than this (CSS px) are treated as accidental.
  MIN_SELECTION: 8,
});

/** Device pixels per CSS pixel actually delivered by captureVisibleTab. */
export function measureScale(bitmapWidth, viewportCssWidth) {
  if (!(bitmapWidth > 0) || !(viewportCssWidth > 0)) {
    throw new ShotError(ErrorCode.CAPTURE_FAILED, 'The browser returned an empty screenshot.');
  }
  return bitmapWidth / viewportCssWidth;
}

/**
 * Converts a selection in CSS pixels (viewport coordinates) to a source
 * rectangle in screenshot pixels. Works for any combination of devicePixelRatio
 * and browser zoom because the scale is measured from the real bitmap.
 */
export function cropRectToBitmap(rect, vw, vh, bmpW, bmpH) {
  const scaleX = bmpW / vw;
  const scaleY = bmpH / vh;
  let x1 = Math.round(rect.x * scaleX);
  let y1 = Math.round(rect.y * scaleY);
  let x2 = Math.round((rect.x + rect.w) * scaleX);
  let y2 = Math.round((rect.y + rect.h) * scaleY);
  x1 = Math.min(Math.max(x1, 0), bmpW);
  y1 = Math.min(Math.max(y1, 0), bmpH);
  x2 = Math.min(Math.max(x2, 0), bmpW);
  y2 = Math.min(Math.max(y2, 0), bmpH);
  return { sx: x1, sy: y1, sw: x2 - x1, sh: y2 - y1 };
}

/**
 * Decides how a full-page capture is laid out.
 *  - frames: scroll offsets (CSS px) to visit. Consecutive frames overlap by
 *    OVERLAP px so rounding can never leave a gap; later frames overdraw earlier ones.
 *  - outScale: 1 when the page fits, otherwise the factor needed to fit browser limits.
 */
export const FRAME_OVERLAP = 2;

export function planFullPage({ totalHeight, vw, vh, nativeScale, bmpW }) {
  const height = Math.max(1, Math.ceil(totalHeight));
  const nativeW = Math.round(bmpW);
  const nativeH = Math.max(1, Math.round(height * nativeScale));

  const outScale = Math.min(
    1,
    LIMITS.MAX_DIMENSION / nativeH,
    LIMITS.MAX_DIMENSION / nativeW,
    Math.sqrt(LIMITS.MAX_AREA / (nativeW * nativeH))
  );
  if (outScale < LIMITS.MIN_OUTPUT_SCALE) {
    throw new ShotError(
      ErrorCode.TOO_LARGE,
      `This page is too long to capture as a single PNG (${nativeW} × ${nativeH} px). ` +
        'Try capturing it in parts with “Capture Area”.'
    );
  }

  const frames = [];
  if (height <= vh) {
    frames.push(0);
  } else {
    const step = Math.max(1, vh - FRAME_OVERLAP);
    const last = height - vh;
    for (let y = 0; y < last; y += step) frames.push(y);
    frames.push(last);
  }

  return {
    frames,
    canvasW: Math.max(1, Math.round(nativeW * outScale)),
    canvasH: Math.max(1, Math.round(nativeH * outScale)),
    outScale,
    downscaled: outScale < 1,
    nativeW,
    nativeH,
  };
}

export function createCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export async function canvasToPngBlob(canvas) {
  let blob;
  if (typeof canvas.convertToBlob === 'function') {
    blob = await canvas.convertToBlob({ type: 'image/png' });
  } else {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }
  if (!blob || blob.size === 0) {
    throw new ShotError(
      ErrorCode.TOO_LARGE,
      'The browser could not encode an image this large. Try capturing a smaller area.'
    );
  }
  return blob;
}

export async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

/** Crops a bitmap to a PNG blob. */
export async function cropBitmapToPng(bitmap, { sx, sy, sw, sh }) {
  const canvas = createCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvasToPngBlob(canvas);
}

/** Downscales an image blob so its longest side is <= maxSide (used for Visual Search uploads). */
export async function limitImageSize(blob, maxSide) {
  const bmp = await createImageBitmap(blob);
  try {
    const longest = Math.max(bmp.width, bmp.height);
    if (longest <= maxSide) return { blob, width: bmp.width, height: bmp.height };
    const k = maxSide / longest;
    const w = Math.max(1, Math.round(bmp.width * k));
    const h = Math.max(1, Math.round(bmp.height * k));
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    return { blob: await canvasToPngBlob(canvas), width: w, height: h };
  } finally {
    bmp.close();
  }
}
