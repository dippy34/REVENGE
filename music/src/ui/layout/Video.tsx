import { useEffect, useRef } from 'preact/hooks';
import { activeSlot, embedActive, registerSlot, type SlotName } from '../../player/surface';
import { svc } from '../../app/services';
import { Icon } from '../icons';
import { nowPlayingOpen, setPanel } from '../state';
import { useMedia } from '../hooks';

/** A placeholder the YouTube player is laid over. At least 200×200 (CSS). */
export function VideoSlot({ name, class: cls }: { name: SlotName; class?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (ref.current ? registerSlot(name, ref.current) : undefined), [name]);
  return <div ref={ref} class={`m-slot m-slot-${name}${cls ? ` ${cls}` : ''}`} aria-hidden="true" />;
}

/**
 * Floating dock that keeps the YouTube player on screen when neither the
 * now-playing view nor the side panel shows it (YouTube's terms: visible).
 */
export function VideoDock() {
  const kind = embedActive.value;
  const slot = activeSlot.value;
  const wide = useMedia('(min-width: 1180px)');
  const track = svc().player.currentTrack.value;
  const docked = !!kind && (!slot || slot === 'dock');
  // Nothing may cover the player, so dialogs move up while it is docked (music.css).
  useEffect(() => {
    document.documentElement.classList.toggle('m-docked', docked);
    return () => document.documentElement.classList.remove('m-docked');
  }, [docked]);
  if (!docked) return null;
  return (
    <aside class="m-dock" aria-label="YouTube player">
      <header class="m-dock-head">
        <span class="m-dock-t">{`> ${track ? track.title.toLowerCase() : 'player'} · youtube`}</span>
        {wide ? (
          <button type="button" class="ib" aria-label="Show in side panel" title="side panel" onClick={() => setPanel('nowplaying')}>
            <Icon name="minimize" size={15} />
          </button>
        ) : null}
        <button type="button" class="ib" aria-label="Open now playing" title="full screen" onClick={() => (nowPlayingOpen.value = true)}>
          <Icon name="expand" size={15} />
        </button>
      </header>
      <VideoSlot name="dock" />
    </aside>
  );
}
