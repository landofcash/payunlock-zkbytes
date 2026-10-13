import {useEffect, useState} from "react";
import {Link, useParams} from "react-router-dom";
import {ArrowLeft, ArrowRight, RefreshCw} from "lucide-react";
import {Button} from "@/components/ui/button";
import {type Page, type Product, useCommerce} from "./client";
import {useAdministrator} from "./FeaturedAdmin";
import {OfferCard} from "./OfferCard";
import {OfferGallery} from "./OfferImages";
import {OfferReview} from "./OfferReview";
import type {OfferPreview} from "./ProductPage";
import {Feedback, useTask} from "./ui";

export function RestrictedAdmin() {
  const api = useCommerce(), admin = useAdministrator(), task = useTask();
  const [page, setPage] = useState<Page<Product>>({items: [], nextCursor: null}), [loaded, setLoaded] = useState(false);

  async function load(after?: string) {
    const value = await api.request<Page<Product>>(`/admin/restricted${after ? `?after=${after}` : ""}`);
    setPage(previous => ({
      ...value,
      items: after ? [...new Map([...previous.items, ...value.items].map(p => [p.id, p])).values()] : value.items
    }));
    setLoaded(true);
  }

  useEffect(() => {
    if (admin.isAdmin) void task.run(() => load());
  }, [admin.isAdmin]);
  return <section className="commerce-page">
    <div className="section-heading"><h1>Restricted offers</h1><Button asChild variant="ghost"><Link to="/platform">Platform
      administration</Link></Button></div>
    {!admin.ready ? <p role="status">Checking administrator access...</p> : !admin.isAdmin ?
      <p role="alert">Only the platform administrator can view original restricted offers.</p> : <>
        <p>Original content is shown here for administrator review. Open an offer to view its details or remove its
          restriction.</p>
        <Button icon={RefreshCw} variant="secondary" disabled={task.busy}
                onClick={() => void task.run(() => load())}>Refresh</Button>
        <Feedback {...task} />
        {loaded && !page.items.length && <p>No restricted offers.</p>}
        <div className="offers">
          <div className="offer-grid">{page.items.map(product => <div className="featured-admin-item" key={product.id}>
            <OfferCard product={product} to={`/admin/offers/${product.id}`}/>
            <Button asChild variant="ghost"><Link to={`/admin/offers/${product.id}`}>Open original
              details</Link></Button>
          </div>)}</div>
        </div>
        {page.nextCursor && <Button icon={ArrowRight} variant="secondary" disabled={task.busy}
                                    onClick={() => void task.run(() => load(page.nextCursor!))}>More restricted
            offers</Button>}
      </>}
  </section>;
}

type OriginalOffer = { product: Product; version: string; preview: OfferPreview | null };

export function RestrictedOfferPage() {
  const {id} = useParams();
  return id ? <OriginalOfferDetails key={id} id={id}/> : null;
}

function OriginalOfferDetails({id}: { id: string }) {
  const api = useCommerce(), admin = useAdministrator(), task = useTask();
  const [original, setOriginal] = useState<OriginalOffer>();

  async function load() {
    setOriginal(await api.request<OriginalOffer>(`/admin/products/${id}/original`));
  }

  useEffect(() => {
    if (admin.isAdmin) void task.run(load);
  }, [admin.isAdmin]);
  const product = original?.product, preview = original?.preview;
  const terms = preview?.configuration.terms;
  const reviewProduct = product && terms ? {
    ...product,
    draftTerms: {
      token: terms.token,
      price: terms.price,
      eventEnd: terms.hasEventEnd ? terms.eventEnd : null,
      reviewWindow: terms.reviewWindow,
      commitmentWindow: Number(terms.commitmentWindow)
    }
  } : undefined;
  return <section className="commerce-page buyer-offer">
    <Button asChild variant="ghost"><Link to="/admin/restricted"><ArrowLeft aria-hidden="true"/>Restricted offers</Link></Button>
    <div className="section-heading"><h1>Original offer details</h1>{admin.isAdmin && product &&
        <span className="order-badge">{product.restricted ? "Restricted" : "Unrestricted"}</span>}</div>
    {!admin.ready ? <p role="status">Checking administrator access...</p> : !admin.isAdmin ?
      <p role="alert">Only the platform administrator can view original offer details.</p> : <>
        <Feedback {...task} />
        {product && <>
            <section className="card offer-review">{preview && reviewProduct ?
              <OfferReview product={reviewProduct} publicPreview assetDetails={preview.asset}
                           seller={product.seller}/> : <>
                <OfferGallery images={product.images ?? []} title={product.title}/><h2>{product.title}</h2><p
                className="offer-review-description">{product.description}</p>
                <p className="muted">Current sale terms are unavailable. Saved offer terms are shown below.</p>
                {product.draftTerms && <dl className="terms">
                    <dt>Saved price (base units)</dt>
                    <dd>{product.draftTerms.price}</dd>
                    <dt>Payment token</dt>
                    <dd className="address">{product.draftTerms.token}</dd>
                    <dt>Review period</dt>
                    <dd>{product.draftTerms.reviewWindow === null ? "Platform default" : `${product.draftTerms.reviewWindow} seconds`}</dd>
                    <dt>Publication period</dt>
                    <dd>{product.draftTerms.commitmentWindow} seconds</dd>
                  {product.draftTerms.eventEnd && <>
                      <dt>Event end</dt>
                      <dd>{new Date(Number(product.draftTerms.eventEnd) * 1000).toLocaleString()}</dd>
                  </>}</dl>}
              </>}</section>
            <div className="actions">{product.restricted &&
                <Button disabled={task.busy} onClick={() => void task.run(async () => {
                  await api.request(`/admin/products/${id}`, {
                    expectedVersion: original!.version,
                    restricted: false
                  }, "PATCH");
                  await load();
                })}>Remove restriction</Button>}
                <Button icon={RefreshCw} variant="secondary" disabled={task.busy} onClick={() => void task.run(load)}>Reload
                    details</Button>
              {product.visibility !== "draft" &&
                  <Button asChild variant="ghost"><Link to={`/products/${id}`}>Open public offer page</Link></Button>}
            </div>
        </>}
        {!product && task.error && <Button icon={RefreshCw} variant="secondary" disabled={task.busy}
                                           onClick={() => void task.run(load)}>Retry</Button>}
      </>}
  </section>;
}
