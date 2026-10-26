import { AccessError, identifier, promptMappingKey, requireValue } from "./contracts.mjs";

export const DATABASE_NAME = "application-tracker-studio-access";
export const DATABASE_VERSION = 1;
export const STORE_NAME = "handles";

export function validateHandle(handle, kind) {
  requireValue(handle?.kind === kind && typeof handle.queryPermission === "function" &&
    typeof handle.requestPermission === "function" &&
    typeof handle[kind === "directory" ? "getFileHandle" : "getFile"] === "function" &&
    (kind !== "directory" || (typeof handle.getDirectoryHandle === "function" && typeof handle.entries === "function")),
  "The saved handle is missing or unusable. Select the resource again.", "stored-handle-invalid");
  return handle;
}

export class HandleStore {
  constructor(indexedDB = globalThis.indexedDB) { this.indexedDB = indexedDB; }
  open() {
    if (!this.indexedDB) return Promise.reject(new AccessError("storage-unavailable", "IndexedDB is unavailable. Studio cannot remember filesystem access."));
    return new Promise((resolve, reject) => {
      let request, settled = false;
      const fail = () => { settled = true; reject(new AccessError("storage-unavailable", "Browser handle storage could not be opened. Close other Studio pages and retry.")); };
      try { request = this.indexedDB.open(DATABASE_NAME, DATABASE_VERSION); } catch { fail(); return; }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: "key" });
      };
      request.onerror = fail;
      request.onblocked = fail;
      request.onsuccess = () => {
        const database = request.result;
        if (settled) { database.close(); return; }
        database.onversionchange = () => database.close();
        resolve(database);
      };
    });
  }
  async transaction(mode, operation) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      let transaction, result;
      const fail = () => { database.close(); reject(new AccessError("storage-failed", "Browser handle storage failed. The previous saved mapping was not replaced.")); };
      try {
        transaction = database.transaction(STORE_NAME, mode);
        transaction.oncomplete = () => { database.close(); resolve(result); };
        transaction.onerror = fail; transaction.onabort = fail;
        const request = operation(transaction.objectStore(STORE_NAME));
        request.onsuccess = () => { result = request.result; };
      } catch { try { transaction?.abort(); } catch { /* It may already be closed. */ } fail(); }
    });
  }
  async read(key, kind) {
    const record = await this.transaction("readonly", store => store.get(key));
    if (record === undefined) return null;
    requireValue(record?.schemaVersion === 1 && record.key === key && record.kind === kind,
      "The saved handle record is incompatible or damaged. Select the resource again.", "stored-handle-invalid");
    validateHandle(record.handle, kind);
    try { identifier(record.scope, "Saved configuration scope"); }
    catch { throw new AccessError("stored-handle-invalid", "The saved handle scope is damaged. Select the resource again."); }
    return record;
  }
  async write(key, kind, handle, scope) {
    validateHandle(handle, kind); identifier(scope, "Configuration scope");
    const record = { key, schemaVersion: 1, kind, scope, handle };
    await this.transaction("readwrite", store => store.put(record));
    return record;
  }
  getDirectory(slot = "configuration") { identifier(slot, "Directory slot"); return this.read(JSON.stringify(["directory", slot]), "directory"); }
  saveDirectory(handle, scope, slot = "configuration") { identifier(slot, "Directory slot"); return this.write(JSON.stringify(["directory", slot]), "directory", handle, scope); }
  async getPrompt(scope, reference) {
    const record = await this.read(promptMappingKey(scope, reference), "file");
    requireValue(!record || record.scope === scope, "The saved prompt mapping has a different configuration scope. Relink the file.", "stored-handle-invalid");
    return record;
  }
  savePrompt(scope, reference, handle) { return this.write(promptMappingKey(scope, reference), "file", handle, scope); }
  removePrompt(scope, reference) { return this.transaction("readwrite", store => store.delete(promptMappingKey(scope, reference))); }
  removeDirectory(slot = "configuration") { identifier(slot, "Directory slot"); return this.transaction("readwrite", store => store.delete(JSON.stringify(["directory", slot]))); }
}
