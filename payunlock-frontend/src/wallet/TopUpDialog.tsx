import {useEffect, useId, useRef, useState} from "react";
import {createPortal} from "react-dom";
import {ArrowRight, HandCoins, X} from "lucide-react";
import {Button} from "@/components/ui/button";
import {CopyableField} from "@/components/CopyableField";
import type {TopUpProvider} from "@/config/token-icons";

export function TopUpDialog({symbol, address, chainId, providers, onClose}: {
  symbol: string; address: string; chainId: number; providers: TopUpProvider[]; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId(), tabsId = useId();
  const [selected, setSelected] = useState(0);
  const provider = providers[selected];
  const network = chainId === 10143 ? "Monad Testnet" : chainId === 143 ? "Monad Mainnet" : `Network ${chainId}`;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  if (!provider) return null;
  // A widget URL must be generated and verified for this token/network before configuration.
  const widgetUrl = provider.widget ? new URL(provider.widget.url) : undefined;
  if (widgetUrl && provider.widget?.kind === "changelly") widgetUrl.searchParams.set("address", address);
  return createPortal(<dialog ref={dialog} className="approval-dialog wallet-action-dialog wallet-topup-dialog"
                              aria-labelledby={titleId} onCancel={event => {
    event.preventDefault();
    onClose();
  }}>
    <div className="section-heading"><h2 id={titleId}>Top up {symbol}</h2><Button icon={X} variant="ghost" size="icon"
                                                                                  aria-label="Close top-up dialog"
                                                                                  onClick={onClose}/></div>
    <p className="muted">Receive {symbol} on {network}.</p>
    {providers.length > 1 && <div role="tablist" aria-label="Top-up providers"
                                  className="topup-provider-tabs">{providers.map((entry, index) => <Button
      key={entry.id} icon={HandCoins} variant="secondary" role="tab" id={`${tabsId}-tab-${index}`}
      aria-controls={`${tabsId}-panel`} aria-selected={selected === index} tabIndex={selected === index ? 0 : -1}
      onClick={() => setSelected(index)} onKeyDown={event => {
      const next = event.key === "ArrowRight" ? (index + 1) % providers.length : event.key === "ArrowLeft" ? (index + providers.length - 1) % providers.length : event.key === "Home" ? 0 : event.key === "End" ? providers.length - 1 : undefined;
      if (next !== undefined) {
        event.preventDefault();
        setSelected(next);
        document.getElementById(`${tabsId}-tab-${next}`)?.focus();
      }
    }}>{entry.name}</Button>)}</div>}
    <div id={`${tabsId}-panel`} role={providers.length > 1 ? "tabpanel" : undefined}
         aria-labelledby={providers.length > 1 ? `${tabsId}-tab-${selected}` : undefined}>
      {provider.kind === "faucet" ? <ol className="topup-instructions" aria-label="Top-up steps">
          <li><span className="topup-step-number"
                    aria-hidden="true">1</span><span>Copy your receiving address below.</span></li>
          <li><span className="topup-step-number" aria-hidden="true">2</span><span>Continue to {provider.name} and paste your address.</span>
          </li>
          <li><span className="topup-step-number" aria-hidden="true">3</span><span>Request the test tokens, return and refresh your balance.</span>
          </li>
        </ol> :
        <p>Choose what you want to pay with, then select {symbol} on {network} as the receiving asset. Use the address
          below and review the amount and fees with {provider.name}.</p>}
      <div className="topup-receiving-details">
        <div className="topup-network"><span className="copyable-label">Network</span><span>{network}</span></div>
        <CopyableField label="Receiving address" value={address}/>
      </div>
      {widgetUrl && <iframe key={provider.id} className="topup-exchange-widget" src={widgetUrl.toString()}
                            title={`${provider.name} exchange`} referrerPolicy="no-referrer"/>}
      <div className="dialog-actions"><Button icon={X} variant="secondary" onClick={onClose}>Cancel</Button><Button
        asChild><a href={provider.url} target="_blank" rel="noopener noreferrer"><ArrowRight aria-hidden="true"/>Continue
        to {provider.name}</a></Button></div>
    </div>
  </dialog>, document.body);
}
