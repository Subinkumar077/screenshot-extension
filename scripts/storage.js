// Tiny IndexedDB wrapper used to hand a finished screenshot (a Blob) from the
// service worker to the preview page. IndexedDB is shared by every page of the
// extension, avoids the size limits of chrome.storage and of message passing,
// and lets us keep the data entirely on the user's device.

const DB_NAME = 'snapshot-db';
const STORE = 'shots';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open local storage.'));
    req.onblocked = () => reject(new Error('Local storage is blocked by another open tab.'));
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      Promise.resolve(fn(store))
        .then((r) => {
          result = r;
        })
        .catch(reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('Local storage error.'));
      tx.onabort = () => reject(tx.error || new Error('Local storage write was aborted (disk full?).'));
    });
  } finally {
    db.close();
  }
}

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Ids sort chronologically: 13-digit timestamp + random suffix. */
export function newShotId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${String(Date.now()).padStart(13, '0')}-${rand}`;
}

export function putShot(record) {
  return withStore('readwrite', (s) => wrap(s.put(record)));
}

export function getShot(id) {
  return withStore('readonly', (s) => wrap(s.get(id)));
}

export function deleteShot(id) {
  return withStore('readwrite', (s) => wrap(s.delete(id)));
}

/**
 * Removes old screenshots so temporary data never piles up.
 * Keeps the newest `keep` records and drops anything older than `maxAgeMs`.
 */
export async function pruneShots({ keep = 5, maxAgeMs = 6 * 60 * 60 * 1000, exceptId } = {}) {
  const keys = await withStore('readonly', (s) => wrap(s.getAllKeys()));
  const sorted = keys.slice().sort();
  const cutoff = Date.now() - maxAgeMs;
  const doomed = sorted.filter((key, i) => {
    if (key === exceptId) return false;
    const tooMany = i < sorted.length - keep;
    const ts = Number(String(key).slice(0, 13));
    return tooMany || (Number.isFinite(ts) && ts < cutoff);
  });
  if (!doomed.length) return 0;
  await withStore('readwrite', (s) => Promise.all(doomed.map((k) => wrap(s.delete(k)))));
  return doomed.length;
}
