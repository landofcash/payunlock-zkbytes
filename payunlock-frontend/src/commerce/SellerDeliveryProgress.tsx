import {Check, FilePenLine, Package, Send} from "lucide-react";

export function SellerDeliveryProgress({state, canceled}: { state: number; canceled: boolean }) {
  if (canceled || state >= 6) return null;
  const step = state === 1 ? 0 : state === 2 ? 1 : 2;
  return <section className="seller-delivery-progress" aria-label="Seller fulfillment"><h2>Delivery progress</h2>
    <ol>{[{label: "Prepare content", icon: FilePenLine}, {
      label: "Publish delivery",
      icon: Send
    }, {label: "Buyer review", icon: Package}].map((item, index) => {
      const Icon = index < step ? Check : item.icon;
      return <li key={item.label} className={index === step ? "current" : index < step ? "complete" : ""}
                 aria-current={index === step ? "step" : undefined}><Icon size={18}/><span>{item.label}</span></li>;
    })}</ol>
    <p>{step === 0 ? "Prepare and review your buyer's content before sending." : step === 1 ? "Finish publication before the deadline. Your delivery is not complete until publication is confirmed." : "Delivery is published. Follow the order status for review, conversation or payment actions."}</p>
  </section>;
}
