import { Component, type ComponentType } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { settings } from '../data/settings';
import { recallScroll, rememberScroll, route, navigate, type RouteName } from './router';
import { svc } from './services';
import { Empty } from '../ui/components/Fx';
import { useMedia } from '../ui/hooks';
import { MiniPlayer, PlayerBar } from '../ui/layout/PlayerBar';
import { BottomNav, TopBar } from '../ui/layout/Nav';
import { NowPlaying, RightPanel } from '../ui/layout/NowPlaying';
import { VideoDock } from '../ui/layout/Video';
import { DialogHost, MenuHost, closeMenu, dialogState, menuState } from '../ui/overlays';
import { nowPlayingOpen, panel, togglePanel } from '../ui/state';
import { dismissToast, toasts } from '../ui/toast';

type Loader = () => Promise<ComponentType>;

const pages: Record<RouteName, Loader> = {
  home: () => import('../ui/pages/Home').then((m) => m.default),
  search: () => import('../ui/pages/Search').then((m) => m.default),
  library: () => import('../ui/pages/Library').then((m) => m.default),
  playlist: () => import('../ui/pages/Library').then((m) => m.PlaylistPage),
  album: () => import('../ui/pages/Album').then((m) => m.default),
  artist: () => import('../ui/pages/Artist').then((m) => m.default),
  notfound: () => import('../ui/pages/Library').then((m) => m.NotFound),
};

const loaded = new Map<RouteName, ComponentType>();

class Boundary extends Component<{ resetKey: string; children: preact.ComponentChildren }, { error: string | null; key: string }> {
  override state = { error: null as string | null, key: this.props.resetKey };
  static override getDerivedStateFromProps(props: { resetKey: string }, state: { key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }
  override componentDidCatch(error: Error) {
    console.error('[music] page error', error);
    this.setState({ error: error.message || 'unknown error' });
  }
  override render() {
    if (this.state.error) {
      return (
        <Empty text="this page broke. the player keeps going." bad>
          <button type="button" class="pill" onClick={() => this.setState({ error: null })}>
            try again
          </button>
        </Empty>
      );
    }
    return this.props.children;
  }
}

function Outlet() {
  const r = route.value;
  const [Page, setPage] = useState<ComponentType | null>(() => loaded.get(r.name) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const cached = loaded.get(r.name);
    if (cached) {
      setPage(() => cached);
      return;
    }
    let alive = true;
    setFailed(false);
    pages[r.name]().then(
      (C) => {
        loaded.set(r.name, C);
        if (alive) setPage(() => C);
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [r.name]);
  if (failed) {
    return (
      <Empty text="this page couldn’t load. check the connection." bad>
        <button type="button" class="pill" onClick={() => location.reload()}>
          reload
        </button>
      </Empty>
    );
  }
  if (!Page || !loaded.has(r.name)) return <div class="m-loading" aria-busy="true" />;
  return (
    <Boundary resetKey={r.path}>
      <Page key={r.path} />
    </Boundary>
  );
}

function Toasts() {
  const list = toasts.value;
  return (
    <div class="m-toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} class={`m-toast${t.tone === 'error' ? ' is-bad' : ''}`}>
          <span class="m-toast-p" aria-hidden="true">
            &gt;
          </span>
          <span class="m-toast-t">{t.message.toLowerCase()}</span>
          {t.action ? (
            <button
              type="button"
              class="pill is-small"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label.toLowerCase()}
            </button>
          ) : null}
          <button type="button" class="ib" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || isTyping(e.target)) return;
      if (dialogState.value || menuState.value) return;
      // the site console (eggs.js) owns ` and ~
      if (document.documentElement.classList.contains('egg-busy')) return;
      const p = svc().player;
      const el = e.target as HTMLElement;
      const interactive = el.closest('button, a, [role=slider], [role=switch], [role=tab], [role=menuitem], [role=option]');
      const key = e.key;
      if (key === ' ' && !interactive) {
        e.preventDefault();
        p.togglePlay();
      } else if (key === 'ArrowRight' && !el.closest('[role=slider]')) {
        if (e.shiftKey) p.next();
        else if (!e.altKey) p.seekBy(5);
        else return;
        e.preventDefault();
      } else if (key === 'ArrowLeft' && !el.closest('[role=slider]')) {
        if (e.shiftKey) p.previous();
        else if (!e.altKey) p.seekBy(-5);
        else return;
        e.preventDefault();
      } else if ((key === 'ArrowUp' || key === 'ArrowDown') && e.shiftKey && !e.altKey) {
        e.preventDefault();
        p.setVolume(settings.value.volume + (key === 'ArrowUp' ? 0.05 : -0.05));
      } else if (e.altKey || e.shiftKey) {
        return;
      } else if (key === 'm') p.toggleMute();
      else if (key === 's') p.toggleShuffle();
      else if (key === 'r') p.cycleRepeat();
      else if (key === 'q') togglePanel('queue');
      else if (key === '/') {
        e.preventDefault();
        if (route.value.name !== 'search') navigate('#/search');
        else document.querySelector<HTMLInputElement>('.m-q input')?.focus();
      } else if (key === 'Escape' && nowPlayingOpen.value) nowPlayingOpen.value = false;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  const r = route.value;
  const desktop = useMedia('(min-width: 761px)');
  const wide = useMedia('(min-width: 1180px)');
  const view = useRef<HTMLElement>(null);
  const hasTrack = !!svc().player.currentTrack.value;
  useShortcuts();

  // Each route rises in; scroll is remembered per route.
  useLayoutEffect(() => {
    window.scrollTo(0, recallScroll(r.path + r.query.toString()));
    closeMenu();
    const el = view.current;
    if (el) {
      el.classList.remove('is-in');
      void el.offsetWidth;
      el.classList.add('is-in');
    }
    document.documentElement.classList.toggle('m-is-home', r.name === 'home');
  }, [r.path]);

  useEffect(() => {
    let t = 0;
    const key = r.path + r.query.toString();
    const onScroll = () => {
      cancelAnimationFrame(t);
      t = requestAnimationFrame(() => {
        rememberScroll(key, window.scrollY);
        document.querySelector('.m-top')?.classList.toggle('is-scrolled', window.scrollY > 4);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [r.path, r.query.toString()]);

  const showPanel = wide && !!panel.value;
  return (
    <div class={`m-app${showPanel ? ' with-side' : ''}${desktop ? '' : ' is-phone'}${hasTrack ? ' has-track' : ''}`}>
      <TopBar />
      <main class="m-view" id="view" ref={view} tabIndex={-1}>
        <Outlet />
      </main>
      {showPanel ? <RightPanel /> : null}
      {desktop ? (
        <PlayerBar />
      ) : (
        <div class="m-dockbar">
          <MiniPlayer />
          <BottomNav />
        </div>
      )}
      <NowPlaying />
      <VideoDock />
      <MenuHost />
      <DialogHost />
      <Toasts />
    </div>
  );
}
