import { signal } from '@preact/signals';

export interface Toast {
  id: number;
  message: string;
  tone?: 'info' | 'error' | 'success';
  action?: { label: string; run: () => void };
}

export const toasts = signal<Toast[]>([]);
let next = 1;

export function toast(message: string, opts: Omit<Toast, 'id' | 'message'> & { ms?: number } = {}): number {
  const id = next++;
  const { ms, ...rest } = opts;
  toasts.value = [...toasts.value.filter((t) => t.message !== message), { id, message, ...rest }].slice(-4);
  setTimeout(() => dismissToast(id), ms ?? (opts.action ? 7000 : 4000));
  return id;
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}
