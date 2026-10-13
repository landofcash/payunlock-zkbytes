import {useEffect, useId, useRef} from "react";
import {createPortal} from "react-dom";
import {Check, X} from "lucide-react";
import {Button} from "@/components/ui/button";

export function TimingHelpDialog({topic, onClose, readOnly = false}: {
  topic: "event" | "review";
  onClose: () => void;
  readOnly?: boolean
}) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return createPortal(<dialog ref={dialog} className="approval-dialog wallet-action-dialog timing-help-dialog"
                              aria-labelledby={titleId} onCancel={event => {
    event.preventDefault();
    onClose();
  }}>
    <div className="section-heading"><h2 id={titleId}>{topic === "event" ? "Event end" : "Review period"}</h2><Button
      icon={X} variant="ghost" size="icon" aria-label="Close timing help" onClick={onClose}/></div>
    {topic === "event" ? <>
      <p>{readOnly ? "For an offer tied to a workshop, livestream or other event, this is when the event ends. Times are shown in your local time." : "Use this for offers tied to an event, such as a workshop or livestream. Choose when the event finishes, in your local time. Leave it empty for offers without an event."}</p>
      <p>The buyer’s review period starts after both delivery is published and the event has ended—whichever happens
        later.</p>
      <div className="timing-help-example"><strong>Example</strong><p>If you deliver on Monday, the event ends on
        Wednesday at 6 pm, and the review period is 24 hours, the buyer has until Thursday at 6 pm to review.</p></div>
      <p className="muted">This is not a sales closing date or a delivery deadline.</p>
    </> : <>
      <p>This is how long the buyer has to check a published delivery and raise a dispute before the seller becomes
        eligible to claim payment.</p>
      <p>It starts when delivery is published, or at the event end if that is later.</p>
      <div className="timing-help-example"><strong>Example</strong><p>With a 24-hour review period and no event,
        delivery published on Monday at 2 pm can be claimed on Tuesday at 2 pm, unless the buyer opens a dispute.</p>
      </div>
      <p>A buyer can accept delivery early to release payment sooner. A zero review period allows payment to be claimed
        immediately after delivery and any event end.</p>
      <p className="muted">Existing purchases keep the timing terms they were bought with.</p>
    </>}
    <div className="dialog-actions"><Button icon={Check} onClick={onClose}>Got it</Button></div>
  </dialog>, document.body);
}
