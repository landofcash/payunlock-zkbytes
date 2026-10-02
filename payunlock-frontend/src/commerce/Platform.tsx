import { Check as CheckIcon, KeyRound, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { formatEther, formatUnits, id, isAddress, parseEther, parseUnits, ZeroAddress } from "ethers";
import { useSession } from "@/wallet/session-store";
import { useCommerce, type Action, type Deployment, type OrderView } from "./client";
import { OrderDialog } from "./OrderPresentation";
import { arbitratorContext, hexKey, type Arbitrator } from "./lifecycle";
import { restoreReceiving, RETENTION_SECONDS } from "./protocol";
import type { Operation } from "./purchase-journal";
import { Feedback, journal, prepareOperation, randomId, TransactionPanel, useTask, WalletGate } from "./ui";

type PlatformSettings = { owner: string; reviewWindow: string; responseWindow: string; minResponseWindow: string; minCommitmentWindow: number; maxCommitmentWindow: number; batchLimit: number; maxBatch: number; serviceFeeBps?: number; feeTreasury?: string; offerPlacementFee?: string; placementFeeVersion?: string; arbitrationFeeAsset?: string };
type TokenMetadata = { symbol: string; decimals: number };
type AdminOrder = OrderView & { assignmentFeeAsset?: string };
type ChangeSummary = { title: string; rows: [string, string, string][] };
const validInteger = (value: string) => /^\d+$/.test(value);
const validAmount = (value: string, decimals: number) => decimals === 0 ? validInteger(value) : new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`).test(value);
const sameAddress = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
function duration(value?: string | number) {
  if (value === undefined) return "—";
  const seconds = BigInt(value);
  if (seconds === 0n) return "0 seconds";
  if (seconds % 86400n === 0n) return `${seconds / 86400n} days`;
  if (seconds % 3600n === 0n) return `${seconds / 3600n} hours`;
  if (seconds % 60n === 0n) return `${seconds / 60n} minutes`;
  return `${seconds} seconds`;
}
function tokenAmount(amount: string | undefined, metadata: TokenMetadata | undefined) {
  return amount === undefined ? "—" : metadata ? `${formatUnits(amount, metadata.decimals)} ${metadata.symbol}` : `${amount} token base units`;
}
function changeSummary(action: Action, settings?: PlatformSettings, feeToken?: TokenMetadata, arbitrator?: Arbitrator, order?: AdminOrder, claimAmount?: string, claimToken?: TokenMetadata): ChangeSummary {
  const row = (label: string, before: string, after: string): [string, string, string] => [label, before, after];
  switch (action.kind) {
    case "setServiceFee": return { title: "Change service fee", rows: [row("Service fee", `${(settings?.serviceFeeBps ?? 0) / 100}%`, `${action.bps / 100}%`), row("Treasury", settings?.feeTreasury ?? "—", action.treasury)] };
    case "setOfferPlacementFee": return { title: "Change offer placement fee", rows: [row("Placement fee", settings?.offerPlacementFee ? `${formatEther(settings.offerPlacementFee)} MON` : "—", `${formatEther(action.amount)} MON`)] };
    case "setArbitrationFeeAsset": return { title: "Change arbitration fee token", rows: [row("Token", settings?.arbitrationFeeAsset ?? "—", action.asset)] };
    case "setMyArbitrationFee": return { title: "Change your arbitration fee", rows: [row("Fee", tokenAmount(arbitrator?.fee, feeToken), tokenAmount(action.fee, feeToken))] };
    case "setDefaultReviewWindow": return { title: "Change default review period", rows: [row("Review period", duration(settings?.reviewWindow), duration(action.value))] };
    case "setResponseWindow": return { title: "Change response period", rows: [row("Response period", duration(settings?.responseWindow), duration(action.value))] };
    case "setBatchLimit": return { title: "Change batch limit", rows: [row("Batch limit", String(settings?.batchLimit ?? "—"), action.value)] };
    case "setTimingBounds": return { title: "Change timing bounds", rows: [row("Minimum response", duration(settings?.minResponseWindow), duration(action.responseFloor)), row("Minimum publication", duration(settings?.minCommitmentWindow), duration(action.commitmentFloor)), row("Maximum publication", duration(settings?.maxCommitmentWindow), duration(action.commitmentCeiling))] };
    case "setAllowedAsset": return { title: action.allowed ? "Enable payment token" : "Disable payment token", rows: [row("Token", action.asset, action.allowed ? "Enabled" : "Disabled")] };
    case "setReceiveAuthorizationAsset": return { title: action.enabled ? "Enable sponsored token payments" : "Disable sponsored token payments", rows: [row("Token", action.asset, action.enabled ? "Enabled" : "Disabled")] };
    case "addStorageService": return { title: "Register storage service", rows: [row("Permanent service ID", "Unregistered", String(action.serviceId))] };
    case "configureArbitrator": return { title: "Update arbitrator registry", rows: [row("Wallet", "—", action.wallet), row("Receiving key", "—", action.publicKey), row("Available for new cases", "—", action.active ? "Yes" : "No")] };
    case "replaceArbitrator": return { title: `Replace arbitrator for order #${action.orderId}`, rows: [row("Arbitrator", order?.assignment?.wallet ?? "Current assignment", action.replacement), row("Reason hash", "—", action.reason)] };
    case "claimFees": return { title: "Claim accrued fees", rows: [row("Asset", "Accrued balance", action.asset === ZeroAddress ? "MON" : action.asset), row("Amount", "Unclaimed", tokenAmount(claimAmount, claimToken))] };
    default: return { title: "Submit platform change", rows: [] };
  }
}

