import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Client } from "pg";
import { Wallet, Transaction, Result } from "ethers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ApiError, type ChainSnapshot } from "../src/domain.js";
import { ChainService, deployment, deploymentKey, escrowAddress, escrowInterface } from "../src/services/chain-service.js";
import { IndexerService } from "../src/services/indexer-service.js";

const origin = "http://127.0.0.1:4320";
const buyer = Wallet.createRandom(), seller = Wallet.createRandom(), other = Wallet.createRandom(), arbitrator = Wallet.createRandom();
const key = `0x${"11".repeat(32)}`, requestId = `0x${"22".repeat(32)}`, zero = `0x${"00".repeat(32)}`;
const receiving = { nonce: key, publicKey: requestId };
const draft = { title: "Original offer", description: "Before purchase", visibility: "public" as const, draftTerms: { token: "0x0000000000000000000000000000000000000000", price: "1000", eventEnd: null, reviewWindow: null, commitmentWindow: 600 } };
const snapshot: ChainSnapshot = { block: { number: 100, hash: key, timestamp: 1000 }, canceled: false,
  order: { state: 1, buyer: buyer.address.toLowerCase(), seller: seller.address.toLowerCase(), productKey: key, requestId,
    buyerReceiving: receiving, sellerReceiving: receiving,
    terms: { token: draft.draftTerms.token, price: "1000", hasEventEnd: false, eventEnd: "0", reviewWindow: "86400", responseWindow: "259200", commitmentWindow: "600" },
    deliveryHash: zero, publicationDeadline: "0", reviewDeadline: "0", responseDeadline: "0", turn: "0" } };

