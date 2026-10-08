import artwork from "./mascot.svg?raw";
import { createLizardGroundedGait, type GaitPose } from "./grounded-gait.js";

type Point = { x: number; y: number };
type Curve = [Point, Point, Point, Point];
type Pose = GaitPose & { look: number; tongue: number; reaction: number; target: number };
const unit = .255;
const aim = -70;
const speed = unit * 140 * 4.5;
const ramp = .42;
const arrivePause = .12, turn = .42, anticipation = .18, touches = 1.12, hold = .18, straighten = .3;
const touchStart = arrivePause + turn + anticipation;
const straightenStart = touchStart + touches + hold;
const stopDuration = straightenStart + straighten;
// A curious first touch, a longer beat, then two quicker touches.
const touchOffsets = [0, .52, .82];
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const ease = (value: number) => { const p = clamp(value); return p * p * (3 - 2 * p); };

function rotate(point: Point, degrees: number): Point {
  const angle = degrees * Math.PI / 180;
  return { x: point.x * Math.cos(angle) - point.y * Math.sin(angle), y: point.x * Math.sin(angle) + point.y * Math.cos(angle) };
}

// Match the authored SVG's nose (176, 56), head pivot (178, 142), and 52-unit tongue.
function tongueOffset() {
  const head = rotate({ x: -2, y: -138 }, aim);
  return rotate({ x: (2 + head.x) * unit, y: (86 + head.y) * unit }, 90);
}

function bezier([a, b, c, d]: Curve, p: number) {
  const q = 1 - p;
  const dx = 3 * q * q * (b.x - a.x) + 6 * q * p * (c.x - b.x) + 3 * p * p * (d.x - c.x);
  const dy = 3 * q * q * (b.y - a.y) + 6 * q * p * (c.y - b.y) + 3 * p * p * (d.y - c.y);
  return {
    x: q ** 3 * a.x + 3 * q * q * p * b.x + 3 * q * p * p * c.x + p ** 3 * d.x,
    y: q ** 3 * a.y + 3 * q * q * p * b.y + 3 * q * p * p * c.y + p ** 3 * d.y,
    angle: Math.atan2(dy, dx) * 180 / Math.PI + 90,
  };
}

function pathAt(curves: Curve[], p: number) {
  const index = Math.min(curves.length - 1, Math.floor(p * curves.length));
  return bezier(curves[index]!, p * curves.length - index);
}

function measure(curves: Curve[]) {
  const samples = [{ distance: 0, p: 0 }];
  let length = 0, previous = pathAt(curves, 0);
  for (let i = 1; i <= 160; i++) {
    const point = pathAt(curves, i / 160);
    length += Math.hypot(point.x - previous.x, point.y - previous.y);
    samples.push({ distance: length, p: i / 160 });
    previous = point;
  }
  return { curves, samples, length, duration: length / speed + ramp };
}

function travel(route: ReturnType<typeof measure>, elapsed: number) {
  const t = Math.max(0, Math.min(route.duration, elapsed));
  const distance = Math.max(0, Math.min(route.length,
    t < ramp ? .5 * speed * t * t / ramp : t > route.duration - ramp
      ? route.length - .5 * speed * (route.duration - t) ** 2 / ramp : speed * (t - ramp / 2)));
  let low = 0, high = route.samples.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (route.samples[middle]!.distance <= distance) low = middle; else high = middle;
  }
  const a = route.samples[low]!, b = route.samples[high]!;
  const p = a.p + (b.p - a.p) * (distance - a.distance) / (b.distance - a.distance || 1);
  return { ...pathAt(route.curves, p), distance: distance / unit };
}

function touchPose(time: number) {
  let offset: number | undefined;
  for (const start of touchOffsets) { if (time >= start) offset = start; }
  if (offset === undefined || time >= touches) return { tongue: 0, reaction: 0 };
  const t = time - offset;
  const tongue = t < .07 ? ease(t / .07) : t < .14 ? 1 : t < .24 ? 1 - ease((t - .14) / .1) : 0;
  // The icon responds only once the tongue arrives, then gently settles as it retracts.
  const reaction = t < .07 || t >= .30 ? 0 : Math.sin((t - .07) / .23 * Math.PI) ** 2;
  return { tongue, reaction };
}

