import { Library } from '../data/library';
import { PlayerController } from '../player/controller';
import { AudioEngine } from '../player/engines/audio';
import { YouTubeEngine } from '../player/engines/youtube';

/**
 * Composition root: creates the few browser-side services once. Everything
 * else (search, pages, how a song plays) is the server's job.
 */

export interface Services {
  library: Library;
  player: PlayerController;
}

let services: Services | null = null;

export function svc(): Services {
  if (!services) throw new Error('Services not initialised');
  return services;
}

export function initServices(): Services {
  if (services) return services;
  const library = new Library();
  const player = new PlayerController({ engines: { audio: new AudioEngine(), youtube: new YouTubeEngine() } });
  services = { library, player };
  player.restore();
  if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
    (window as unknown as { __m: Services }).__m = services;
  }
  return services;
}
