// Google Lens "visual search" for area screenshots.
//
// What is and is not supported (see README for details):
//  * Google does NOT publish a supported "open Lens with this image" URL or API.
//  * The widely used web workflow is the same one Lens' own upload box uses: a
//    multipart POST with the file in an `encoded_image` field to
//    https://lens.google.com/upload . We submit that form straight from this
//    extension page to Google, in a new tab, only after the user clicks the
//    button and (the first time) confirms. No third-party server is involved.
//  * Because the endpoint is undocumented it can change. The caller therefore
//    also puts the image on the clipboard, and offers a link to lens.google.com
//    where the user can simply paste (Ctrl/Cmd+V).

import { limitImageSize } from './image-processing.js';

export const LENS_UPLOAD_URL = 'https://lens.google.com/upload';
export const LENS_HOME_URL = 'https://lens.google.com/';

const CONSENT_KEY = 'snapshot.lensConsent.v1';
const MAX_UPLOAD_SIDE = 2400; // keeps uploads small and fast; Lens does not need more

export function hasLensConsent() {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberLensConsent() {
  try {
    localStorage.setItem(CONSENT_KEY, '1');
  } catch {
    /* storage unavailable: the dialog simply shows again next time */
  }
}

/** Submits the image to Google Lens in a new tab. Must be called from a user gesture. */
export async function searchWithGoogleLens(blob) {
  const { blob: upload, width, height } = await limitImageSize(blob, MAX_UPLOAD_SIDE);

  const file = new File([upload], 'snapshot.png', { type: 'image/png' });
  const transfer = new DataTransfer();
  transfer.items.add(file);

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = LENS_UPLOAD_URL;
  form.enctype = 'multipart/form-data';
  form.acceptCharset = 'utf-8';
  form.target = '_blank';
  form.rel = 'noopener noreferrer';
  form.style.display = 'none';

  const input = document.createElement('input');
  input.type = 'file';
  input.name = 'encoded_image';
  input.files = transfer.files;

  const dims = document.createElement('input');
  dims.type = 'hidden';
  dims.name = 'processed_image_dimensions';
  dims.value = `${width},${height}`;

  form.append(input, dims);
  document.body.appendChild(form);
  try {
    form.submit();
  } finally {
    setTimeout(() => form.remove(), 1500);
  }
}

export function openLensHome() {
  window.open(LENS_HOME_URL, '_blank', 'noopener,noreferrer');
}
