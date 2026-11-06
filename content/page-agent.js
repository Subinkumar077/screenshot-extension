// Injected into the page (isolated world) only while a full-page capture runs.
// It scrolls the page, loads lazy content, and temporarily hides fixed/sticky
// elements so they are not repeated in every stitched slice. It leaves nothing
// behind: cleanup() restores every style, attribute and the scroll position.
(() => {
  'use strict';

  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // requestAnimationFrame can be paused in occluded windows, so never wait on it alone.
  const settle = async () => {
    await Promise.race([raf().then(raf), sleep(160)]);
    await sleep(60);
  };

  const state = {
    startX: window.scrollX,
    startY: window.scrollY,
    style: null,
    candidates: [],
    hidden: [],
    lazy: [],
  };

  function totalHeight() {
    const de = document.documentElement;
    const b = document.body;
    return Math.max(
      de.scrollHeight,
      de.offsetHeight,
      de.clientHeight,
      b ? b.scrollHeight : 0,
      b ? b.offsetHeight : 0
    );
  }

  function metrics() {
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      totalHeight: totalHeight(),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      dpr: window.devicePixelRatio || 1,
      title: document.title,
      url: location.href,
    };
  }

  // The page itself does not scroll but a big inner container does (many web apps).
  function hasBigInnerScroller() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const els = document.body ? document.body.querySelectorAll('*') : [];
    let checked = 0;
    for (const el of els) {
      if (++checked > 4000) break;
      if (el.scrollHeight <= el.clientHeight + 50) continue;
      if (el.clientHeight < vh * 0.5 || el.clientWidth < vw * 0.5) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') return true;
    }
    return false;
  }

  function hide(el) {
    state.hidden.push({
      el,
      value: el.style.getPropertyValue('visibility'),
      priority: el.style.getPropertyPriority('visibility'),
    });
    el.style.setProperty('visibility', 'hidden', 'important');
  }

  function restoreFixed() {
    for (const h of state.hidden) {
      if (h.value) h.el.style.setProperty('visibility', h.value, h.priority);
      else h.el.style.removeProperty('visibility');
    }
    state.hidden = [];
  }

  function isStuck(el, cs) {
    const r = el.getBoundingClientRect();
    const top = parseFloat(cs.top);
    const bottom = parseFloat(cs.bottom);
    if (!Number.isNaN(top) && window.scrollY > 0 && Math.abs(r.top - top) < 1.5) return true;
    if (!Number.isNaN(bottom) && Math.abs(window.innerHeight - r.bottom - bottom) < 1.5) return true;
    return false;
  }

  async function waitForVisibleImages(timeoutMs) {
    const vh = window.innerHeight;
    const pending = [];
    for (const img of document.images) {
      const r = img.getBoundingClientRect();
      if (r.bottom < -50 || r.top > vh + 50) continue;
      if (!img.complete) {
        pending.push(img.decode ? img.decode().catch(() => {}) : Promise.resolve());
      }
    }
    if (pending.length) await Promise.race([Promise.all(pending), sleep(timeoutMs)]);
  }

  const api = {
    /** Hides scrollbars, disables smooth scrolling and records elements that may need hiding. */
    prepare() {
      const style = document.createElement('style');
      style.setAttribute('data-snapshot-ext', '1');
      style.textContent =
        'html{scroll-behavior:auto !important;scrollbar-width:none !important}' +
        'html::-webkit-scrollbar,body::-webkit-scrollbar{display:none !important;width:0 !important;height:0 !important}';
      (document.head || document.documentElement).appendChild(style);
      state.style = style;

      state.candidates = [];
      const els = document.body ? document.body.querySelectorAll('*') : [];
      for (const el of els) {
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') state.candidates.push(el);
      }
      const m = metrics();
      m.innerScroller = m.totalHeight <= m.vh + 1 && hasBigInnerScroller();
      return m;
    },

    /**
     * Scrolls top-to-bottom once so lazy images / infinite lists load.
     * Time-boxed so endless feeds cannot run forever.
     */
    async warmUp({ maxMs = 10000 } = {}) {
      const t0 = Date.now();
      for (const el of document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]')) {
        state.lazy.push({ el, value: el.getAttribute('loading') });
        el.setAttribute('loading', 'eager');
      }
      let y = 0;
      let stillGrowing = false;
      let stableRounds = 0;
      while (true) {
        if (Date.now() - t0 > maxMs) {
          stillGrowing = true;
          break;
        }
        const maxY = Math.max(0, totalHeight() - window.innerHeight);
        y = Math.min(y, maxY);
        window.scrollTo(window.scrollX, y);
        await settle();
        await waitForVisibleImages(600);
        if (y >= maxY) {
          // At the bottom: give late content a moment to extend the page.
          await sleep(250);
          const newMax = Math.max(0, totalHeight() - window.innerHeight);
          if (newMax <= maxY + 1) {
            stableRounds++;
            if (stableRounds >= 1) break;
          } else {
            stableRounds = 0;
          }
          continue;
        }
        y += Math.round(window.innerHeight * 0.85);
      }
      window.scrollTo(window.scrollX, 0);
      await settle();
      const m = metrics();
      m.stillGrowing = stillGrowing;
      return m;
    },

    async scrollTo(y) {
      window.scrollTo(window.scrollX, Math.max(0, Math.round(y)));
      await settle();
      return { scrollY: window.scrollY, totalHeight: totalHeight() };
    },

    /**
     * First slice keeps everything visible. For later slices, fixed elements and
     * "stuck" sticky elements are hidden (layout is unchanged) so headers/chat
     * widgets do not repeat on every slice.
     */
    async applyFixedPolicy(isFirst) {
      restoreFixed();
      if (!isFirst) {
        for (const el of state.candidates) {
          if (!el.isConnected) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          if (cs.position === 'fixed' || (cs.position === 'sticky' && isStuck(el, cs))) hide(el);
        }
      }
      await settle();
      return true;
    },

    cleanup() {
      restoreFixed();
      for (const { el, value } of state.lazy) {
        if (value === null) el.removeAttribute('loading');
        else el.setAttribute('loading', value);
      }
      state.lazy = [];
      if (state.style && state.style.parentNode) state.style.parentNode.removeChild(state.style);
      state.style = null;
      window.scrollTo(state.startX, state.startY);
      state.candidates = [];
      return true;
    },
  };

  window.__snapAgent = api;
})();
