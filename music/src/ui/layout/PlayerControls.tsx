import { useState } from 'preact/hooks';
import { svc } from '../../app/services';
import { settings } from '../../data/settings';
import { formatTime } from '../hooks';
import { Icon } from '../icons';
import { Slider } from '../components/Slider';

export function isPlaying(): boolean {
  const st = svc().player.playback.value;
  return st.status === 'playing' || st.status === 'buffering' || ((st.status === 'loading' || st.status === 'resolving') && st.intent === 'play');
}

/** Solid white square, the site's "play" button. */
export function PlayButton({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const p = svc().player;
  const st = p.playback.value;
  const playing = isPlaying();
  const busy = (st.status === 'resolving' || st.status === 'loading' || st.status === 'buffering') && st.intent === 'play';
  return (
    <button
      type="button"
      class={`m-play is-${size}${busy ? ' is-busy' : ''}`}
      aria-label={playing ? 'Pause' : 'Play'}
      title={playing ? 'pause (space)' : 'play (space)'}
      data-cursor={playing ? 'pause' : 'play'}
      onClick={() => p.togglePlay()}
      disabled={!p.currentTrack.value}
    >
      <Icon name={playing ? 'pause' : 'play'} size={size === 'lg' ? 26 : size === 'sm' ? 16 : 18} />
    </button>
  );
}

export function TransportControls({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const p = svc().player;
  const q = p.queue.value;
  const has = !!p.currentTrack.value;
  const s = size === 'lg' ? 22 : 17;
  return (
    <div class={`m-transport is-${size}`}>
      <button type="button" class={`ib${q.shuffle ? ' is-on' : ''}`} aria-label="Shuffle" aria-pressed={q.shuffle} title={`shuffle ${q.shuffle ? 'on' : 'off'} (s)`} onClick={() => p.toggleShuffle()}>
        <Icon name="shuffle" size={s} />
      </button>
      <button type="button" class="ib" aria-label="Previous" title="previous (shift + left)" onClick={() => p.previous()} disabled={!has}>
        <Icon name="prev" size={s + 2} />
      </button>
      <PlayButton size={size === 'lg' ? 'lg' : 'md'} />
      <button type="button" class="ib" aria-label="Next" title="next (shift + right)" onClick={() => p.next()} disabled={!has}>
        <Icon name="next" size={s + 2} />
      </button>
      <button type="button" class={`ib${q.repeat !== 'off' ? ' is-on' : ''}`} aria-label={`Repeat: ${q.repeat}`} title={`repeat ${q.repeat} (r)`} onClick={() => p.cycleRepeat()}>
        <Icon name={q.repeat === 'one' ? 'repeatOne' : 'repeat'} size={s} />
      </button>
    </div>
  );
}

export function ProgressBar() {
  const p = svc().player;
  const st = p.playback.value;
  const track = p.currentTrack.value;
  const caps = p.capabilities();
  const [scrub, setScrub] = useState<number | null>(null);
  const duration = st.duration || track?.duration || 0;
  const position = scrub ?? st.position;
  const source = p.source.value;
  const canSeek = caps.seek && !!duration && st.status !== 'resolving' && st.status !== 'error' && !!p.engine;
  return (
    <div class="m-prog">
      <span class="m-time" aria-hidden="true">
        {formatTime(position)}
      </span>
      <Slider value={position} max={duration} label="Seek" valueText={`${formatTime(position)} of ${formatTime(duration)}`} disabled={!canSeek} onScrub={setScrub} onChange={(v) => p.seek(v)} class="seek" />
      <span class="m-time" aria-hidden="true">
        {source?.kind === 'preview' ? `${formatTime(duration)} [30s]` : formatTime(duration)}
      </span>
    </div>
  );
}

export function VolumeControl() {
  const p = svc().player;
  const { volume, muted } = settings.value;
  const icon = muted || volume === 0 ? 'mute' : volume < 0.5 ? 'volumeLow' : 'volume';
  return (
    <div class="m-vol">
      <button type="button" class="ib" aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'unmute (m)' : 'mute (m)'} aria-pressed={muted} onClick={() => p.toggleMute()}>
        <Icon name={icon} size={17} />
      </button>
      <Slider
        value={muted ? 0 : volume * 100}
        max={100}
        step={5}
        label="Volume"
        valueText={`${Math.round((muted ? 0 : volume) * 100)}%`}
        onChange={(v) => p.setVolume(v / 100)}
        onScrub={(v) => v !== null && p.setVolume(v / 100)}
        class="vol"
      />
    </div>
  );
}

/** One terse status line ("> loading from youtube"), or null when all is well. */
export function statusText(): string | null {
  const p = svc().player;
  const st = p.playback.value;
  const source = p.source.value;
  if (st.status === 'resolving') return '> finding a source';
  if (st.status === 'loading' && st.intent === 'play') return source ? `> loading from ${source.label.toLowerCase()}` : '> loading';
  if (st.status === 'buffering') return '> buffering';
  if (st.status === 'error') return `> ${(st.error ?? 'can’t play this song').replace(/\.$/, '').toLowerCase()}`;
  if (st.needsGesture) return source?.engine === 'youtube' ? '> tap play on the video to start' : '> press play to start';
  return null;
}
