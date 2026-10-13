import {CircleDollarSign, Coins, Diamond, type LucideIcon} from "lucide-react";

export type TopUpProvider = {
  id: string;
  name: string;
  kind: "faucet" | "exchange";
  url: string;
  widget?: { kind: "changelly"; url: string }
};
export type TokenPresentation = {
  name?: string;
  icon: LucideIcon;
  iconUrl?: string;
  color?: string;
  topUpProviders?: TopUpProvider[]
};
// Presentation only. Contract permissions, decimals and balances always come from chain reads.
// Keys are chain ID + lowercase contract address; the zero address represents MON.
// Put reviewed logo files in public/tokens and set iconUrl (e.g. /tokens/usdc.svg).
// Never assign a logo using a token's self-reported symbol.
// topUpProviders: faucets on testnet, exchanges/on-ramps on mainnet. Omit when unavailable.
// Multiple providers render as tabs. Optional Changelly widget.url must be generated
// using your merchant ID and verified destination asset/network; it supplies the
// provider UI for from/to currencies, amount and exchange action. The wallet address
// is inserted into its documented address parameter. Never reuse testnet providers on mainnet.
// Configure mainnet destinations separately under their own chain ID.
export const tokenIcons: Record<number, Record<string, TokenPresentation>> = {
  10143: {
    "0x0000000000000000000000000000000000000000": {
      name: "Monad",
      icon: Diamond,
      iconUrl: "/tokens/mon.svg",
      topUpProviders: [{id: "monad", name: "Monad faucet", kind: "faucet", url: "https://faucet.monad.xyz/"}],
      color: "#836ef9"
    },
    "0x534b2f3a21130d7a60830c2df862319e593943a3": {
      name: "USDC",
      icon: CircleDollarSign,
      iconUrl: "/tokens/usdc.svg",
      topUpProviders: [{id: "circle", name: "Circle faucet", kind: "faucet", url: "https://faucet.circle.com/"}],
      color: "#2775ca"
    },
    "0xe12009f8e253760e32f1cd2ba12f813381750049": {
      name: "PayUnlock Test USD",
      icon: CircleDollarSign,
      color: "#2775ca"
    },
  },
};

export function tokenPresentation(chainId: number, address: string): TokenPresentation {
  return tokenIcons[chainId]?.[address.toLowerCase()] ?? {icon: Coins};
}
