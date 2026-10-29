import { signal } from '@preact/signals';
import { store } from './library';

/** The player's only settings, kept in this browser (localStorage). */
export interface Settings {
  volume: number;
  muted: boolean;
}

const KEY = 'm.settings';

export const DEFAULT_SETTINGS: Settings = { volume: 0.8, muted: false };

export function sanitizeSettings(raw: unknown): Settings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const volume = typeof o.volume === 'number' && o.volume >= 0 && o.volume <= 1 ? o.volume : DEFAULT_SETTINGS.volume;
  return { volume, muted: o.muted === true };
}

export const settings = signal<Settings>(sanitizeSettings(store.read(KEY, null)));

export function updateSettings(patch: Partial<Settings>): void {
  settings.value = { ...settings.value, ...patch };
  store.write(KEY, settings.value);
}
