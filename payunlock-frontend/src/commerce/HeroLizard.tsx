import { useEffect, useRef, type RefObject } from "react";
import type { createLizardScene } from "./lizard/scene";
import "./lizard/lizard.css";

const sessionKey = "payunlock:hero-lizard-played";
let playedWithoutStorage = false;
function hasPlayed() {
  try { return playedWithoutStorage || sessionStorage.getItem(sessionKey) === "1"; }
  catch { return playedWithoutStorage; }
}
function markPlayed() {
  playedWithoutStorage = true;
  try { sessionStorage.setItem(sessionKey, "1"); } catch { /* Storage may be disabled. */ }
}

export function HeroLizard({ heroRef }: { heroRef: RefObject<HTMLElement | null> }) {
  const layerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (typeof matchMedia !== "function" || typeof IntersectionObserver !== "function") return;
    const layer = layerRef.current, hero = heroRef.current;
    if (!layer || !hero) return;
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

    async function start(manual = false) {
      if (disposed || scene || loading || !canPlay() || (!manual && hasPlayed())) return;
      loading = true;
      try {
        const { createLizardScene } = await import("./lizard/scene");
        if (disposed || !canPlay() || (!manual && hasPlayed())) return;
        scene = createLizardScene(layer!, targets, () => { scene = null; });
        markPlayed();
        scene.setPaused(false);
      } catch {
        // A decorative asset failing to load must not interrupt the homepage.
        scene?.destroy(); scene = null;
      } finally { loading = false; }
    }

    function update() {
      if (!eligible()) { scene?.destroy(); scene = null; clicks = []; }
      else if (scene) scene.setPaused(!canPlay());
      else void start();
    }

    function onLogoClick(event: MouseEvent) {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !canPlay()) return;
      const now = performance.now();
      clicks = clicks.filter(time => now - time <= 1500);
      clicks.push(now);
      if (clicks.length === 3) { clicks = []; void start(true); }
    }

    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= .5);
      update();
    }, { threshold: [.5] });
    observer.observe(actions);
    desktop.addEventListener("change", update);
    reduced.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    logo?.addEventListener("click", onLogoClick as EventListener);
    return () => {
      disposed = true;
      scene?.destroy();
      observer.disconnect();
      desktop.removeEventListener("change", update);
      reduced.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
      logo?.removeEventListener("click", onLogoClick as EventListener);
    };
  }, [heroRef]);
  return <div ref={layerRef} className="hero-lizard-layer" aria-hidden="true" />;
}
