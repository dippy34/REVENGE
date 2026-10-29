import { route } from '../../app/router';
import { Icon, type IconName } from '../icons';

const ITEMS: { name: string; href: string; icon: IconName; match: string[] }[] = [
  { name: 'home', href: '#/', icon: 'home', match: ['home'] },
  { name: 'search', href: '#/search', icon: 'search', match: ['search'] },
  { name: 'playlists', href: '#/library', icon: 'library', match: ['library', 'playlist'] },
];

/** The hex mark with its eyes, as on every other page. Long-press opens the ghost. */
export function Logo() {
  return (
    <a class="m-logo" href="../" aria-label="back to menu" data-cursor="menu">
      <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" aria-hidden="true">
        <path class="hex" d="M16 3.5 27 9.75v12.5L16 28.5 5 22.25V9.75Z" stroke-width="2" />
        <path class="eyes" d="M10 14.5h4.5M17.5 14.5H22" stroke-width="2.4" />
      </svg>
    </a>
  );
}

/** Sticky glass top bar: mark, "~/m/<route>_", the section words and a search prompt. */
export function TopBar() {
  const r = route.value;
  const where = r.name === 'notfound' ? '404' : r.name;
  return (
    <header class="m-top">
      <div class="m-brand">
        <Logo />
        <span class="m-path" aria-hidden="true">
          ~/m/<b>{where}</b>
        </span>
      </div>
      <nav class="m-nav" aria-label="music">
        {ITEMS.map((item) => {
          const on = item.match.includes(r.name);
          return (
            <a key={item.name} href={item.href} aria-current={on ? 'page' : undefined} aria-label={item.name} data-scramble>
              {item.name}
            </a>
          );
        })}
      </nav>
      {r.name !== 'search' ? (
        <a class="m-find" href="#/search" data-cursor="search">
          <span class="m-prompt" aria-hidden="true">
            &gt;
          </span>
          <span class="m-find-t">search or paste a youtube link</span>
          <kbd aria-hidden="true">/</kbd>
        </a>
      ) : (
        <span />
      )}
    </header>
  );
}

/** Phones: the same four words at the bottom. */
export function BottomNav() {
  const r = route.value;
  return (
    <nav class="m-tabs" aria-label="music">
      {ITEMS.map((item) => {
        const on = item.match.includes(r.name);
        return (
          <a key={item.name} href={item.href} aria-current={on ? 'page' : undefined}>
            <Icon name={item.icon} size={20} />
            <span>{item.name}</span>
          </a>
        );
      })}
    </nav>
  );
}
