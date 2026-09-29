import { Scale as ButtonScale, Eye as ButtonEye, Check as ButtonCheck, ArrowRight as ButtonArrowRight, Copy as ButtonCopy, Undo2 as ButtonUndo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OrderDialog, OrderAmount } from "./OrderPresentation";
import { storageService } from "./lifecycle";
import { useEffect, useRef, useState } from "react";
import { formatEther, formatUnits } from "ethers";
import { useSession } from "@/wallet/session-store";
import { IndexedStore } from "@/storage/local-store";
import { canonical } from "@/crypto/encoding";
import { useCommerce, type Action, type Asset, type OrderView, type Page } from "./client";
import { openDelivery, restoreReceiving, type Opening, type Order, type Service } from "./protocol";
import { openEvidence, persistEvidence, prepareEvidence, restoreEvidence, type PreparedEvidence } from "./evidence";
import { arbitratorContext, assignment, deliveryRecord, evidenceRecord, evidenceReference, type Arbitrator, type ChainRecord, type EvidenceReference } from "./lifecycle";
import { date, Feedback, useTask } from "./ui";
import { assertPurchaseSignature, buildArbitrationAuthorization } from "./token-authorization";
import type { Deployment } from "./client";
const store = new IndexedStore();
type EvidenceRow = { id: string; index: string; revision: string; submitter: string; commitment: string; data: EvidenceReference };
import { requestHash, openRequest, prepareRequest, persistRequest, restoreRequest, type PreparedRequest, type RequestRow, type RequestOpening } from "./requests";
export function Arbitration({ view, order, service, prepareAction }: { view: OrderView; order: Order; service: Service; prepareAction(action: Action): Promise<void> }) {
  const wallet = useSession(), api = useCommerce(), task = useTask();
  const [panel, setPanel] = useState<"evidence" | "request" | "decision">(), [decision, setDecision] = useState(false);
  const [choices, setChoices] = useState<ChainRecord[]>([]);
  const [address, setAddress] = useState(""), [selected, setSelected] = useState<Arbitrator>(), [password, setPassword] = useState("");
  const [prepared, setPrepared] = useState<PreparedEvidence>(), [report, setReport] = useState(""), [evidence, setEvidence] = useState<EvidenceRow[]>([]), [requests, setRequests] = useState<RequestRow[]>([]);
  const [sequences, setSequences] = useState(""), [advisory, setAdvisory] = useState(""), [participant, setParticipant] = useState(view.order.buyer);
  const [requestSelection, setRequestSelection] = useState("");
  const [requestDraft, setRequestDraft] = useState<PreparedRequest>(), [instructions, setInstructions] = useState(""), [requestText, setRequestText] = useState<Record<string, string>>({});
  const [plaintext, setPlaintext] = useState<Opening[]>([]);
  const [registry, setRegistry] = useState<Page<Arbitrator>>({ items: [], nextCursor: null });
  const [feeAsset, setFeeAsset] = useState<string>();
  const [feeMetadata, setFeeMetadata] = useState<Pick<Asset, "symbol" | "decimals" | "authorizationProfile">>();
  const [relayJobId, setRelayJobId] = useState<string>();
  const [payGasSelf, setPayGasSelf] = useState(false);
  const account = wallet.session!.address.toLowerCase(), isParticipant = [view.order.buyer, view.order.seller].includes(account);
  const currentRevision = view.assignment?.revision ?? "1";
  const current = useRef({ revision: currentRevision, account }); current.current = { revision: currentRevision, account };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const recoveryKey = `evidence-pointer:${order.deployment.contract}:${order.orderId}:${account}:${currentRevision}`;
  useEffect(() => {
    if (view.assignment) void task.run(loadEvidence);
    else if (view.eligibility.requestArbitration) void api.read<Page<Arbitrator>>("/arbitrators").then(setRegistry).catch(() => {});
  }, [view.assignment?.revision, view.eligibility.requestArbitration]);
  async function records() {
    const rows: ChainRecord[] = []; let after: string | null = null;
    do { const page: Page<ChainRecord> = await api.request(`/orders/${order.orderId}/records${after ? `?after=${after}` : ""}`); rows.push(...page.items); after = page.nextCursor; } while (after);
    return rows;
  }
  useEffect(() => { if (panel) void task.run(async () => setChoices(await records())); }, [panel]);
  useEffect(() => { void api.read<{ arbitrationFeeAsset?: string }>("/platform").then(async p => {
    if (p.arbitrationFeeAsset) {
      setFeeAsset(p.arbitrationFeeAsset);
      setFeeMetadata(await api.read(`/public/assets/${p.arbitrationFeeAsset}`));
    }
  }).catch(() => {}); }, [order.deployment.contract]);
  useEffect(() => {
    if (!relayJobId) return;
    const timer = window.setInterval(() => { void api.read<{ status: string }>(`/relay/jobs/${relayJobId}`).then(job => {
      if (job.status === "finalized") window.location.reload();
      if (job.status === "failed") { setRelayJobId(undefined); setReport("Relayed activation failed. Review the current case and retry or pay network fees directly."); }
    }).catch(() => {}); }, 5000);
    return () => window.clearInterval(timer);
  }, [relayJobId]);
  const feeLabel = (value: string) => feeAsset && feeMetadata ? `${formatUnits(value, feeMetadata.decimals)} ${feeMetadata.symbol}` : `${formatEther(value)} MON`;
  async function requestRows() {
    const rows: RequestRow[] = []; let after: string | null = null;
    do { const page: Page<RequestRow> = await api.request(`/orders/${order.orderId}/evidence-requests${after ? `?after=${after}` : ""}`); rows.push(...page.items); after = page.nextCursor; } while (after);
    return rows;
  }
  async function loadEvidence() {
    const e: EvidenceRow[] = [], r: RequestRow[] = [];
    let after: string | null = null;
    do { const page: Page<EvidenceRow> = await api.request(`/orders/${order.orderId}/evidence${after ? `?after=${after}` : ""}`); e.push(...page.items); after = page.nextCursor; } while (after);
    do { const page: Page<RequestRow> = await api.request(`/orders/${order.orderId}/evidence-requests${after ? `?after=${after}` : ""}`); r.push(...page.items); after = page.nextCursor; } while (after);
    setEvidence(e); setRequests(r);
  }
  const requestKey = `request-draft:${order.deployment.contract}:${order.orderId}:${account}:${currentRevision}`;
  async function makeRequest() {
    if (await store.get(requestKey)) throw new Error("Restore the existing request draft first.");
    const fresh = await api.request<OrderView>(`/orders/${order.orderId}`);
    if (!fresh.assignment || !fresh.eligibility.resolveArbitration) throw new Error("Request no longer eligible.");
    const rows = await records();
    const { count } = await api.request<{ count: string }>(`/orders/${order.orderId}/request-count`);
    const a = assignment(order.orderId, fresh.assignment);
    const result = await wallet.runOperation(async (session, currentSession) => {
      const valid = () => currentSession() && mounted.current && current.current.revision === a.revision;
      const p = await prepareRequest({ order, assignment: a, index: count, participant, advisoryDate: advisory ? String(Math.floor(Date.parse(advisory) / 1000)) : "0", sequences: sequences === "none" ? [] : sequences.trim() ? sequences.split(",").map(v => v.trim()) : [], instructions, availableSequences: rows.map(r => r.turn), signer: session, service: storageService(await api.read(`/storage-service?id=${service.id}&prepare=true`)), isCurrent: valid });
      await persistRequest(store, requestKey, p, password, valid);
      return p;
    });
    setRequestDraft(result);
  }
  async function submitRequest() {
    if (!requestDraft) return;
    const p = requestDraft, fresh = await api.request<OrderView>(`/orders/${order.orderId}`);
    if (!fresh.assignment || !fresh.eligibility.resolveArbitration || canonical(assignment(order.orderId, fresh.assignment)) !== canonical(p.record.reference.assignment) || canonical(p.record.reference.order) !== canonical(order)) throw new Error("Request assignment/order changed.");
    const savedService = storageService(await api.read(`/storage-service?id=${p.record.reference.serviceId}`));
    const status = await savedService.client.recoverUpload(p.item.seed, p.record.reference.creator);
    if (status.outcome === "active") { if (canonical(status.item) !== canonical(p.item)) throw new Error("Recovered request differs from draft."); }
    else if (status.outcome === "not-found") { const result = await savedService.client.upload(p.item); if ("state" in result) throw new Error("Upload pending; recover this same request."); }
    else throw new Error(`Request storage status: ${status.outcome}`);
    const request = evidenceReference({ record: p.record.reference });
    await prepareAction({ kind: "requestArbitrationEvidence", orderId: order.orderId, revision: fresh.assignment.revision, expectedIndex: p.record.index, participant: p.record.participant, advisoryDate: p.record.advisoryDate, request });
  }
  async function inspectRequest(row: RequestRow) {
    const all = await records();
    const opened = await wallet.runOperation(async (session, valid) => {
      const role = account === order.buyer.context.account ? "buyer" : account === order.seller.context.account ? "seller" : "arbitrator";
      const context = role === "arbitrator" ? arbitratorContext(order.deployment, account) : order[role].context;
      const key = role === "arbitrator" ? assignment(order.orderId, row.assignment).publicKey : order[role].publicKey;
      const identity = await restoreReceiving(context, session, valid, key);
      try { return await openRequest({ row, order, role, privateKey: identity.privateKey, service: storageService(await api.read(`/storage-service?id=${row.data.contentRef.serviceId}`)), availableSequences: all.map(r => r.turn), isCurrent: () => valid() && mounted.current }); }
      finally { identity.privateKey.fill(0); }
    });
    setRequestText(old => ({ ...old, [row.id]: `Requested sequences: ${opened.content.sequences.join(", ") || "none"}. ${opened.content.instructions}` }));
  }
  async function makeEvidence() {
    if (await store.get(recoveryKey)) throw new Error("An evidence draft exists. Restore it before preparing another copy.");
    const fresh = await api.request<OrderView>(`/orders/${order.orderId}`);
    const target = fresh.assignment ?? (selected && { ...selected, revision: "1" });
    if (!target) throw new Error("Select and review an arbitrator first.");
    if (fresh.order.state !== 6 && !fresh.eligibility.requestArbitration) throw new Error("Arbitration entry is no longer eligible.");
    const a = assignment(order.orderId, target), all = await records();
    const wanted = sequences === "none" ? [] : sequences.trim() ? sequences.split(",").map(s => s.trim()) : all.slice(0, 100).map(r => r.turn);
    const rows = all.filter(row => wanted.includes(row.turn));
    if (rows.length > 100 || rows.length !== new Set(wanted).size) throw new Error("Choose up to 100 existing sequence numbers, separated by commas.");
    const expected = rows.map(r => r.reference.contentHash), requested = fresh.assignment ? await requestRows() : [];
    const requestIds = requestSelection === "none" ? [] : requestSelection.trim() ? requestSelection.split(",").map(s => s.trim()) : requested.slice(0, 100).map(r => r.index);
    const selectedRequests = requested.filter(r => requestIds.includes(r.index));
    if (selectedRequests.length > 100 || selectedRequests.length !== new Set(requestIds).size) throw new Error("Select up to 100 existing request indexes.");
    const result = await wallet.runOperation(async (session, isCurrent) => {
      const valid = () => isCurrent() && mounted.current && current.current.revision === a.revision;
      const role = account === order.buyer.context.account ? "buyer" : "seller";
      const identity = await restoreReceiving(order[role].context, session, valid, order[role].publicKey);
      const originals: Opening[] = [], unreadable: string[] = [], requestCopies: RequestOpening[] = [];
      try {
        for (const row of rows) {
          try { originals.push(await openDelivery({ record: deliveryRecord(row, order), expectedRecordHash: row.commitment, order, role, privateKey: identity.privateKey, services: [storageService(await api.read(`/storage-service?id=${row.reference.serviceId}`))], isCurrent: valid })); }
          catch { if (!valid()) throw new Error("Wallet or assignment changed."); unreadable.push(row.reference.contentHash); }
        }
        for (const row of selectedRequests) {
          try { requestCopies.push(await openRequest({ row, order, role, privateKey: identity.privateKey, service: storageService(await api.read(`/storage-service?id=${row.data.contentRef.serviceId}`)), availableSequences: all.map(r => r.turn), isCurrent: valid })); }
          catch { if (!valid()) throw new Error("Wallet or assignment changed."); }
        }
      } finally { identity.privateKey.fill(0); }
      const selectedService = storageService(await api.read(`/storage-service?id=${service.id}&prepare=true`));
      const result = await prepareEvidence({ originals, expected, requests: requestCopies, expectedRequests: requested.map(r => r.commitment), availableSequences: all.map(r => r.turn), order, assignment: a, unreadable, signer: session, serviceId: selectedService.id, maxRetentionSeconds: selectedService.maxRetentionSeconds, latestPublicationSeconds: BigInt(Math.floor(Date.now() / 1000) + 600), isCurrent: valid });
      await persistEvidence(store, result, password, valid);
      if (!valid()) throw new Error("Wallet or assignment changed.");
      await store.compareAndSwap(recoveryKey, undefined, result.recordHash);
      return { ...result, requestCopies: requestCopies.length };
    });
    setPrepared(result); setReport(`${result.report.verified.length} verified originals; ${result.report.missing.length} unavailable in this copy. ${all.length - rows.length} other records may need supplemental copies. ${result.requestCopies} verified requests included; ${requested.length - result.requestCopies} requests omitted or unavailable.`);
  }
  async function submitEvidence() {
    if (!prepared) return;
    const fresh = await api.request<OrderView>(`/orders/${order.orderId}`);
    let target = fresh.assignment;
    let registry: Arbitrator | undefined;
    if (!target) {
      registry = await api.read<Arbitrator>(`/arbitrators/${prepared.record.assignment.wallet}`);
      if (!registry.active || !selected || registry.keyVersion !== selected.keyVersion || registry.fee !== selected.fee || registry.feeVersion !== selected.feeVersion) throw new Error("Arbitrator terms changed. Review them before proceeding.");
      target = { ...registry, revision: "1", requester: account, handoverRecorded: false };
    }
    if (canonical(assignment(order.orderId, target)) !== canonical(prepared.record.assignment)) throw new Error("Assignment changed. Keep this historical copy and prepare evidence for the replacement.");
    const savedService = storageService(await api.read(`/storage-service?id=${prepared.record.serviceId}`));
    const status = await savedService.client.recoverUpload(prepared.item.seed, prepared.record.creator);
    if (status.outcome === "active") { if (canonical(status.item) !== canonical(prepared.item)) throw new Error("Recovered evidence differs from saved evidence."); }
    else if (status.outcome === "not-found") {
      const result = await savedService.client.upload(prepared.item);
      if ("state" in result) throw new Error("Upload is pending. Retry to recover this same evidence object.");
    } else throw new Error(`Evidence storage status: ${status.outcome}. Keep the saved original.`);
    const content = evidenceReference(prepared);
    if (!mounted.current) throw new Error("Assignment changed; restore the current evidence draft.");
    if (fresh.order.state === 6) await prepareAction({ kind: "submitArbitrationEvidence", orderId: order.orderId, revision: target.revision, evidence: content });
    else {
      if (!fresh.eligibility.requestArbitration || !registry) throw new Error("Arbitration entry is no longer eligible.");
      const deployment = await api.read<Deployment>("/deployment");
      if (!payGasSelf && BigInt(registry.fee) > 0n && feeAsset && feeMetadata?.authorizationProfile?.mode === "eip3009-receive" && deployment.router && registry.feeVersion) {
        if (relayJobId) throw new Error("Check the pending arbitration activation before signing again.");
        const balance = await api.read<Asset>(`/public/wallets/${account}/assets/${feeAsset}`);
        if (BigInt(balance.balance) < BigInt(registry.fee)) throw new Error(`Insufficient ${balance.symbol} for the arbitration fee.`);
        const packet = buildArbitrationAuthorization({ deployment, asset: { ...feeMetadata, token: feeAsset }, requester: account,
          orderId: order.orderId, turn: fresh.order.turn, responseDeadline: fresh.order.responseDeadline, arbitrator: registry.wallet,
          keyVersion: registry.keyVersion, feeVersion: registry.feeVersion, fee: registry.fee, evidence: content });
        const signature = await wallet.runOperation(async (session, isCurrent) => {
          if (!session.signTypedData || !isCurrent() || session.address.toLowerCase() !== account) throw new Error("This wallet cannot sign token authorizations. Use the direct route.");
          const signed = await session.signTypedData(packet.typedData);
          if (!isCurrent()) throw new Error("Wallet changed while signing.");
          assertPurchaseSignature(packet.typedData, signed, account);
          return signed;
        });
        const job = await api.request<{ id: string }>("/relay/payments", { kind: "arbitration", chainId: deployment.chainId, escrow: deployment.contract,
          router: deployment.router, intent: packet.intent, authorization: { ...packet.authorization, signature } });
        setRelayJobId(job.id);
        setReport(`Arbitration activation submitted to the relayer. Job ${job.id}; the fee is charged only if activation succeeds.`);
        return;
      }
      if (feeAsset) {
        const balance = await api.read<Asset>(`/public/wallets/${account}/assets/${feeAsset}`);
        if (BigInt(balance.balance) < BigInt(registry.fee)) throw new Error(`Insufficient ${balance.symbol} for the arbitration fee.`);
        if (BigInt(balance.allowance) < BigInt(registry.fee)) {
          await prepareAction({ kind: "approveArbitrationFee", orderId: order.orderId, arbitrator: registry.wallet, expectedFee: registry.fee, expectedFeeAsset: feeAsset });
          return;
        }
      }
      await prepareAction({ kind: "requestArbitration", orderId: order.orderId, wallet: registry.wallet, expectedKeyVersion: registry.keyVersion, expectedFee: registry.fee,
        expectedFeeVersion: registry.feeVersion, expectedFeeAsset: feeAsset, evidence: content });
    }
  }
  async function inspect(row: EvidenceRow) {
    const fresh = await api.request<OrderView>(`/orders/${order.orderId}`), a = fresh.assignment;
    if (!a || row.revision !== a.revision) throw new Error("This copy belongs to an earlier assignment. Request a current handover copy.");
    const all = await records(), expected = all.map(r => r.reference.contentHash), requested = await requestRows();
    const result = await wallet.runOperation(async (session, isCurrent) => {
      const role = account === order.buyer.context.account ? "buyer" : account === order.seller.context.account ? "seller" : "arbitrator";
      const context = role === "arbitrator" ? arbitratorContext(order.deployment, account) : order[role].context;
      const publicKey = role === "arbitrator" ? assignment(order.orderId, a).publicKey : order[role].publicKey;
      const identity = await restoreReceiving(context, session, isCurrent, publicKey);
      const savedService = storageService(await api.read(`/storage-service?id=${row.data.contentRef.serviceId}`));
      try { return await openEvidence({ record: evidenceRecord(row.data, assignment(order.orderId, a), order), expectedRecordHash: row.commitment, role, privateKey: identity.privateKey, serviceId: savedService.id, download: (seed, creator) => savedService.client.downloadAndVerify(seed, creator), assignment: assignment(order.orderId, a), order, expected, expectedRequests: requested.map(r => r.commitment), availableSequences: all.map(r => r.turn), isCurrent: () => isCurrent() && mounted.current && current.current.revision === a.revision }); }
      finally { identity.privateKey.fill(0); }
    });
    setPlaintext(result.evidence.originals); setRequestText(old => ({ ...old, ...Object.fromEntries(result.evidence.requests.map(r => [requested.find(row => row.commitment === requestHash(r.record))?.id ?? r.record.index, `Verified handed-over request: ${r.content.sequences.join(", ")}. ${r.content.instructions}`])) })); setReport(`Integrity verified: ${result.report.verified.length} originals; reported unreadable: ${result.evidence.unreadable.length}; omitted: ${result.report.missing.length - result.evidence.unreadable.length}; missing sequences: ${all.filter(r => result.report.missing.includes(r.reference.contentHash)).map(r => r.turn).join(", ") || "none"}. No automatic settlement follows verification.`);
  }
  if (!view.assignment && !view.eligibility.requestArbitration) return null;
  return <section className="arbitration-workspace"><h3>Case details</h3><Feedback {...task} />{report && <p role="status">{report}</p>}
    {view.eligibility.requestArbitration && <><label>Approved arbitrators<select value={address} onChange={e => { setAddress(e.target.value); setSelected(undefined); }}><option value="">Select or enter a wallet below</option>{registry.items.filter(a => ![view.order.buyer, view.order.seller].includes(a.wallet)).map(a => <option key={a.wallet} value={a.wallet}>{a.wallet} · {feeLabel(a.fee)}</option>)}</select></label>{registry.nextCursor && <Button icon={ButtonScale} variant="secondary" onClick={() => void task.run(async () => { const p = await api.read<Page<Arbitrator>>(`/arbitrators?after=${registry.nextCursor}`); setRegistry({ ...p, items: [...registry.items, ...p.items] }); })}>More arbitrators</Button>}</>}
    {view.eligibility.requestArbitration && <><p>Choose an approved arbitrator. Their fee is paid directly on activation. A direct token payment requires an allowance first. Missing evidence does not prevent entry.</p><label>Arbitrator wallet<input value={address} onChange={e => { setAddress(e.target.value); setSelected(undefined); }} /></label><Button icon={ButtonScale} disabled={task.busy} onClick={() => void task.run(async () => { const a = await api.read<Arbitrator>(`/arbitrators/${address}`); if (!a.active || [view.order.buyer, view.order.seller].includes(a.wallet)) throw new Error("Select an active independent arbitrator."); setSelected(a); })}>Review arbitrator and fee</Button>{selected && <><p>{selected.wallet} · key version {selected.keyVersion} · fee {feeLabel(selected.fee)} (non-refundable)</p>{feeAsset && feeMetadata?.authorizationProfile && <label className="checkbox"><input type="checkbox" checked={payGasSelf} onChange={e => setPayGasSelf(e.target.checked)} />Pay MON network gas myself instead of using a relayer</label>}</>}</>}
    {view.assignment && <><p>Assigned: {view.assignment.wallet} · revision {view.assignment.revision} · key version {view.assignment.keyVersion}</p>{view.order.state === 6 && <p>Waiting for the arbitrator's decision. Ordinary acceptance, refund and payout are paused. {view.assignment.handoverRecorded ? "Evidence handover recorded." : "Evidence handover is pending; either participant can supply a copy."}</p>}<Button icon={ButtonEye} variant="secondary" disabled={task.busy} onClick={() => void task.run(loadEvidence)}>Load evidence and requests</Button>{requests.map(r => <p key={r.id}>Revision {r.revision}: request to {r.participant} with encrypted instructions. Suggested date: {date(r.advisoryDate)} (informational; does not prevent a decision). <Button icon={ButtonEye} disabled={task.busy || (!isParticipant && r.assignment.wallet !== account)} onClick={() => void task.run(() => inspectRequest(r))}>Open encrypted request</Button>{requestText[r.id] && <span className="description">{requestText[r.id]}</span>}</p>)}{evidence.map(e => <div className="card" key={e.id}><p>Evidence #{e.index} · assignment {e.revision} · encrypted coverage; open to verify</p><Button icon={ButtonCheck} disabled={task.busy || e.revision !== currentRevision} onClick={() => void task.run(() => inspect(e))}>Open and verify evidence</Button></div>)}</>}
    {plaintext.map(o => <article className="card" key={o.turn}><h3>Verified original #{o.turn}</h3><p className="description">{o.payload.text}</p>{o.payload.tickets.map(t => <p key={t.row}>{t.ticket}</p>)}</article>)}
    {isParticipant && (view.eligibility.requestArbitration || view.order.state === 6) && <><Button icon={ButtonCopy} variant="secondary" disabled={task.busy} onClick={() => setPanel("evidence")}>Prepare or restore evidence</Button>{panel === "evidence" && <OrderDialog title="Prepare evidence" onClose={() => { if (!task.busy) setPanel(undefined); }}><EvidenceSelection title="Messages to include" choices={choices.map(r => ({ id: r.turn, label: r.turn === "0" ? "Seller delivery" : `Message ${r.turn} - ${r.sender === account ? "You" : "Other participant"}` }))} value={sequences} onChange={setSequences} defaultFirst /><EvidenceSelection title="Arbitrator requests to include" choices={requests.map(r => ({ id: r.index, label: `Request ${r.index} - assignment ${r.revision}` }))} value={requestSelection} onChange={setRequestSelection} defaultFirst /><label>Evidence recovery passphrase<input type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} /></label><Button icon={ButtonArrowRight} disabled={task.busy || wallet.busy || password.length < 12 || (!selected && !view.assignment)} onClick={() => void task.run(makeEvidence)}>Prepare encrypted evidence</Button><Button icon={ButtonArrowRight} disabled={task.busy || password.length < 12} onClick={() => void task.run(async () => { const key = await store.get(recoveryKey); if (typeof key !== "string") throw new Error("No saved evidence for this assignment."); const p = await restoreEvidence(store, key, password); setPrepared(p); if (!view.assignment) setSelected(await api.read<Arbitrator>(`/arbitrators/${p.record.assignment.wallet}`)); })}>Restore evidence draft</Button>{prepared && <><p>Saved evidence for {prepared.record.assignment.wallet}, revision {prepared.record.assignment.revision}. Available: {prepared.report.verified.length}; missing: {prepared.report.missing.length}.</p><Button icon={ButtonScale} disabled={task.busy || wallet.busy} onClick={() => void task.run(async () => { await submitEvidence(); setPanel(undefined); })}>{view.order.state === 6 ? "Review evidence submission" : "Review arbitration activation and fee"}</Button><Button icon={ButtonCopy} disabled={task.busy} onClick={() => void task.run(async () => { await loadEvidence(); const page = await api.request<Page<EvidenceRow>>(`/orders/${order.orderId}/evidence?limit=50`); if (!page.items.some(e => e.commitment === prepared.recordHash)) throw new Error("Keep this draft until its publication is finalized and indexed."); await store.remove(recoveryKey); setPrepared(undefined); })}>Start supplemental copy after publication</Button></>}<Feedback {...task} />{report && <p role="status">{report}</p>}</OrderDialog>}</>}
    {view.eligibility.resolveArbitration && view.assignment && <><h3>Arbitrator actions</h3><Button icon={ButtonEye} variant="secondary" disabled={task.busy} onClick={() => setPanel("request")}>Request evidence</Button><Button icon={ButtonUndo2} variant="secondary" disabled={task.busy} onClick={() => { setDecision(false); setPanel("decision"); }}>Refund buyer</Button><Button icon={ButtonCheck} disabled={task.busy} onClick={() => { setDecision(true); setPanel("decision"); }}>Pay seller</Button>{panel === "decision" && <OrderDialog title={decision ? "Pay seller" : "Refund buyer"} onClose={() => { if (!task.busy) setPanel(undefined); }}><OrderAmount token={view.order.terms.token} price={view.order.terms.price} /><p>This decision settles the full order amount in favor of the {decision ? "seller" : "buyer"}. Review the evidence before continuing.</p><Button icon={ButtonCheck} disabled={task.busy} onClick={() => void task.run(async () => { await prepareAction({ kind: "resolveArbitration", orderId: order.orderId, revision: currentRevision, sellerWins: decision }); setPanel(undefined); })}>Review decision transaction</Button><Feedback {...task} /></OrderDialog>}{panel === "request" && <OrderDialog title="Request evidence" onClose={() => { if (!task.busy) setPanel(undefined); }}><p>You may decide on available evidence at any time, including missing handover. Suggested response dates do not block decisions.</p><label>Request evidence from<select value={participant} onChange={e => setParticipant(e.target.value)}><option value={view.order.buyer}>Buyer</option><option value={view.order.seller}>Seller</option></select></label><EvidenceSelection title="Messages to request" choices={choices.map(r => ({ id: r.turn, label: r.turn === "0" ? "Seller delivery" : `Message ${r.turn}` }))} value={sequences} onChange={setSequences} /><label>Suggested response date<input type="datetime-local" value={advisory} onChange={e => setAdvisory(e.target.value)} /></label><label>Request instructions<textarea value={instructions} onChange={e => setInstructions(e.target.value)} /></label><label>Request recovery passphrase<input type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} /></label><Button icon={ButtonArrowRight} disabled={task.busy || wallet.busy || password.length < 12} onClick={() => void task.run(makeRequest)}>Prepare encrypted request</Button><Button icon={ButtonArrowRight} disabled={task.busy || password.length < 12} onClick={() => void task.run(async () => setRequestDraft(await restoreRequest(store, requestKey, password)))}>Restore request draft</Button>{requestDraft && <><p>Saved request #{requestDraft.record.index} to {requestDraft.record.participant}; sequences {requestDraft.content.sequences.join(", ") || "none"}; suggested date {date(requestDraft.record.advisoryDate)}.</p><p className="description">{requestDraft.content.instructions}</p><Button icon={ButtonEye} disabled={task.busy || wallet.busy} onClick={() => void task.run(async () => { await submitRequest(); setPanel(undefined); })}>Review encrypted evidence request</Button><Button icon={ButtonArrowRight} disabled={task.busy} onClick={() => void task.run(async () => { const page = await api.request<Page<RequestRow>>(`/orders/${order.orderId}/evidence-requests?after=${BigInt(requestDraft.record.index) - 1n}&limit=1`); if (!page.items.some(r => r.commitment === requestDraft.recordHash)) throw new Error("Keep draft until finalized publication is verified."); await store.remove(requestKey); setRequestDraft(undefined); await loadEvidence(); })}>Start next request after publication</Button><Button icon={ButtonArrowRight} disabled={task.busy} onClick={() => void task.run(async () => { const page = await api.request<Page<RequestRow>>(`/orders/${order.orderId}/evidence-requests?after=${BigInt(requestDraft.record.index) - 1n}&limit=1`); if (!page.items.some(r => r.index === requestDraft.record.index && r.commitment !== requestDraft.recordHash)) throw new Error("No finalized competing request at this index. Keep this draft."); await store.remove(requestKey); setRequestDraft(undefined); })}>Discard draft superseded by another finalized request</Button></>}<Feedback {...task} /></OrderDialog>}</>}
  </section>;
}

function EvidenceSelection({ title, choices, value, onChange, defaultFirst = false }: { title: string; choices: { id: string; label: string }[]; value: string; onChange(value: string): void; defaultFirst?: boolean }) {
  const selected = value === "none" ? [] : value ? value.split(",") : defaultFirst ? choices.slice(0, 100).map(c => c.id) : [];
  return <fieldset className="evidence-selection"><legend>{title}</legend><p className="muted">Select up to 100. Missing content does not prevent arbitration.</p>{choices.map(choice => <label key={choice.id}><input type="checkbox" checked={selected.includes(choice.id)} disabled={!selected.includes(choice.id) && selected.length >= 100} onChange={e => { const next = e.target.checked ? [...selected, choice.id] : selected.filter(id => id !== choice.id); onChange(next.length ? next.join(",") : "none"); }} />{choice.label}</label>)}{!choices.length && <p>No indexed items available.</p>}</fieldset>;
}
