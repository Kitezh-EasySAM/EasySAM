import { useLayoutEffect, useEffect, useRef, type RefObject } from "react";

const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Полоска под активной вкладкой переезжает к новой: контейнеру ставятся `--ink-x`/`--ink-w`
 * (рисует `::after` в app.css), класс `ink-ready` включает переход только после первой расстановки.
 */
export function useInk(ref: RefObject<HTMLElement | null>, dep: unknown) {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const place = () => {
      const a = box.querySelector<HTMLElement>(":scope > .active");
      box.style.setProperty("--ink-x", `${a ? a.offsetLeft : 0}px`);
      box.style.setProperty("--ink-w", `${a ? a.offsetWidth : 0}px`);
    };
    place();
    const f = requestAnimationFrame(() => box.classList.add("ink-ready"));
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    ro?.observe(box);
    document.fonts?.ready.then(place, () => {});
    return () => {
      cancelAnimationFrame(f);
      ro?.disconnect();
    };
  }, [ref, dep]);
}

/** Содержимое под вкладками мягко проявляется при переключении (не при первом показе). */
export function useFadeSiblings(ref: RefObject<HTMLElement | null>, dep: unknown) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el || reduced()) return;
    // вкладки во врезке .page-tabs — проявляется то, что после врезки
    const from = el.parentElement?.classList.contains("page-tabs") ? el.parentElement : el;
    for (let s = from.nextElementSibling; s; s = s.nextElementSibling)
      s.animate?.(
        [
          { opacity: 0, transform: "translateY(6px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 220, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" },
      );
  }, [ref, dep]);
}

/** Радиус круга из точки (x, y), который закрывает весь экран w×h. */
export const revealRadius = (x: number, y: number, w: number, h: number): number =>
  Math.ceil(Math.hypot(Math.max(x, w - x), Math.max(y, h - y)));

/**
 * Смена темы с анимацией: новая тема расходится кругом от точки (кнопки) — View Transitions;
 * где их нет — цвета плавно перетекают (класс `theme-fade`); при `prefers-reduced-motion` — сразу.
 */
export function animateThemeChange(apply: () => void, from?: { x: number; y: number }) {
  const root = document.documentElement;
  if (reduced()) return apply();
  if (!document.startViewTransition) {
    root.classList.add("theme-fade");
    apply();
    window.setTimeout(() => root.classList.remove("theme-fade"), 450);
    return;
  }
  const x = from?.x ?? innerWidth / 2;
  const y = from?.y ?? 0;
  const r = revealRadius(x, y, innerWidth, innerHeight);
  const vt = document.startViewTransition(apply);
  vt.ready
    .then(() =>
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 550, easing: "cubic-bezier(0.4, 0, 0.2, 1)", pseudoElement: "::view-transition-new(root)" },
      ),
    )
    .catch(() => {});
}