describe.skipIf(process.env.PAYUNLOCK_DB_TEST !== "1")("commerce API with isolated PostgreSQL schema", () => {
  const schema = `phase4_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  const chain = new ChainService("https://rpc.example.invalid");
  const indexer = new IndexerService();
  let app: ReturnType<typeof buildApp>;
  let buyerAuth: Record<string, string>, sellerAuth: Record<string, string>, otherAuth: Record<string, string>, arbAuth: Record<string, string>;
  let productId: string;
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    const require = createRequire(import.meta.url);
    for (const file of ["202609240001_foundation.cjs", "202609250001_application.cjs", "202609250002_checkout_reviews.cjs", "202609260001_deployment_scope.cjs", "202609280001_offer_images.cjs", "202610030001_offer_moderation.cjs"]) {
      if (file.includes("foundation")) continue;
      await require(`../migrations/${file}`).up({ sql: (sql: string) => admin.query(sql) });
    }
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    const config = loadConfig({ ...process.env, DATABASE_URL: url.toString(), LOG_LEVEL: "silent" });
    vi.spyOn(chain, "isEOA").mockResolvedValue(true);
    vi.spyOn(indexer, "purchaseTransaction").mockResolvedValue(key);
    vi.spyOn(chain, "purchaseCheckoutHash").mockResolvedValue(requestId);
    vi.spyOn(chain, "anchor").mockResolvedValue(snapshot.block);
    vi.spyOn(chain, "order").mockImplementation(async () => structuredClone(snapshot));
    vi.spyOn(chain, "orders").mockImplementation(async ids => ids.map(() => structuredClone(snapshot)));
    vi.spyOn(chain, "configuration").mockResolvedValue({ chainId: 10143, contract: escrowAddress, seller: seller.address.toLowerCase(), productKey: key,
      expectedTerms: requestId, terms: snapshot.order.terms, sellerReceiving: receiving, status: 1, allowed: true, block: snapshot.block, authorizationMode: "direct-only", serviceFee: { bps: 0, treasury: seller.address.toLowerCase(), sellerCapBps: 0 } });
    vi.spyOn(chain, "recover").mockResolvedValue({ status: "finalized", orderId: "1", snapshot });
    vi.spyOn(indexer, "orders").mockResolvedValue(["1"]);
    app = buildApp(config, { chain, indexer });
    await app.ready();
    async function login(wallet: typeof buyer) {
      const challenge = await app.inject({ method: "POST", url: "/v1/auth/challenge", headers: { origin }, payload: { address: wallet.address } });
      expect(challenge.statusCode).toBe(200);
      const body = challenge.json();
      const signature = await wallet.signMessage(body.message);
      const verified = await app.inject({ method: "POST", url: "/v1/auth/verify", headers: { origin }, payload: { id: body.id, signature } });
      expect(verified.statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/v1/auth/verify", headers: { origin }, payload: { id: body.id, signature } })).statusCode).toBe(401);
      return { origin, authorization: `Bearer ${verified.json().token}` };
    }
    buyerAuth = await login(buyer); sellerAuth = await login(seller); otherAuth = await login(other); arbAuth = await login(arbitrator);
  });
  afterAll(async () => {
    await app?.close();
    if (!/^phase4_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unsafe test schema");
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  it("uploads owned immutable images and preserves earlier gallery revisions", async () => {
    const payload = await sharp({ create: { width: 32, height: 20, channels: 3, background: "blue" } }).png().toBuffer();
    expect((await app.inject({ method: "POST", url: "/v1/seller/images", headers: { origin, "content-type": "application/octet-stream" }, payload })).statusCode).toBe(401);
    const response = await app.inject({ method: "POST", url: "/v1/seller/images", headers: { ...sellerAuth, "content-type": "application/octet-stream" }, payload });
    expect(response.statusCode).toBe(200);
    const image = response.json();
    expect(image).toMatchObject({ width: 32, height: 20 });
    const media = await app.inject(image.url);
    expect(media.headers["content-type"]).toBe("image/webp");
    expect(media.headers["cache-control"]).toContain("immutable");
    expect((await sharp(media.rawPayload).metadata()).width).toBe(32);
    expect((await app.inject({ method: "POST", url: "/v1/seller/products", headers: otherAuth, payload: { ...draft, images: [image] } })).statusCode).toBe(400);
    const created = await app.inject({ method: "POST", url: "/v1/seller/products", headers: sellerAuth, payload: { ...draft, visibility: "draft", images: [image] } });
    expect(created.statusCode).toBe(200);
    const product = created.json(); expect(product.images).toEqual([image]);
    const saved = await app.inject({ method: "PUT", url: `/v1/seller/products/${product.id}`, headers: sellerAuth, payload: { ...draft, visibility: "draft", images: [], expectedRevision: product.revision } });
    expect(saved.statusCode).toBe(200); expect(saved.json().images).toEqual([]);
    const history = await admin.query("SELECT images FROM offer_revisions WHERE product_id=$1 AND revision=1", [product.id]);
    expect(history.rows[0].images).toEqual([image]);
    expect((await app.inject(image.url)).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/seller/images", headers: { ...sellerAuth, "content-type": "application/octet-stream" }, payload: Buffer.alloc(15 * 1024 * 1024 + 1) })).statusCode).toBe(413);
  });
  it("binds sessions to origin, rejects wrong signatures, and consumes concurrent challenges once", async () => {
    expect((await app.inject({ url: "/v1/auth/session", headers: { ...buyerAuth, origin: "https://foreign.invalid" } })).statusCode).toBe(403);
    const challenge = (await app.inject({ method: "POST", url: "/v1/auth/challenge", headers: { origin }, payload: { address: buyer.address } })).json();
    expect((await app.inject({ method: "POST", url: "/v1/auth/verify", headers: { origin }, payload: { id: challenge.id, signature: await other.signMessage(challenge.message) } })).statusCode).toBe(401);
    const payload = { id: challenge.id, signature: await buyer.signMessage(challenge.message) };
    const responses = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: "/v1/auth/verify", headers: { origin }, payload })));
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 401]);
  });
  it("keeps seller drafts and mappings private and rejects edits by another seller", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/seller/products", headers: sellerAuth, payload: draft });
    expect(created.statusCode).toBe(200); productId = created.json().id;
    expect((await app.inject({ method: "PUT", url: `/v1/seller/products/${productId}`, headers: otherAuth, payload: { ...draft, expectedRevision: 1 } })).statusCode).toBe(409);
    const registration = await app.inject({ method: "PUT", url: `/v1/seller/products/${productId}/registration`, headers: sellerAuth, payload: { productKey: key } });
    expect(registration.json().status).toBe("finalized");
    const discovered = await app.inject("/v1/products");
    expect(discovered.json().items).toEqual([{ id: productId, title: draft.title, description: draft.description, images: [], revision: 1, restricted: false, frontpagePosition: null, sale: { status: "unavailable" } }]);
    expect(discovered.body).not.toContain(escrowAddress);
    expect(discovered.body).not.toContain(key);
    expect(discovered.body).not.toContain("draftTerms");
    const hidden = (await app.inject({ method: "POST", url: "/v1/seller/products", headers: sellerAuth, payload: { ...draft, visibility: "hidden" } })).json();
    expect((await app.inject(`/v1/products/${hidden.id}`)).statusCode).toBe(200);
    expect((await app.inject("/v1/products")).json().items).toHaveLength(1);
  });
  it("serves public token metadata and an offer preview without a wallet and hides drafts", async () => {
    expect((await app.inject(`/v1/public/assets/${draft.draftTerms.token}`)).json()).toMatchObject({ symbol: "MON", decimals: 18 });
    expect((await app.inject("/v1/public/assets/invalid")).statusCode).toBe(400);
    const response = await app.inject(`/v1/products/${productId}/preview`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configuration: { seller: seller.address.toLowerCase(), terms: { price: "1000" } }, asset: { symbol: "MON", decimals: 18 } });
    const created = (await app.inject({ method: "POST", url: "/v1/seller/products", headers: sellerAuth, payload: { ...draft, visibility: "draft" } })).json();
    expect((await app.inject(`/v1/products/${created.id}/preview`)).statusCode).toBe(404);
  });
  it("adds canonical history dates without losing events when dates are unavailable", async () => {
    const history = vi.spyOn(indexer, "history").mockResolvedValue([{ id: "event", name: "Purchased", blockNumber: "100", blockHash: key, position: "1", transactionHash: zero, data: {} }]);
    const freshness = vi.spyOn(indexer, "freshness").mockResolvedValue({ status: "available" } as Awaited<ReturnType<IndexerService["freshness"]>>);
    const block = vi.spyOn(chain, "block").mockResolvedValue(snapshot.block);
    try {
      const read = () => app.inject({ url: "/v1/orders/1/history", headers: buyerAuth });
      expect((await read()).json().items[0]).toMatchObject({ id: "event", timestamp: 1000 });
      block.mockResolvedValue({ ...snapshot.block, hash: zero });
      expect((await read()).json().items[0]).toMatchObject({ id: "event", timestamp: null });
      block.mockRejectedValue(new Error("RPC unavailable"));
      expect((await read()).json().items[0]).toMatchObject({ id: "event", timestamp: null });
    } finally { history.mockRestore(); freshness.mockRestore(); block.mockRestore(); }
  });
  it("serves public order summaries without authentication and keeps private data protected", async () => {
    const response = await app.inject(`/v1/public/orders?address=${buyer.address}&role=buyer&limit=1`);
    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({ orderId: "1", order: { state: 1, terms: { price: "1000" } }, offer: { title: draft.title } });
    const detail = await app.inject("/v1/public/orders/1");
    expect(detail.json()).toEqual(response.json().items[0]);
    for (const field of ["buyerReceiving", "sellerReceiving", "requestId", "eligibility", "draftTerms", "deliveryHash", "buyerEnvelope", "sellerEnvelope"])
      expect(detail.body).not.toContain(field);
    expect((await app.inject({ url: "/v1/orders/1", headers: { origin } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/seller/products", headers: { origin } })).statusCode).toBe(401);
    expect((await app.inject(`/v1/public/orders?address=${other.address}&role=buyer`)).json().items).toEqual([]);
    expect((await app.inject(`/v1/public/orders?address=invalid&role=buyer`)).statusCode).toBe(400);
    expect((await app.inject(`/v1/public/orders?address=${buyer.address}&role=buyer&limit=51`)).statusCode).toBe(400);
    await admin.query("UPDATE catalog_products SET visibility='hidden' WHERE id=$1", [productId]);
    expect((await app.inject("/v1/public/orders/1")).json().offer).toBeNull();
    await admin.query("UPDATE catalog_products SET visibility='draft' WHERE id=$1", [productId]);
    expect((await app.inject("/v1/public/orders/1")).json().offer).toBeNull();
    await admin.query("UPDATE catalog_products SET visibility='public' WHERE id=$1", [productId]);
  });
  it("reads finalized native balances without authentication and validates the address", async () => {
    const rpc = vi.spyOn(chain, "rpc").mockResolvedValueOnce("0xde0b6b3a7640000");
    const canonical = vi.spyOn(chain, "ensureCanonical").mockResolvedValueOnce();
    try {
      const result = await app.inject(`/v1/public/wallets/${buyer.address}/balance`);
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ address: buyer.address.toLowerCase(), balance: "1000000000000000000", chainId: 10143, block: snapshot.block });
      expect(rpc).toHaveBeenCalledWith("eth_getBalance", [buyer.address.toLowerCase(), "0x64"]);
      expect(canonical).toHaveBeenCalledWith(snapshot.block);
      expect((await app.inject("/v1/public/wallets/invalid/balance")).statusCode).toBe(400);
    } finally { rpc.mockRestore(); canonical.mockRestore(); }
  });
  it("exposes the payment balance for a chosen address without a sign-in token", async () => {
    const rpc = vi.spyOn(chain, "rpc").mockResolvedValueOnce("0xde0b6b3a7640000");
    const allowed = vi.spyOn(chain, "call").mockResolvedValueOnce([true] as never);
    const canonical = vi.spyOn(chain, "ensureCanonical").mockResolvedValueOnce();
    try {
      const result = await app.inject(`/v1/public/wallets/${buyer.address}/assets/${draft.draftTerms.token}`);
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ symbol: "MON", balance: "1000000000000000000", nativeBalance: "1000000000000000000", allowance: "0" });
      expect((await app.inject(`/v1/public/wallets/invalid/assets/${draft.draftTerms.token}`)).statusCode).toBe(400);
    } finally { rpc.mockRestore(); allowed.mockRestore(); canonical.mockRestore(); }
  });
  it("preserves reviewed offer metadata and same-ID recovery across edits and indexer outage", async () => {
    const checkout = await app.inject({ method: "POST", url: `/v1/products/${productId}/checkout`, headers: buyerAuth, payload: { requestId, buyerReceiving: receiving } });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.json().configuration.terms.price).toBe("1000");
    await app.inject({ method: "PUT", url: `/v1/seller/products/${productId}`, headers: sellerAuth, payload: { ...draft, title: "Edited offer", draftTerms: { ...draft.draftTerms, price: "9999" }, expectedRevision: 1 } });
    vi.spyOn(indexer, "products").mockResolvedValue(new Map([[`${deploymentKey}:${seller.address.toLowerCase()}:${key}`, { status: "indexed", finality: "provisional", productState: 1, allowed: true,
      terms: { token: draft.draftTerms.token, price: "1000", eventEnd: null, reviewWindow: "86400", responseWindow: "259200", commitmentWindow: "600" } }]]));
    const discovery = await app.inject(`/v1/products/${productId}`);
    expect(discovery.json().sale.terms.price).toBe("1000");
    expect(discovery.body).not.toContain("9999");
    expect(discovery.body).not.toContain(escrowAddress);
    const retry = await app.inject({ method: "POST", url: `/v1/products/${productId}/checkout`, headers: buyerAuth, payload: { requestId, buyerReceiving: receiving } });
    expect(retry.json()).toMatchObject({ reused: true, revision: 1, configuration: { terms: { price: "1000" } } });
    const recovered = await app.inject({ url: `/v1/orders/recover/${requestId}`, headers: buyerAuth });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ status: "finalized", orderId: "1", indexing: { status: "unavailable" }, offer: { title: "Original offer", revision: 1, cryptographicallyBound: false } });
    expect((await app.inject({ url: "/v1/orders/1", headers: otherAuth })).statusCode).toBe(403);
  });
  it("authorizes every batch snapshot and scopes seller pagination to the exact product", async () => {
    const result = await app.inject({ method: "POST", url: "/v1/orders/batch", headers: sellerAuth, payload: { orderIds: ["1", "2"] } });
    expect(result.statusCode).toBe(200); expect(result.json().items.map((v: { orderId: string }) => v.orderId)).toEqual(["1", "2"]);
    expect((await app.inject({ method: "POST", url: "/v1/orders/batch", headers: otherAuth, payload: { orderIds: ["1"] } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/orders/batch", headers: sellerAuth, payload: { orderIds: ["1", "1"] } })).statusCode).toBe(400);
    const page = await app.inject({ url: `/v1/seller/products/${productId}/orders?limit=10`, headers: sellerAuth });
    expect(page.statusCode).toBe(200); expect(indexer.orders).toHaveBeenLastCalledWith(seller.address.toLowerCase(), "seller", "0", 11, key);
    expect((await app.inject({ url: `/v1/seller/products/${productId}/orders`, headers: otherAuth })).statusCode).toBe(404);
  });
  it("will not use an unrelated receipt or wrong calldata to recover a batch", async () => {
    const action = { kind: "refundCanceledOrders", orderIds: ["1"] }, data = escrowInterface.encodeFunctionData("refundCanceledOrders", [["1"]]);
    const rpc = vi.spyOn(chain, "rpc").mockResolvedValue({ hash: key, from: seller.address, to: escrowAddress, input: data, value: "0x0" });
    const transaction = vi.spyOn(chain, "transaction").mockResolvedValue({ status: "uncertain" });
    const request = () => app.inject({ method: "POST", url: "/v1/transactions/batch-status", headers: sellerAuth, payload: { hash: key, action } });
    expect((await request()).statusCode).toBe(200);
    rpc.mockResolvedValue({ hash: key, from: seller.address, to: escrowAddress, input: escrowInterface.encodeFunctionData("refundCanceledOrders", [["2"]]), value: "0x0" });
    expect((await request()).json().error).toBe("TRANSACTION_ACTION_MISMATCH");
    rpc.mockRestore(); transaction.mockRestore();
  });
  it("accepts the signed payload size of a full 30-order publication", async () => {
    const reference = { serviceId: 1, preparedAt: "1000", creator: key, buyerEnvelope: `0x03${"11".repeat(64)}`, sellerEnvelope: `0x03${"22".repeat(64)}`, contentHash: requestId };
    const items = Array.from({ length: 30 }, (_, i) => ({ orderId: String(i + 1), reference, reservationTransaction: key }));
    const data = escrowInterface.encodeFunctionData("publishDeliveries", [items.map(i => i.orderId), items.map(i => i.reference)]);
    const raw = await seller.signTransaction({ chainId: 10143, to: escrowAddress, data, value: 0n, nonce: 0, gasLimit: 20000000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, type: 2 });
    expect(raw.length).toBeGreaterThan(24000);
    const call = vi.spyOn(chain, "call").mockImplementation(async name => [name === "batchLimit" ? 30 : zero] as never);
    const canonical = vi.spyOn(chain, "ensureCanonical").mockResolvedValue();
    const publication = vi.spyOn(chain, "batchPublication").mockResolvedValue(items.map(() => true));
    const rpc = vi.spyOn(chain, "rpc").mockResolvedValue(Transaction.from(raw).hash);
    const response = await app.inject({ method: "POST", url: "/v1/transactions/broadcast", headers: sellerAuth, payload: { action: { kind: "publishDeliveries", items }, raw } });
    expect(response.statusCode).toBe(200);
    call.mockRestore(); canonical.mockRestore(); publication.mockRestore(); rpc.mockRestore();
  });
  it("rejects stale projected arbitration authority using the latest contract assignment", async () => {
    const assigned = { ...snapshot, assignment: { wallet: arbitrator.address.toLowerCase(), publicKey: key, keyVersion: "1", revision: "1", fee: "10", requester: buyer.address.toLowerCase(), handoverRecorded: false } };
    vi.mocked(chain.order).mockImplementation(async (_id, tag) => tag === "latest" ? { ...assigned, assignment: { ...assigned.assignment, wallet: other.address.toLowerCase(), revision: "2" } } : assigned);
    expect((await app.inject({ url: "/v1/orders/1", headers: arbAuth })).statusCode).toBe(403);
    vi.mocked(chain.order).mockImplementation(async () => structuredClone(snapshot));
  });
  it("refreshes changed checkout terms under the original request while retaining both reviewed snapshots", async () => {
    const nextRequest = `0x${"77".repeat(32)}`;
    const prepared = await app.inject({ method: "POST", url: `/v1/products/${productId}/checkout`, headers: buyerAuth, payload: { requestId: nextRequest, buyerReceiving: receiving } });
    expect(prepared.statusCode).toBe(200);
    const original = prepared.json().configuration;
    const nextOrder = { ...snapshot.order, requestId: nextRequest, terms: { ...snapshot.order.terms, reviewWindow: "0" } };
    const changed = { ...original, expectedTerms: nextRequest, terms: nextOrder.terms };
    vi.mocked(chain.recover).mockResolvedValueOnce({ status: "uncertain", requestId: nextRequest, finalizedBlock: 100 });
    vi.mocked(chain.configuration).mockResolvedValueOnce(changed);
    const refreshed = await app.inject({ method: "POST", url: `/v1/products/${productId}/checkout/refresh`, headers: buyerAuth, payload: { requestId: nextRequest } });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ requestId: nextRequest, configuration: { terms: { reviewWindow: "0" } } });
    const rows = await app.db.query("SELECT r.expected_terms FROM checkout_reviews r JOIN checkout_intents i ON i.id=r.intent_id WHERE i.request_id=$1", [nextRequest]);
    expect(rows.rows.map(r => r.expected_terms).sort()).toEqual([original.expectedTerms, changed.expectedTerms].sort());
    expect((await app.inject({ method: "POST", url: `/v1/products/${productId}/checkout`, headers: buyerAuth, payload: { requestId: nextRequest, buyerReceiving: { ...receiving, nonce: zero } } })).statusCode).toBe(400);
  });
  it("stores only a bounded encrypted pending envelope and rejects stale or cross-wallet writes", async () => {
    const id = randomUUID();
    const body = { kind: "purchase", requestId, orderId: null, transactionHash: null, encryptedReference: { version: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAA" }, expectedVersion: 0 };
    expect((await app.inject({ method: "PUT", url: `/v1/pending/${id}`, headers: buyerAuth, payload: { ...body, plaintext: "secret" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: `/v1/pending/${id}`, headers: buyerAuth, payload: body })).json().version).toBe(1);
    expect((await app.inject({ method: "PUT", url: `/v1/pending/${id}`, headers: otherAuth, payload: { ...body, expectedVersion: 1 } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: `/v1/pending/${id}`, headers: buyerAuth, payload: { ...body, expectedVersion: 1 } })).json().version).toBe(2);
    expect((await app.inject({ method: "DELETE", url: `/v1/pending/${id}`, headers: buyerAuth, payload: { expectedVersion: 1 } })).statusCode).toBe(409);
    expect((await app.inject({ url: "/v1/pending", headers: otherAuth })).json().items).toEqual([]);
  });
  it("treats missing finalized request lookup as uncertain and preserves the request ID", async () => {
    vi.mocked(chain.recover).mockResolvedValueOnce({ status: "uncertain", requestId, finalizedBlock: 100 });
    const result = (await app.inject({ url: `/v1/orders/recover/${requestId}`, headers: buyerAuth })).json();
    expect(result).toMatchObject({ status: "uncertain", retryWithSameRequestId: true, requestId });
    vi.mocked(chain.configuration).mockRejectedValueOnce(new ApiError(503, "CHAIN_UNAVAILABLE"));
    const result2 = await app.inject({ method: "PUT", url: `/v1/seller/products/${productId}/registration`, headers: sellerAuth, payload: { productKey: key } });
    expect(result2.json().status).toBe("uncertain");
    expect((await app.db.query("SELECT count(*)::int AS count FROM product_mappings WHERE chain_id=$1", [deployment.chainId])).rows[0].count).toBe(1);
  });
  it("authorizes moderation, masks current and historical offers, and keeps checkout and refund paths usable", async () => {
    const call = vi.spyOn(chain, "call").mockResolvedValue(Result.fromItems([other.address.toLowerCase()]));
    const canonical = vi.spyOn(chain, "ensureCanonical").mockResolvedValue();
    try {
      expect((await app.inject({ url: "/v1/admin/featured", headers: { origin }, remoteAddress: "127.0.0.77" })).statusCode).toBe(401);
      expect((await app.inject({ url: "/v1/admin/featured", headers: sellerAuth, remoteAddress: "127.0.0.77" })).statusCode).toBe(403);
      const state = (await app.inject({ url: `/v1/admin/products/${productId}`, headers: otherAuth, remoteAddress: "127.0.0.77" })).json();
      expect((await app.inject({ method: "PATCH", url: `/v1/admin/products/${productId}`, headers: sellerAuth, remoteAddress: "127.0.0.77", payload: { expectedVersion: state.version, restricted: true } })).statusCode).toBe(403);
      expect((await app.inject({ method: "PUT", url: "/v1/admin/featured", headers: sellerAuth, remoteAddress: "127.0.0.77", payload: { expectedVersion: state.version, ids: [] } })).statusCode).toBe(403);
      const existing = (await app.inject({ url: `/v1/seller/products/${productId}`, headers: sellerAuth, remoteAddress: "127.0.0.77" })).json();
      const bytes = await sharp({ create: { width: 32, height: 20, channels: 3, background: "green" } }).png().toBuffer();
      const image = (await app.inject({ method: "POST", url: "/v1/seller/images", headers: { ...sellerAuth, "content-type": "application/octet-stream" }, remoteAddress: "127.0.0.77", payload: bytes })).json();
      expect((await app.inject({ method: "PUT", url: `/v1/seller/products/${productId}`, headers: sellerAuth, remoteAddress: "127.0.0.77", payload: { ...draft, title: existing.title, description: existing.description, images: [image], expectedRevision: existing.revision } })).statusCode).toBe(200);
      const originalMedia = (await app.inject(image.url)).rawPayload;
      const feature = await app.inject({ method: "PATCH", url: `/v1/admin/products/${productId}`, headers: otherAuth, remoteAddress: "127.0.0.77", payload: { expectedVersion: state.version, featured: true } });
      expect(feature.statusCode).toBe(200);
      const featuredItems = (await app.inject("/v1/products/featured")).json().items;
      expect(featuredItems.map((p: { id: string }) => p.id)).toEqual([productId]);
      expect((await app.inject({ url: "/v1/admin/featured", headers: otherAuth, remoteAddress: "127.0.0.77" })).json().items).toEqual(featuredItems);
      const original = (await app.inject(`/v1/products/${productId}`)).json();
      const restriction = await app.inject({ method: "PATCH", url: `/v1/admin/products/${productId}`, headers: otherAuth, remoteAddress: "127.0.0.77", payload: { expectedVersion: feature.json().version, restricted: true } });
      expect(restriction.statusCode).toBe(200); expect(restriction.json().frontpagePosition).toBeNull();
      expect((await app.inject("/v1/products/featured")).json().items).toEqual([]);
      expect((await app.inject("/v1/products")).json().items.map((p: { id: string }) => p.id)).not.toContain(productId);
      const masked = (await app.inject(`/v1/products/${productId}`)).json();
      expect(masked).toMatchObject({ title: "Restricted offer", restricted: true });
      expect(masked.images[0].url).toBe("/v1/media/restricted");
      expect((await app.inject(image.url)).rawPayload).toEqual(originalMedia);
      for (const url of ["/v1/admin/restricted", `/v1/admin/products/${productId}/original`]) {
        expect((await app.inject({ url, headers: { origin }, remoteAddress: "127.0.0.77" })).statusCode).toBe(401);
        expect((await app.inject({ url, headers: sellerAuth, remoteAddress: "127.0.0.77" })).statusCode).toBe(403);
      }
      const restrictedList = await app.inject({ url: "/v1/admin/restricted?limit=1", headers: otherAuth, remoteAddress: "127.0.0.77" });
      expect(restrictedList.statusCode).toBe(200);
      expect(restrictedList.json()).toMatchObject({ items: [{ id: productId, title: original.title, description: original.description, images: original.images }], nextCursor: null });
      expect(restrictedList.headers["cache-control"]).toBe("no-store");
      const originalDetails = await app.inject({ url: `/v1/admin/products/${productId}/original`, headers: otherAuth, remoteAddress: "127.0.0.77" });
      expect(originalDetails.statusCode).toBe(200);
      expect(originalDetails.json()).toMatchObject({ version: restriction.json().version, product: { title: original.title, description: original.description, images: original.images, restricted: true, seller: seller.address.toLowerCase() }, preview: { configuration: { terms: { price: "1000" } }, asset: { symbol: "MON" } } });
      vi.mocked(chain.configuration).mockRejectedValueOnce(new ApiError(503, "CHAIN_UNAVAILABLE"));
      expect((await app.inject({ url: `/v1/admin/products/${productId}/original`, headers: otherAuth, remoteAddress: "127.0.0.77" })).json()).toMatchObject({ product: { title: original.title, images: original.images }, preview: null });
      expect((await app.inject(`/v1/products/${productId}?original=true`)).json().title).toBe("Restricted offer");
      expect((await app.inject(masked.images[0].url)).headers["content-type"]).toContain("image/svg+xml");
      expect((await app.inject({ url: "/v1/orders/1", headers: buyerAuth, remoteAddress: "127.0.0.77" })).json()).toMatchObject({ offer: { title: "Restricted offer", restricted: true }, eligibility: { claimRefund: true } });
      expect((await app.inject("/v1/public/orders/1")).json().offer.title).toBe("Restricted offer");
      expect((await app.inject(`/v1/products/${productId}/preview`)).statusCode).toBe(200);
      const checkout = await app.inject({ method: "POST", url: `/v1/products/${productId}/checkout`, headers: buyerAuth, remoteAddress: "127.0.0.77", payload: { requestId: `0x${"88".repeat(32)}`, buyerReceiving: receiving } });
      expect(checkout.statusCode).toBe(200);
      const own = (await app.inject({ url: `/v1/seller/products/${productId}`, headers: sellerAuth, remoteAddress: "127.0.0.77" })).json();
      const save = await app.inject({ method: "PUT", url: `/v1/seller/products/${productId}`, headers: sellerAuth, remoteAddress: "127.0.0.77", payload: { ...draft, title: "Attempted overwrite", images: masked.images, expectedRevision: own.revision } });
      expect(save.statusCode).toBe(200); expect(save.json().title).toBe("Restricted offer");
      expect((await app.db.query("SELECT title,description,restricted,images FROM catalog_products WHERE id=$1", [productId])).rows[0]).toMatchObject({ title: original.title, description: original.description, restricted: true, images: original.images });
      const unrestrict = await app.inject({ method: "PATCH", url: `/v1/admin/products/${productId}`, headers: otherAuth, remoteAddress: "127.0.0.77", payload: { expectedVersion: restriction.json().version, restricted: false } });
      expect(unrestrict.statusCode).toBe(200); expect(unrestrict.json().frontpagePosition).toBeNull();
      expect((await app.inject(`/v1/products/${productId}`)).json().title).toBe(original.title);
      expect((await app.inject(`/v1/products/${productId}`)).json().images).toEqual(original.images);
      expect((await app.inject({ url: "/v1/admin/restricted", headers: otherAuth, remoteAddress: "127.0.0.77" })).json().items).toEqual([]);
    } finally { call.mockRestore(); canonical.mockRestore(); }
  });
  it("excludes abandoned deployment catalogs and pending operations without deleting them", async () => {
    await app.db.query("UPDATE catalog_products SET deployment_scope='abandoned' WHERE id=$1", [productId]);
    expect((await app.inject({ url: `/v1/products/${productId}` })).statusCode).toBe(404);
    const page = (await app.inject({ url: "/v1/seller/products", headers: sellerAuth })).json();
    expect(page.items.some((p: { id: string }) => p.id === productId)).toBe(false);
    await app.db.query("UPDATE pending_operations SET contract=$1", [`0x${"aa".repeat(20)}`]);
    expect((await app.inject({ url: "/v1/pending", headers: buyerAuth })).json().items).toEqual([]);
    expect((await app.db.query("SELECT count(*)::int AS n FROM pending_operations")).rows[0].n).toBeGreaterThan(0);
  });
  it("filters private seller offers before pagination", async () => {
    const created = [];
    for (const visibility of ["draft", "public", "hidden"]) {
      const response = await app.inject({ method: "POST", url: "/v1/seller/products", headers: sellerAuth, payload: { ...draft, title: "Filter fixture " + visibility } });
      expect(response.statusCode).toBe(200);
      created.push({ id: response.json().id, visibility });
      await app.db.query("UPDATE catalog_products SET visibility=$2 WHERE id=$1", [response.json().id, visibility]);
    }
    const other = await app.inject({ method: "POST", url: "/v1/seller/products", headers: otherAuth, payload: draft });
    for (const filter of ["draft", "published"]) {
      let after: string | null = null; const found: string[] = [];
      do {
        const response = await app.inject({ url: "/v1/seller/products?filter=" + filter + "&limit=1" + (after ? "&after=" + after : ""), headers: sellerAuth });
        expect(response.statusCode).toBe(200); const page: { items: { id: string; visibility: string }[]; nextCursor: string | null } = response.json();
        for (const item of page.items) { expect(filter === "draft" ? item.visibility === "draft" : ["public", "hidden"].includes(item.visibility)).toBe(true); found.push(item.id); }
        after = page.nextCursor;
      } while (after);
      expect(found).not.toContain(other.json().id);
      for (const row of created) expect(found.includes(row.id)).toBe(filter === "draft" ? row.visibility === "draft" : row.visibility !== "draft");
    }
    expect((await app.inject({ url: "/v1/seller/products?filter=draft", headers: { origin } })).statusCode).toBe(401);
  });

});
