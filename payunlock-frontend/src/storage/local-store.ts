export interface LocalStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  compareAndSwap(key: string, expected: unknown, value: unknown): Promise<void>;
  keys?(): Promise<string[]>;
}
export class IndexedStore implements LocalStore {
  private db?: Promise<IDBDatabase>;
  constructor(private readonly name = "payunlock-private-v1") {}
  private open() {
    return this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("records");
      request.onerror = () => { this.db = undefined; reject(new Error("Local storage could not be opened.")); };
      request.onblocked = () => { this.db = undefined; reject(new Error("Close other PayUnlock tabs to open storage.")); };
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); this.db = undefined; }; resolve(request.result); };
    });
  }
  private async request(key: string, mode: IDBTransactionMode, action: (store: IDBObjectStore, key: string) => IDBRequest) {
    const db = await this.open();
    return new Promise<unknown>((resolve, reject) => {
      const transaction = db.transaction("records", mode);
      const request = action(transaction.objectStore("records"), key);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(new Error("Local storage write failed; do not continue the operation."));
      transaction.onerror = () => reject(new Error("Local storage operation failed."));
    });
  }
  get(key: string) { return this.request(key, "readonly", (store, id) => store.get(id)); }
  async put(key: string, value: unknown) { await this.request(key, "readwrite", (store, id) => store.put(value, id)); }
  async remove(key: string) { await this.request(key, "readwrite", (store, id) => store.delete(id)); }
  async keys() {
    const db = await this.open();
    return new Promise<string[]>((resolve, reject) => {
      const transaction = db.transaction("records", "readonly"), request = transaction.objectStore("records").getAllKeys();
      transaction.oncomplete = () => resolve(request.result.filter((key): key is string => typeof key === "string"));
      transaction.onabort = transaction.onerror = () => reject(new Error("Local records could not be listed."));
    });
  }
  async compareAndSwap(key: string, expected: unknown, value: unknown) {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("records", "readwrite"), store = transaction.objectStore("records");
      const read = store.get(key);
      read.onsuccess = () => {
        if (JSON.stringify(read.result) !== JSON.stringify(expected)) { transaction.abort(); return; }
        if (value === undefined) store.delete(key); else store.put(value, key);
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error("Record changed in another tab. Reload before continuing."));
      transaction.onerror = () => reject(new Error("Recovery record could not be persisted."));
    });
  }
}
