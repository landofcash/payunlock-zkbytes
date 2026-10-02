import { ArrowRight, Box } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { DiaTextReveal } from "@/components/ui/dia-text-reveal";
import { Highlighter } from "@/components/ui/highlighter";

const revealColors = ["var(--accent)", "var(--accent-soft)", "var(--text)", "var(--accent)"];

const slides = [
  {
    title: "A regular marketplace.\nWithout a centralized platform.",
    description: "Minimal fees and direct payments. The flow of funds is programmed into the smart contract, so payments can’t be delayed, redirected, or lost.",
    highlight: "direct payments",
  },
  {
    title: "Small offers.\nStill profitable.",
    description: "If the price is one dollar, the seller receives 99 cents and just one cent goes to fees.",
    highlight: "99 cents",
  },
  {
    title: "Every purchase.\nProtected by escrow.",
    description: "The payment is held in escrow until the buyer confirms receipt.\nThe buyer and seller can discuss any issues and try to reach a solution. Unresolved disputes can be escalated to arbitration.",
    highlight: "held in escrow",
  },
  {
    title: "Your orders. Your conversations.\nPrivate by design.",
    description: "Privacy is built into the protocol with end-to-end encryption. Order details and all communication remain encrypted and accessible only to the buyer and seller.",
    highlight: "end-to-end encryption",
  },
];

function HighlightedDescription({ text, highlight, active }: { text: string; highlight: string; active: boolean }) {
  const parts = text.split(/(minimal fees|direct payments|99 cents|one cent|held in escrow|arbitration|end-to-end encryption|only to the buyer and seller)/gi);
  return <>{parts.map((part, index) => {
    if (!(index % 2)) return part;
    if (active && part.toLowerCase() === highlight) return <Highlighter key={index} action="underline" color="var(--accent)" strokeWidth={1.5} animationDuration={750} iterations={1}><strong>{part}</strong></Highlighter>;
    return <strong key={index}>{part}</strong>;
  })}</>;
}

export function CatalogHero() {
  const [active, setActive] = useState(0);
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (hovered || focused || hidden || reducedMotion) return;
    const timer = window.setTimeout(() => setActive(index => (index + 1) % slides.length), 10000);
    return () => window.clearTimeout(timer);
  }, [active, hovered, focused, hidden, reducedMotion]);

  return <section className="hero" aria-label="About PayUnlock" aria-roledescription="carousel"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <div className="hero-backdrop" aria-hidden="true">
      <svg viewBox="0 0 640 520" preserveAspectRatio="none" fill="none" focusable="false">
        <path d="M-80 410C140 600 650 480 550 180C510 60 370-30 220-70" />
        <path d="M-80 450C160 650 710 510 595 180C550 45 390-55 230-95" />
        <path d="M-80 490C180 700 770 540 640 180C590 30 410-80 240-120" />
      </svg>
    </div>
    <div className="hero-slides">
      {slides.map((slide, index) => {
        const [lead, ...details] = slide.description.split(/(?<=[.!?])\s+/);
        return <div key={slide.title} className={`hero-slide${active === index ? " is-active" : ""}`}
        role="group" aria-roledescription="slide" aria-label={`${index + 1} of ${slides.length}`} aria-hidden={active !== index} inert={active !== index}>
        <h1><span className="hero-headline-gradient">{slide.title.split("\n")[0]}</span><br />{active === index ? <DiaTextReveal text={slide.title.split("\n")[1]!} colors={revealColors} textColor="var(--accent)" duration={1.35} delay={.15} /> : <span>{slide.title.split("\n")[1]}</span>}</h1>
        <p className="intro"><span className="hero-description-lead"><HighlightedDescription text={lead!} highlight={slide.highlight} active={active === index} /></span>{details.length > 0 && <> <span className="hero-description-detail"><HighlightedDescription text={details.join(" ")} highlight={slide.highlight} active={active === index} /></span></>}</p>
      </div>;
      })}
    </div>
    <div className="hero-slide-controls" aria-label="Hero slideshow controls">
      {slides.map((slide, index) => <button key={slide.title} type="button" className="hero-slide-dot"
        aria-label={`Show message ${index + 1}: ${slide.title.replace("\n", " ")}`} aria-pressed={active === index} onClick={() => setActive(index)}><span /></button>)}
    </div>
    <div className="actions"><Button asChild variant="outline" className="rainbow-button rainbow-outline"><Link to="/create"><Box aria-hidden="true" />Create an offer</Link></Button><Button asChild variant="outline" className="rainbow-button rainbow-outline"><Link to="/discover"><ArrowRight aria-hidden="true" />Explore offers</Link></Button></div>
  </section>;
}
