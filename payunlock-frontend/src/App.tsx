import { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { ArrowUpRight, LockKeyhole, PackageOpen, ShieldCheck } from "lucide-react";
import { HealthResponseSchema } from "@payunlock/api-contracts";
import { lazy, Suspense } from "react";
const WalletPage = lazy(() => import("./wallet/WalletPage").then(module => ({ default: module.WalletPage })));

export function App({ apiOrigin, walletsEnabled = false }: { apiOrigin: string; walletsEnabled?: boolean }) {
  const [availability, setAvailability] = useState("Connecting");
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${apiOrigin}/health`, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("API unavailable");
      HealthResponseSchema.parse(await response.json());
      setAvailability("Connected");
    }).catch(() => { if (!controller.signal.aborted) setAvailability("Service unavailable"); });
    return () => controller.abort();
  }, [apiOrigin]);
  return <div className="app-shell">
    <header><Link className="brand" to="/" aria-label="PayUnlock home"><span className="brand-icon"><LockKeyhole size={20} /></span>PayUnlock<span className="preview-label">Preview</span></Link>
      <nav aria-label="Main navigation"><NavLink to="/" end>Discover</NavLink><NavLink to="/purchases">Purchases</NavLink><NavLink to="/sales">Sales</NavLink></nav>
      {walletsEnabled && <NavLink to="/wallet">Wallet</NavLink>}<span className="network">Monad Testnet</span>
    </header>
    <main><Routes>
      <Route path="/" element={<><section className="hero"><p className="eyebrow">YOUR NEXT GOOD FIND</p><h1>Worth discovering.<br /><span>Yours to unlock.</span></h1><p className="intro">Digital products, private events, and ideas worth sharing. A place to buy from creators and receive your content privately.</p><a className="discover-link" href="#offers">Explore offers <ArrowUpRight size={18} /></a></section><section id="offers" className="offers"><div className="section-heading"><h2>Discover offers</h2><span>Coming soon</span></div><div className="empty-state"><PackageOpen size={36} strokeWidth={1.3} /><h3>A new space for creators</h3><p>Offers and purchasing will be available in a future preview.</p></div></section></>} />
      <Route path="/purchases" element={<EmptyPage title="Your purchases" description="Your orders and private deliveries will appear here once purchasing is available." />} />
      <Route path="/sales" element={<EmptyPage title="Your sales" description="Your offers, paid orders, and delivery tools will be available here." />} />
      <Route path="/wallet" element={walletsEnabled ? <Suspense fallback={<p>Opening wallet…</p>}><WalletPage /></Suspense> : <EmptyPage title="Wallet unavailable" description="Wallets are not enabled in this environment." />} />
      <Route path="*" element={<EmptyPage title="Page not found" description="Use Discover to return to the home page." />} />
    </Routes></main>
    <footer><span><ShieldCheck size={16} /> Private delivery with zkbytes</span><span role="status">{availability}</span></footer>
  </div>;
}
function EmptyPage({ title, description }: { title: string; description: string }) {
  return <section className="page-intro"><p className="eyebrow">PAYUNLOCK</p><h1>{title}</h1><p>{description}</p><Link className="discover-link" to="/">Back to Discover <ArrowUpRight size={18} /></Link></section>;
}
