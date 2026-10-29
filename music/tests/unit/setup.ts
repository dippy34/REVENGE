// Node has no localStorage: a small in-memory one, emptied before each file.
const data = new Map<string, string>();
const storage = {
  getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
  setItem: (k: string, v: string) => void data.set(k, String(v)),
  removeItem: (k: string) => void data.delete(k),
  clear: () => data.clear(),
  key: (i: number) => [...data.keys()][i] ?? null,
  get length() {
    return data.size;
  },
};
(globalThis as unknown as { localStorage: typeof storage }).localStorage = storage;
