// Per transaction, including the preparation service's 20% estimation margin.
// The contract authorization tests verify this bound for reserve and publish.
export const DELIVERY_GAS_BOUND = 1_000_000n;
