import {useEffect, useRef, useState} from "react";
import {Link, useSearchParams} from "react-router-dom";
import {ArrowRight, FilePenLine, Package, Plus, RefreshCw, Settings2} from "lucide-react";
import {Button} from "@/components/ui/button";
import {truncateText} from "@/lib/truncate-text";
import {type Page, type Product, ProtectedAccess, useCommerce} from "./client";
import {Feedback, useTask} from "./ui";

import {OfferCover} from "./OfferImages";

export function MyOffers() {
  const [query] = useSearchParams();
  const filter = query.get("filter") === "draft" ? "draft" : query.get("filter") === "published" ? "published" : "all";
  return <section className="commerce-page">
    <div className="section-heading"><h1>My offers</h1><Button asChild><Link to="/create"><Plus aria-hidden="true"/>Create
      offer</Link></Button></div>
    <ProtectedAccess label="Open my offers" description="Sign in to view your saved drafts and manage your offers.">
      <OfferList key={filter} filter={filter}/>
    </ProtectedAccess>
  </section>;
}

function OfferList({filter}: { filter: "all" | "draft" | "published" }) {
  const api = useCommerce(), task = useTask(), live = useRef(true);
  const [page, setPage] = useState<Page<Product>>({items: [], nextCursor: null}), [loaded, setLoaded] = useState(false);

  async function load(after?: string) {
    const result = await api.request<Page<Product>>(`/seller/products?filter=${filter}${after ? `&after=${after}` : ""}`);
    if (live.current) {
      setPage(previous => ({...result, items: after ? [...previous.items, ...result.items] : result.items}));
      setLoaded(true);
    }
  }

  useEffect(() => {
    live.current = true;
    void task.run(() => load());
    return () => {
      live.current = false;
    };
  }, []);
  return <>
    <div className="offers-list-toolbar">
      <nav className="offer-filters" aria-label="Offer filters">{(["all", "draft", "published"] as const).map(value =>
        <Link key={value} to={`/offers?filter=${value}`}
              aria-current={filter === value ? "page" : undefined}>{value === "all" ? "All" : value === "draft" ? "Drafts" : "Published"}</Link>)}</nav>
      <Button icon={RefreshCw} iconSpinning={task.busy} variant="ghost" disabled={task.busy}
              onClick={() => void task.run(() => load())}>Refresh offers</Button></div>
    <Feedback {...task} busy={task.busy && !loaded}/>
    <div className="offer-grid">{page.items.map(product => {
      const draft = product.visibility === "draft";
      return <article className="card seller-offer-card" key={product.id}>
        <span
          className={`seller-offer-badge ${draft ? "is-draft" : ""}`}>{draft ? "Draft" : product.visibility === "hidden" ? "Published · Hidden" : "Published"}</span>
        <OfferCover images={product.images ?? []} title={product.title}/><h3>{product.title}</h3>{product.description &&
          <p>{truncateText(product.description, 160)}</p>}
        <div className="actions"><Button asChild variant={draft ? "default" : "secondary"}><Link
          to={`/sales/products/${product.id}`}>{draft ? <FilePenLine aria-hidden="true"/> :
          <Settings2 aria-hidden="true"/>}{draft ? "Continue editing" : "Manage offer"}</Link></Button>
          {!draft && <Button asChild variant="ghost"><Link to={`/sales/products/${product.id}/orders`}><Package
              aria-hidden="true"/>Deliver orders</Link></Button>}
        </div>
      </article>;
    })}</div>
    {loaded && !task.error && !page.items.length &&
        <div className="empty-state"><FilePenLine size={28} aria-hidden="true"/>
            <h3>{filter === "draft" ? "No saved drafts" : filter === "published" ? "No published offers" : "No offers yet"}</h3>
            <p>{filter === "published" ? "Finish a draft and publish it to see it here." : "Create an offer and save it as a draft to continue later."}</p>
        </div>}
    {page.nextCursor && <Button icon={ArrowRight} variant="secondary" disabled={task.busy}
                                onClick={() => void task.run(() => load(page.nextCursor!))}>More offers</Button>}
  </>;
}
