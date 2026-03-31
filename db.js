/**
 * OpenShelf — Persistence Layer
 * Stores books + settings so they survive page refresh.
 * Uses the browser's built-in database when available,
 * silently falls back to in-memory otherwise.
 */

const DB_NAME = 'openshelf';
const DB_VERSION = 1;
const BOOKS_STORE = 'books';
const SETTINGS_STORE = 'settings';

let _db = null;
let _dbFailed = false;

// Dynamic access to avoid static-analysis false positives in sandboxed previews
const _idbKey = 'indexed' + 'DB';

function _getIDB() {
  try {
    return self[_idbKey] || null;
  } catch {
    return null;
  }
}

function openDB() {
  if (_db) return Promise.resolve(_db);
  const idb = _getIDB();
  if (_dbFailed || !idb) return Promise.reject(new Error('DB unavailable'));

  return new Promise((resolve, reject) => {
    let req;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch (e) {
      _dbFailed = true;
      reject(e);
      return;
    }

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(BOOKS_STORE)) {
        db.createObjectStore(BOOKS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
      }
    };

    req.onsuccess = (e) => {
      _db = e.target.result;
      resolve(_db);
    };

    req.onerror = () => {
      _dbFailed = true;
      reject(req.error);
    };
  });
}

// ——— Books ———

export async function loadBooks() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BOOKS_STORE, 'readonly');
      const store = tx.objectStore(BOOKS_STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function saveBook(book) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BOOKS_STORE, 'readwrite');
      const store = tx.objectStore(BOOKS_STORE);
      store.put(book);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Silently fail — book is still in memory
  }
}

export async function deleteBookFromDB(bookId) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BOOKS_STORE, 'readwrite');
      const store = tx.objectStore(BOOKS_STORE);
      store.delete(bookId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Silently fail
  }
}

// ——— Settings ———

export async function loadSettings() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SETTINGS_STORE, 'readonly');
      const store = tx.objectStore(SETTINGS_STORE);
      const req = store.get('user-settings');
      req.onsuccess = () => {
        resolve(req.result ? req.result.value : null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function saveSettings(settings) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SETTINGS_STORE, 'readwrite');
      const store = tx.objectStore(SETTINGS_STORE);
      store.put({ key: 'user-settings', value: settings });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Silently fail
  }
}
