const BASE_DB_NAME = "danshi-english";
const DB_VERSION = 1;
let activeDatabaseName = BASE_DB_NAME;
let activeAccountName = "";

export const STORES = Object.freeze({
  attempts: "attempts",
  wordStates: "wordStates",
  sessions: "sessions",
  settings: "settings",
});

let dbPromise;

export function setDatabaseAccount(account) {
  activeAccountName = account?.name || "";
  const storageKey = account?.storageKey || "";
  activeDatabaseName =
    storageKey === "legacy" || !storageKey
      ? BASE_DB_NAME
      : `${BASE_DB_NAME}-account-${storageKey.replace(/[^a-zA-Z0-9-]/g, "")}`;
  dbPromise = null;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("事务已取消"));
  });
}

export function openDatabase() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(activeDatabaseName, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORES.attempts)) {
        const attempts = db.createObjectStore(STORES.attempts, { keyPath: "id" });
        attempts.createIndex("day", "day");
        attempts.createIndex("sessionId", "sessionId");
        attempts.createIndex("itemId", "itemId");
      }

      if (!db.objectStoreNames.contains(STORES.wordStates)) {
        db.createObjectStore(STORES.wordStates, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(STORES.sessions)) {
        const sessions = db.createObjectStore(STORES.sessions, { keyPath: "id" });
        sessions.createIndex("day", "day");
      }

      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

export async function getRecord(storeName, key) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readonly");
  return requestToPromise(transaction.objectStore(storeName).get(key));
}

export async function getAll(storeName) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readonly");
  return requestToPromise(transaction.objectStore(storeName).getAll());
}

export async function getByIndex(storeName, indexName, value) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readonly");
  const index = transaction.objectStore(storeName).index(indexName);
  return requestToPromise(index.getAll(value));
}

export async function putRecord(storeName, value) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
  return value;
}

export async function putMany(storeName, values) {
  if (!values.length) {
    return;
  }

  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readwrite");
  const store = transaction.objectStore(storeName);

  for (const value of values) {
    store.put(value);
  }

  await transactionDone(transaction);
}

export async function saveWordTurn({ session, wordState, attempt }) {
  const db = await openDatabase();
  const transaction = db.transaction(
    [STORES.sessions, STORES.wordStates, STORES.attempts],
    "readwrite",
  );
  transaction.objectStore(STORES.sessions).put(session);
  transaction.objectStore(STORES.wordStates).put(wordState);
  transaction.objectStore(STORES.attempts).put(attempt);
  await transactionDone(transaction);
}

export async function deleteRecord(storeName, key) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).delete(key);
  await transactionDone(transaction);
}

export async function exportDatabaseBackup() {
  const [attempts, wordStates, sessions, settings] = await Promise.all([
    getAll(STORES.attempts),
    getAll(STORES.wordStates),
    getAll(STORES.sessions),
    getAll(STORES.settings),
  ]);

  return {
    app: "danshi-english",
    schemaVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    account: {
      name: activeAccountName || "未命名账号",
    },
    stores: {
      [STORES.attempts]: attempts,
      [STORES.wordStates]: wordStates,
      [STORES.sessions]: sessions,
      [STORES.settings]: settings,
    },
  };
}

export async function importDatabaseBackup(backup) {
  if (!backup || backup.app !== "danshi-english" || !backup.stores) {
    throw new Error("这不是有效的滴水英语备份文件。");
  }

  const storeNames = Object.values(STORES);
  for (const storeName of storeNames) {
    const records = backup.stores[storeName];
    if (Array.isArray(records)) {
      await putMany(storeName, records);
    }
  }
}

