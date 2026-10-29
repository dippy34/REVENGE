import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Icon, type IconName } from './icons';

/**
 * Context menus and modal dialogs, rendered once at the app root.
 * Menus are keyboard navigable; dialogs trap focus and close on Escape.
 */

export interface MenuItem {
  label: string;
  icon?: IconName;
  run?: () => void;
  href?: string;
  external?: boolean;
  disabled?: boolean;
  danger?: boolean;
  submenu?: MenuItem[];
  separator?: boolean;
  hint?: string;
}

interface MenuState {
  items: MenuItem[];
  x: number;
  y: number;
  align: 'right' | 'point';
  returnFocus?: HTMLElement | null;
  label?: string;
}

export const menuState = signal<MenuState | null>(null);

export function openMenu(items: MenuItem[], anchor: { x: number; y: number } | HTMLElement, label?: string): void {
  let x: number;
  let y: number;
  let align: MenuState['align'] = 'point';
  if (anchor instanceof HTMLElement) {
    const r = anchor.getBoundingClientRect();
    x = r.right;
    y = r.bottom + 4;
    align = 'right';
  } else ({ x, y } = anchor);
  menuState.value = { items, x, y, align, returnFocus: document.activeElement as HTMLElement | null, label };
}

export function closeMenu(): void {
  const st = menuState.value;
  menuState.value = null;
  st?.returnFocus?.focus?.();
}

function MenuList({ items }: { items: MenuItem[] }) {
  // Submenus drill in (the list is replaced, with a Back row) instead of
  // flying out, so they are never clipped and work the same on touch screens.
  const [stack, setStack] = useState<{ items: MenuItem[]; label: string }[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const level = stack[stack.length - 1];
  const shown = level ? level.items : items;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role=menuitem]:not([aria-disabled=true])')?.focus();
  }, [stack.length]);
  const back = () => setStack((s) => s.slice(0, -1));
  const onKey = (e: KeyboardEvent) => {
    const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([aria-disabled=true])') ?? [])];
    const i = nodes.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      nodes[(i + 1) % nodes.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      nodes[(i - 1 + nodes.length) % nodes.length]?.focus();
    } else if (e.key === 'ArrowLeft' && stack.length) {
      e.preventDefault();
      back();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (stack.length) back();
      else closeMenu();
    }
  };
  return (
    <div class="m-menu-list" role="menu" ref={ref} onKeyDown={onKey}>
      {level ? (
        <>
          <button type="button" class="m-menu-item is-back" role="menuitem" tabIndex={-1} onClick={(e) => (e.stopPropagation(), back())}>
            <Icon name="chevronLeft" size={16} />
            <span>{level.label}</span>
          </button>
          <div class="m-menu-sep" role="separator" />
        </>
      ) : null}
      {shown.map((item, i) =>
        item.separator ? (
          <div class="m-menu-sep" role="separator" key={`s${i}`} />
        ) : item.href && !item.disabled ? (
          <a
            key={item.label}
            class={`m-menu-item${item.danger ? ' is-danger' : ''}`}
            role="menuitem"
            href={item.href}
            target={item.external ? '_blank' : undefined}
            rel={item.external ? 'noopener noreferrer' : undefined}
            onClick={() => closeMenu()}
            tabIndex={-1}
          >
            {item.icon ? <Icon name={item.icon} size={16} /> : <span class="m-menu-gap" />}
            <span>{item.label}</span>
            {item.external ? <Icon name="external" size={14} class="m-menu-trail" /> : null}
          </a>
        ) : (
          <button
            key={item.label}
            type="button"
            class={`m-menu-item${item.danger ? ' is-danger' : ''}`}
            role="menuitem"
            aria-disabled={item.disabled ? 'true' : undefined}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            tabIndex={-1}
            onClick={(e) => {
              if (item.disabled) return;
              if (item.submenu) {
                e.stopPropagation();
                setStack((s) => [...s, { items: item.submenu!, label: item.label }]);
                return;
              }
              closeMenu();
              item.run?.();
            }}
            onKeyDown={(e) => {
              if (item.submenu && e.key === 'ArrowRight') {
                e.preventDefault();
                e.stopPropagation();
                setStack((s) => [...s, { items: item.submenu!, label: item.label }]);
              }
            }}
          >
            {item.icon ? <Icon name={item.icon} size={16} /> : <span class="m-menu-gap" />}
            <span>{item.label}</span>
            {item.hint ? <span class="m-menu-hint">{item.hint}</span> : null}
            {item.submenu ? <Icon name="chevronRight" size={14} class="m-menu-trail" /> : null}
          </button>
        ),
      )}
    </div>
  );
}

export function MenuHost() {
  const st = menuState.value;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!st || !ref.current) return setPos(null);
    setPos(null);
    const r = ref.current.getBoundingClientRect();
    const pad = 8;
    const maxLeft = window.innerWidth - r.width - pad;
    let left = st.align === 'right' ? st.x - r.width : st.x;
    if (left > maxLeft) left = st.align === 'point' ? st.x - r.width : maxLeft;
    left = Math.max(pad, Math.min(left, maxLeft));
    const top = st.y + r.height > window.innerHeight - pad ? Math.max(pad, st.y - r.height - 8) : st.y;
    setPos({ left, top });
  }, [st]);
  useEffect(() => {
    if (!st) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeMenu();
    };
    const onScroll = () => closeMenu();
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [st]);
  if (!st) return null;
  return (
    <div class="m-menu" ref={ref} aria-label={st.label} style={pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { visibility: 'hidden', left: '0px', top: '0px' }}>
      <MenuList items={st.items} />
    </div>
  );
}

// --- dialogs -----------------------------------------------------------------

interface DialogState {
  title: string;
  body: (close: () => void) => ComponentChildren;
  wide?: boolean;
}

export const dialogState = signal<DialogState | null>(null);

export function openDialog(title: string, body: (close: () => void) => ComponentChildren, wide = false): void {
  dialogState.value = { title, body, wide };
}

export function closeDialog(): void {
  dialogState.value = null;
}

export function DialogHost() {
  const st = dialogState.value;
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!st) return;
    opener.current = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not(.m-dialog-x)');
    (first ?? ref.current)?.focus();
    return () => opener.current?.focus?.();
  }, [st]);
  if (!st) return null;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeDialog();
    }
    if (e.key === 'Tab' && ref.current) {
      const nodes = [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])')];
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  return (
    <div class="m-dialog-bg" onPointerDown={(e) => e.target === e.currentTarget && closeDialog()}>
      <div class={`m-dialog${st.wide ? ' is-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={ref} tabIndex={-1} onKeyDown={onKey}>
        <header class="m-dialog-head">
          <h2 id="dialog-title">{`// ${st.title.toLowerCase()}`}</h2>
          <button type="button" class="ib m-dialog-x" aria-label="Close" onClick={closeDialog}>
            <Icon name="close" />
          </button>
        </header>
        <div class="m-dialog-body">{st.body(closeDialog)}</div>
      </div>
    </div>
  );
}
