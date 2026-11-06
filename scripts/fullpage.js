// Full-page capture: scroll -> capture viewport -> stitch on a canvas.
// Runs in the service worker. The page-side work lives in content/page-agent.js.

import { ErrorCode, ShotError, isRestrictedUrl, toShotError } from './errors.js';
import { captureVisibleTab } from './capture.js';
import {
  canvasToPngBlob,
  createCanvas,
  dataUrlToBitmap,
  measureScale,
  planFullPage,
} from './image-processing.js';

/** Calls a method of the page agent and unwraps errors into ShotErrors. */
async function agent(tabId, method, ...args) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (m, a) => {
        try {
          if (!window.__snapAgent) return { err: 'AGENT_MISSING' };
          return { ok: await window.__snapAgent[m](...a) };
        } catch (e) {
          return { err: String((e && e.message) || e) };
        }
      },
      args: [method, args],
    });
  } catch (e) {
    throw toShotError(e);
  }
  const res = results && results[0] && results[0].result;
  if (!res) throw new ShotError(ErrorCode.NAVIGATED, 'The page changed during the capture.');
  if (res.err === 'AGENT_MISSING') {
    throw new ShotError(ErrorCode.NAVIGATED, 'The page was reloaded or navigated during the capture.');
  }
  if (res.err) throw new ShotError(ErrorCode.CAPTURE_FAILED, `Page error: ${res.err}`);
  return res.ok;
}

/**
 * @param tab   chrome.tabs.Tab of the tab to capture
 * @param hooks { onProgress(percent, text), abortReason(): ShotError|null }
 * @returns {{blob, width, height, note}}
 */
export async function captureFullPage(tab, { onProgress, abortReason }) {
  const tabId = tab.id;
  const startUrl = tab.url;
  if (isRestrictedUrl(startUrl)) throw toShotError(new Error('Cannot access contents of the page'), { url: startUrl });

  const notes = [];

  // Every step re-checks that the user is still on the same, visible tab.
  const guard = async () => {
    const reason = abortReason();
    if (reason) throw reason;
    let t;
    try {
      t = await chrome.tabs.get(tabId);
    } catch {
      throw new ShotError(ErrorCode.NAVIGATED, 'The tab was closed during the capture.');
    }
    if (t.url !== startUrl) throw new ShotError(ErrorCode.NAVIGATED, 'The page navigated away during the capture.');
    if (!t.active) {
      throw new ShotError(
        ErrorCode.TAB_CHANGED,
        'You switched tabs during the capture. Stay on the page until it finishes and try again.'
      );
    }
  };

  let injected = false;
  try {
    onProgress(2, 'Preparing page…');
    await guard();
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/page-agent.js'] });
    injected = true;

    const prepared = await agent(tabId, 'prepare');
    if (prepared.innerScroller) {
      notes.push(
        'This page scrolls inside an inner container, so only the visible part could be captured. ' +
          'Use “Capture Area” for the rest.'
      );
    }

    onProgress(6, 'Loading images and lazy content…');
    await guard();
    const warmed = await agent(tabId, 'warmUp', { maxMs: 10000 });
    if (warmed.stillGrowing) {
      notes.push('This page keeps loading more content as you scroll. The capture covers what had loaded so far.');
    }
    const totalHeight = warmed.totalHeight;
    const vw = warmed.vw;
    const vh = warmed.vh;

    // First slice (scrollY = 0) with every element visible.
    onProgress(20, 'Capturing…');
    await guard();
    await agent(tabId, 'scrollTo', 0);
    await agent(tabId, 'applyFixedPolicy', true);
    await guard();
    const first = await dataUrlToBitmap(await captureVisibleTab(tab.windowId));

    let canvas;
    let ctx;
    let plan;
    let nativeScale;
    try {
      nativeScale = measureScale(first.width, vw);
      plan = planFullPage({ totalHeight, vw, vh, nativeScale, bmpW: first.width });
      if (plan.downscaled) {
        notes.push(
          `The page is very large, so the image was scaled to ${Math.round(plan.outScale * 100)}% to fit browser limits.`
        );
      }
      canvas = createCanvas(plan.canvasW, plan.canvasH);
      ctx = canvas.getContext('2d');
      if (!ctx) throw new ShotError(ErrorCode.TOO_LARGE, 'The browser could not allocate memory for this page.');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      drawSlice(ctx, first, 0, nativeScale, plan.outScale);
    } finally {
      first.close();
    }

    // Remaining slices.
    const total = plan.frames.length;
    for (let i = 1; i < total; i++) {
      await guard();
      onProgress(20 + (70 * i) / total, `Capturing… ${i + 1} of ${total}`);
      const { scrollY } = await agent(tabId, 'scrollTo', plan.frames[i]);
      await agent(tabId, 'applyFixedPolicy', false);
      await guard();
      const bmp = await dataUrlToBitmap(await captureVisibleTab(tab.windowId));
      try {
        if (Math.abs(bmp.width / vw - nativeScale) > 0.02) {
          throw new ShotError(
            ErrorCode.CAPTURE_FAILED,
            'The zoom level or window size changed during the capture. Please try again without resizing.'
          );
        }
        drawSlice(ctx, bmp, scrollY, nativeScale, plan.outScale);
      } finally {
        bmp.close();
      }
    }

    await guard();
    onProgress(93, 'Stitching and encoding PNG…');
    const blob = await canvasToPngBlob(canvas);
    // Drop the large pixel buffer right away.
    canvas.width = 1;
    canvas.height = 1;

    onProgress(98, 'Opening preview…');
    return { blob, width: plan.canvasW, height: plan.canvasH, note: notes.join(' ') };
  } finally {
    if (injected) {
      try {
        await agent(tabId, 'cleanup');
      } catch {
        /* tab is gone or navigated: nothing to restore */
      }
    }
  }
}

function drawSlice(ctx, bitmap, scrollY, nativeScale, outScale) {
  const dy = Math.round(scrollY * nativeScale * outScale);
  if (outScale === 1) {
    ctx.drawImage(bitmap, 0, dy);
  } else {
    ctx.drawImage(
      bitmap,
      0,
      dy,
      Math.round(bitmap.width * outScale),
      Math.ceil(bitmap.height * outScale)
    );
  }
}
