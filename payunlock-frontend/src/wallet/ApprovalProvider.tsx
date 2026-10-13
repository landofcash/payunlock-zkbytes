import {KeyRound as ButtonKeyRound, X as ButtonX} from "lucide-react";
import {Button} from "@/components/ui/button";
import {createContext, type ReactNode, useContext, useEffect, useRef, useState} from "react";
import type {Approval} from "./managed-session";
import {useSession} from "./session-store";
import {formatEther} from "ethers";

const Context = createContext<Approval | null>(null);

export function ApprovalProvider({children}: { children: ReactNode }) {
  const wallet = useSession();
  const [request, setRequest] = useState<Parameters<Approval>[0] | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const signingDetails = useRef<HTMLDetailsElement>(null);
  const answer = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setRequest(null);
  };
  useEffect(() => {
    answer(false);
    return () => {
      resolver.current?.(false);
      resolver.current = null;
    };
  }, [wallet.sessionEpoch, wallet.identityEpoch]);
  useEffect(() => {
    if (request) {
      signingDetails.current?.removeAttribute("open");
      if (!dialog.current?.open) dialog.current?.showModal();
    } else dialog.current?.close();
  }, [request]);
  const approve: Approval = value => new Promise(resolve => {
    resolver.current?.(false);
    resolver.current = resolve;
    setRequest(value);
  });
  return <Context.Provider value={approve}>{children}
    <dialog className="approval-dialog" aria-labelledby="signing-title" ref={dialog} onCancel={e => {
      e.preventDefault();
      answer(false);
    }}><h2
      id="signing-title">{request?.kind === "transaction" ? "Confirm wallet transaction" : request?.kind === "typedData" ? request.typedData.primaryType === "PayUnlockAction" ? "Authorize sponsored action" : "Authorize token payment" : "Review message signature"}</h2>
      <p>{request?.kind === "transaction" ? "Confirm the payment and maximum network fee before signing." : request?.kind === "typedData" ? request.typedData.primaryType === "PayUnlockAction" ? "This signature authorizes the exact action shown below. A relayer pays the MON network fee." : "This signature authorizes the exact token amount below. A relayer pays the MON network fee." : "This message signature costs no gas. Approve only the request you intended."}</p>{request?.kind === "transaction" &&
            <dl className="terms">
                <dt>Amount</dt>
                <dd>{formatEther(request.transaction.value)} MON</dd>
                <dt>Maximum network fee</dt>
                <dd>{formatEther(request.transaction.gas * request.transaction.maxFeePerGas)} MON</dd>
                <dt>Destination</dt>
                <dd className="address">{request.transaction.to}</dd>
            </dl>}{request?.kind === "typedData" && <dl className="terms">
            <dt>Purpose</dt>
            <dd>{request.typedData.review.title}</dd>
        {request.typedData.primaryType !== "PayUnlockAction" && <>
            <dt>Amount</dt>
            <dd>{request.typedData.review.amount} {request.typedData.review.asset}</dd>
        </>}
            <dt>Expires</dt>
            <dd>{request.typedData.review.expiresAt}</dd>
            <dt>{request.typedData.primaryType === "PayUnlockAction" ? "Escrow" : "Authorized recipient"}</dt>
            <dd className="address">{request.typedData.review.recipient}</dd>
        </dl>}
      <details ref={signingDetails} className="signing-details">
        <summary>Signing details</summary>
        <pre>{request?.kind === "message" ? request.message : request?.kind === "transaction" ? JSON.stringify(request.transaction, (_, v: unknown) => typeof v === "bigint" ? String(v) : v, 2) : request?.kind === "typedData" ? JSON.stringify({
          domain: request.typedData.domain,
          message: request.typedData.message
        }, null, 2) : ""}</pre>
      </details>
      <Button icon={ButtonX} variant="secondary" onClick={() => answer(false)}>Cancel</Button><Button
        icon={ButtonKeyRound}
        onClick={() => answer(true)}>{request?.kind === "transaction" ? "Sign transaction" : "Approve signature"}</Button>
    </dialog>
  </Context.Provider>;
}

export function useApproval() {
  const value = useContext(Context);
  if (!value) throw new Error("ApprovalProvider missing.");
  return value;
}
