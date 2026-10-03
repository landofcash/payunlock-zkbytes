import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCommerce, useCommerceAccess, type Product } from "./client";
import { Feedback, useTask } from "./ui";
import { OfferCard } from "./OfferCard";

export function useAdministrator() {
  const api = useCommerce(), access = useCommerceAccess();
  const [owner, setOwner] = useState<string>();
  const [checkedAddress, setCheckedAddress] = useState<string>();
  const address = access.address?.toLowerCase();
  useEffect(() => {
    let live = true;
    setOwner(undefined); setCheckedAddress(undefined);
    if (address) void api.read<{ owner?: string }>("/platform").then(value => {
      if (live) { setOwner(value.owner?.toLowerCase()); setCheckedAddress(address); }
    }).catch(() => { if (live) setCheckedAddress(address); });
    return () => { live = false; };
  }, [address]);
  return { isAdmin: !!address && checkedAddress === address && owner === address, ready: !address || checkedAddress === address };
}

type FeaturedList = { version: string; items: Product[] };
export function FeaturedAdmin() {
  const api = useCommerce(), admin = useAdministrator(), task = useTask();
  const [saved, setSaved] = useState<FeaturedList>(), [items, setItems] = useState<Product[]>([]);
  async function load() {
    const value = await api.request<FeaturedList>("/admin/featured");
    setSaved(value); setItems(value.items);
  }
  useEffect(() => { if (admin.isAdmin) void task.run(load); }, [admin.isAdmin]);
  function move(from: number, to: number) {
    setItems(previous => { const next = [...previous]; next.splice(to, 0, next.splice(from, 1)[0]!); return next; });
  }
  const changed = !!saved && JSON.stringify(items.map(p => p.id)) !== JSON.stringify(saved.items.map(p => p.id));
  return <section className="commerce-page">
    <div className="section-heading"><h1>Featured offers</h1><Button asChild variant="ghost"><Link to="/platform">Platform administration</Link></Button></div>
    {!admin.ready ? <p role="status">Checking administrator access...</p> : !admin.isAdmin ? <p role="alert">Only the platform administrator can manage featured offers.</p> : <>
      <p>Reorder or remove homepage offers. Add offers from their details page.</p>
      <div className="actions"><Button icon={RefreshCw} variant="secondary" disabled={task.busy} onClick={() => void task.run(load)}>Reload list</Button>
        <Button disabled={task.busy || !changed} onClick={() => void task.run(async () => {
          const value = await api.request<FeaturedList>("/admin/featured", { ids: items.map(p => p.id), expectedVersion: saved!.version }, "PUT");
          setSaved(value); setItems(value.items);
        })}>Save changes</Button></div>
      <Feedback {...task} />
      {saved && !items.length && <p>No featured offers selected.</p>}
      <ol className="offer-grid featured-admin-list">{items.map((product, index) => <li className="featured-admin-item" key={product.id}>
        <OfferCard product={product} />
        <div className="actions">
          <Button icon={ArrowLeft} size="icon" variant="secondary" aria-label={`Move ${product.title} left`} title="Move earlier" disabled={task.busy || index === 0} onClick={() => move(index, index - 1)} />
          <Button icon={ArrowRight} size="icon" variant="secondary" aria-label={`Move ${product.title} right`} title="Move later" disabled={task.busy || index === items.length - 1} onClick={() => move(index, index + 1)} />
          <Button icon={Trash2} size="icon" variant="secondary" aria-label={`Remove ${product.title} from featured`} title="Remove from featured" disabled={task.busy} onClick={() => setItems(previous => previous.filter(p => p.id !== product.id))} />
        </div>
      </li>)}</ol>
    </>}
  </section>;
}

type Moderation = { version: string; restricted: boolean; frontpagePosition: number | null; visibility?: string };
export function OfferAdmin({ product, onChange }: { product: Product; onChange(product: Product): void }) {
  const api = useCommerce(), access = useCommerceAccess(), admin = useAdministrator(), task = useTask();
  const [status, setStatus] = useState<Moderation>();
  async function load() { setStatus(await api.request<Moderation>(`/admin/products/${product.id}`)); }
  useEffect(() => { setStatus(undefined); if (admin.isAdmin && access.authenticated) void task.run(load); }, [product.id, admin.isAdmin, access.authenticated]);
  async function update(change: { featured?: boolean; restricted?: boolean }) {
    const next = await api.request<Moderation>(`/admin/products/${product.id}`, { ...change, expectedVersion: status!.version }, "PATCH");
    setStatus({ ...status, ...next });
    onChange(await api.read<Product>(`/products/${product.id}`));
  }
  if (!admin.isAdmin) return null;
  return <section className="card offer-admin"><h2>Offer administration</h2>
    {!access.authenticated ? <Button disabled={access.busy} onClick={() => access.authorize()}>Sign in to manage this offer</Button> : <>
      {status && <><p>{status.frontpagePosition ? `Homepage position: ${status.frontpagePosition}` : "Not featured on the homepage"}</p>
        <div className="actions"><Button variant="secondary" disabled={task.busy || (!status.frontpagePosition && (status.restricted || status.visibility !== "public"))} onClick={() => void task.run(() => update({ featured: !status.frontpagePosition }))}>{status.frontpagePosition ? "Remove from featured" : "Add to featured"}</Button>
          <Button variant={status.restricted ? "secondary" : "destructive"} disabled={task.busy} onClick={() => void task.run(() => update({ restricted: !status.restricted }))}>{status.restricted ? "Remove restriction" : "Restrict offer"}</Button></div></>}
      <Button icon={RefreshCw} variant="ghost" disabled={task.busy} onClick={() => void task.run(load)}>Reload admin status</Button>
    </>}
    {access.error && <p role="alert">{access.error}</p>}<Feedback {...task} />
    {(status?.restricted ?? product.restricted) && <Button asChild variant="secondary"><Link to={`/admin/offers/${product.id}`}>View original details</Link></Button>}
    <Button asChild variant="ghost"><Link to="/admin/featured">Manage featured order</Link></Button>
  </section>;
}
