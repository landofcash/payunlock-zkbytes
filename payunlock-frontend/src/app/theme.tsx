// Adapted from Message Lab's data-theme and persistence pattern.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Monitor, MoonStar, Sun, Terminal, type LucideIcon } from "lucide-react";
import { MotionConfig } from "motion/react";
import { Toaster } from "sonner";
import { Button } from "@/components/ui/button";
export const themes = ["light", "terminal", "cyberpunk", "cosmic"] as const;
export type Theme = typeof themes[number];
export const THEME_KEY = "payunlock.theme";
export const isTheme = (value: unknown): value is Theme => themes.includes(value as Theme);
export function initialTheme(): Theme { try { const value = localStorage.getItem(THEME_KEY); return isTheme(value) ? value : "light"; } catch { return "light"; } }
const Context = createContext<{ theme: Theme; setTheme(theme: Theme): void }>({ theme: "light", setTheme: () => {} });
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, update] = useState(initialTheme);
  function setTheme(next: Theme) { update(next); try { localStorage.setItem(THEME_KEY, next); } catch { /* Session-only theme if storage is unavailable. */ } }
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme === "light" ? "light" : "dark"; }, [theme]);
  useEffect(() => { const sync = (event: StorageEvent) => { if (event.key === THEME_KEY) update(isTheme(event.newValue) ? event.newValue : "light"); }; window.addEventListener("storage", sync); return () => window.removeEventListener("storage", sync); }, []);
  return <Context.Provider value={{ theme, setTheme }}><MotionConfig reducedMotion="user" transition={{ duration: .2 }}>{children}<Toaster theme={theme === "light" ? "light" : "dark"} position="bottom-right" closeButton richColors /></MotionConfig></Context.Provider>;
}
export const useTheme = () => useContext(Context);
const icons: Record<Theme, LucideIcon> = { light: Sun, terminal: Terminal, cyberpunk: Monitor, cosmic: MoonStar };
export function ThemePicker() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const title = (value: Theme) => value.charAt(0).toUpperCase() + value.slice(1);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div className="theme-picker" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <Button ref={trigger} icon={icons[theme]} className="theme-trigger" aria-label={`Theme: ${title(theme)}`} title="Choose theme" aria-expanded={open} aria-controls="theme-options" onClick={() => setOpen(value => !value)}><span>Theme</span><ChevronDown aria-hidden="true" /></Button>
    {open && <div id="theme-options" className="theme-options" role="group" aria-label="Choose theme"><p>Appearance</p>{themes.map(value => <Button key={value} icon={icons[value]} data-theme={value} className="theme-option" aria-label={`${title(value)} theme`} aria-pressed={theme === value} onClick={() => { setTheme(value); setOpen(false); trigger.current?.focus(); }}><span>{title(value)}</span><span className="theme-swatches" aria-hidden="true"><i /><i /><i /></span>{theme === value && <Check aria-hidden="true" />}</Button>)}</div>}
  </div>;
}
