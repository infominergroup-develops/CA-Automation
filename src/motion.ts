import { useEffect, useLayoutEffect, useRef } from 'react';
import { gsap } from 'gsap';

/**
 * Motion layer (GSAP). Two rules: motion explains, never decorates; and anyone who prefers reduced motion
 * gets the final state immediately.
 */

export const EASE = 'expo.out';
export const prefersReducedMotion = () =>
  typeof window === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------- Reveal on enter
 * Elements that mount at about the same time are revealed together with a short stagger,
 * so a page settles in reading order instead of popping in piece by piece.
 */
let queue: HTMLElement[] = [];
let scheduled = false;
const flush = () => {
  scheduled = false;
  const els = queue.filter((el) => el.isConnected);
  queue = [];
  if (!els.length) return;
  els.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  gsap.to(els, { autoAlpha: 1, y: 0, duration: 0.7, ease: EASE, stagger: 0.045, clearProps: 'transform,opacity,visibility' });
};
const enqueue = (el: HTMLElement) => {
  queue.push(el);
  if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
};

const io = typeof window !== 'undefined' && 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io && io.unobserve(e.target); enqueue(e.target as HTMLElement); }
  }, { rootMargin: '0px 0px -40px 0px' })
  : null;

export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || !io) return;
    gsap.set(el, { autoAlpha: 0, y: 14 });
    io.observe(el);
    // Safety net: never leave content hidden (e.g. very long pages, printing, screenshots).
    const t = setTimeout(() => { io.unobserve(el); if (gsap.getProperty(el, 'opacity') === 0) enqueue(el); }, 1400);
    return () => { clearTimeout(t); io.unobserve(el); gsap.killTweensOf(el); };
  }, []);
  return ref;
}

/* ------------------------------------------------------------- Count-up numbers */

export function useCountUp(value: number, format: (n: number) => string) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion() || !Number.isFinite(value)) { el.textContent = format(value); last.current = value; return; }
    const obj = { v: last.current };
    const tween = gsap.to(obj, {
      v: value, duration: Math.min(1.2, 0.5 + Math.log10(Math.abs(value - last.current) + 1) * 0.12), ease: 'power3.out',
      onUpdate: () => { el.textContent = format(Number.isInteger(value) ? Math.round(obj.v) : obj.v); },
      onComplete: () => { el.textContent = format(value); last.current = value; },
    });
    return () => { tween.kill(); };
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return ref;
}

/* ------------------------------------------------------------- Timelines */

/** Runs a one-off entrance timeline scoped to a container, e.g. the login screen. */
export function useEntrance(build: (tl: gsap.core.Timeline, q: (sel: string) => Element[]) => void) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!ref.current || prefersReducedMotion()) return;
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: EASE, duration: 0.9 } });
      build(tl, gsap.utils.selector(ref.current));
    }, ref);
    return () => ctx.revert();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return ref;
}
