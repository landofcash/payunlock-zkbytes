import { RefreshCw as ButtonRefreshCw, ArrowRight as ButtonArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { truncateText } from "@/lib/truncate-text";
import { ArrowDown, ArrowRight, Box } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useCommerce, type Page, type Product } from "./client";
import { Feedback, useTask } from "./ui";
import { OfferCover } from "./OfferImages";
import { OfferPrice } from "./OfferPrice";
import { CatalogHero } from "./CatalogHero";
export function Catalog() {
  return <OfferList showHero />;
}
export function OfferList({ headingLevel = "h2", showHero = false }: { headingLevel?: "h1" | "h2"; showHero?: boolean }) {
  const api = useCommerce(), task = useTask(), [page, setPage] = useState<Page<Product>>({ items: [], nextCursor: null }), [loaded, setLoaded] = useState(false);
  const Heading = headingLevel;
  const offersRef = useRef<HTMLDivElement>(null);
  function scrollToOffers() {
    offersRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }
  async function load(after?: string) { const result = await api.read<Page<Product>>(`/products${after ? `?after=${after}` : ""}`); setPage(p => ({ ...result, items: after ? [...p.items, ...result.items] : result.items })); setLoaded(true); }
  useEffect(() => { void task.run(() => load()); }, []);
  const cards = page.items.map(p => <Link className="card offer-card" key={p.id} to={`/products/${p.id}`}><OfferCover images={p.images ?? []} title={p.title} /><div className="offer-card-content"><h3>{p.title}</h3><p>{truncateText(p.description, 180)}</p><OfferPrice product={p} /><div className="offer-card-footer"><span>{p.sale?.status === "indexed" ? p.sale.productState === 1 ? "Available" : "Sales paused" : "Syncing"}</span><ArrowRight size={18} aria-hidden="true" /></div></div></Link>);
  const heading = <div className="section-heading"><Heading>{showHero ? <button type="button" className="offers-scroll-link" onClick={scrollToOffers}><ArrowDown aria-hidden="true" /><span>Top Offers</span><ArrowDown aria-hidden="true" /></button> : "Discover offers"}</Heading><Button icon={ButtonRefreshCw} iconSpinning={task.busy} variant={showHero ? "ghost" : "secondary"} size={showHero ? "icon" : "default"} aria-label="Refresh" title={showHero ? "Refresh offers" : undefined} disabled={task.busy} onClick={() => void task.run(() => load())}>{!showHero && "Refresh"}</Button></div>;
  const feedback = <><Feedback {...task} busy={task.busy && !loaded} />{loaded && !page.items.length && <div className="empty-state"><Box size={32} aria-hidden="true" /><h3>A new space for creators</h3><p>No public offers yet. Yours could be the first.</p></div>}</>;
  return <>{showHero && <div className="homepage-hero"><CatalogHero /></div>}<section className="offers" id="discover">{heading}{feedback}<div className="offer-grid" ref={offersRef}>{cards}</div>{page.nextCursor && <Button icon={ButtonArrowRight} variant="secondary" disabled={task.busy} onClick={() => void task.run(() => load(page.nextCursor!))}>More offers</Button>}</section></>;
}
export { ProductPage } from "./ProductPage";
