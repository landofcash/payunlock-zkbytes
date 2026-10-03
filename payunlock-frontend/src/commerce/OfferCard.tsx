import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { truncateText } from "@/lib/truncate-text";
import type { Product } from "./client";
import { OfferCover } from "./OfferImages";
import { OfferPrice } from "./OfferPrice";

export function OfferCard({ product, to }: { product: Product; to?: string }) {
  return <Link className="card offer-card" to={to ?? `/products/${product.id}`}>
    <OfferCover images={product.images ?? []} title={product.title} />
    <div className="offer-card-content"><h3>{product.title}</h3><p>{truncateText(product.description, 180)}</p>
      <OfferPrice product={product} />
      <div className="offer-card-footer"><span>{product.sale?.status === "indexed" ? product.sale.productState === 1 ? "Available" : "Sales paused" : "Syncing"}</span><ArrowRight size={18} aria-hidden="true" /></div>
    </div>
  </Link>;
}
