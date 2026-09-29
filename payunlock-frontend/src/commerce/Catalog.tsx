import { RefreshCw as ButtonRefreshCw, ArrowRight as ButtonArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ArrowRight, Box, LockKeyhole, ShieldCheck } from "lucide-react";
import { DeliveryIllustration } from "@/components/Visuals";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useCommerce, type Page, type Product } from "./client";
import { Feedback, useTask } from "./ui";
import { OfferCover } from "./OfferImages";
import { OfferPrice } from "./OfferPrice";
export function Catalog() {
  return <><div className="hero-grid"><section className="hero"><p className="eyebrow"><span className="live-dot" /> PRIVATE BY DESIGN</p><h1>Worth discovering.<br /><span>Yours to unlock.</span></h1><p className="intro">Digital products, private events, and ideas worth sharing. Buy from creators and receive your content privately.</p><div className="actions"><Link className="button" to="/create"><Box aria-hidden="true" />Create an offer</Link><Link className="button secondary" to="/discover"><ArrowRight aria-hidden="true" />Explore offers</Link></div><p className="hero-caption"><ShieldCheck size={15} aria-hidden="true" /> Escrow payments <span /> <LockKeyhole size={15} aria-hidden="true" /> Encrypted delivery</p></section><DeliveryIllustration /></div><OfferList /></>;
}
export function OfferList({ showEyebrow = true, headingLevel = "h2" }: { showEyebrow?: boolean; headingLevel?: "h1" | "h2" }) {
  const api = useCommerce(), task = useTask(), [page, setPage] = useState<Page<Product>>({ items: [], nextCursor: null });
  const Heading = headingLevel;
  async function load(after?: string) { const result = await api.read<Page<Product>>(`/products${after ? `?after=${after}` : ""}`); setPage(p => ({ ...result, items: after ? [...p.items, ...result.items] : result.items })); }
  useEffect(() => { void task.run(() => load()); }, []);
  return <section className="offers" id="discover"><div className="section-heading"><div>{showEyebrow && <p className="eyebrow">FROM THE COMMUNITY</p>}<Heading>Discover offers</Heading></div><Button icon={ButtonRefreshCw} variant="secondary" disabled={task.busy} onClick={() => void task.run(() => load())}>Refresh</Button></div><Feedback {...task} /><div className="offer-grid">{page.items.map(p => <Link className="card offer-card" key={p.id} to={`/products/${p.id}`}><OfferCover images={p.images ?? []} title={p.title} /><div className="offer-card-content"><h3>{p.title}</h3><p>{p.description.slice(0, 180)}</p><OfferPrice product={p} /><div className="offer-card-footer"><span>{p.sale?.status === "indexed" ? p.sale.productState === 1 ? "Available" : "Sales paused" : "Syncing"}</span><ArrowRight size={18} aria-hidden="true" /></div></div></Link>)}</div>{!task.busy && !page.items.length && <div className="empty-state"><Box size={32} aria-hidden="true" /><h3>A new space for creators</h3><p>No public offers yet. Yours could be the first.</p></div>}{page.nextCursor && <Button icon={ButtonArrowRight} variant="secondary" disabled={task.busy} onClick={() => void task.run(() => load(page.nextCursor!))}>More offers</Button>}</section>;
}
export { ProductPage } from "./ProductPage";
