import { useEffect, useRef } from 'preact/hooks';
import { embedActive, registerSlot } from '../../player/surface';
import { svc } from '../../app/services';

/**
 * Songs from YouTube play with the video out of sight (surface.ts). Some
 * phones only start YouTube's player after a tap inside it: then, until the
 * song plays, this dock shows the player so it can be tapped.
 */
export function VideoDock() {
  const p = svc().player;
  const docked = !!embedActive.value && p.playback.value.needsGesture;
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => (docked && slot.current ? registerSlot(slot.current) : undefined), [docked]);
  // Nothing may cover the player, so dialogs move up while it is docked (music.css).
  useEffect(() => {
    document.documentElement.classList.toggle('m-docked', docked);
    return () => document.documentElement.classList.remove('m-docked');
  }, [docked]);
  if (!docked) return null;
  const track = p.currentTrack.value;
  return (
    <aside class="m-dock" aria-label="YouTube player">
      <header class="m-dock-head">
        <span class="m-dock-t">{`> tap play to start${track ? ` · ${track.title.toLowerCase()}` : ''}`}</span>
      </header>
      <div ref={slot} class="m-slot" aria-hidden="true" />
    </aside>
  );
}
