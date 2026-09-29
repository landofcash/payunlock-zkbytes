import { useEffect, useState } from "react";
import { formatUnits } from "ethers";
import { CalendarDays, Clock, CircleHelp, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyableField } from "@/components/CopyableField";
import { tokenPresentation } from "@/config/token-icons";
import { useCommerce, type Product } from "./client";
import { TimingHelpDialog } from "./TimingHelpDialog";

import { OfferGallery } from "./OfferImages";
export function OfferReview({ product, defaultReview, publicPreview = false, assetDetails, compact = false, seller }: { product: Product; defaultReview?: string; publicPreview?: boolean; compact?: boolean; seller?: string; assetDetails?: { symbol: string; decimals: number } }) {
  const api = useCommerce(), terms = product.draftTerms!;
  const [asset, setAsset] = useState<{ symbol: string; decimals: number }>(), [error, setError] = useState(false);
  const [help, setHelp] = useState<"event" | "review">();
  useEffect(() => { if (publicPreview) { setAsset(assetDetails); setError(false); return; } let live = true; setAsset(undefined); setError(false); void api.request<{ symbol: string; decimals: number }>(`/assets/${terms.token}`).then(value => { if (live) setAsset(value); }).catch(() => { if (live) setError(true); }); return () => { live = false; }; }, [terms.token, publicPreview, assetDetails?.symbol, assetDetails?.decimals]);
  const presentation = tokenPresentation(10143, terms.token), TokenIcon = presentation.icon;
  const review = terms.reviewWindow ?? defaultReview;
  const duration = review === undefined ? "Loading..." : BigInt(review) % 3600n === 0n ? `${BigInt(review) / 3600n} hours` : BigInt(review) % 60n === 0n ? `${BigInt(review) / 60n} minutes` : `${review} seconds`;
  const price = asset && asset.decimals <= 80 ? formatUnits(terms.price, asset.decimals).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1") : undefined;
  return <div className={publicPreview && product.images?.length && !compact ? "offer-visual-summary" : undefined}>
    {!compact && <OfferGallery images={product.images ?? []} title={product.title} />}
    <div className="offer-summary-copy"><div className="offer-review-heading"><h2>{product.title}</h2><div className="offer-review-price" aria-label="Price">
      {presentation.iconUrl ? <img src={presentation.iconUrl} alt="" width={28} height={28} /> : <TokenIcon size={28} aria-hidden="true" style={{ color: presentation.color }} />}
      <span>{price !== undefined ? <>{price} <span className="offer-review-symbol">{asset!.symbol}</span></> : error ? "Unable to load token details" : "Loading..."}</span>
    </div></div>
    {!compact && product.description && <p className="offer-review-description">{product.description}</p>}
    {!compact && <dl className="offer-review-timing">
      {terms.eventEnd && <div><dt><CalendarDays size={17} aria-hidden="true" />Event end<Button icon={CircleHelp} variant="ghost" size="icon" aria-label="About event end" onClick={() => setHelp("event")} /></dt><dd>{new Date(Number(terms.eventEnd) * 1000).toLocaleString()}</dd></div>}
      <div><dt><Clock size={17} aria-hidden="true" />Review period<Button icon={CircleHelp} variant="ghost" size="icon" aria-label="About review period" onClick={() => setHelp("review")} /></dt><dd>{duration}{terms.reviewWindow === null ? " (default)" : ""}</dd></div>
      {seller && <div><dt><Store size={17} aria-hidden="true" />Seller</dt><dd><CopyableField label="Seller" value={seller} displayValue={`${seller.slice(0, 6)}...${seller.slice(-4)}`} /></dd></div>}
    </dl>}
    {help && <TimingHelpDialog readOnly={publicPreview} topic={help} onClose={() => setHelp(undefined)} />}
    </div>
  </div>;
}
