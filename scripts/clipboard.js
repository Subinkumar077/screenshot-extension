// Copies a PNG blob to the system clipboard as an image.

export async function copyImageBlob(blob) {
  if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') {
    throw new Error('This browser does not support copying images to the clipboard.');
  }
  // The Clipboard API only guarantees image/png, so make sure the MIME type is exact.
  const png = blob.type === 'image/png' ? blob : new Blob([blob], { type: 'image/png' });
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } catch (e) {
    const name = e && e.name;
    const msg = String((e && e.message) || '');
    if (/not focused/i.test(msg)) {
      throw new Error('Click anywhere on this page, then press Copy again (the browser only allows copying while this tab is focused).');
    }
    if (name === 'NotAllowedError' || /denied|permission/i.test(msg)) {
      throw new Error('Clipboard access was denied. Allow clipboard access for this extension in your browser settings, or use Save instead.');
    }
    if (name === 'DataError' || /too large|size/i.test(msg)) {
      throw new Error('The image is too large to copy to the clipboard. Use Save instead.');
    }
    throw new Error(msg || 'The image could not be copied to the clipboard.');
  }
}
