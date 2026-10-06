import { canonical } from "@/crypto/encoding";
import type { Action, OrderView, Page } from "./client";
import type { ChainRecord, EvidenceReference } from "./lifecycle";
type Reader = { request<T>(path: string): Promise<T> };
// A positive result proves the intended effect exists in finalized state. Absence
// remains uncertain; it never authorizes a fresh operation or an automatic retry.
export async function reconcileAction(api: Reader, account: string, action: Action): Promise<boolean> {
  if (!("orderId" in action)) return false;
  const view = await api.request<OrderView>(`/orders/${action.orderId}`), o = view.order;
  switch (action.kind) {
    case "withdrawSeller": return o.seller === account && o.state === 8;
    case "claimResponseTimeout": return o.seller === account ? o.state === 8 : o.buyer === account && o.state === 9;
    case "reserveDelivery": return o.seller === account && BigInt(o.publicationDeadline) > 0n;
    case "publishDelivery": case "openDispute": case "replyToDispute": {
      const turn = action.kind === "publishDelivery" ? "0" : action.kind === "openDispute" ? "1" : action.expectedTurn;
      const page = await api.request<Page<ChainRecord>>(`/orders/${action.orderId}/records?after=${BigInt(turn) - 1n}&limit=1`);
      return page.items.some(r => r.turn === turn && r.sender === account && canonical(r.reference) === canonical(action.reference));
    }
    case "requestArbitration": case "submitArbitrationEvidence": {
      let after: string | null = null;
      do {
        const page: Page<{ submitter: string; revision: string; data: EvidenceReference }> = await api.request(`/orders/${action.orderId}/evidence${after ? `?after=${after}` : ""}`);
        if (page.items.some(r => r.submitter === account && r.revision === (action.kind === "requestArbitration" ? "1" : action.revision) && canonical(r.data) === canonical(action.evidence))) return true;
        after = page.nextCursor;
      } while (after);
      return false;
    }
    case "requestArbitrationEvidence": {
      const page = await api.request<Page<{ index: string; revision: string; participant: string; advisoryDate: string; assignment: { wallet: string }; data: EvidenceReference }>>(`/orders/${action.orderId}/evidence-requests?after=${BigInt(action.expectedIndex) - 1n}&limit=1`);
      return page.items.some(r => r.index === action.expectedIndex && r.revision === action.revision && r.assignment.wallet === account && r.participant === action.participant && r.advisoryDate === action.advisoryDate && canonical(r.data) === canonical(action.request));
    }
    default: return false;
  }
}
