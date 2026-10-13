import {type RefObject, useEffect, useRef} from "react";
import type {createLizardScene} from "./lizard/scene";
import {PeekingHead} from "./lizard/PeekingHead";
import "./lizard/lizard.css";

const sessionKey = "payunlock:hero-lizard-played";
let completedWithoutStorage = false;

function hasCompletedCycle() {
  try {
    return completedWithoutStorage || sessionStorage.getItem(sessionKey) === "complete";
  } catch {
    return completedWithoutStorage;
  }
}

function markCycleComplete() {
  completedWithoutStorage = true;
  try {
    sessionStorage.setItem(sessionKey, "complete");
  } catch { /* Storage may be disabled. */
  }
}

export function HeroLizard({heroRef}: { heroRef: RefObject<HTMLElement | null> }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const peekRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (typeof matchMedia !== "function" || typeof IntersectionObserver !== "function" || typeof ResizeObserver !== "function") return;
    const layer = layerRef.current, hero = heroRef.current, peek = peekRef.current;
    if (!layer || !hero || !peek) return;
    const targets = [...hero.querySelectorAll<SVGSVGElement>("[data-lizard-target]")];
    const actions = hero.querySelector(".actions");
    if (!actions || targets.length !== 2) return;
    const desktop = matchMedia("(min-width: 1024px) and (hover: hover) and (pointer: fine)");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const logo = document.querySelector("[data-lizard-replay]");
    let scene: ReturnType<typeof createLizardScene> | null = null;
    let visible = false, disposed = false, loading = false;
    let clicks: number[] = [];
    const eligible = () => desktop.matches && !reduced.matches;
    const canPlay = () => eligible() && visible && !document.hidden;
    const syncPeek = () => {
      peek.hidden = !hasCompletedCycle() || !canPlay() || !!scene || loading;
    };

    function positionPeek() {
      peek!.style.left = `calc(50% - ${document.documentElement.clientWidth / 2}px)`;
      peek!.style.top = `${actions!.getBoundingClientRect().bottom - hero!.getBoundingClientRect().top + 6}px`;
    }

    async function start(manual = false) {
      if (disposed || scene || loading || !canPlay() || (!manual && hasCompletedCycle())) return;
      const restoreFocus = document.activeElement === peek;
      loading = true;
      syncPeek();
      try {
        const {createLizardScene} = await import("./lizard/scene");
        if (disposed || !canPlay() || (!manual && hasCompletedCycle())) return;
        scene = createLizardScene(layer!, targets, () => {
          scene = null;
          markCycleComplete();
          syncPeek();
          if (restoreFocus && !peek!.hidden && document.activeElement === document.body) peek!.focus({preventScroll: true});
        });
        scene.setPaused(false);
      } catch {
        // A decorative asset failing to load must not interrupt the homepage.
        scene?.destroy();
        scene = null;
      } finally {
        loading = false;
        if (!disposed) syncPeek();
      }
    }

    function update() {
      if (!eligible()) {
        scene?.destroy();
        scene = null;
        clicks = [];
      } else if (scene) scene.setPaused(!canPlay());
      else void start();
      syncPeek();
    }

    function onLogoClick(event: MouseEvent) {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !canPlay()) return;
      const now = performance.now();
      clicks = clicks.filter(time => now - time <= 1500);
      clicks.push(now);
      if (clicks.length === 3) {
        clicks = [];
        void start(true);
      }
    }

    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= .5);
      update();
    }, {threshold: [.5]});
    observer.observe(actions);
    const resize = new ResizeObserver(positionPeek);
    resize.observe(hero);
    resize.observe(actions);
    resize.observe(document.documentElement);
    positionPeek();
    const onPeekClick = () => {
      void start(true);
    };
    peek.addEventListener("click", onPeekClick);
    desktop.addEventListener("change", update);
    reduced.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    logo?.addEventListener("click", onLogoClick as EventListener);
    return () => {
      disposed = true;
      scene?.destroy();
      observer.disconnect();
      resize.disconnect();
      peek.hidden = true;
      peek.removeEventListener("click", onPeekClick);
      desktop.removeEventListener("change", update);
      reduced.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
      logo?.removeEventListener("click", onLogoClick as EventListener);
    };
  }, [heroRef]);
  return <>
    <div ref={layerRef} className="hero-lizard-layer" aria-hidden="true"/>
    <button ref={peekRef} className="hero-lizard-peek" type="button" hidden aria-label="Run lizard animation"
            title="Run lizard animation"><PeekingHead/></button>
  </>;
}
