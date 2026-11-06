# Snapshot – Area & Full-Page Screenshots

A Manifest V3 screenshot extension for Chrome, Microsoft Edge and Brave, inspired by Edge's built-in
screenshot tool. Two modes (**Capture Area**, **Capture Full Page**), a preview page with **Copy**, **Save PNG**
and (for areas) **Visual Search**. Vanilla HTML/CSS/JS, no dependencies, no network requests of its own.

## Install (unpacked)

**Chrome / Brave**
1. Open `chrome://extensions` (Brave: `brave://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (the one containing `manifest.json`).
4. Pin the extension from the puzzle-piece menu so the icon is always visible.

**Microsoft Edge**
1. Open `edge://extensions`.
2. Turn on **Developer mode** (left sidebar).
3. Click **Load unpacked** and pick this folder.
4. Pin it from the toolbar's Extensions menu.

To capture local `file://` pages, open the extension's *Details* page and enable **Allow access to file URLs**.

## Architecture

```
 ┌────────┐ START_AREA / START_FULLPAGE / CANCEL / GET_STATUS ┌──────────────┐
 │ popup  │ ────────────────────────────────────────────────▶ │ background.js│
 │        │ ◀──────── PROGRESS / JOB_DONE / JOB_FAILED ────── │ (service     │
 └────────┘                                                   │  worker)     │
 ┌──────────────┐  AREA_CAPTURE {rect, vw, vh}                │              │
 │ content.js   │ ──────────────────────────────────────────▶ │  capture.js  │
 │ (overlay in  │ ◀─────────────── {ok} / {error} ─────────── │  fullpage.js │
 │ shadow DOM)  │                                             │  image-proc… │
 └──────────────┘                                             └──────┬───────┘
 ┌──────────────┐  executeScript → window.__snapAgent                │ PNG Blob
 │ page-agent.js│ ◀─ prepare / warmUp / scrollTo / applyFixedPolicy  │ (IndexedDB)
 │ (full page)  │    / cleanup                                       ▼
 └──────────────┘                                              ┌─────────────┐
                                                               │ preview page│ Copy · Save · Visual Search
                                                               └─────────────┘
```

* Nothing is declared in `content_scripts`; the overlay and page agent are **injected on demand** after the user
  clicks the toolbar icon (`activeTab` + `scripting`), so the extension never runs on pages you did not ask about.
* The finished PNG is handed to the preview tab through **IndexedDB** (no size limit issues, never leaves the device).
  Old records are pruned automatically and the **Close** button deletes the current one.

### Project layout

```
manifest.json            MV3 manifest (permissions: activeTab, scripting, downloads, clipboardWrite; no host permissions)
background.js            Service worker: message router, job state, preview opening
popup/                   Toolbar popup (action cards + full-page progress view)
content/content.js       Area-selection overlay (closed shadow DOM, drag/move/resize, Esc/Enter)
content/selection.css    Overlay styles (isolated from the page)
content/page-agent.js    Full-page helper injected into the page: lazy-load pass, fixed/sticky handling, cleanup
preview/                 Preview page: large image, Copy / Save / Visual Search / Close, toasts, loading state
scripts/capture.js       Throttled captureVisibleTab + area cropping
scripts/fullpage.js      Scroll → capture → stitch pipeline with abort checks
scripts/image-processing.js  Pure geometry (crop mapping, frame plan, limits) + canvas helpers
scripts/clipboard.js     navigator.clipboard.write with friendly errors
scripts/download.js      chrome.downloads with completion/failure detection, dated filenames
scripts/visual-search.js Google Lens submission
scripts/storage.js       IndexedDB hand-off + pruning
scripts/errors.js        Error codes, restricted-URL detection, friendly messages
assets/theme.css         Shared design tokens/components (light + dark)
tests/geometry.test.mjs  Node tests for the maths (run: node tests/geometry.test.mjs)
tools/make_icons.py      Regenerates the PNG icons (Pillow)
```

## How the hard parts work

**Accurate area cropping.** The overlay reports the selection in CSS pixels relative to the viewport, plus
`innerWidth/innerHeight`. The worker captures the viewport and measures `scale = bitmap.width / innerWidth`
from the real image, so devicePixelRatio **and** browser zoom are handled by one measured ratio (no guessing).
The overlay is `display:none` for two animation frames *before* the capture, so it can't appear in the result.
Scrolling is locked while selecting, so the selection always matches what is captured.

**Full-page stitching.** Hide scrollbars → one slow scroll pass to trigger lazy images and infinite lists
(time-boxed to 10 s) → capture slices at `vh − 2 px` steps (2 px overlap, later slices overdraw earlier ones, so
rounding can never leave a gap) → draw onto one canvas at the actual `scrollY` the browser reports (handles the
clamped last slice) → restore scroll position, styles and `loading` attributes. Fixed/sticky elements stay visible in
the first slice only, then are hidden (`visibility`, so layout doesn't shift) so headers don't repeat down the image.
`captureVisibleTab` is limited to ~2 calls/s, so slices are throttled to one per 600 ms (a 10-screen page ≈ 7 s).

**Limits are explicit, never silent.** Canvases max out at 32,767 px per side and the extension caps the pixel area
at 100 MP. Bigger pages are scaled down (the preview shows a notice, e.g. "scaled to 74%"); below 30% it stops with
a clear error suggesting Capture Area.

## Google Visual Search – what is and isn't possible

Google publishes **no** supported "open Lens with this image" URL or API. What exists is the same web upload that the
Lens page uses: a multipart POST containing the file in an `encoded_image` field to `https://lens.google.com/upload`.
Snapshot does exactly that, from the preview page directly to Google, in a new tab. This has these consequences:

* It is **undocumented**, so Google can change or block it at any time. Because of that, the image is also copied
  to your clipboard and a toast offers **Open Lens** – on the Lens page you can paste with Ctrl/⌘+V.
* The image **is uploaded to Google** (that's what visual search is). A confirmation dialog appears the first time;
  nothing is sent before you confirm, and it never goes to any third party. Large images are scaled to ≤ 2400 px first.
* I could not verify the endpoint's current behaviour from the build environment, so test it once in your browser
  (see below). It is only offered for area captures, as specified.

## Testing guide

1. **Area selection** – open any site, click the icon → *Capture Area*. Drag a box; check the `W × H` label, drag
   inside to move, drag the 8 handles to resize, click outside to start over. `Esc` cancels, `Enter` captures,
   Cancel/Capture buttons work. A tiny drag shows "too small".
2. **Crop accuracy** – put a ruler/grid page (e.g. a page with a visible 100 px grid) on screen, select exactly one
   grid cell and compare. Repeat at **50 %, 100 %, 150 %, 200 %** zoom (Ctrl +/−) and, if you have one, on a second
   monitor with a different scaling. The output pixel size should be `selection × DPR × zoom`. Confirm that the
   overlay and selection border are *not* in the image.
3. **Clipboard** – Copy, then paste into Paint/Docs/Slack. Test the denied case by blocking clipboard for the
   extension in site settings; you should see a readable message, not a crash.
4. **PNG download** – Save; the file should be named `Snapshot_area_<host>_<YYYY-MM-DD>_<HH-MM-SS>.png` and open
   at the displayed pixel size. Make the disk/permission fail (e.g. block downloads) to see the error toast.
5. **Visual Search** – area capture → *Visual Search* → confirm. A Lens tab should open with your image. If it
   shows an empty search box instead, paste (the image is on your clipboard).
6. **Full-page stitching** – a long article, e.g. Wikipedia: scroll through the result looking for seams, repeated
   or missing bands. Pages with sticky headers should show the header once, at the top.
7. **Long pages** – an endless-scroll site (feed): expect a notice that the capture covers what loaded. A very tall
   page (> 32 k px) should show the "scaled to …%" notice or the "too long" error – never a corrupt image.
8. **Zoom levels** – run full-page at 75 %, 100 %, 125 %, 200 %; widths should match the viewport × DPR × zoom.
9. **Restricted pages** – open `chrome://extensions`, `edge://newtab`, the Chrome Web Store: the popup explains why
   capture is unavailable and disables both buttons. A `file://` page explains the file-access toggle.
10. **Interruptions** – start a full-page capture, then switch tabs, reload, or close the tab: you get a clear message
    and the page's scroll position/styles are restored. *Cancel* in the popup also restores the page.

Automated checks (no browser needed): `node tests/geometry.test.mjs` verifies the crop maths for several DPR/zoom
combinations, frame planning, size limits, restricted-URL detection, error mapping, filenames and a row-by-row
stitching simulation.

## Permissions & privacy

| Permission | Why |
| --- | --- |
| `activeTab` | Temporary access to the tab you clicked the icon on (capture + injection). No broad host permissions. |
| `scripting` | Inject the overlay / page agent on demand. |
| `downloads` | Save PNGs and detect download failures. |
| `clipboardWrite` | Copy the image. |

No analytics, no remote code, no network requests except the Visual Search upload you explicitly confirm.
Screenshots exist only in memory and in a short-lived local IndexedDB record that powers the preview.

## Known limitations (honest list)

* Pages that scroll inside an inner container (some web apps) can't be stitched; you get the visible part plus a notice.
* Horizontal scrolling is not stitched (the capture is the viewport width).
* Fixed elements (e.g. a bottom cookie banner) appear only in the first slice; unusual sticky layouts may differ slightly.
* Pinch-zoom, PDF viewers and other extension/browser pages can't be captured by extensions.
* A full-page capture needs the tab to stay visible and focused until it finishes.
* The service worker needs a visible window; minimised windows make `captureVisibleTab` fail (reported as an error).

## Final review checklist (done)

* MV3: service worker module, no `webRequest` blocking, no remote scripts, no `eval`, default extension-page CSP.
* Permissions: minimal, no host permissions; all APIs used are covered (`tabs.captureVisibleTab` via `activeTab`,
  `tabs.create/get/remove` need none, `downloads.*` via `downloads`).
* Paths: every manifest/HTML/ES-import path verified to exist; every JS file syntax-checked.
* Memory: bitmaps `close()`d after use, canvas shrunk after encoding, object URLs revoked, IndexedDB records pruned.
* UI: one design-token file shared by popup and preview, light/dark, reduced-motion respected.
