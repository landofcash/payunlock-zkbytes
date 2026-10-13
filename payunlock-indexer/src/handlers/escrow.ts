import { indexer, type EvmOnEventContext, type ChainOrder } from "envio";

/**
 * Lifecycle states for PayUnlock escrow orders.
 */
export const OrderState = {
  None: 0,
  Created: 1,
  Reserved: 2,
  Delivered: 3,
  Reviewing: 4,
  Disputed: 5,
  Arbitration: 6,
  Confirmed: 7,
  SettledToSeller: 8,
  SettledToBuyer: 9,
} as const;

export type OrderState = (typeof OrderState)[keyof typeof OrderState];

/** 32-byte zero hex string used as a placeholder for uninitialized commitments. */
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

/** Block number multiplier used to generate a unique monotonically increasing event position key. */
const EVENT_POSITION_BLOCK_MULTIPLIER = 1_000_000n;

// Handlers only write Envio entities: all writes participate in Envio rollback.
// No application database, network calls, signing, or fulfillment side effects.

/**
 * Serializes values to JSON, converting BigInts to strings and formatting specific fields (e.g. serviceId).
 */
export const encode = (value: unknown): string =>
  JSON.stringify(value, (key, item: unknown) =>
    key === "serviceId" ? Number(item) : typeof item === "bigint" ? item.toString() : item
  );

type Event = {
  chainId: number;
  srcAddress: string;
  logIndex: number;
  block: { number: number; hash: string };
  transaction: { hash: string };
  params: unknown;
};

const deployment = (event: Event): string => `${event.chainId}:${event.srcAddress.toLowerCase()}`;
const orderKey = (event: Event, id: bigint): string => `${deployment(event)}:${id}`;
const eventKey = (event: Event): string => `${deployment(event)}:${event.block.number}:${event.logIndex}`;

async function begin(context: EvmOnEventContext, event: Event, name: string, id?: bigint) {
  const key = eventKey(event);
  const [seen, order] = await Promise.all([
    context.ChainEvent.get(key),
    id === undefined ? Promise.resolve(undefined) : context.ChainOrder.get(orderKey(event, id)),
  ]);

  if (context.isPreload || seen) {
    return undefined;
  }

  const blockNumber = BigInt(event.block.number);
  const position = blockNumber * EVENT_POSITION_BLOCK_MULTIPLIER + BigInt(event.logIndex);

  context.ChainEvent.set({
    id: key,
    deployment: deployment(event),
    order: id === undefined ? "" : orderKey(event, id),
    name,
    blockNumber,
    blockHash: event.block.hash,
    position,
    transactionHash: event.transaction.hash,
    data: encode(event.params),
  });

  return { order, block: blockNumber };
}

function existing(order: ChainOrder | undefined, orderId?: bigint): ChainOrder {
  if (!order) {
    const idDetails = orderId !== undefined ? ` (orderId: ${orderId})` : "";
    throw new Error(`Order event before purchase${idDetails}; check deployment start block or event sequence.`);
  }
  return order;
}

indexer.onEvent({ contract: "PayUnlock", event: "ProductConfigured" }, async ({ event, context }) => {
  if (!(await begin(context, event, "ProductConfigured"))) return;
  const p = event.params;
  context.ChainProduct.set({
    id: `${deployment(event)}:${p.seller.toLowerCase()}:${p.key}`,
    deployment: deployment(event),
    seller: p.seller.toLowerCase(),
    productKey: p.key,
    status: Number(p.product.status),
    data: encode(p.product),
    updatedBlock: BigInt(event.block.number),
  });
});

