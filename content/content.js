// Area-selection overlay. Injected on demand by the service worker (never
// declared in the manifest, so it does not run on pages the user did not ask about).
// The overlay lives in a closed shadow root and is fully removed before the
// screenshot is taken, so it can never appear in the result.
(() => {
  'use strict';

  if (typeof window.__sxCleanup === 'function') {
    try {
      window.__sxCleanup();
    } catch (_) {
      /* previous instance already gone */
    }
  }

  const MIN_SIZE = 8;
  const CSS = typeof window.__SX_CSS === 'string' ? window.__SX_CSS : '';
  try {
    delete window.__SX_CSS;
  } catch (_) {
    window.__SX_CSS = undefined;
  }

  const startScrollX = window.scrollX;
  const startScrollY = window.scrollY;

  // ---------- DOM ----------
  const host = document.createElement('div');
  host.setAttribute('data-snapshot-ext', 'overlay');
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };

  const layer = el('div', 'sx-layer');
  layer.tabIndex = -1;

  const hint = el('div', 'sx-hint');
  hint.append('Drag to select an area · ');
  const kbd = el('kbd', '', 'Esc');
  hint.append(kbd, ' to cancel');

  const sel = el('div', 'sx-sel');
  sel.hidden = true;
  const dims = el('div', 'sx-dims');
  sel.appendChild(dims);
  for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    const handle = el('div', 'sx-handle');
    handle.dataset.h = h;
    sel.appendChild(handle);
  }

  const toolbar = el('div', 'sx-toolbar');
  toolbar.hidden = true;
  const btnCancel = el('button', 'sx-btn', 'Cancel');
  btnCancel.type = 'button';
  const btnCapture = el('button', 'sx-btn primary', 'Capture');
  btnCapture.type = 'button';
  toolbar.append(btnCancel, btnCapture);

  const toast = el('div', 'sx-toast');
  toast.hidden = true;
  toast.setAttribute('role', 'alert');

  layer.append(hint, sel, toolbar, toast);
  root.appendChild(layer);
  document.documentElement.appendChild(host);
  layer.focus({ preventScroll: true });

  // ---------- State ----------
  let rect = null; // {x1,y1,x2,y2} in viewport CSS px
  let mode = 'none'; // none | draw | move | resize
  let dragStart = null;
  let startRect = null;
  let resizeDir = '';
  let capturing = false;
  let toastTimer = 0;

  const vw = () => window.innerWidth;
  const vh = () => window.innerHeight;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  const norm = (r) => ({
    x: Math.min(r.x1, r.x2),
    y: Math.min(r.y1, r.y2),
    w: Math.abs(r.x2 - r.x1),
    h: Math.abs(r.y2 - r.y1),
  });

  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 4500);
  }

  function render() {
    if (!rect) {
      sel.hidden = true;
      toolbar.hidden = true;
      layer.classList.remove('has-sel');
      return;
    }
    const n = norm(rect);
    layer.classList.add('has-sel');
    sel.hidden = false;
    sel.style.left = n.x + 'px';
    sel.style.top = n.y + 'px';
    sel.style.width = n.w + 'px';
    sel.style.height = n.h + 'px';

    dims.textContent = `${Math.round(n.w)} × ${Math.round(n.h)}`;
    dims.classList.toggle('inside', n.y < 38);

    if (mode === 'none') {
      toolbar.hidden = false;
      const tbW = toolbar.offsetWidth || 180;
      const tbH = toolbar.offsetHeight || 46;
      let tx = n.x + n.w - tbW;
      tx = clamp(tx, 8, Math.max(8, vw() - tbW - 8));
      let ty = n.y + n.h + 10;
      if (ty + tbH > vh() - 6) ty = n.y - tbH - 10;
      if (ty < 6) ty = clamp(n.y + n.h - tbH - 10, 6, vh() - tbH - 6);
      toolbar.style.left = tx + 'px';
      toolbar.style.top = ty + 'px';
    } else {
      toolbar.hidden = true;
    }
  }

  // ---------- Pointer handling ----------
  function point(e) {
    return { x: clamp(e.clientX, 0, vw()), y: clamp(e.clientY, 0, vh()) };
  }

  function inside(p, n) {
    return p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h;
  }

  layer.addEventListener('pointerdown', (e) => {
    if (capturing || e.button !== 0) return;
    if (toolbar.contains(e.target) || e.composedPath().includes(toolbar)) return;
    e.preventDefault();
    const p = point(e);
    const path = e.composedPath();
    const handle = path.find((n) => n.classList && n.classList.contains('sx-handle'));

    if (rect && handle) {
      mode = 'resize';
      resizeDir = handle.dataset.h;
    } else if (rect && inside(p, norm(rect))) {
      mode = 'move';
    } else {
      mode = 'draw';
      rect = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    }
    dragStart = p;
    startRect = { ...rect };
    layer.setPointerCapture(e.pointerId);
    toast.hidden = true;
    render();
  });

  layer.addEventListener('pointermove', (e) => {
    if (mode === 'none' || !rect) return;
    const p = point(e);
    if (mode === 'draw') {
      rect.x2 = p.x;
      rect.y2 = p.y;
    } else if (mode === 'move') {
      const n = norm(startRect);
      const dx = clamp(p.x - dragStart.x, -n.x, vw() - (n.x + n.w));
      const dy = clamp(p.y - dragStart.y, -n.y, vh() - (n.y + n.h));
      rect = { x1: startRect.x1 + dx, x2: startRect.x2 + dx, y1: startRect.y1 + dy, y2: startRect.y2 + dy };
    } else if (mode === 'resize') {
      if (resizeDir.includes('w')) rect.x1 = p.x;
      if (resizeDir.includes('e')) rect.x2 = p.x;
      if (resizeDir.includes('n')) rect.y1 = p.y;
      if (resizeDir.includes('s')) rect.y2 = p.y;
    }
    render();
  });

  function endDrag(e) {
    if (mode === 'none') return;
    const wasDraw = mode === 'draw';
    mode = 'none';
    try {
      layer.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* not captured */
    }
    if (!rect) return;
    const n = norm(rect);
    rect = { x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h };
    if (n.w < MIN_SIZE || n.h < MIN_SIZE) {
      rect = null;
      if (wasDraw && (n.w > 1 || n.h > 1)) showToast('That selection is too small. Drag a larger area.');
    }
    render();
  }
  layer.addEventListener('pointerup', endDrag);
  layer.addEventListener('pointercancel', endDrag);

  btnCancel.addEventListener('click', (e) => {
    e.stopPropagation();
    cleanup();
  });
  btnCapture.addEventListener('click', (e) => {
    e.stopPropagation();
    doCapture();
  });

  // ---------- Keyboard / scroll lock ----------
  // The screenshot is taken from the current viewport, so the page must not
  // scroll between "select" and "capture".
  const SCROLL_KEYS = new Set([' ', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

  function onKeyDown(e) {
    if (capturing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    } else if (e.key === 'Enter' && rect && mode === 'none') {
      e.preventDefault();
      e.stopPropagation();
      doCapture();
    } else if (SCROLL_KEYS.has(e.key)) {
      e.preventDefault();
    }
  }
  const blockWheel = (e) => e.preventDefault();
  const restoreScroll = () => {
    if (window.scrollX !== startScrollX || window.scrollY !== startScrollY) {
      window.scrollTo(startScrollX, startScrollY);
    }
  };
  const onResize = () => {
    if (!rect) return;
    const w = vw();
    const h = vh();
    rect = {
      x1: clamp(rect.x1, 0, w),
      x2: clamp(rect.x2, 0, w),
      y1: clamp(rect.y1, 0, h),
      y2: clamp(rect.y2, 0, h),
    };
    const n = norm(rect);
    if (n.w < MIN_SIZE || n.h < MIN_SIZE) rect = null;
    render();
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('wheel', blockWheel, { passive: false, capture: true });
  window.addEventListener('touchmove', blockWheel, { passive: false, capture: true });
  window.addEventListener('scroll', restoreScroll, true);
  window.addEventListener('resize', onResize);

  // ---------- Capture ----------
  const nextFrames = () =>
    new Promise((resolve) => {
      const done = () => setTimeout(resolve, 80);
      requestAnimationFrame(() => requestAnimationFrame(done));
      setTimeout(resolve, 400); // rAF may be throttled in background windows
    });

  async function doCapture() {
    if (capturing || !rect) return;
    const n = norm(rect);
    if (n.w < MIN_SIZE || n.h < MIN_SIZE) {
      showToast('That selection is too small. Drag a larger area.');
      return;
    }
    capturing = true;
    // Remove the overlay from rendering completely before the browser grabs pixels.
    host.style.display = 'none';
    await nextFrames();

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: 'AREA_CAPTURE',
        rect: { x: n.x, y: n.y, w: n.w, h: n.h },
        vw: vw(),
        vh: vh(),
        dpr: window.devicePixelRatio || 1,
      });
    } catch (err) {
      resp = {
        ok: false,
        error: {
          message: /context invalidated/i.test(String(err && err.message))
            ? 'Snapshot was updated or reloaded. Refresh this page and try again.'
            : 'Could not reach the extension. Please try again.',
        },
      };
    }

    if (resp && resp.ok) {
      cleanup();
      return;
    }
    host.style.display = '';
    capturing = false;
    showToast((resp && resp.error && resp.error.message) || 'The screenshot could not be taken.');
    layer.focus({ preventScroll: true });
  }

  // ---------- Teardown ----------
  function cleanup() {
    clearTimeout(toastTimer);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('wheel', blockWheel, { capture: true });
    window.removeEventListener('touchmove', blockWheel, { capture: true });
    window.removeEventListener('scroll', restoreScroll, true);
    window.removeEventListener('resize', onResize);
    host.remove();
    if (window.__sxCleanup === cleanup) delete window.__sxCleanup;
  }
  window.__sxCleanup = cleanup;
})();