export function createLizardScene(layer: HTMLDivElement, targets: SVGSVGElement[], onFinish: () => void) {
  // A fresh SVG per run makes effect cleanup/re-creation safe under React StrictMode.
  // This is a bundled local asset, never user-provided markup.
  layer.innerHTML = `<div class="hero-lizard-actor">${artwork}</div><span class="hero-lizard-contact"></span>`;
  // Exclude the scrollbar so the decorative overlay cannot create horizontal scrolling.
  layer.style.width = `${document.documentElement.clientWidth}px`;
  const actor = layer.querySelector<HTMLDivElement>(".hero-lizard-actor")!;
  const svg = actor.querySelector("svg")!;
  const heads = svg.querySelectorAll<SVGElement>(".pico-head");
  const glow = layer.querySelector<HTMLSpanElement>(".hero-lizard-contact")!;
  svg.classList.add("is-scripted", "is-running", "is-paused");
  svg.setAttribute("aria-hidden", "true");
  svg.pauseAnimations();
  Object.assign(svg.style, { width: `${300 * unit}px`, height: `${600 * unit}px`, left: `${-146 * unit}px`, top: `${-56 * unit}px` });
  const gait = createLizardGroundedGait(svg);
  let contacts: Point[] = [], stops: Point[] = [], routes: ReturnType<typeof measure>[] = [];
  let time = 0, frame = 0, previous: number | null = null, paused = true, destroyed = false, dirty = true;

  function geometry() {
    const bounds = layer.getBoundingClientRect();
    contacts = targets.map(target => {
      const rect = target.getBoundingClientRect();
      return { x: rect.left - bounds.left + rect.width / 2, y: rect.top - bounds.top + rect.height / 2 };
    });
    const offset = tongueOffset();
    stops = contacts.map(contact => ({ x: contact.x - offset.x, y: contact.y - offset.y }));
    const lane = Math.max(...targets.map(target => target.closest("a")!.getBoundingClientRect().bottom - bounds.top)) + 30;
    const points = [{ x: -60, y: lane }, ...stops, { x: bounds.width + 200, y: lane }];
    routes = points.slice(1).map((end, index) => {
      const start = points[index]!, reach = (end.x - start.x) / 3;
      if (index > 0 && index < stops.length) {
        // Dip below the labels between stops, keeping a horizontal tangent at both icons.
        const middle = { x: (start.x + end.x) / 2, y: lane };
        const bend = (end.x - start.x) / 6;
        return measure([
          [start, { x: start.x + bend, y: start.y }, { x: middle.x - bend, y: lane }, middle],
          [middle, { x: middle.x + bend, y: lane }, { x: end.x - bend, y: end.y }, end],
        ]);
      }
      return measure([[start, { x: start.x + reach, y: start.y }, { x: end.x - reach, y: end.y }, end]]);
    });
    gait.reset();
    dirty = false;
  }

  function sample(elapsed: number): Pose | null {
    let distance = 0;
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i]!;
      if (elapsed < route.duration) {
        const point = travel(route, elapsed);
        return { ...point, distance: distance + point.distance, running: true, look: 0, tongue: 0, reaction: 0, target: i };
      }
      elapsed -= route.duration;
      distance += route.length / unit;
      if (i < stops.length) {
        if (elapsed < stopDuration) {
          const turning = clamp((elapsed - arrivePause) / turn);
          const look = elapsed < arrivePause + turn
            ? turning < .7 ? (aim - 6) * ease(turning / .7) : aim - 6 + 6 * ease((turning - .7) / .3)
            : elapsed < straightenStart ? aim : aim * (1 - ease((elapsed - straightenStart) / straighten));
          return { ...stops[i]!, angle: 90, distance, running: false, look, ...touchPose(elapsed - touchStart), target: i };
        }
        elapsed -= stopDuration;
      }
    }
    return null;
  }

  function render(pose: Pose) {
    svg.classList.toggle("is-paused", !pose.running);
    if (pose.running) svg.unpauseAnimations(); else svg.pauseAnimations();
    gait.draw(pose, unit);
    actor.style.transform = `translate(${pose.x}px,${pose.y}px) rotate(${pose.angle}deg)`;
    heads.forEach(head => { head.style.transform = `rotate(${pose.look}deg)`; });
    svg.style.setProperty("--pico-tongue-extension", String(pose.tongue));
    const contact = contacts[pose.target];
    targets.forEach((target, index) => target.style.setProperty("--lizard-icon-pulse", String(index === pose.target ? pose.reaction : 0)));
    glow.style.opacity = String(pose.reaction * .65);
    glow.style.transform = `translate(-50%, -50%) scale(${.85 + pose.reaction * .25})`;
    if (contact) { glow.style.left = `${contact.x}px`; glow.style.top = `${contact.y}px`; }
  }

  function tick(now: number) {
    frame = 0;
    if (destroyed || paused) return;
    if (dirty) geometry();
    if (previous !== null) time += Math.min((now - previous) / 1000, .05);
    previous = now;
    const pose = sample(time);
    if (!pose) { destroy(); onFinish(); return; }
    render(pose);
    frame = requestAnimationFrame(tick);
  }

  function setPaused(value: boolean) {
    if (destroyed) return;
    paused = value;
    previous = null;
    if (value) {
      cancelAnimationFrame(frame); frame = 0;
      svg.classList.add("is-paused"); svg.pauseAnimations();
    } else if (!frame) frame = requestAnimationFrame(tick);
  }

  function destroy() {
    destroyed = true;
    cancelAnimationFrame(frame);
    resize.disconnect();
    svg.pauseAnimations();
    targets.forEach(target => target.style.removeProperty("--lizard-icon-pulse"));
    layer.replaceChildren();
    layer.style.removeProperty("width");
  }

  const resize = new ResizeObserver(() => {
    layer.style.width = `${document.documentElement.clientWidth}px`;
    dirty = true;
  });
  resize.observe(document.documentElement);
  resize.observe(layer);
  targets.forEach(target => resize.observe(target));
  return { setPaused, destroy };
}
