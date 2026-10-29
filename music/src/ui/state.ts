import { signal } from '@preact/signals';

/** UI-only state (the side-panel choice is kept in localStorage). */

export type PanelTab = 'nowplaying' | 'queue';

function readPanel(): PanelTab | null {
  try {
    const v = localStorage.getItem('m.panel');
    return v === 'nowplaying' || v === 'queue' ? v : v === 'none' ? null : 'nowplaying';
  } catch {
    return 'nowplaying';
  }
}

export const panel = signal<PanelTab | null>(readPanel());
export const nowPlayingOpen = signal(false);
export const nowPlayingTab = signal<'queue' | null>(null);

export function setPanel(tab: PanelTab | null): void {
  panel.value = tab;
  try {
    localStorage.setItem('m.panel', tab ?? 'none');
  } catch {
    /* storage unavailable */
  }
}

export function togglePanel(tab: PanelTab): void {
  setPanel(panel.value === tab ? null : tab);
}
