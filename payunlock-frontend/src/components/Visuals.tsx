import { motion, useReducedMotion } from "motion/react";
import { BadgeCheck, Box, LockKeyhole, ShieldCheck, Sparkles } from "lucide-react";
import { BorderBeam } from "./ui/border-beam";
import { useTheme } from "@/app/theme";
import { orderStatusTone } from "@/commerce/order-status-tone";
export function DeliveryIllustration() {
  const reduced = useReducedMotion(), { theme } = useTheme();
  return <motion.div className="delivery-illustration" initial={false} animate={{ opacity: 1 }} aria-label="Private delivery with payment protection">
    <div className="illustration-top"><span><Sparkles size={15} aria-hidden="true" /> Built for the exchange</span><span className="live-dot" /></div>
    <div className="illustration-path" aria-hidden="true"><div><Box /><span>Create</span></div><i /><div className="illustration-lock"><LockKeyhole /><span>Encrypt</span></div><i /><div><BadgeCheck /><span>Deliver</span></div></div>
    <div className="illustration-card"><div className="illustration-avatar"><LockKeyhole aria-hidden="true" /></div><div><strong>Good things. Privately delivered.</strong><p>Your content is encrypted for its recipients.</p></div></div>
    <div className="illustration-footer"><ShieldCheck size={16} aria-hidden="true" /> Payment held in escrow <span>Powered by zkbytes</span></div>
    {!reduced && theme !== "terminal" && <BorderBeam duration={12} size={110} colorFrom="var(--accent)" colorTo="var(--accent-soft)" />}
  </motion.div>;
}
export function OrderBadge({ state }: { state: number }) {
  const names = ["Missing", "Paid", "Publication pending", "Delivered", "Seller response due", "Buyer response due", "In arbitration", "Accepted", "Paid out", "Refunded"];
  return <span className={`order-badge status-${orderStatusTone(state)}`}>{names[state] ?? "Unknown"}</span>;
}
