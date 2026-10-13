export type OrderRole = "buyer" | "seller" | "arbitrator";

export function orderPath(id: string, role: OrderRole) {
  return role === "buyer" ? `/purchases/${id}` : role === "seller" ? `/sales/orders/${id}` : `/arbitration/${id}`;
}

export function orderRole(order: {
  buyer: string;
  seller: string
}, arbitrator: string | undefined, account: string | null | undefined): OrderRole | undefined {
  const address = account?.toLowerCase();
  if (!address) return undefined;
  return order.buyer.toLowerCase() === address ? "buyer" : order.seller.toLowerCase() === address ? "seller" : arbitrator?.toLowerCase() === address ? "arbitrator" : undefined;
}

export function matchesOrderRole(role: OrderRole, order: {
  buyer: string;
  seller: string
}, arbitrator: string | undefined, account: string | null | undefined) {
  const participant = role === "arbitrator" ? arbitrator : order[role];
  return !!participant && !!account && participant.toLowerCase() === account.toLowerCase();
}
