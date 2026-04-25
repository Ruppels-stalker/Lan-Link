import { openDB } from 'idb';

const DB_NAME = 'LanLinkDB';
const DB_VERSION = 1;

export async function initDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const store = db.createObjectStore('chunks', { autoIncrement: true });
        store.createIndex('fileId', 'fileId');
      }
    },
  });
}

export async function saveChunk(fileId: string, chunk: ArrayBuffer, index: number) {
  const db = await initDB();
  await db.put('chunks', { fileId, chunk, index });
}

export async function getFileChunks(fileId: string): Promise<ArrayBuffer[]> {
  const db = await initDB();
  const tx = db.transaction('chunks', 'readonly');
  const index = tx.store.index('fileId');
  let cursor = await index.openCursor(IDBKeyRange.only(fileId));
  const chunks: {chunk: ArrayBuffer, index: number}[] = [];
  
  while (cursor) {
    chunks.push({ chunk: cursor.value.chunk, index: cursor.value.index });
    cursor = await cursor.continue();
  }
  
  // Sort chunks by index to ensure correct order
  chunks.sort((a, b) => a.index - b.index);
  return chunks.map(c => c.chunk);
}

export async function clearFileChunks(fileId: string) {
  const db = await initDB();
  const tx = db.transaction('chunks', 'readwrite');
  const index = tx.store.index('fileId');
  let cursor = await index.openCursor(IDBKeyRange.only(fileId));
  
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
}
