import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, CircleHelp, RefreshCw } from "lucide-react";
import { formatUnits, parseUnits, ZeroAddress } from "ethers";
import { TimingHelpDialog } from "./TimingHelpDialog";
import { Button } from "@/components/ui/button";
import { tokenPresentation } from "@/config/token-icons";
import { useCommerce, type DraftTerms, type Product } from "./client";

import { OfferImageEditor } from "./OfferImages";
type Token = { address: string; symbol: string; decimals: number | null; allowed: boolean | null };
type TokenPage = { items: Token[]; nextCursor: string | null; incomplete: boolean; discoveryAvailable: boolean };
type Form = Omit<Product, "id" | "revision">;
export function priceInUnits(value: string, decimals: number) {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error("Enter a valid price.");
  const result = parseUnits(value, decimals);
  if (result <= 0n || result >= 2n ** 256n) throw new Error("Enter a price greater than zero within the supported range.");
  return result.toString();
}
export function durationInSeconds(value: string, unit: number) {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error("Enter a valid duration.");
  const scaled = parseUnits(value, 6) * BigInt(unit);
  if (scaled % 1000000n !== 0n || scaled / 1000000n >= 2n ** 64n) throw new Error("Use a duration in whole seconds within the supported range.");
  return (scaled / 1000000n).toString();
}
export function localEventDate(seconds: string | null) {
  if (!seconds) return "";
  const date = new Date(Number(seconds) * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function readableDuration(seconds?: string | number) {
  if (seconds === undefined) return "loading…";
  const n = BigInt(seconds);
  if (n !== 0n && n % 3600n === 0n) return `${n / 3600n} hours`;
  if (n !== 0n && n % 60n === 0n) return `${n / 60n} minutes`;
  return `${n} seconds`;
}
function DurationInput({ label, value, onChange }: { label: string; value: string; onChange: (seconds: string) => void }) {
  const initialUnit = value && BigInt(value) !== 0n ? BigInt(value) % 3600n === 0n ? 3600 : BigInt(value) % 60n === 0n ? 60 : 1 : 60;
  const [unit, setUnit] = useState(initialUnit), [text, setText] = useState(value ? (BigInt(value) / BigInt(initialUnit)).toString() : "");
  const emitted = useRef(value);
  useEffect(() => { if (value !== emitted.current) { emitted.current = value; setUnit(initialUnit); setText(value ? (BigInt(value) / BigInt(initialUnit)).toString() : ""); } }, [value]);
  function update(text: string, unit: number) {
    try { const seconds = durationInSeconds(text, unit); emitted.current = seconds; onChange(seconds); }
    catch { emitted.current = ""; onChange(""); }
  }
  return <div className="offer-duration"><label>{label}<input required inputMode="decimal" value={text} onChange={event => { setText(event.target.value); update(event.target.value, unit); }} /></label><label>Unit<select aria-label={`${label} unit`} value={unit} onChange={event => { const next = Number(event.target.value); setUnit(next); update(text, next); }}><option value={60}>Minutes</option><option value={3600}>Hours</option><option value={86400}>Days</option><option value={1}>Seconds</option></select></label></div>;
}
export function OfferFields({ form, onChange, account, confirmed, defaultReview, bounds, onValidity, stagedImages, onStagedImagesChange }: {
  form: Form; onChange: (form: Form) => void; account?: string; confirmed: boolean; defaultReview?: string;
  stagedImages?: File[]; onStagedImagesChange?: (files: File[]) => void;
  bounds?: { minCommitmentWindow: number; maxCommitmentWindow: number }; onValidity: (valid: boolean) => void;
}) {
  const api = useCommerce(), terms = form.draftTerms!;
  const fieldId = useId();
  const [imagesBusy, setImagesBusy] = useState(false);
  const [timingHelp, setTimingHelp] = useState<"event" | "review">();
  const [tokens, setTokens] = useState<Token[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const [price, setPrice] = useState(""), [priceError, setPriceError] = useState(""), [pickerOpen, setPickerOpen] = useState(false);
  const emittedPrice = useRef(terms.price);
  const selected = tokens.find(token => token.address === terms.token);
  useEffect(() => {
    let live = true; setLoading(true); setError(""); setTokens([]);
    void (async () => {
      let after: string | null = null; const rows: Token[] = [];
      do {
        // The endpoint exposes allowed payment tokens; its wallet balance is not needed while editing a draft.
        const page: TokenPage = await api.read(`/public/wallets/${account ?? ZeroAddress}/balances${after ? `?after=${after}` : ""}`);
        if (!live) return;
        if (!page.discoveryAvailable) throw new Error("Token list unavailable. Try again.");
        rows.push(...page.items.filter(token => token.allowed && token.decimals !== null)); after = page.nextCursor;
      } while (after);
      if (live) setTokens(rows);
    })().catch(() => { if (live) setError("Could not load payment tokens. Try again."); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [account, retry]);
  useEffect(() => {
    if (selected?.decimals !== null && selected?.decimals !== undefined && terms.price) setPrice(formatUnits(terms.price, selected.decimals));
    if (terms.price) setPriceError("");
    emittedPrice.current = terms.price;
  }, [terms.token, selected?.decimals]);
  useEffect(() => { if (terms.price !== emittedPrice.current && selected?.decimals !== null && selected?.decimals !== undefined) { emittedPrice.current = terms.price; setPrice(terms.price ? formatUnits(terms.price, selected.decimals) : ""); setPriceError(""); } }, [terms.price]);
  useEffect(() => { onValidity(!imagesBusy && !!selected && selected.decimals !== null && !!terms.price && !priceError && !loading && terms.reviewWindow !== "" && !!bounds && terms.commitmentWindow >= bounds.minCommitmentWindow && terms.commitmentWindow <= bounds.maxCommitmentWindow); }, [imagesBusy, selected, terms.price, priceError, loading, terms.reviewWindow, terms.commitmentWindow, bounds]);
  function updateTerms(next: Partial<DraftTerms>) { onChange({ ...form, draftTerms: { ...terms, ...next } }); }
  function updatePrice(value: string, token = selected) {
    setPrice(value);
    try { if (token?.decimals === null || token?.decimals === undefined) throw new Error("Select a payment token."); const units = priceInUnits(value, token.decimals); setPriceError(""); emittedPrice.current = units; return units; }
    catch { setPriceError("Enter a positive amount with no more decimal places than this token supports."); emittedPrice.current = ""; return ""; }
  }
  return <>
    <section className="offer-form-section"><h2>Offer details</h2><p className="offer-help">Tell buyers what they will receive.</p><label>Title<input required maxLength={160} placeholder="Give your offer a clear name" value={form.title} onChange={event => onChange({ ...form, title: event.target.value })} /></label><label>Description<textarea maxLength={12000} placeholder="Describe what is included and how you will deliver it" value={form.description} onChange={event => onChange({ ...form, description: event.target.value })} /></label></section>
    <OfferImageEditor images={form.images ?? []} onChange={images => onChange({ ...form, images })} onBusy={setImagesBusy} stagedFiles={stagedImages} onStagedFilesChange={onStagedImagesChange} />
    <section className="offer-form-section"><h2>Price</h2><div className="offer-field-grid">
      <div className="offer-token-picker"><span id="offer-token-label" className="offer-field-label">Payment token</span><Button icon={ChevronDown} variant="secondary" className="offer-token-trigger" aria-labelledby="offer-token-label" aria-expanded={pickerOpen} disabled={loading} onClick={() => setPickerOpen(!pickerOpen)}>{selected ? <TokenName token={selected} /> : loading ? "Loading tokens…" : "Select a token"}</Button>
        {pickerOpen && <div className="offer-token-options" role="group" aria-label="Enabled payment tokens">{tokens.map(token => <Button key={token.address} variant="ghost" aria-pressed={terms.token === token.address} onClick={() => { const units = updatePrice(price, token); updateTerms({ token: token.address, price: units }); setPickerOpen(false); }}><TokenName token={token} /></Button>)}</div>}
        {error && <><p role="status">{error}</p><Button icon={RefreshCw} variant="ghost" onClick={() => setRetry(value => value + 1)}>Retry tokens</Button></>}
        {!loading && !error && !selected && <p className="offer-help">Choose an enabled payment token to save this offer.</p>}
      </div>
      <label>Price{selected ? ` (${selected.symbol})` : ""}<input required inputMode="decimal" placeholder="0.00" value={price} disabled={!selected} aria-invalid={!!priceError} onChange={event => updateTerms({ price: updatePrice(event.target.value) })} /></label>
    </div>{priceError && <p role="alert">{priceError}</p>}</section>
    <details className="offer-form-section offer-timing"><summary>Timing</summary><div className="offer-field-grid"><div><div className="offer-field-heading"><label htmlFor={`${fieldId}-event`}>Event end (optional)</label><Button icon={CircleHelp} variant="ghost" size="icon" aria-label="About event end" onClick={() => setTimingHelp("event")} /></div><input id={`${fieldId}-event`} type="datetime-local" step="1" value={localEventDate(terms.eventEnd)} onChange={event => updateTerms({ eventEnd: event.target.value ? String(Math.floor(new Date(event.target.value).getTime() / 1000)) : null })} /><p className="offer-help">Your local time. Leave empty if this offer has no event.</p></div><div><div className="offer-field-heading"><label htmlFor={`${fieldId}-review`}>Review period</label><Button icon={CircleHelp} variant="ghost" size="icon" aria-label="About review period" onClick={() => setTimingHelp("review")} /></div><select id={`${fieldId}-review`} value={terms.reviewWindow === null ? "default" : "custom"} onChange={event => updateTerms({ reviewWindow: event.target.value === "default" ? null : defaultReview ?? "86400" })}><option value="default">Use default — {readableDuration(defaultReview)}</option><option value="custom">Custom duration</option></select>{terms.reviewWindow !== null && <DurationInput label="Review duration" value={terms.reviewWindow} onChange={reviewWindow => updateTerms({ reviewWindow })} />}<p className="offer-help">Time buyers have to review delivery. Zero allows immediate payout after delivery or the event ends, whichever is later.</p></div></div></details>
    {timingHelp && <TimingHelpDialog topic={timingHelp} onClose={() => setTimingHelp(undefined)} />}
    {confirmed && <section className="offer-form-section"><h2>Publishing</h2><label>Visibility<select value={form.visibility} onChange={event => onChange({ ...form, visibility: event.target.value as Product["visibility"] })}><option value="draft">Draft</option><option value="public" disabled={!confirmed}>Visible</option><option value="hidden" disabled={!confirmed}>Hidden — direct link only</option></select></label><p className="offer-help">Draft: not published. Visible: listed in Discover. Hidden: available through its link.</p>{confirmed && <p className="offer-help">To stop purchases, disable sales using the controls below.</p>}</section>}
  </>;
}
function TokenName({ token }: { token: Token }) {
  const entry = tokenPresentation(10143, token.address), Icon = entry.icon;
  return <span className="offer-token-name">{entry.iconUrl ? <img src={entry.iconUrl} alt="" /> : <Icon aria-hidden="true" />}<span>{token.symbol}</span></span>;
}