indexer.onEvent({ contract: "PayUnlock", event: "Purchased" }, async ({ event, context }) => {
  const p = event.params;
  const productId = `${deployment(event)}:${p.order.seller.toLowerCase()}:${p.order.productKey}`;
  const product = await context.ChainProduct.get(productId);
  const result = await begin(context, event, "Purchased", p.orderId);
  if (!result) return;
  if (result.order) throw new Error(`Duplicate purchase event for order ID ${p.orderId}`);

  const o = p.order;
  context.ChainOrder.set({
    id: orderKey(event, p.orderId),
    deployment: deployment(event),
    orderId: p.orderId,
    buyer: o.buyer.toLowerCase(),
    seller: o.seller.toLowerCase(),
    productKey: o.productKey,
    requestId: o.requestId,
    state: Number(o.state),
    snapshot: encode(o),
    token: o.terms.token.toLowerCase(),
    price: o.terms.price,
    commitment: ZERO_BYTES32,
    publicationDeadline: 0n,
    reviewDeadline: 0n,
    responseDeadline: 0n,
    turn: 0n,
    arbitrator: "",
    assignment: "",
    revision: 0n,
    handoverRecorded: false,
    updatedBlock: result.block,
  });

  if (product) {
    const data = JSON.parse(product.data) as { orderCount: string };
    data.orderCount = (BigInt(data.orderCount) + 1n).toString();
    context.ChainProduct.set({ ...product, data: encode(data), updatedBlock: result.block });
  }
});

indexer.onEvent({ contract: "PayUnlock", event: "DeliveryReserved" }, async ({ event, context }) => {
  const result = await begin(context, event, "DeliveryReserved", event.params.orderId);
  if (!result) return;

  context.ChainOrder.set({
    ...existing(result.order, event.params.orderId),
    state: OrderState.Reserved,
    publicationDeadline: event.params.publicationDeadline,
    updatedBlock: result.block,
  });
});

indexer.onEvent({ contract: "PayUnlock", event: "RecordPublished" }, async ({ event, context }) => {
  const p = event.params;
  const result = await begin(context, event, "RecordPublished", p.orderId);
  if (!result) return;

  const order = existing(result.order, p.orderId);
  context.ChainRecord.set({
    id: `${order.id}:${p.sequence}`,
    order: order.id,
    sequence: p.sequence,
    author: p.author.toLowerCase(),
    commitment: p.recordHash,
    data: encode(p.contentRef),
  });

  context.ChainOrder.set({
    ...order,
    ...(p.sequence === 0n ? { commitment: p.recordHash } : {}),
    turn: p.sequence,
    updatedBlock: result.block,
  });
});

indexer.onEvent({ contract: "PayUnlock", event: "StateChanged" }, async ({ event, context }) => {
  const p = event.params;
  const result = await begin(context, event, "StateChanged", p.orderId);
  if (!result) return;

  const order = existing(result.order, p.orderId);
  const state = Number(p.state);

  context.ChainOrder.set({
    ...order,
    state,
    updatedBlock: result.block,
    reviewDeadline: state === OrderState.Delivered ? p.deadline : order.reviewDeadline,
    responseDeadline:
      state === OrderState.Reviewing || state === OrderState.Disputed ? p.deadline : order.responseDeadline,
  });
});

indexer.onEvent({ contract: "PayUnlock", event: "Settled" }, async ({ event, context }) => {
  const result = await begin(context, event, "Settled", event.params.orderId);
  if (!result) return;

  context.ChainOrder.set({
    ...existing(result.order, event.params.orderId),
    state: Number(event.params.state),
    updatedBlock: result.block,
  });
});

indexer.onEvent({ contract: "PayUnlock", event: "ArbitratorConfigured" }, async ({ event, context }) => {
  if (!(await begin(context, event, "ArbitratorConfigured"))) return;
  const p = event.params;

  context.ChainArbitrator.set({
    id: `${deployment(event)}:${p.arbitrator.toLowerCase()}`,
    deployment: deployment(event),
    wallet: p.arbitrator.toLowerCase(),
    ...p.configuration,
  });
});

