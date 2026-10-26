// In-memory protocol fakes, not implementations of Chrome/IndexedDB.
import assert from "node:assert/strict";

export const domError = name => Object.assign(new Error(name), { name });
export function fileHandle(name, body = "Instructions", permission = "granted") {
  return {
    kind: "file", name, body, permission, exists: true, reads: 0, requests: 0,
    async queryPermission() { return this.permission; },
    async requestPermission() { this.requests++; this.permission = this.nextPermission ?? "granted"; return this.permission; },
    async getFile() {
      if (!this.exists) throw domError("NotFoundError");
      this.reads++; this.onRead?.(this.reads);
      const bytes = typeof this.body === "string" ? new TextEncoder().encode(this.body) : this.body;
      return { name: this.name, size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
    },
  };
}
export function directoryHandle(name = "config", contents = new Map()) {
  return {
    kind: "directory", name, contents, permission: "granted", exists: true, requests: 0,
    async queryPermission() { return this.permission; },
    async requestPermission() { this.requests++; this.permission = this.nextPermission ?? "granted"; return this.permission; },
    async getFileHandle(key, options) {
      assert.deepEqual(options, { create: false });
      if (!this.exists || this.contents.get(key)?.kind !== "file") throw domError("NotFoundError");
      return this.contents.get(key);
    },
    async getDirectoryHandle(key, options) {
      assert.deepEqual(options, { create: false });
      if (!this.exists || this.contents.get(key)?.kind !== "directory") throw domError("NotFoundError");
      return this.contents.get(key);
    },
    async *entries() { if (!this.exists) throw domError("NotFoundError"); yield* this.contents.entries(); },
    async isSameEntry(other) { return this === other; },
  };
}
export function candidate(overrides = {}) {
  return { id: "candidate-one", name: "Alex Example", extensionId: "a".repeat(32),
    historyFolder: "C:\\Synthetic\\History", promptTemplate: "templates/candidate-one.txt", ...overrides };
}
export function configuration(candidates = [candidate()]) {
  const registry = { schemaVersion: 1, activeCandidateId: candidates[0]?.id ?? null, candidates };
  return directoryHandle("config", new Map([
    ["candidates.json", fileHandle("candidates.json", JSON.stringify(registry))],
    ["templates", directoryHandle("templates", new Map([["candidate-one.txt", fileHandle("candidate-one.txt", "  Legacy tagged instructions\r\n")]]))],
  ]));
}

export class FakeIndexedDB {
  constructor() { this.records = new Map(); this.created = false; this.upgrades = 0; this.closes = 0; }
  open(name, version) {
    this.openedName = name; this.openedVersion = version;
    if (this.throwOnOpen) throw domError("SecurityError");
    const request = {};
    queueMicrotask(() => {
      if (this.openError) { request.onerror?.(); return; }
      const factory = this;
      const database = {
        objectStoreNames: { contains: () => factory.created },
        createObjectStore(storeName, options) { assert.deepEqual(options, { keyPath: "key" }); factory.created = true; factory.upgrades++; },
        close() { factory.closes++; },
        transaction(storeName, mode) {
          if (factory.throwTransaction) throw domError("InvalidStateError");
          const fail = factory.failNextTransaction; factory.failNextTransaction = false;
          const transaction = { abort() { queueMicrotask(() => transaction.onabort?.()); } };
          transaction.objectStore = () => {
            const operation = (kind, input) => {
              const operationRequest = {};
              queueMicrotask(() => {
                operationRequest.result = kind === "get" ? factory.records.get(input) : undefined;
                operationRequest.onsuccess?.();
                queueMicrotask(() => {
                  if (fail) { transaction.onabort?.(); return; }
                  if (kind === "put") factory.records.set(input.key, { ...input });
                  if (kind === "delete") factory.records.delete(input);
                  transaction.oncomplete?.();
                });
              });
              return operationRequest;
            };
            return { get: key => operation("get", key), put: value => operation("put", value), delete: key => operation("delete", key) };
          };
          return transaction;
        },
      };
      request.result = database;
      if (this.blocked) request.onblocked?.();
      if (!factory.created) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  }
}
