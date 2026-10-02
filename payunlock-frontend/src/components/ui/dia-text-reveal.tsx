// Adapted from Magic UI (MIT); see licenses/magicui.txt.
import { useEffect, useRef } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { cn } from "@/lib/utils";

const DEFAULT_COLORS = ["#c679c4", "#fa3d1d", "#ffb005", "#e1e1fe", "#0358f7"];
const BAND_HALF = 17, SWEEP_START = -BAND_HALF, SWEEP_END = 100 + BAND_HALF;

function buildGradient(position: number, colors: string[], textColor: string) {
  const start = position - BAND_HALF, end = position + BAND_HALF;
  if (start >= 100) return `linear-gradient(90deg, ${textColor}, ${textColor})`;
  const stops: string[] = [];
  if (start > 0) stops.push(`${textColor} 0%`, `${textColor} ${start.toFixed(2)}%`);
  colors.forEach((color, index) => {
    const stop = colors.length === 1 ? position : start + index / (colors.length - 1) * BAND_HALF * 2;
    stops.push(`${color} ${stop.toFixed(2)}%`);
  });
  if (end < 100) stops.push(`transparent ${end.toFixed(2)}%`, "transparent 100%");
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

type DiaTextRevealProps = {
  text: string;
  colors?: string[];
  textColor?: string;
  duration?: number;
  delay?: number;
  className?: string;
};

// The carousel owns rotation; this single-text adaptation plays once per mount.
export function DiaTextReveal({ text, colors = DEFAULT_COLORS, textColor = "var(--text)", duration = 1.2, delay = 0, className }: DiaTextRevealProps) {
  const reducedMotion = useReducedMotion();
  const options = useRef({ colors, textColor });
  options.current = { colors, textColor };
  const position = useMotionValue(SWEEP_START);
  const backgroundImage = useTransform(position, value => buildGradient(value, options.current.colors, options.current.textColor));
  useEffect(() => {
    if (reducedMotion) { position.set(SWEEP_END); return; }
    position.set(SWEEP_START);
    const controls = animate(position, SWEEP_END, {
      duration, delay,
      ease: value => value < .5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2,
    });
    return () => controls.stop();
  }, [text, duration, delay, reducedMotion, position]);

  if (reducedMotion) return <span className={cn("dia-text-reveal", className)} style={{ color: textColor }}>{text}</span>;

  return <motion.span className={cn("dia-text-reveal", className)}
    style={{ color: "transparent", backgroundClip: "text", WebkitBackgroundClip: "text", backgroundImage }}>
    {text}
  </motion.span>;
}