export function Platform() {
  const api = useCommerce(), wallet = useSession(), task = useTask();
  const [refreshing, setRefreshing] = useState(false);
  const [platform, setPlatform] = useState<PlatformSettings>(), [deployment, setDeployment] = useState<Deployment>();
  const [feeToken, setFeeToken] = useState<TokenMetadata>(), [claimToken, setClaimToken] = useState<TokenMetadata>();
  const [durationInput, setDurationInput] = useState(""), [response, setResponse] = useState(""), [floor, setFloor] = useState(""), [minimum, setMinimum] = useState(""), [maximum, setMaximum] = useState(""), [batch, setBatch] = useState("");
  const [serviceBps, setServiceBps] = useState(""), [treasury, setTreasury] = useState(""), [placement, setPlacement] = useState(""), [arbitrationAsset, setArbitrationAsset] = useState("");
  const [myFee, setMyFee] = useState(""), [myArbitrator, setMyArbitrator] = useState<Arbitrator>();
  const [claimAsset, setClaimAsset] = useState(ZeroAddress), [claimAmount, setClaimAmount] = useState<string>();
  const [assetAddress, setAssetAddress] = useState(""), [assetStatus, setAssetStatus] = useState<{ asset: string; allowed: boolean; receiveAuthorization: boolean }>();
  const [serviceId, setServiceId] = useState(""), [myPublicKey, setMyPublicKey] = useState(""), [registryKey, setRegistryKey] = useState(""), [registryWallet, setRegistryWallet] = useState(""), [active, setActive] = useState(true);
  const [orderId, setOrderId] = useState(""), [order, setOrder] = useState<AdminOrder>(), [orderFeeToken, setOrderFeeToken] = useState<TokenMetadata>();
  const [replacement, setReplacement] = useState(""), [candidate, setCandidate] = useState<Arbitrator>(), [reason, setReason] = useState("");
  const [operation, setOperation] = useState<Operation>(), [reviewOpen, setReviewOpen] = useState(false), [reviewSummary, setReviewSummary] = useState<ChangeSummary>();
  const selectedAsset = assetAddress.trim().toLowerCase(), currentAssetStatus = assetStatus?.asset === selectedAsset ? assetStatus : undefined;
  const isOwner = sameAddress(platform?.owner, wallet.session?.address), isTreasury = sameAddress(platform?.feeTreasury, wallet.session?.address);
  const pending = operation?.progress === "checking";
  const validResponse = validInteger(response) && BigInt(response) >= BigInt(platform?.minResponseWindow ?? 0);
  const validBounds = [floor, minimum, maximum].every(validInteger) && BigInt(floor) > 0n && BigInt(floor) <= BigInt(platform?.responseWindow ?? 0) && Number(minimum) > 0 && Number(maximum) >= Number(minimum) && Number(maximum) < RETENTION_SECONDS;

  async function loadAsset(asset = selectedAsset) { setAssetStatus(await api.read(`/platform/assets/${asset}`)); }
  async function load() {
    if (isAddress(selectedAsset)) await loadAsset();
    const [settings, currentDeployment] = await Promise.all([api.read<PlatformSettings>("/platform"), api.read<Deployment>("/deployment")]);
    setPlatform(settings); setDeployment(currentDeployment);
    setDurationInput(settings.reviewWindow); setResponse(settings.responseWindow); setFloor(settings.minResponseWindow);
    setMinimum(String(settings.minCommitmentWindow)); setMaximum(String(settings.maxCommitmentWindow)); setBatch(String(settings.batchLimit));
    setServiceBps(String((settings.serviceFeeBps ?? 0) / 100)); setTreasury(settings.feeTreasury ?? "");
    setPlacement(settings.offerPlacementFee ? formatEther(settings.offerPlacementFee) : ""); setArbitrationAsset(settings.arbitrationFeeAsset ?? "");
    const metadata = settings.arbitrationFeeAsset ? await api.read<TokenMetadata>(`/public/assets/${settings.arbitrationFeeAsset}`).catch(() => undefined) : undefined;
    setFeeToken(metadata);
    if (wallet.session) {
      const [arbitrator, latest] = await Promise.all([api.read<Arbitrator>(`/arbitrators/${wallet.session.address.toLowerCase()}`), journal.list(wallet.session.address)]);
      setMyArbitrator(arbitrator); setMyFee(metadata ? formatUnits(arbitrator.fee, metadata.decimals) : "");
      setOperation(latest.filter(o => o.id.startsWith("platform:") && o.deployment.contract.toLowerCase() === currentDeployment.contract.toLowerCase()).at(-1));
    } else { setMyArbitrator(undefined); setOperation(undefined); }
  }
  useEffect(() => { void task.run(load); }, [wallet.sessionEpoch]);
  async function prepare(action: Action) {
    if (!wallet.session || !deployment) return;
    if (pending) throw new Error("Finish checking the current transaction first.");
    const saved = await prepareOperation(api, { id: `platform:${randomId()}`, account: wallet.session.address.toLowerCase(), deployment, hashes: [], progress: "draft", version: 0 }, action);
    setOperation(saved); setReviewSummary(changeSummary(action, platform, feeToken, myArbitrator, order, claimAmount, claimToken)); setReviewOpen(true);
  }
  function updateOperation(value: Operation) { setOperation(value); if (value.progress !== "review") setReviewOpen(false); }
  async function loadAdminOrder() {
    const value = await api.request<AdminOrder>(`/admin/orders/${orderId}`);
    setOrder(value); setCandidate(undefined); setReplacement(""); setOrderFeeToken(undefined);
    if (value.assignmentFeeAsset) setOrderFeeToken(await api.read<TokenMetadata>(`/public/assets/${value.assignmentFeeAsset}`).catch(() => undefined));
  }
  async function checkClaim() {
    const amount = (await api.request<{ amount: string }>(`/platform/fees/${claimAsset}`)).amount;
    setClaimAmount(amount);
    setClaimToken(await api.read<TokenMetadata>(`/public/assets/${claimAsset}`).catch(() => undefined));
  }
  const claimCard = deployment?.router ? <div className="card platform-card"><h3>Claim accrued fees</h3><p>Placement fees in MON and service fees in payment tokens accrue separately. Only the wallet that accrued them can claim them.</p><label>Fee asset address<input value={claimAsset} onChange={e => { setClaimAsset(e.target.value); setClaimAmount(undefined); setClaimToken(undefined); }} /></label><div className="actions"><Button variant="secondary" onClick={() => { setClaimAsset(ZeroAddress); setClaimAmount(undefined); }}>MON</Button>{deployment.usdc && <Button variant="secondary" onClick={() => { setClaimAsset(deployment.usdc!); setClaimAmount(undefined); }}>USDC</Button>}<Button variant="secondary" disabled={task.busy || !isAddress(claimAsset)} onClick={() => void task.run(checkClaim)}>Check claimable</Button></div>{claimAmount !== undefined && <><p>Claimable: <strong>{tokenAmount(claimAmount, claimToken)}</strong></p><Button disabled={task.busy || pending || BigInt(claimAmount) === 0n} onClick={() => void task.run(() => prepare({ kind: "claimFees", asset: claimAsset }))}>Claim fees</Button></>}</div> : null;

  return <section className="commerce-page platform-page">
    <div className="section-heading"><div><h1>Platform</h1><p className="muted">Arbitration and platform settings</p></div><Button icon={RefreshCw} iconSpinning={refreshing} variant="secondary" disabled={task.busy} onClick={() => { setRefreshing(true); void task.run(load).finally(() => setRefreshing(false)); }}>Refresh</Button></div>
    <Feedback {...task} busy={task.busy && !refreshing} />
    {!wallet.session ? <WalletGate /> : <>
      {operation?.progress === "review" && !operation.action && <div className="notice platform-operation" role="alert"><strong>Saved change unavailable</strong><p>Prepare this change again.</p><Button variant="secondary" onClick={() => setOperation(undefined)}>Dismiss</Button></div>}
      {operation?.progress === "review" && operation.action && !reviewOpen && <div className="notice platform-operation" role="status"><strong>Change ready to submit</strong><p>Your prepared change is saved. Continue when you are ready to sign.</p><Button onClick={() => setReviewOpen(true)}>Continue change</Button></div>}
      {pending && <div className="platform-operation" role="status"><TransactionPanel record={operation} onChange={updateOperation} onFinalized={load} compactReview /></div>}
      {operation?.progress === "finalized" && <div className="notice platform-operation" role="status"><strong>Change confirmed</strong><p>The platform setting has been updated on Monad Testnet.</p>{operation.activeHash && <p className="address">Transaction: {operation.activeHash}</p>}<Button variant="secondary" onClick={() => setOperation(undefined)}>Dismiss</Button></div>}
      {operation?.progress === "reverted" && <div className="notice platform-operation" role="alert"><strong>Change did not complete</strong><p>Review the setting and prepare a new transaction before trying again.</p><Button variant="secondary" onClick={() => setOperation(undefined)}>Dismiss</Button></div>}

      <section className="platform-group" aria-labelledby="my-arbitration"><h2 id="my-arbitration">My arbitration</h2>
        <div className="card platform-card"><h3>Receiving key</h3><p>Derive your public key to give to the platform administrator. Your private key stays in your wallet.</p><Button icon={KeyRound} variant="secondary" disabled={task.busy || wallet.busy || !deployment} onClick={() => void task.run(async () => {
          const key = await wallet.runOperation(async (session, isCurrent) => { const identity = await restoreReceiving(arbitratorContext(deployment!, session.address), session, isCurrent); try { return hexKey(identity.publicKey); } finally { identity.privateKey.fill(0); } }); setMyPublicKey(key);
        })}>Derive public receiving key</Button>{myPublicKey && <p className="address">{myPublicKey}</p>}</div>
        {deployment?.router && myArbitrator?.active && <div className="card platform-card"><h3>My arbitration fee</h3><p>Current fee: <strong>{tokenAmount(myArbitrator.fee, feeToken)}</strong>. A new fee affects future cases.</p><label>New fee in {feeToken?.symbol ?? "token units"}<input inputMode="decimal" value={myFee} onChange={e => setMyFee(e.target.value)} /></label><Button disabled={task.busy || pending || !feeToken || !validAmount(myFee, feeToken?.decimals ?? 0) || !myArbitrator.feeVersion || myFee === formatUnits(myArbitrator.fee, feeToken?.decimals ?? 18)} onClick={() => void task.run(() => prepare({ kind: "setMyArbitrationFee", expectedVersion: myArbitrator.feeVersion!, fee: parseUnits(myFee, feeToken!.decimals).toString() }))}>Save my fee</Button></div>}
      </section>

      {claimCard && (isTreasury ? <section className="platform-group" aria-labelledby="treasury-fees"><h2 id="treasury-fees">Treasury</h2>{claimCard}</section> : <details className="platform-group platform-past-fees"><summary>Claim past treasury fees</summary>{claimCard}</details>)}

      {isOwner && <section className="platform-group" aria-labelledby="administration"><h2 id="administration">Platform administration</h2><p className="muted">Changes to these settings are recorded on-chain.</p>
        <div className="card platform-card"><h3>Payments and fees</h3>
          {deployment?.router && <>
            <p>Service fees are deducted from seller proceeds; buyer refunds return the full principal. Placement fees are paid in MON when an offer is published.</p>
            <div className="platform-setting"><h4>Service fee</h4><p>Current: <strong>{(platform?.serviceFeeBps ?? 0) / 100}%</strong> to <span className="address">{platform?.feeTreasury}</span></p><div className="platform-fields"><label>Service fee (%)<input inputMode="decimal" value={serviceBps} onChange={e => setServiceBps(e.target.value)} /></label><label>Treasury wallet<input value={treasury} onChange={e => setTreasury(e.target.value)} /></label></div><Button disabled={task.busy || pending || !validAmount(serviceBps, 2) || Number(serviceBps) > 100 || !isAddress(treasury) || sameAddress(treasury, ZeroAddress) || sameAddress(treasury, deployment?.contract) || (Number(serviceBps) * 100 === platform?.serviceFeeBps && sameAddress(treasury, platform?.feeTreasury))} onClick={() => void task.run(() => prepare({ kind: "setServiceFee", bps: Number(parseUnits(serviceBps, 2)), treasury }))}>Save service fee</Button></div>
            <div className="platform-setting"><h4>Offer placement fee</h4><p>Current: <strong>{platform?.offerPlacementFee ? `${formatEther(platform.offerPlacementFee)} MON` : "—"}</strong></p><label>New placement fee (MON)<input inputMode="decimal" value={placement} onChange={e => setPlacement(e.target.value)} /></label><Button disabled={task.busy || pending || !validAmount(placement, 18) || placement === (platform?.offerPlacementFee ? formatEther(platform.offerPlacementFee) : "")} onClick={() => void task.run(() => prepare({ kind: "setOfferPlacementFee", amount: parseEther(placement).toString() }))}>Save placement fee</Button></div>
            <div className="platform-setting"><h4>Arbitration fee token</h4><p>Current: <strong>{feeToken?.symbol ?? platform?.arbitrationFeeAsset}</strong></p><label>Token address<input value={arbitrationAsset} onChange={e => setArbitrationAsset(e.target.value)} /></label><Button disabled={task.busy || pending || !isAddress(arbitrationAsset) || arbitrationAsset === ZeroAddress || sameAddress(arbitrationAsset, platform?.arbitrationFeeAsset)} onClick={() => void task.run(() => prepare({ kind: "setArbitrationFeeAsset", asset: arbitrationAsset }))}>Save arbitration token</Button></div>
          </>}
          <div className="platform-setting"><h4>Payment tokens</h4><p>Disabling a token stops new purchases and offer changes with that token. Existing orders can still be completed.</p><label>Payment token address<input placeholder="0x…" value={assetAddress} onChange={e => { setAssetAddress(e.target.value); setAssetStatus(undefined); }} /></label><div className="actions"><Button icon={RefreshCw} variant="secondary" disabled={task.busy || !isAddress(selectedAsset)} onClick={() => void task.run(() => loadAsset())}>Check status</Button><Button icon={CheckIcon} variant="secondary" disabled={task.busy} onClick={() => { setAssetAddress(ZeroAddress); setAssetStatus(undefined); void task.run(() => loadAsset(ZeroAddress)); }}>Select MON</Button>{deployment?.usdc && <Button variant="secondary" disabled={task.busy} onClick={() => { setAssetAddress(deployment.usdc!); setAssetStatus(undefined); void task.run(() => loadAsset(deployment.usdc!)); }}>Select USDC</Button>}</div>
            {currentAssetStatus && <><p>{selectedAsset === ZeroAddress ? "MON" : selectedAsset}: <strong>{currentAssetStatus.allowed ? "Enabled" : "Disabled"}</strong></p><Button variant={currentAssetStatus.allowed ? "destructive" : "default"} disabled={task.busy || pending} onClick={() => void task.run(() => prepare({ kind: "setAllowedAsset", asset: selectedAsset, allowed: !currentAssetStatus.allowed }))}>{currentAssetStatus.allowed ? "Disable token" : "Enable token"}</Button>{deployment?.router && selectedAsset !== ZeroAddress && currentAssetStatus.allowed && <p>Sponsored payments: <strong>{currentAssetStatus.receiveAuthorization ? "Enabled" : "Disabled"}</strong>. Enable only after verifying this token's signed authorization behavior. <Button variant="secondary" disabled={task.busy || pending} onClick={() => void task.run(() => prepare({ kind: "setReceiveAuthorizationAsset", asset: selectedAsset, enabled: !currentAssetStatus.receiveAuthorization }))}>{currentAssetStatus.receiveAuthorization ? "Disable sponsorship" : "Enable sponsorship"}</Button></p>}</>}
          </div>
        </div>

        <div className="card platform-card"><h3>Order timing</h3><p>These changes affect future purchases. Existing orders retain their terms.</p>
          <div className="platform-setting"><h4>Default review period</h4><p>Current: <strong>{duration(platform?.reviewWindow)}</strong>. Zero permits immediate payout after delivery and any event end.</p><label>New period (seconds)<input inputMode="numeric" value={durationInput} onChange={e => setDurationInput(e.target.value)} /><small>3,600 seconds = 1 hour</small></label><Button disabled={task.busy || pending || !validInteger(durationInput) || durationInput === platform?.reviewWindow} onClick={() => void task.run(() => prepare({ kind: "setDefaultReviewWindow", value: durationInput }))}>Save review period</Button></div>
          <div className="platform-setting"><h4>Negotiation response period</h4><p>Current: <strong>{duration(platform?.responseWindow)}</strong></p><label>New period (seconds)<input inputMode="numeric" value={response} onChange={e => setResponse(e.target.value)} /><small>Must be at least {duration(platform?.minResponseWindow)}.</small></label><Button disabled={task.busy || pending || !validResponse || response === platform?.responseWindow} onClick={() => void task.run(() => prepare({ kind: "setResponseWindow", value: response }))}>Save response period</Button></div>
          <div className="platform-setting"><h4>Timing bounds</h4><p>Current minimum response: {duration(platform?.minResponseWindow)}; publication: {duration(platform?.minCommitmentWindow)} to {duration(platform?.maxCommitmentWindow)}. Offers outside new bounds need updating.</p><div className="platform-fields"><label>Minimum response (seconds)<input inputMode="numeric" value={floor} onChange={e => setFloor(e.target.value)} /></label><label>Minimum publication (seconds)<input inputMode="numeric" value={minimum} onChange={e => setMinimum(e.target.value)} /></label><label>Maximum publication (seconds)<input inputMode="numeric" value={maximum} onChange={e => setMaximum(e.target.value)} /></label></div><Button disabled={task.busy || pending || !validBounds || (floor === platform?.minResponseWindow && minimum === String(platform?.minCommitmentWindow) && maximum === String(platform?.maxCommitmentWindow))} onClick={() => void task.run(() => prepare({ kind: "setTimingBounds", responseFloor: floor, commitmentFloor: Number(minimum), commitmentCeiling: Number(maximum) }))}>Save timing bounds</Button></div>
        </div>

        <div className="card platform-card"><h3>Arbitrators</h3><div className="platform-setting"><h4>Registry</h4><label>Arbitrator wallet<input value={registryWallet} onChange={e => setRegistryWallet(e.target.value)} /></label><label>Public receiving key<input value={registryKey} onChange={e => setRegistryKey(e.target.value)} /></label><label className="checkbox"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />Available for new cases</label><Button disabled={task.busy || pending || !isAddress(registryWallet) || !/^0x[0-9a-fA-F]{64}$/.test(registryKey)} onClick={() => void task.run(() => prepare({ kind: "configureArbitrator", wallet: registryWallet, publicKey: registryKey, active }))}>Save arbitrator</Button></div>
          <div className="platform-setting"><h4>Replace an arbitrator</h4><label>Order number<input value={orderId} onChange={e => { setOrderId(e.target.value); setOrder(undefined); setOrderFeeToken(undefined); }} /></label><Button icon={KeyRound} variant="secondary" disabled={task.busy || !validInteger(orderId)} onClick={() => void task.run(loadAdminOrder)}>Load assignment</Button>{order?.assignment && <><p>Current arbitrator: <span className="address">{order.assignment.wallet}</span> · assignment {order.assignment.revision} · original fee {tokenAmount(order.assignment.fee, orderFeeToken)}{order.assignmentFeeAsset && !orderFeeToken ? ` (${order.assignmentFeeAsset})` : ""}</p><label>Replacement wallet<input value={replacement} onChange={e => { setReplacement(e.target.value); setCandidate(undefined); }} /></label><Button variant="secondary" disabled={task.busy || !isAddress(replacement)} onClick={() => void task.run(async () => { const found = await api.read<Arbitrator>(`/arbitrators/${replacement}`); if (!found.active || [order.order.buyer, order.order.seller, order.assignment!.wallet].some(wallet => sameAddress(wallet, found.wallet))) throw new Error("Choose an eligible different arbitrator."); setCandidate(found); })}>Check replacement</Button>{candidate && <p>Replacement: <span className="address">{candidate.wallet}</span> · key version {candidate.keyVersion}. No additional participant fee.</p>}<label>Reason for replacement<textarea value={reason} onChange={e => setReason(e.target.value)} /><small>Only its hash is recorded on-chain.</small></label><Button disabled={!candidate || !reason.trim() || task.busy || pending} onClick={() => void task.run(() => prepare({ kind: "replaceArbitrator", orderId, revision: order.assignment!.revision, replacement: candidate!.wallet, expectedKeyVersion: candidate!.keyVersion, reason: id(reason.trim()) }))}>Replace arbitrator</Button></>}</div></div>

        <details className="card platform-card platform-advanced"><summary>Advanced infrastructure</summary><div className="platform-setting"><h3>Batch size</h3><p>Current: {platform?.batchLimit}; allowed range: 1–{platform?.maxBatch}. Lowering may split pending batches.</p><label>New batch size<input type="number" min={1} max={platform?.maxBatch} value={batch} onChange={e => setBatch(e.target.value)} /></label><Button disabled={task.busy || pending || !validInteger(batch) || Number(batch) < 1 || Number(batch) > (platform?.maxBatch ?? 0) || batch === String(platform?.batchLimit)} onClick={() => void task.run(() => prepare({ kind: "setBatchLimit", value: batch }))}>Save batch size</Button></div><div className="platform-setting"><h3>Register storage service</h3><p>Registration is permanent. ID 1 is zkbytes; an adapter must also be configured before another service can be used.</p><label>New service ID<input type="number" min={2} max={4294967295} value={serviceId} onChange={e => setServiceId(e.target.value)} /></label><Button disabled={task.busy || pending || !validInteger(serviceId) || Number(serviceId) < 2 || Number(serviceId) > 4294967295} onClick={() => void task.run(() => prepare({ kind: "addStorageService", serviceId: Number(serviceId) }))}>Register service</Button></div></details>
      </section>}
      {reviewOpen && operation?.progress === "review" && operation.action && <OrderDialog title={reviewSummary?.title ?? changeSummary(operation.action, platform, feeToken, myArbitrator, order, claimAmount, claimToken).title} onClose={() => setReviewOpen(false)}><TransactionPanel record={operation} summary={<dl className="terms platform-review">{(reviewSummary ?? changeSummary(operation.action, platform, feeToken, myArbitrator, order, claimAmount, claimToken)).rows.map(([label, before, after]) => <div key={label}><dt>{label}</dt><dd><span>Current: {before}</span><span aria-hidden="true">→</span><strong>New: {after}</strong></dd></div>)}</dl>} onChange={updateOperation} onFinalized={load} compactReview /></OrderDialog>}
    </>}
  </section>;
}
