// Run with: node tests/geometry.test.mjs
import assert from 'node:assert/strict';
import { cropRectToBitmap, planFullPage, measureScale, LIMITS, FRAME_OVERLAP } from '../scripts/image-processing.js';
import { isRestrictedUrl, toShotError, ErrorCode } from '../scripts/errors.js';
import { buildFilename } from '../scripts/download.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('crop @ DPR 1 / 100% zoom', () => {
  const c = cropRectToBitmap({ x: 100, y: 50, w: 400, h: 300 }, 1280, 720, 1280, 720);
  assert.deepEqual(c, { sx: 100, sy: 50, sw: 400, sh: 300 });
});
t('crop @ DPR 2 (retina)', () => {
  const c = cropRectToBitmap({ x: 100, y: 50, w: 400, h: 300 }, 1280, 720, 2560, 1440);
  assert.deepEqual(c, { sx: 200, sy: 100, sw: 800, sh: 600 });
});
t('crop @ 150% browser zoom, DPR 1 (viewport is 853x480 CSS px, bitmap 1280x720)', () => {
  const c = cropRectToBitmap({ x: 100, y: 100, w: 200, h: 100 }, 853.333, 480, 1280, 720);
  assert.equal(Math.abs(c.sx - 150) <= 1, true);
  assert.equal(Math.abs(c.sw - 300) <= 1, true);
  assert.equal(c.sh, 150);
});
t('crop @ DPR 1.25 + 110% zoom', () => {
  const s = measureScale(1920, 1920 / (1.25 * 1.1));
  assert.ok(Math.abs(s - 1.375) < 1e-9);
});
t('crop is clamped to the bitmap', () => {
  const c = cropRectToBitmap({ x: 1200, y: 700, w: 400, h: 400 }, 1280, 720, 1280, 720);
  assert.deepEqual(c, { sx: 1200, sy: 700, sw: 80, sh: 20 });
});

t('plan: short page = one frame', () => {
  const p = planFullPage({ totalHeight: 700, vw: 1280, vh: 720, nativeScale: 1, bmpW: 1280 });
  assert.deepEqual(p.frames, [0]);
  assert.equal(p.outScale, 1);
});
t('plan: frames cover the page with no gaps (many sizes/scales)', () => {
  for (const [H, vh, s] of [[5000, 720, 1], [12345, 800, 2], [9999, 745, 1.1], [3000, 1000, 1.375], [721, 720, 1], [100000, 900, 1]]) {
    const p = planFullPage({ totalHeight: H, vw: 1280, vh, nativeScale: s, bmpW: Math.round(1280 * s) });
    const frameH = Math.round(vh * s);
    let covered = 0; // device px covered from the top
    for (const y of p.frames) {
      const top = Math.round(y * s * p.outScale);
      assert.ok(top <= covered + 1, `gap before frame at y=${y} (H=${H}, s=${s}): top=${top}, covered=${covered}`);
      covered = Math.max(covered, top + Math.ceil(frameH * p.outScale));
    }
    assert.ok(covered >= p.canvasH - 1, `page bottom not covered (H=${H}): ${covered} < ${p.canvasH}`);
    assert.equal(p.frames.at(-1), Math.max(0, Math.ceil(H) - vh));
  }
});
t('plan: very tall page is downscaled to fit the 32767px canvas limit', () => {
  const p = planFullPage({ totalHeight: 60000, vw: 1280, vh: 800, nativeScale: 1, bmpW: 1280 });
  assert.ok(p.downscaled && p.canvasH <= LIMITS.MAX_DIMENSION && p.canvasW * p.canvasH <= LIMITS.MAX_AREA);
});
t('plan: pixel-area budget is enforced on hi-dpi', () => {
  const p = planFullPage({ totalHeight: 20000, vw: 1920, vh: 1000, nativeScale: 2, bmpW: 3840 });
  assert.ok(p.canvasW * p.canvasH <= LIMITS.MAX_AREA + 1);
});
t('plan: absurdly long page raises TOO_LARGE (never a broken image)', () => {
  assert.throws(
    () => planFullPage({ totalHeight: 400000, vw: 1280, vh: 800, nativeScale: 1, bmpW: 1280 }),
    (e) => e.code === ErrorCode.TOO_LARGE
  );
});

t('restricted URLs', () => {
  for (const u of ['chrome://settings', 'edge://newtab', 'brave://settings', 'about:blank', 'chrome-extension://abc/x.html',
    'https://chromewebstore.google.com/detail/x', 'https://microsoftedge.microsoft.com/addons/detail/x', 'view-source:https://a.com', '', undefined])
    assert.equal(isRestrictedUrl(u), true, String(u));
  for (const u of ['https://example.com/', 'http://localhost:3000/a', 'file:///C:/a.html', 'https://chrome.google.com/other'])
    assert.equal(isRestrictedUrl(u), false, u);
});
t('error mapping', () => {
  assert.equal(toShotError(new Error('Cannot access contents of the page. Extension manifest must request permission')).code, ErrorCode.RESTRICTED);
  assert.equal(toShotError(new Error('Cannot access contents of url "file:///a.html"'), { url: 'file:///a.html' }).code, ErrorCode.FILE_ACCESS);
  assert.equal(toShotError(new Error('No tab with id: 5.')).code, ErrorCode.NAVIGATED);
  assert.equal(toShotError(new Error("The 'activeTab' permission is not in effect")).code, ErrorCode.NO_PERMISSION);
});
t('filename has date+time and is filesystem-safe', () => {
  const f = buildFilename({ kind: 'fullpage', host: 'ex ample.com/../x', date: new Date(2026, 10, 6, 9, 18, 33) });
  assert.equal(f, 'Snapshot_full-page_ex-ample.com-..-x_2026-11-06_09-18-33.png');
  assert.ok(!/[\\/:*?"<>|]/.test(f));
});
console.log(`\n${n} tests passed`);

// ---- pixel-level stitching simulation (mirrors fullpage.js drawSlice math) ----
t('simulated stitch reproduces every row exactly (DPR/zoom variants, incl. last-frame clamp)', () => {
  for (const [H, vh, s] of [[5000, 720, 1], [12345, 800, 2], [9999, 745, 1.1], [3001, 1000, 1.375], [721, 720, 1], [2500, 937, 1.25]]) {
    const bmpW = Math.round(1280 * s);
    const bmpH = Math.round(vh * s);
    const plan = planFullPage({ totalHeight: H, vw: 1280, vh, nativeScale: s, bmpW });
    assert.equal(plan.outScale, 1);
    const canvas = new Int32Array(plan.canvasH).fill(-1);
    for (const requested of plan.frames) {
      const scrollY = Math.min(requested, Math.ceil(H) - vh);          // browser clamps scroll
      const top = Math.round(scrollY * s);                              // device row at viewport top
      for (let r = 0; r < bmpH; r++) {                                  // drawImage(bitmap, 0, dy)
        const dest = Math.round(scrollY * s) + r;
        if (dest >= 0 && dest < canvas.length) canvas[dest] = top + r;  // value = true page row
      }
    }
    for (let i = 0; i < canvas.length; i++) {
      assert.ok(canvas[i] !== -1, `unfilled row ${i} (H=${H}, s=${s})`);
      assert.equal(canvas[i], i, `row ${i} misplaced (H=${H}, s=${s})`);
    }
  }
});
console.log(`${n} tests passed (with simulation)`);
