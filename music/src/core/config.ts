import { API_BASE } from './http';

export const APP_VERSION = '2.0.0';

/** <audio> may only load from our server. */
export function audioAllowed(url: string): boolean {
  return url.startsWith(`${API_BASE}/audio/`);
}