indexer.onEvent({ contract: "PayUnlock", event: "ArbitrationFeeSet" }, async ({ event, context }) => {
  if (!(await begin(context, event, "ArbitrationFeeSet"))) return;
  const key = `${deployment(event)}:${event.params.arbitrator.toLowerCase()}`;
  const existingArbitrator = await context.ChainArbitrator.get(key);
  if (!existingArbitrator) {
    throw new Error(`Arbitrator ${event.params.arbitrator} fee event before registration; check deployment start block.`);
  }

  context.ChainArbitrator.set({ ...existingArbitrator, fee: event.params.fee });
});

indexer.onEvent({ contract: "PayUnlock", event: "FeeAccrued" }, async ({ event, context }) => {
  await begin(context, event, "FeeAccrued", event.params.orderId);
});

indexer.onEvent({ contract: "PayUnlock", event: "FeesClaimed" }, async ({ event, context }) => {
  await begin(context, event, "FeesClaimed");
});

indexer.onEvent({ contract: "PayUnlock", event: "ArbitrationAssigned" }, async ({ event, context }) => {
  const p = event.params;
  const result = await begin(context, event, "ArbitrationAssigned", p.orderId);
  if (!result) return;

  context.ChainOrder.set({
    ...existing(result.order, p.orderId),
    state: OrderState.Arbitration,
    arbitrator: p.assignment.wallet.toLowerCase(),
    assignment: encode(p.assignment),
    revision: p.assignment.revision,
    handoverRecorded: p.assignment.handoverRecorded,
    updatedBlock: result.block,
  });
});

indexer.onEvent({ contract: "PayUnlock", event: "EvidencePublished" }, async ({ event, context }) => {
  const p = event.params;
  const result = await begin(context, event, "EvidencePublished", p.orderId);
  if (!result) return;

  const order = existing(result.order, p.orderId);
  context.ChainEvidence.set({
    id: `${order.id}:${p.index}`,
    order: order.id,
    index: p.index,
    revision: p.revision,
    submitter: p.submitter.toLowerCase(),
    commitment: p.recordHash,
    data: encode(p.evidence),
  });

  const assignment = JSON.parse(order.assignment) as Record<string, unknown>;
  context.ChainOrder.set({
    ...order,
    assignment: encode({ ...assignment, handoverRecorded: true }),
    handoverRecorded: true,
    updatedBlock: result.block,
  });
});

indexer.onEvent({ contract: "PayUnlock", event: "EvidenceRequested" }, async ({ event, context }) => {
  const p = event.params;
  const result = await begin(context, event, "EvidenceRequested", p.orderId);
  if (!result) return;

  const order = existing(result.order, p.orderId);
  context.ChainEvidenceRequest.set({
    id: `${order.id}:${p.requestIndex}`,
    order: order.id,
    index: p.requestIndex,
    revision: p.revision,
    participant: p.participant.toLowerCase(),
    commitment: p.recordHash,
    data: encode(p.request),
    assignment: encode(p.assignment),
    advisoryDate: p.advisoryDate,
  });
});

const PROTOCOL_CONFIG_EVENTS = [
  "StorageServiceAdded",
  "BatchLimitChanged",
  "TimingBoundsChanged",
  "AssetAllowed",
  "ReceiveAuthorizationAssetConfigured",
  "AuthorizationRouterSet",
  "ServiceFeeConfigured",
  "PlacementFeeConfigured",
  "SellerFeeCapConfigured",
  "ArbitrationFeeAssetSet",
  "DefaultsChanged",
  "OwnershipTransferStarted",
  "OwnershipTransferred",
] as const;

for (const name of PROTOCOL_CONFIG_EVENTS) {
  indexer.onEvent({ contract: "PayUnlock", event: name }, async ({ event, context }) => {
    if (!(await begin(context, event, name))) return;
    const suffix =
      "asset" in event.params
        ? `:${event.params.asset.toLowerCase()}`
        : "serviceId" in event.params
          ? `:${event.params.serviceId}`
          : "";
    context.ChainConfiguration.set({
      id: `${deployment(event)}:${name}${suffix}`,
      data: encode(event.params),
    });
  });
}
