

const DB_NAME = 'StickyNotesDB';
const DB_VERSION = 1; 
const STORE_NAME = 'notes';
let db;
let openingPromise = null; 

export async function initDB() {
  if (db) return db; 
  if (openingPromise) return openingPromise; 

  openingPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = (event) => {
      console.error('[DB] initDB: IndexedDB error:', event.target.error);
      openingPromise = null; 
      reject(event.target.error);
    };
    request.onsuccess = (event) => {
      db = event.target.result;
      // console.log('[DB] initDB: IndexedDB opened successfully.'); // Optional: Keep for minimal startup log
      resolve(db);
    };
    request.onupgradeneeded = (event) => {
      // console.log('[DB] initDB: onupgradeneeded triggered.'); // Optional
      const tempDb = event.target.result;
      let store;
      if (!tempDb.objectStoreNames.contains(STORE_NAME)) {
        store = tempDb.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      } else {
        store = event.target.transaction.objectStore(STORE_NAME);
      }
      if (!store.indexNames.contains('scopeValue_scopeType')) store.createIndex('scopeValue_scopeType', ['scopeValue', 'scopeType'], { unique: false });
      if (!store.indexNames.contains('isDeleted')) store.createIndex('isDeleted', 'isDeleted', { unique: false });
      if (!store.indexNames.contains('scope_isDeleted')) store.createIndex('scope_isDeleted', ['scopeType', 'scopeValue', 'isDeleted'], { unique: false });
    };
  });
  return openingPromise;
}

async function setLocalChangesFlag() {
    try {
        await chrome.storage.local.set({ hasLocalChangesSinceLastUpload: true });
    } catch (error) {
        console.error('[DB] setLocalChangesFlag: Error:', error);
    }
}

export async function saveNote(note) {
  await initDB();
  const noteToSave = { ...note };
  if (typeof noteToSave.isDeleted === 'undefined') noteToSave.isDeleted = false;
  if (typeof noteToSave.deletedTimestamp === 'undefined') noteToSave.deletedTimestamp = null;
  if (typeof noteToSave.timestamp !== 'number' || noteToSave.timestamp <= 0) {
    // console.warn(`[DB] saveNote: Note ID ${noteToSave.id} had invalid/missing timestamp. Setting to Date.now().`); // Optional
    noteToSave.timestamp = Date.now();
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(noteToSave);
    request.onsuccess = async () => {
      await setLocalChangesFlag();
      resolve(request.result);
    };
    request.onerror = (event) => {
        console.error(`[DB] saveNote: Error saving note ID ${noteToSave.id}:`, event.target.error);
        reject(event.target.error);
    };
  });
}

export async function getNoteById(id) {
  await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = (event) => {
        console.error(`[DB] getNoteById: Error getting ID ${id}:`, event.target.error);
        reject(event.target.error);
    };
  });
}

export async function getAllNotes(includeTombstones = false) {
  await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      let notes = request.result || [];
      if (!includeTombstones) notes = notes.filter(note => !note.isDeleted);
      resolve(notes);
    };
    request.onerror = (event) => {
        console.error('[DB] getAllNotes: Error:', event.target.error);
        reject(event.target.error);
    };
  });
}

export async function getNotesForScope(currentScopeType, currentScopeValue, includeTombstones = false) {
  await initDB();
  if (typeof currentScopeType !== 'string' || currentScopeType.trim() === '') {
    console.error(`[DB] getNotesForScope: Invalid scopeType: "${currentScopeType}".`);
    return Promise.resolve([]);
  }
  if (currentScopeValue === null || currentScopeValue === undefined) currentScopeValue = ''; 
  else if (typeof currentScopeValue !== 'string') currentScopeValue = String(currentScopeValue); 
  if (typeof includeTombstones !== 'boolean') includeTombstones = false; 

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('scopeValue_scopeType'); 
    let query;
    try { query = IDBKeyRange.only([currentScopeValue, currentScopeType]); }
    catch (e) {
        console.error(`[DB] getNotesForScope: Failed to create IDBKeyRange for index 'scopeValue_scopeType'. Error: ${e.message}`);
        reject(new Error(`Failed to create IDBKeyRange: ${e.message}.`)); return;
    }
    const request = index.getAll(query);
    request.onsuccess = () => {
        let fetchedNotes = request.result || [];
        resolve(includeTombstones ? fetchedNotes : fetchedNotes.filter(note => !note.isDeleted));
    };
    request.onerror = (event) => {
        console.error(`[DB] getNotesForScope: Error for scope "${currentScopeType}", "${currentScopeValue}":`, event.target.error);
        reject(event.target.error);
    };
  });
}


export async function deleteNoteWithTombstone(noteId) {
    await initDB();
    const note = await getNoteById(noteId); 
    if (note) {
        note.isDeleted = true;
        note.deletedTimestamp = Date.now();
        note.timestamp = Date.now(); 
        await saveNote(note); 
    } else {
        // console.warn(`[DB] deleteNoteWithTombstone: Note ID ${noteId} not found.`); // Optional
    }
}

export async function permanentlyDeleteNoteFromDB(noteId) {
    await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(noteId);
        request.onsuccess = async () => { await setLocalChangesFlag(); resolve(); };
        request.onerror = (event) => {
            console.error(`[DB] permanentlyDeleteNoteFromDB: Error deleting ${noteId}:`, event.target.error);
            reject(event.target.error);
        };
    });
}

export async function clearAllData() {
  await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();
    request.onsuccess = async () => { await setLocalChangesFlag(); resolve(); };
    request.onerror = (event) => {
      console.error('[DB] clearAllData: Error:', event.target.error);
      reject(event.target.error);
    };
  });
}
