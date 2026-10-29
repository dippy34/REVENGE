import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

/**
 * Glue to the site's shared effects (site/js/fx.js), which the page loads.
 * Everything degrades to plain text when fx.js is missing or motion is reduced.
 */

interface Fx {
  decode(el: Element, opts?: Record<string, unknown>): void;
  scramble(el: Element, opts?: Record<string, unknown>): void;
  glitch(el: Element): void;
  reduced(): boolean;
  hold(on: boolean): void;
  rain?: { pause(): void; resume(): void; burst(x: number, y: number, s: number): void };
}

export function fx(): Fx | null {
  return ((window as unknown as { fx?: Fx }).fx as Fx | undefined) ?? null;
}

/** Decodes the element's text in from noise once, when it mounts or the text changes. */
export function useDecode<T extends HTMLElement>(text: string) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    const f = fx();
    if (el && f && !f.reduced()) f.decode(el);
  }, [text]);
  return ref;
}

/** "// title [n] ------ extra", the section heading used across the site. */
export function SecHead({ title, count, extra, sub, id }: { title: string; count?: number | string; extra?: ComponentChildren; sub?: string; id?: string }) {
  const ref = useDecode<HTMLHeadingElement>(title);
  return (
    <>
      <div class="sec-head">
        <h2 class="m-h" id={id} aria-label={title} data-scramble ref={ref}>
          {title}
        </h2>
        {count !== undefined && count !== '' ? <span class="sec-n">{count}</span> : null}
        <span class="sec-rule" aria-hidden="true" />
        {extra}
      </div>
      {sub ? <p class="m-subh">{sub}</p> : null}
    </>
  );
}

const ART = {
  empty: ['   ________', '  /        \\', ' /  ==  ==  \\', ' \\          /', '  \\________/'].join('\n'),
  error: ['   ________', '  /        \\', ' /  ><  ><  \\', ' \\   ____   /', '  \\________/'].join('\n'),
};

/** Empty and error states: the site's small ASCII mask and a terse line. */
export function Empty({ text, bad, children }: { text: string; bad?: boolean; children?: ComponentChildren }) {
  return (
    <div class={`m-empty${bad ? ' is-bad' : ''}`} role={bad ? 'alert' : undefined}>
      <pre class="ascii" aria-hidden="true">
        {bad ? ART.error : ART.empty}
      </pre>
      <p>{text}</p>
      {children}
    </div>
  );
}

/** "> fetch 0x3fa2c1_" while something loads. */
export function Noise({ label = 'fetch' }: { label?: string }) {
  const hex = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return <span class="m-noise">{`> ${label} 0x${hex}`}</span>;
}
