import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, Navigate, useLocation } from "react-router-dom";
import { ArrowUpRight, ShieldCheck, Compass, ShoppingBag, Wallet } from "lucide-react";
import { ThemeProvider, ThemePicker } from "./app/theme";
import { HealthResponseSchema } from "@payunlock/api-contracts";
import { lazy, Suspense } from "react";
import { CommerceProvider, ProtectedAccess } from "./commerce/client";
import { ApprovalProvider } from "./wallet/ApprovalProvider";
import { Catalog, ProductPage } from "./commerce/Catalog";
import { SellerEditor } from "./commerce/Seller";
import { Orders, OrderPage, BuyerOrderPage, SellerOrderPage, ArbitratorOrderPage } from "./commerce/Orders";
import { BulkDelivery } from "./commerce/BulkDelivery";
import { MyOffers } from "./commerce/MyOffers";
import { Platform } from "./commerce/Platform";
import { useSession } from "./wallet/session-store";
import { SellerMenu } from "./app/SellerMenu";
import { Discover } from "./commerce/Discover";
const WalletMenu = lazy(() => import("./wallet/WalletPage").then(module => ({ default: module.WalletMenu })));

export function App({ apiOrigin, walletsEnabled = false }: { apiOrigin: string; walletsEnabled?: boolean }) {
  return <ThemeProvider><AppShell apiOrigin={apiOrigin} walletsEnabled={walletsEnabled} /></ThemeProvider>;
}
function AppShell({ apiOrigin, walletsEnabled }: { apiOrigin: string; walletsEnabled: boolean }) {
  const wallet = useSession();
  const location = useLocation();
  const previousPath = useRef(location.pathname);
  useEffect(() => {
    if (previousPath.current !== location.pathname) document.getElementById("main-content")?.focus({ preventScroll: true });
    previousPath.current = location.pathname;
  }, [location.pathname]);
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
  return <ApprovalProvider><CommerceProvider origin={apiOrigin}><div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header><Link className="brand" to="/" aria-label="PayUnlock home"><span className="brand-icon" aria-hidden="true" />PayUnlock</Link>
      <nav aria-label="Main navigation"><NavLink to="/discover"><Compass aria-hidden="true" />Discover</NavLink><NavLink to="/purchases"><ShoppingBag aria-hidden="true" />Purchases</NavLink><SellerMenu /></nav>
      <div className="header-actions"><ThemePicker />{walletsEnabled && <Suspense fallback={<span className="wallet-nav"><Wallet size={17} aria-hidden="true" />Sign in</span>}><WalletMenu /></Suspense>}</div>
    </header>
    <main id="main-content" tabIndex={-1}><Routes key={location.pathname === "/create" ? "create" : `${wallet.sessionEpoch}:${wallet.identityEpoch}`}>
      <Route path="/" element={<Catalog />} />
      <Route path="/discover" element={<Discover />} />
      <Route path="/purchases" element={<Orders role="buyer" />} />
      <Route path="/sales" element={<Orders role="seller" />} />
      <Route path="/offers" element={<MyOffers />} />
      <Route path="/arbitration" element={<Orders role="arbitrator" />} />
      <Route path="/platform" element={<Platform />} />
      <Route path="/products/:id" element={<ProductPage />} />
      <Route path="/create" element={<SellerEditor />} />
      <Route path="/sales/products/:id" element={<ProtectedAccess label="Manage offer"><SellerEditor /></ProtectedAccess>} />
      <Route path="/sales/products/:id/orders" element={<ProtectedAccess label="Prepare deliveries"><BulkDelivery /></ProtectedAccess>} />
      <Route path="/purchases/:id" element={<BuyerOrderPage />} />
      <Route path="/sales/orders/:id" element={<SellerOrderPage />} />
      <Route path="/arbitration/:id" element={<ArbitratorOrderPage />} />
      <Route path="/orders/:id" element={<OrderPage />} />
      <Route path="/wallet" element={walletsEnabled ? <Navigate to="/?wallet=open" replace /> : <EmptyPage title="Wallet unavailable" description="Wallets are not enabled in this environment." />} />
      <Route path="*" element={<EmptyPage title="Page not found" description="Use Discover to return to the home page." />} />
    </Routes></main>
    <footer><span><ShieldCheck size={16} /> Private delivery with zkbytes</span><span role="status">{availability}</span></footer>
  </div></CommerceProvider></ApprovalProvider>;
}
function EmptyPage({ title, description }: { title: string; description: string }) {
  return <section className="page-intro"><p className="eyebrow">PAYUNLOCK</p><h1>{title}</h1><p>{description}</p><Link className="discover-link" to="/">Back to Discover <ArrowUpRight size={18} /></Link></section>;
}
