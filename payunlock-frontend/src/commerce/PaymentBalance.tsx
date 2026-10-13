import {type ReactNode, useEffect, useState} from "react";
import {Check, HandCoins, RefreshCw} from "lucide-react";
import {formatUnits, ZeroAddress} from "ethers";
import {Button} from "@/components/ui/button";
import {CopyableField} from "@/components/CopyableField";
import {AccountNameLabel} from "@/wallet/AccountName";
import {ACCOUNT_NAMES_EVENT, ACCOUNT_NAMES_KEY, savedAccountNames} from "@/wallet/account-names";
import {tokenPresentation} from "@/config/token-icons";
import type {Asset, Configuration} from "./client";

function BalanceRow({chainId, token, symbol, amount, busy, onTopUp, children}: {
  chainId: number; token: string; symbol: string; amount: string; busy: boolean;
  onTopUp(asset: { token: string; symbol: string }): void; children?: ReactNode;
}) {
  const [iconFailed, setIconFailed] = useState(false);
  const presentation = tokenPresentation(chainId, token), TokenIcon = presentation.icon;
  return <div className="buyer-balance-row" role="group" aria-label={symbol + " balance"}>
    <div className="buyer-balance-token"><span
      style={{color: presentation.color}}>{presentation.iconUrl && !iconFailed ?
      <img src={presentation.iconUrl} alt="" onError={() => setIconFailed(true)}/> :
      <TokenIcon aria-hidden="true"/>}</span><span>{symbol}</span></div>
    <strong className="buyer-balance-amount">{amount} {symbol}</strong>
    {!!presentation.topUpProviders?.length &&
        <Button icon={HandCoins} variant="secondary" size="sm" disabled={busy} onClick={() => onTopUp({token, symbol})}>Top
            up {symbol}</Button>}
    {children}
  </div>;
}

export function PaymentBalance({address, asset, configuration, selfPay, feeChoice, busy, error, onRefresh, onTopUp}: {
  address: string | null; asset?: Asset; configuration: Configuration; selfPay: boolean;
  feeChoice?: { disabled: boolean; onChange(value: boolean): void }; busy: boolean; error: string;
  onRefresh(): void; onTopUp(asset: { token: string; symbol: string }): void;
}) {
  const [names, setNames] = useState(savedAccountNames);
  useEffect(() => {
    const refresh = () => setNames(savedAccountNames());
    const sync = (event: StorageEvent) => {
      if (event.key === ACCOUNT_NAMES_KEY || event.key === null) refresh();
    };
    refresh();
    window.addEventListener(ACCOUNT_NAMES_EVENT, refresh);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(ACCOUNT_NAMES_EVENT, refresh);
      window.removeEventListener("storage", sync);
    };
  }, [address]);
  const shortfall = asset ? BigInt(configuration.terms.price) - BigInt(asset.balance) : undefined;
  const [expanded, setExpanded] = useState(() => shortfall !== undefined && shortfall > 0n);
  useEffect(() => {
    setExpanded(shortfall !== undefined && shortfall > 0n);
  }, [shortfall]);
  return <section className="buyer-balances" aria-label="Your balance">
    <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary><span>Your balance</span>{asset ?
        <span className={`buyer-balance-readiness ${shortfall! > 0n ? "is-low" : "is-ready"}`} role="status"
              aria-label="Purchase balance">{shortfall! > 0n ? `You need another ${formatUnits(shortfall!, asset.decimals)} ${asset.symbol}` : <>
          <Check aria-hidden="true"/>Enough for this purchase</>}</span> : error && <span role="alert">{error}</span>}
      </summary>
      <div className="buyer-balance-content">
        {address && <div className="buyer-balance-account"><AccountNameLabel
            name={names[address.toLowerCase()] ?? "Your account"}/><CopyableField hideLabel label="Address"
                                                                                  value={address}
                                                                                  displayValue={`${address.slice(0, 8)}...${address.slice(-6)}`}/>
        </div>}
        {asset ? <>
          <BalanceRow key={configuration.terms.token} chainId={configuration.chainId} token={configuration.terms.token}
                      symbol={asset.symbol} amount={formatUnits(asset.balance, asset.decimals)} busy={busy}
                      onTopUp={onTopUp}>
          </BalanceRow>
          {selfPay && configuration.terms.token !== ZeroAddress &&
              <BalanceRow chainId={configuration.chainId} token={ZeroAddress} symbol="MON"
                          amount={formatUnits(asset.nativeBalance, 18)} busy={busy} onTopUp={onTopUp}><p
                  className="buyer-balance-readiness muted">For network fees</p></BalanceRow>}
        </> : address ? !error && <p role="status">Loading balances...</p> :
          <p className="muted">Choose a wallet at payment to see its balance.</p>}
        {feeChoice && <label className="buyer-fee-switch"><input type="checkbox" role="switch" checked={selfPay}
                                                                 disabled={feeChoice.disabled}
                                                                 onChange={event => feeChoice.onChange(event.currentTarget.checked)}/><span>Pay network fee myself</span></label>}
      </div>
    </details>
    {address &&
        <Button className="buyer-balance-refresh" icon={RefreshCw} iconSpinning={busy} variant="ghost" size="icon"
                title="Refresh balance" aria-label="Refresh balance" disabled={busy} onClick={onRefresh}/>}
  </section>;
}
