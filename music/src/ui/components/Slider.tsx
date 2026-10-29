import { useRef, useState } from 'preact/hooks';

interface Props {
  value: number;
  max: number;
  onChange: (value: number) => void;
  /** Called continuously while dragging (optional). */
  onScrub?: (value: number | null) => void;
  label: string;
  valueText?: string;
  disabled?: boolean;
  step?: number;
  class?: string;
  buffered?: number;
}

/** Accessible range control (role=slider) with pointer dragging and keyboard steps. */
export function Slider({ value, max, onChange, onScrub, label, valueText, disabled, step, class: cls }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? value;
  const pct = max > 0 ? Math.max(0, Math.min(100, (shown / max) * 100)) : 0;
  const keyStep = step ?? (max > 60 ? 5 : max / 20);

  const fromEvent = (e: PointerEvent): number => {
    const r = ref.current!.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    return ratio * max;
  };

  const onDown = (e: PointerEvent) => {
    if (disabled || !max) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const v = fromEvent(e);
    setDrag(v);
    onScrub?.(v);
    const move = (ev: PointerEvent) => {
      const nv = fromEvent(ev);
      setDrag(nv);
      onScrub?.(nv);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const nv = fromEvent(ev);
      setDrag(null);
      onScrub?.(null);
      onChange(nv);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const onKey = (e: KeyboardEvent) => {
    if (disabled) return;
    let v: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = Math.min(max, value + keyStep);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = Math.max(0, value - keyStep);
    else if (e.key === 'Home') v = 0;
    else if (e.key === 'End') v = max;
    else if (e.key === 'PageUp') v = Math.min(max, value + keyStep * 4);
    else if (e.key === 'PageDown') v = Math.max(0, value - keyStep * 4);
    if (v !== null) {
      e.preventDefault();
      e.stopPropagation();
      onChange(v);
    }
  };

  return (
    <div
      ref={ref}
      class={`m-slider${disabled ? ' is-disabled' : ''}${drag !== null ? ' is-dragging' : ''}${cls ? ` ${cls}` : ''}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={valueText}
      aria-disabled={disabled ? 'true' : undefined}
      onPointerDown={(e) => onDown(e as unknown as PointerEvent)}
      onKeyDown={onKey}
      style={{ '--pct': `${pct}%` } as Record<string, string>}
    >
      <div class="m-slider-track">
        <div class="m-slider-fill" />
      </div>
      <div class="m-slider-thumb" />
    </div>
  );
}
