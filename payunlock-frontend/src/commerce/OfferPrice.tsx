import {useEffect, useState} from "react";
import {formatUnits, ZeroAddress} from "ethers";
import {tokenPresentation} from "@/config/token-icons";
import {type Product, useCommerce} from "./client";

export function OfferPrice({product}: { product: Product }) {
  const api = useCommerce();
  const terms = product.sale?.terms;
  const [asset, setAsset] = useState<{ symbol: string; decimals: number } | null>();
  useEffect(() => {
    let current = true;
    setAsset(undefined);
    if (!terms) {
      setAsset(null);
      return () => {
        current = false;
      };
    }
    if (terms.token.toLowerCase() === ZeroAddress.toLowerCase()) {
      setAsset({symbol: "MON", decimals: 18});
      return () => {
        current = false;
      };
    }
    void api.read<{ symbol: string; decimals: number }>(`/public/assets/${terms.token}`)
      .then(value => {
        if (current) setAsset(Number.isInteger(value.decimals) && value.decimals >= 0 && value.decimals <= 80 ? value : null);
      })
      .catch(() => {
        if (current) setAsset(null);
      });
    return () => {
      current = false;
    };
  }, [api, terms?.token, terms?.price]);

  const amount = terms && asset
    ? `${formatUnits(terms.price, asset.decimals).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1")} ${asset.symbol}`
    : asset === null ? "Price unavailable" : "Loading price...";
  const presentation = tokenPresentation(10143, terms?.token ?? ""), TokenIcon = presentation.icon;
  return <div className="offer-price" aria-label={`Offer price: ${amount}`}>{presentation.iconUrl ?
    <img src={presentation.iconUrl} alt="" width={16} height={16}/> :
    <TokenIcon size={16} aria-hidden="true" style={{color: presentation.color}}/>}<span>{amount}</span></div>;
}
