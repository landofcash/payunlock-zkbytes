import { useEffect, useId, useRef, useState } from "react";
import { formatUnits, ZeroAddress } from "ethers";
import { ChevronDown, HandCoins, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCommerce } from "@/commerce/client";
import { TopUpDialog } from "./TopUpDialog";
import { tokenPresentation } from "@/config/token-icons";

type Asset = { address: string; symbol: string; decimals: number | null; balance: string | null; allowed: boolean | null };
type Balances = { chainId: number; items: Asset[]; nextCursor: string | null; incomplete: boolean; discoveryAvailable: boolean };
function TokenIcon({ chainId, address }: { chainId: number; address: string }) {
  const entry = tokenPresentation(chainId, address), Icon = entry.icon;
  const [failed, setFailed] = useState(false);
  return <span className="wallet-token-icon" style={{ color: entry.color }}>
    {entry.iconUrl && !failed ? <img src={entry.iconUrl} alt="" onError={() => setFailed(true)} /> : <Icon aria-hidden="true" />}
  </span>;
}
function TokenLabel({ chainId, asset }: { chainId: number; asset: Asset }) {
  const [visible, setVisible] = useState(false), tooltipId = useId();
  const name = tokenPresentation(chainId, asset.address).name ?? asset.symbol;
  return <div className="wallet-token-identity" onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}>
    <Button variant="ghost" className="wallet-token-label" aria-label={`${asset.symbol} token details`} aria-describedby={visible ? tooltipId : undefined} onFocus={() => setVisible(true)} onBlur={() => setVisible(false)} onClick={() => setVisible(true)} onKeyDown={event => { if (event.key === "Escape" && visible) { event.preventDefault(); event.stopPropagation(); setVisible(false); } }}>
      <TokenIcon chainId={chainId} address={asset.address} /><span>{asset.symbol}{asset.address === ZeroAddress && asset.allowed === false && <small>Gas only</small>}</span>
    </Button>
    {visible && <span id={tooltipId} role="tooltip" className="wallet-token-tooltip"><span>{name}</span><code>{asset.address === ZeroAddress ? "Native MON ? no token contract" : asset.address}</code></span>}
  </div>;
}
export function WalletBalances({ address }: { address: string }) {
  const api = useCommerce();
  const [topUpAsset, setTopUpAsset] = useState<Asset>();
  const topUpTrigger = useRef<HTMLButtonElement | null>(null), walletPopover = useRef<HTMLElement | null>(null);
  function closeTopUp() { setTopUpAsset(undefined); if (walletPopover.current?.isConnected) walletPopover.current.showPopover(); topUpTrigger.current?.focus(); }
  const [data, setData] = useState<Balances>(), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const generation = useRef(0), pending = useRef(false);
  async function refresh(after?: string) {
    if (pending.current) return;
    const started = generation.current;
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await api.read<Balances>(`/public/wallets/${address}/balances${after ? `?after=${after}` : ""}`);
      if (started !== generation.current) return;
      setData(previous => after && previous ? { ...result, items: [...previous.items, ...result.items], incomplete: previous.incomplete || result.incomplete } : result);
    } catch { if (started === generation.current) { setError("Balances unavailable. Try refreshing shortly."); if (!after) setData(undefined); } }
    finally { if (started === generation.current) { pending.current = false; setBusy(false); } }
  }
  useEffect(() => {
    generation.current++; pending.current = false; setData(undefined); void refresh();
    const timer = setInterval(() => { void refresh(); }, 30000);
    return () => { generation.current++; clearInterval(timer); };
  }, [address]);
  return <div className="wallet-balance-section" aria-label="Token balances">
    <div className="wallet-balance-heading"><span className="eyebrow">BALANCES</span><Button icon={RefreshCw} variant="ghost" size="icon" title="Refresh balance" aria-label="Refresh balance" disabled={busy} onClick={() => void refresh()} /></div>
    {!data && <p role="status">{busy ? "Loading balances…" : "Balances unavailable"}</p>}
    {data?.items.map(asset => {
      const providers = tokenPresentation(data.chainId, asset.address).topUpProviders;
      return <div className="wallet-balance-row" role="group" aria-label={`${asset.symbol} balance and top up`} key={asset.address}>
      <TokenLabel chainId={data.chainId} asset={asset} />
      <strong title={asset.balance ?? undefined}>{asset.balance === null || asset.decimals === null ? "Unavailable" : formatUnits(asset.balance, asset.decimals)}</strong>
      <Button icon={HandCoins} variant="secondary" size="sm" className="wallet-topup-button" disabled={!providers?.length} title={!providers?.length ? "No top-up service configured for this token" : undefined} aria-label={`Top up ${asset.symbol}${providers?.length ? "" : " unavailable"}`} onClick={event => { topUpTrigger.current = event.currentTarget; walletPopover.current = event.currentTarget.closest<HTMLElement>("[popover]"); walletPopover.current?.hidePopover(); setTopUpAsset(asset); }}>Top up</Button>
    </div>; })}
    {topUpAsset && data && <TopUpDialog key={`${address}:${topUpAsset.address}`} symbol={topUpAsset.symbol} address={address} chainId={data.chainId} providers={tokenPresentation(data.chainId, topUpAsset.address).topUpProviders ?? []} onClose={closeTopUp} />}
    {error && <p role="status">{error}</p>}
    {data?.incomplete && <p className="muted" role="status">{data.discoveryAvailable ? "Some token details are unavailable. Try refreshing." : "Token list unavailable. MON is shown separately; try refreshing."}</p>}
    {data?.nextCursor && <Button icon={ChevronDown} variant="ghost" disabled={busy} onClick={() => void refresh(data.nextCursor!)}>More tokens</Button>}
  </div>;
}
