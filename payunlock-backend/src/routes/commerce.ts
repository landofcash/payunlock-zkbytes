import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { ApiError, address, hash, nonzeroHash, orderId, page, parse, productInput, receiving, uint, json, type ChainSnapshot } from "../domain.js";
import { AuthService } from "../services/auth-service.js";
import { ChainService, deployment, deploymentKey, escrowAddress, escrowInterface, eligibility } from "../services/chain-service.js";
import { IndexerService } from "../services/indexer-service.js";
import { CatalogRepository, type ProductRow } from "../repositories/catalog-repository.js";
import { walletBalances } from "../services/wallet-balances.js";
import { TransactionService, actionSchema } from "../services/transaction-service.js";
import { RelayerService } from "../services/relayer-service.js";

import { MAX_IMAGE_BYTES, saveOfferImage } from "../services/offer-images.js";
export interface CommerceOptions { config: Config; chain?: ChainService; indexer?: IndexerService }
const uuidParams = z.strictObject({ id: z.uuid() });
const orderParams = z.strictObject({ id: orderId });
const publicProduct = (p: ProductRow) => ({ id: p.id, title: p.title, description: p.description, images: p.images ?? [], revision: p.revision });
const sellerProduct = (p: ProductRow) => ({ ...publicProduct(p), seller: p.seller, visibility: p.visibility, draftTerms: p.draft_terms });

export const commerceRoutes: FastifyPluginAsync<CommerceOptions> = async (app, options) => {
  const chain = options.chain ?? new ChainService(options.config.MONAD_TESTNET_RPC_URL);
  const indexer = options.indexer ?? new IndexerService(options.config.ENVIO_GRAPHQL_URL, options.config.ENVIO_HASURA_ADMIN_SECRET);
  const auth = new AuthService(app.db, options.config.API_ORIGINS, wallet => chain.isEOA(wallet));
  const catalog = new CatalogRepository(app.db);
  const transactions = new TransactionService(chain, catalog);
  const relayer = new RelayerService(app.db, chain);
  const identity = (request: FastifyRequest) => auth.authenticate(request.headers.authorization, request.headers.origin);
  app.post("/relay/payments", async request => {
    auth.origin(request.headers.origin);
    await auth.rateLimit(request.ip, "relay-payment", 20);
    return relayer.enqueue(request.body);
  });
  app.get("/relay/jobs/:id", async request => {
    auth.origin(request.headers.origin);
    const { id } = parse(uuidParams, request.params);
    return relayer.status(id);
  });
  app.get("/relay/jobs/by-nonce/:actor/:nonce", async request => {
    auth.origin(request.headers.origin);
    const { actor, nonce } = parse(z.strictObject({ actor: address, nonce: nonzeroHash }), request.params);
    return relayer.statusByNonce(actor, nonce);
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_IMAGE_BYTES }, (_req, body, done) => done(null, body));
  app.post("/seller/images", { bodyLimit: MAX_IMAGE_BYTES, onRequest: async request => { await identity(request); } }, async request => {
    const owner = await identity(request);
    await auth.rateLimit(owner, "offer-image", 40);
    if (!Buffer.isBuffer(request.body)) throw new ApiError(400, "INVALID_IMAGE");
    return saveOfferImage(app.db, owner, request.body);
  });
  app.get("/media/:id/:variant", async (request, reply) => {
    const { id, variant } = parse(z.strictObject({ id: z.uuid(), variant: z.enum(["image", "thumbnail"]) }), request.params);
    const result = await app.db.query<{ data: Buffer }>(variant === "image" ? "SELECT image AS data FROM offer_images WHERE id=$1" : "SELECT thumbnail AS data FROM offer_images WHERE id=$1", [id]);
    if (!result.rows[0]) throw new ApiError(404, "IMAGE_NOT_FOUND");
    return reply.type("image/webp").header("X-Content-Type-Options", "nosniff").header("Cache-Control", "public, max-age=31536000, immutable").send(result.rows[0].data);
  });
  app.post("/orders/batch", async request => {
    const wallet = await identity(request), body = parse(z.strictObject({ orderIds: z.array(orderId).min(1).max(30) }), request.body);
    if (new Set(body.orderIds).size !== body.orderIds.length) throw new ApiError(400, "DUPLICATE_ORDER");
    const snapshots = await chain.orders(body.orderIds);
    const items = await Promise.all(body.orderIds.map((id, i) => orderView(id, wallet, snapshots[i])));
    return { items };
  });
  app.post("/transactions/batch-status", async request => {
    const wallet = await identity(request), body = parse(z.strictObject({ hash, action: actionSchema }), request.body), a = body.action;
    let args: unknown[];
    if (a.kind === "cancelProduct") args = [a.productKey];
    else if (a.kind === "reserveDeliveries") args = [a.items.map(i => i.orderId)];
    else if (a.kind === "publishDeliveries") args = [a.items.map(i => i.orderId), a.items.map(i => i.reference)];
    else if (a.kind === "refundCanceledOrders") args = [a.orderIds];
    else throw new ApiError(400, "INVALID_BATCH_ACTION");
    const tx = await chain.rpc<{ from: string; to: string; input: string; value: string; hash: string } | null>("eth_getTransactionByHash", [body.hash]);
    if (!tx) return { status: "uncertain" };
    if (tx.hash.toLowerCase() !== body.hash.toLowerCase() || tx.from.toLowerCase() !== wallet || tx.to?.toLowerCase() !== escrowAddress || BigInt(tx.value) !== 0n || tx.input.toLowerCase() !== escrowInterface.encodeFunctionData(a.kind, args).toLowerCase()) throw new ApiError(409, "TRANSACTION_ACTION_MISMATCH");
    return chain.transaction(body.hash, wallet);
  });
  app.addHook("onSend", async (request, reply) => {
    if (request.routeOptions.url !== "/v1/media/:id/:variant" || reply.statusCode !== 200) reply.header("cache-control", "no-store");
  });
  app.addHook("onRequest", async request => { await auth.rateLimit(request.ip, "api", 120); });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.code });
    // Do not log bodies, RPC/GraphQL URLs, signatures, credentials, or DB exceptions.
    app.log.error({ code: "COMMERCE_REQUEST_FAILED" }, "Commerce request failed");
    const tooLarge = (error as { statusCode?: number }).statusCode === 413;
    return reply.code(tooLarge ? 413 : 503).send({ error: tooLarge ? "BODY_TOO_LARGE" : "SERVICE_UNAVAILABLE" });
  });

  app.post("/auth/challenge", async request => {
    await auth.rateLimit(request.ip, "auth", 10);
    const body = parse(z.strictObject({ address }), request.body);
    return auth.challenge(body.address, auth.origin(request.headers.origin));
  });
  app.post("/auth/verify", async request => {
    await auth.rateLimit(request.ip, "verify", 20);
    const body = parse(z.strictObject({ id: z.uuid(), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }), request.body);
    return auth.verify(body.id, body.signature, auth.origin(request.headers.origin));
  });
  app.get("/auth/session", async request => ({ address: await identity(request), accountType: "eoa" }));
  app.get("/public/wallets/:address/balances", async request => {
    const wallet = parse(z.strictObject({ address }), request.params).address;
    const { after } = parse(z.strictObject({ after: address.optional() }), request.query);
    return walletBalances(chain, indexer, wallet, after);
  });
  app.get("/public/wallets/:address/balance", async request => {
    const wallet = parse(z.strictObject({ address }), request.params).address, block = await chain.anchor();
    const value = await chain.rpc<string>("eth_getBalance", [wallet, `0x${block.number.toString(16)}`]);
    await chain.ensureCanonical(block);
    return { address: wallet, chainId: 10143, symbol: "MON", decimals: 18, balance: BigInt(value).toString(), block };
  });
  app.post("/auth/logout", async request => { await identity(request); await auth.logout(request.headers.authorization!); return { status: "signed_out" }; });

  async function discovery(products: ProductRow[]) {
    const mappings = await catalog.mappings(products.map(p => p.id));
    const keys = mappings.map(m => `${deploymentKey}:${m.seller}:${m.product_key}`);
    let sales: Awaited<ReturnType<IndexerService["products"]>> | undefined;
    try { if (keys.length) sales = await indexer.products(keys); } catch { /* Metadata remains readable during an indexer outage. */ }
    return products.map(product => {
      const mapping = mappings.find(m => m.product_id === product.id);
      const sale = !mapping ? { status: "unregistered" } : !sales ? { status: "unavailable" }
        : sales.get(`${deploymentKey}:${mapping.seller}:${mapping.product_key}`) ?? { status: "syncing" };
      return { ...publicProduct(product), sale };
    });
  }

  app.get("/products", async request => {
    const query = parse(page.extend({ after: z.uuid().optional() }), request.query);
    const rows = await catalog.list(undefined, query.after, query.limit + 1);
    return { items: await discovery(rows.slice(0, query.limit)), nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null, indexing: await indexer.freshness() };
  });
  app.get("/products/:id", async request => ({ ...(await discovery([await catalog.get(parse(uuidParams, request.params).id)]))[0], indexing: await indexer.freshness() }));
  app.get("/products/:id/preview", async request => {
    const id = parse(uuidParams, request.params).id;
    await catalog.get(id); // Apply public visibility checks before returning chain details.
    const mapping = await catalog.mapping(id);
    const configuration = await chain.configuration(mapping.seller, mapping.product_key);
    const asset = await transactions.assetMetadata(configuration.terms.token);
    return { configuration, asset };
  });
  app.get("/seller/products", async request => {
    const seller = await identity(request), query = parse(page.extend({ after: z.uuid().optional(), filter: z.enum(["all", "draft", "published"]).default("all") }), request.query);
    const rows = await catalog.list(seller, query.after, query.limit + 1, query.filter);
    return { items: rows.slice(0, query.limit).map(sellerProduct), nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null };
  });
  app.post("/seller/products", async request => sellerProduct(await catalog.save(await identity(request), parse(productInput, request.body))));
  app.get("/seller/products/:id", async request => sellerProduct(await catalog.get(parse(uuidParams, request.params).id, await identity(request))));
  app.get("/deployment", async () => { const block = await chain.anchor(); const reviewWindow = String((await chain.call("defaultReviewWindow", [], block))[0]); await chain.ensureCanonical(block); return { chainId: deployment.chainId, contract: escrowAddress, reviewWindow, router: deployment.router, usdc: deployment.usdc }; });
  app.get("/platform", async () => chain.policies());
  app.get("/platform/assets/:asset", async request => {
    const { asset } = parse(z.strictObject({ asset: address }), request.params);
    const block = await chain.anchor("latest");
    const allowed = Boolean((await chain.call("allowedAssets", [asset], block))[0]);
    const receiveAuthorization = deployment.router && asset !== "0x0000000000000000000000000000000000000000"
      ? Boolean((await chain.call("receiveAuthorizationAssets", [asset], block))[0]) : false;
    await chain.ensureCanonical(block);
    return { asset, allowed, receiveAuthorization };
  });
  app.get("/platform/fees/:asset", async request => {
    const wallet = await identity(request), { asset } = parse(z.strictObject({ asset: address }), request.params);
    if (!deployment.router) throw new ApiError(409, "ACTION_NOT_AVAILABLE");
    const block = await chain.anchor();
    const amount = String((await chain.call("accruedFees", [wallet, asset], block))[0]);
    await chain.ensureCanonical(block);
    return { asset, amount, wallet };
  });
  app.get("/storage-services", async () => {
    const configured = [{ id: 1, label: "zkbytes", offerNew: options.config.ZKBYTES_OFFER_NEW }, ...(options.config.STORAGE_SERVICES_JSON ?? []).map(s => ({ id: s.id, label: `Storage service ${s.id}`, offerNew: s.offerNew }))];
    const block = await chain.anchor();
    const registered = await Promise.all(configured.map(s => chain.call("allowedStorageServices", [s.id], block)));
    await chain.ensureCanonical(block);
    return { items: configured.filter((s, i) => s.offerNew && registered[i]![0]).map(({ id, label }) => ({ id, label })) };
  });
  app.get("/storage-service", async request => {
    const query = parse(z.strictObject({ id: z.coerce.number().int().min(1).max(4294967295).default(1), prepare: z.enum(["true", "false"]).default("false") }), request.query);
    const c = options.config;
    const service = query.id === 1
      ? c.ZKBYTES_DOWNLOAD_ORIGIN && c.ZKBYTES_MAX_RETENTION_SECONDS !== undefined ? { id: 1, adapter: "zkbytes-v1", apiOrigin: new URL(c.ZKBYTES_SERVICE_URL).origin, downloadOrigin: new URL(c.ZKBYTES_DOWNLOAD_ORIGIN).origin, maxRetentionSeconds: c.ZKBYTES_MAX_RETENTION_SECONDS, offerNew: c.ZKBYTES_OFFER_NEW } : undefined
      : c.STORAGE_SERVICES_JSON?.find(s => s.id === query.id);
    if (!service) throw new ApiError(422, "UNSUPPORTED_STORAGE_SERVICE");
    if (query.prepare === "true" && !service.offerNew) throw new ApiError(409, "SERVICE_NOT_OFFERED_FOR_NEW_CONTENT");
    const block = await chain.anchor();
    if (!(await chain.call("allowedStorageServices", [query.id], block))[0]) throw new ApiError(409, "STORAGE_SERVICE_NOT_REGISTERED");
    await chain.ensureCanonical(block);
    return service;
  });
  app.get("/arbitrators/:wallet", async request => {
    const wallet = parse(z.strictObject({ wallet: address }), request.params).wallet, block = await chain.anchor();
    const result = await chain.call("arbitrators", [wallet], block);
    const feeVersion = deployment.router ? String((await chain.call("arbitratorFeeVersion", [wallet], block))[0]) : undefined;
    await chain.ensureCanonical(block);
    return { wallet, active: result[0], publicKey: result[1], keyVersion: String(result[2]), fee: String(result[3]), feeVersion };
  });
  app.get("/arbitrators", async request => {
    const query = parse(page.extend({ after: address.optional() }), request.query);
    const wallets = await indexer.arbitrators(query.after ?? "", query.limit + 1), block = await chain.anchor(), items = [];
    for (const wallet of wallets.slice(0, query.limit)) {
      const result = await chain.call("arbitrators", [wallet], block);
      if (result[0]) items.push({ wallet, active: result[0], publicKey: result[1], keyVersion: String(result[2]), fee: String(result[3]),
        feeVersion: deployment.router ? String((await chain.call("arbitratorFeeVersion", [wallet], block))[0]) : undefined });
    }
    await chain.ensureCanonical(block);
    return { items, nextCursor: wallets.length > query.limit ? wallets[query.limit - 1] : null };
  });
  app.get("/public/assets/:token", async request => transactions.assetMetadata(parse(z.strictObject({ token: address }), request.params).token));
  app.get("/public/wallets/:address/assets/:token", async request => {
    const params = parse(z.strictObject({ address, token: address }), request.params);
    return transactions.asset(params.address, params.token);
  });
  app.get("/assets/:token", async request => transactions.asset(await identity(request), parse(z.strictObject({ token: address }), request.params).token));
  app.post("/transactions/prepare", async request => transactions.prepare(await identity(request), parse(actionSchema, request.body)));
  app.post("/transactions/request", async request => transactions.request(await identity(request), parse(actionSchema, request.body)));
  app.post("/transactions/broadcast", async request => {
    // A 30-order publication includes both 65-byte envelopes per order plus ABI offsets.
    const body = parse(z.strictObject({ action: actionSchema, raw: z.string().max(64000).regex(/^0x[0-9a-fA-F]+$/) }), request.body);
    return transactions.broadcast(await identity(request), body.action, body.raw);
  });
  app.post("/products/:id/checkout/refresh", async request => {
    const wallet = await identity(request), id = parse(uuidParams, request.params).id;
    const body = parse(z.strictObject({ requestId: nonzeroHash }), request.body);
    const intent = await catalog.intent(wallet, body.requestId);
    if (!intent || intent.product_id !== id) throw new ApiError(404, "CHECKOUT_NOT_FOUND");
    if ((await chain.recover(wallet, body.requestId)).status === "finalized") throw new ApiError(409, "PURCHASE_ALREADY_FINALIZED");
    const product = await catalog.get(id), mapping = await catalog.mapping(id);
    const configuration = await chain.configuration(mapping.seller, mapping.product_key);
    if (configuration.status !== 1 || !configuration.allowed) throw new ApiError(409, "SALES_UNAVAILABLE");
    const review = await catalog.recordReview(intent.id, product.revision, configuration);
    return { requestId: body.requestId, ...review, reused: true };
  });
  app.put("/seller/products/:id", async request => {
    const wallet = await identity(request), id = parse(uuidParams, request.params).id;
    const body = parse(productInput.extend({ expectedRevision: z.number().int().positive() }), request.body);
    return sellerProduct(await catalog.save(wallet, body, id, body.expectedRevision));
  });
  app.put("/seller/products/:id/registration", async request => {
    const wallet = await identity(request), id = parse(uuidParams, request.params).id;
    const body = parse(z.strictObject({ productKey: nonzeroHash }), request.body);
    // Persist before the RPC lookup so registration survives RPC/indexer outages.
    const mapping = await catalog.map(id, wallet, body.productKey);
    try { return { status: "finalized", configuration: await chain.configuration(mapping.seller, mapping.product_key) }; }
    catch (error) { if (error instanceof ApiError && [404, 503].includes(error.statusCode)) return { status: "uncertain", productKey: body.productKey }; throw error; }
  });
  app.get("/seller/products/:id/registration", async request => {
    const wallet = await identity(request), id = parse(uuidParams, request.params).id;
    await catalog.get(id, wallet);
    const mapping = await catalog.mapping(id);
    return { configuration: await chain.configuration(mapping.seller, mapping.product_key) };
  });
  app.post("/products/:id/checkout", async request => {
    const wallet = await identity(request), id = parse(uuidParams, request.params).id;
    const body = parse(z.strictObject({ requestId: nonzeroHash, buyerReceiving: receiving }), request.body);
    const previous = await catalog.intent(wallet, body.requestId);
    if (previous) {
      if (previous.product_id !== id || previous.buyer_receiving.nonce !== body.buyerReceiving.nonce || previous.buyer_receiving.publicKey !== body.buyerReceiving.publicKey) throw new ApiError(409, "REQUEST_ID_ALREADY_USED");
      return { requestId: body.requestId, configuration: previous.configuration, revision: previous.revision, reused: true };
    }
    const product = await catalog.get(id), mapping = await catalog.mapping(id);
    if (product.seller === wallet) throw new ApiError(400, "SELF_PURCHASE");
    const configuration = await chain.configuration(mapping.seller, mapping.product_key);
    if (configuration.status !== 1 || !configuration.allowed) throw new ApiError(409, "SALES_UNAVAILABLE");
    const intent = await catalog.prepare(product, wallet, body.requestId, body.buyerReceiving, configuration);
    return { requestId: body.requestId, configuration: intent.configuration, revision: intent.revision, reused: false };
  });

  async function authorizedOrder(id: string, wallet: string, supplied?: ChainSnapshot) {
    const snapshot = supplied ?? await chain.order(id);
    const participant = [snapshot.order.buyer, snapshot.order.seller].includes(wallet);
    if (!participant && snapshot.assignment?.wallet !== wallet) throw new ApiError(403, "FORBIDDEN");
    // Also check latest authority: a newly replaced arbitrator must immediately lose access.
    if (!participant && (await chain.order(id, "latest")).assignment?.wallet !== wallet) throw new ApiError(403, "FORBIDDEN");
    return snapshot;
  }
  async function orderView(id: string, wallet: string, supplied?: ChainSnapshot) {
    const snapshot = await authorizedOrder(id, wallet, supplied);
    await catalog.associate(id, snapshot.order);
    return { orderId: id, ...snapshot, eligibility: eligibility(snapshot, wallet), offer: await catalog.offer(id) };
  }
  // Public chain summaries deliberately exclude private purchased metadata,
  // drafts, receiving material, records, eligibility and recovery information.
  async function publicOrder(id: string, snapshot: ChainSnapshot) {
    const o = snapshot.order;
    return { orderId: id, block: snapshot.block, canceled: snapshot.canceled, arbitrator: snapshot.assignment?.wallet,
      order: { state: o.state, buyer: o.buyer, seller: o.seller, terms: o.terms,
        publicationDeadline: o.publicationDeadline, reviewDeadline: o.reviewDeadline, responseDeadline: o.responseDeadline },
      offer: await catalog.publicOffer(o.seller, o.productKey) };
  }
  app.get("/public/orders", async request => {
    const query = parse(page.extend({ address, role: z.enum(["buyer", "seller", "arbitrator"]), after: uint.default("0") }), request.query);
    const ids = await indexer.orders(query.address, query.role, query.after, query.limit + 1);
    const selected = ids.slice(0, query.limit), items = [];
    for (let offset = 0; offset < selected.length; offset += 30) {
      const group = selected.slice(offset, offset + 30), snapshots = await chain.orders(group);
      for (const [i, snapshot] of snapshots.entries()) {
        const owner = query.role === "arbitrator" ? snapshot.assignment?.wallet : snapshot.order[query.role];
        if (owner === query.address) items.push(await publicOrder(group[i]!, snapshot));
      }
    }
    const anchor = await chain.anchor();
    return { items, nextCursor: ids.length > query.limit ? ids[query.limit - 1] : null, indexing: await indexer.freshness(anchor.number) };
  });
  app.get("/public/orders/:id", async request => {
    const id = parse(orderParams, request.params).id;
    return publicOrder(id, await chain.order(id));
  });
  app.get("/orders", async request => {
    const wallet = await identity(request), query = parse(page.extend({ role: z.enum(["buyer", "seller", "arbitrator"]), after: uint.default("0") }), request.query);
    const ids = await indexer.orders(wallet, query.role, query.after, query.limit + 1);
    const items = [];
    for (const id of ids.slice(0, query.limit)) {
      try { items.push(await orderView(id, wallet)); }
      catch (error) { if (!(error instanceof ApiError && [403, 404].includes(error.statusCode))) throw error; }
    }
    const anchor = await chain.anchor();
    return { items, nextCursor: ids.length > query.limit ? ids[query.limit - 1] : null, indexing: await indexer.freshness(anchor.number) };
  });
  app.get("/seller/products/:id/orders", async request => {
    const wallet = await identity(request), id = parse(uuidParams, request.params).id;
    await catalog.get(id, wallet);
    const mapping = await catalog.mapping(id);
    const query = parse(page.extend({ after: uint.default("0") }), request.query);
    const ids = await indexer.orders(wallet, "seller", query.after, query.limit + 1, mapping.product_key);
    const items = [];
    for (let offset = 0; offset < Math.min(query.limit, ids.length); offset += 30) {
      const group = ids.slice(offset, Math.min(offset + 30, query.limit)), snapshots = await chain.orders(group);
      const views = await Promise.all(group.map((id, i) => orderView(id, wallet, snapshots[i])));
      items.push(...views.filter(v => v.order.seller === wallet && v.order.productKey === mapping.product_key));
    }
    const anchor = await chain.anchor();
    return { items, nextCursor: ids.length > query.limit ? ids[query.limit - 1] : null, indexing: await indexer.freshness(anchor.number) };
  });
  app.get("/orders/recover/:requestId", async request => {
    const wallet = await identity(request), params = parse(z.strictObject({ requestId: nonzeroHash }), request.params);
    const result = await chain.recover(wallet, params.requestId);
    if (result.status === "uncertain") return { ...result, retryWithSameRequestId: true, indexing: await indexer.freshness(result.finalizedBlock) };
    return { status: "finalized", ...await orderView(result.orderId, wallet), indexing: await indexer.freshness(result.snapshot.block.number) };
  });
  app.get("/orders/:id", async request => {
    const view = await orderView(parse(orderParams, request.params).id, await identity(request));
    return { ...view, indexing: await indexer.freshness(view.block.number) };
  });
  app.get("/admin/orders/:id", async request => {
    const wallet = await identity(request), block = await chain.anchor();
    if (String((await chain.call("owner", [], block))[0]).toLowerCase() !== wallet) throw new ApiError(403, "FORBIDDEN");
    await chain.ensureCanonical(block);
    const id = parse(orderParams, request.params).id;
    const snapshot = await chain.order(id);
    const assignmentFeeAsset = snapshot.assignment ? String((await chain.call("assignmentFeeAsset", [id], snapshot.block))[0]).toLowerCase() : undefined;
    await chain.ensureCanonical(snapshot.block);
    return { ...snapshot, assignmentFeeAsset };
  });
  app.get("/orders/:id/records", async request => {
    const wallet = await identity(request), id = parse(orderParams, request.params).id;
    const query = parse(page.extend({ after: z.union([uint, z.literal("-1")]).default("-1") }), request.query);
    const snapshot = await authorizedOrder(id, wallet), items = [];
    const last = BigInt(snapshot.order.turn), start = BigInt(query.after) + 1n;
    for (let turn = start; turn <= last && items.length < query.limit; turn++) {
      const commitment = String((await chain.call("recordCommitments", [id, turn], snapshot.block))[0]);
      if (/^0x0{64}$/.test(commitment)) continue;
      const reference = (await chain.call("getRecord", [id, turn], snapshot.block))[0].toObject(true);
      const sender = String((await chain.call("recordAuthors", [id, turn], snapshot.block))[0]).toLowerCase();
      items.push({ turn: String(turn), commitment, sender, reference: { ...JSON.parse(json(reference)), serviceId: Number(reference.serviceId) } });
    }
    await chain.ensureCanonical(snapshot.block);
    const next = items.at(-1)?.turn;
    return { items, nextCursor: next !== undefined && BigInt(next) < last ? next : null, block: snapshot.block };
  });
  app.get("/orders/:id/history", async request => {
    const wallet = await identity(request), id = parse(orderParams, request.params).id;
    const query = parse(page.extend({ after: uint.default("0") }), request.query);
    const snapshot = await authorizedOrder(id, wallet);
    const rows = await indexer.history(id, query.after, query.limit + 1);
    const items = rows.slice(0, query.limit);
    const timestamps = new Map<string, number | null>();
    // Dates are presentation data. A failed lookup must not hide order activity.
    const blocks = [...new Set(items.map(row => row.blockNumber))];
    for (let offset = 0; offset < blocks.length; offset += 4) {
      await Promise.all(blocks.slice(offset, offset + 4).map(async number => {
        try {
          const block = await chain.block(`0x${BigInt(number).toString(16)}`);
          for (const row of items.filter(row => row.blockNumber === number)) timestamps.set(row.id, block.hash.toLowerCase() === row.blockHash.toLowerCase() ? block.timestamp : null);
        } catch { /* Keep history available without dates. */ }
      }));
    }
    // Provisional event data is explicitly marked; financial state comes from RPC.
    return { items: items.map(row => ({ ...row, timestamp: timestamps.get(row.id) ?? null })), nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.position : null,
      indexing: await indexer.freshness(snapshot.block.number), authoritativeRevision: snapshot.assignment?.revision ?? null };
  });
  app.get("/orders/:id/request-count", async request => {
    const wallet = await identity(request), id = parse(orderParams, request.params).id;
    const snapshot = await authorizedOrder(id, wallet);
    const count = String((await chain.call("evidenceRequestCount", [id], snapshot.block))[0]);
    await chain.ensureCanonical(snapshot.block);
    return { count };
  });
  for (const kind of ["evidence", "evidence-requests"] as const) {
    app.get(`/orders/:id/${kind}`, async request => {
      const wallet = await identity(request), id = parse(orderParams, request.params).id;
      const query = parse(page.extend({ after: z.union([uint, z.literal("-1")]).default("-1") }), request.query);
      const snapshot = await authorizedOrder(id, wallet);
      const rows = await indexer.evidence(id, query.after, query.limit + 1, kind === "evidence-requests");
      {
        for (const row of rows) {
          const commitment = String((await chain.call(kind === "evidence" ? "evidenceCommitments" : "evidenceRequestCommitments", [id, uint.parse(String(row.index))], snapshot.block))[0]);
          if (commitment !== row.commitment) throw new ApiError(503, "EVIDENCE_NOT_FINALIZED");
        }
        await chain.ensureCanonical(snapshot.block);
      }
      return { items: rows.slice(0, query.limit), nextCursor: rows.length > query.limit ? String(rows[query.limit - 1]!.index) : null,
        currentAssignment: snapshot.assignment, indexing: await indexer.freshness(snapshot.block.number) };
    });
  }
  app.get("/transactions/:hash", async request => {
    const wallet = await identity(request), params = parse(z.strictObject({ hash }), request.params);
    const query = parse(z.strictObject({ token: address.optional() }), request.query);
    if (query.token && query.token !== escrowAddress) await transactions.asset(wallet, query.token);
    const result = await chain.transaction(params.hash, wallet, query.token ?? escrowAddress);
    return { status: result.status, ...("blockNumber" in result ? { blockNumber: result.blockNumber, blockHash: result.blockHash } : {}) };
  });
  app.post("/orders/:id/publication-check", async request => {
    const wallet = await identity(request), id = parse(orderParams, request.params).id;
    const body = parse(z.strictObject({ reservationTransaction: hash }), request.body);
    return chain.publication(id, body.reservationTransaction, wallet);
  });

  const pendingBody = z.strictObject({ kind: z.enum(["registration", "purchase", "delivery", "refund", "dispute", "arbitration"]),
    requestId: nonzeroHash.nullable(), orderId: orderId.nullable(), transactionHash: hash.nullable(),
    // Only a versioned encrypted client envelope is accepted, never arbitrary JSON fields.
    encryptedReference: z.strictObject({ version: z.literal(1), nonce: z.string().regex(/^[A-Za-z0-9+/]{16}$/), ciphertext: z.string().min(24).max(130000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }),
    expectedVersion: z.number().int().min(0),
  });
  app.put("/pending/:id", async request => {
    const wallet = await identity(request), id = parse(uuidParams, request.params).id, body = parse(pendingBody, request.body);
    if (body.orderId) await authorizedOrder(body.orderId, wallet);
    const result = body.expectedVersion === 0
      ? await app.db.query(`INSERT INTO pending_operations(id,owner,chain_id,contract,kind,request_id,order_id,transaction_hash,encrypted_reference)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING RETURNING id,version`,
      [id, wallet, deployment.chainId, escrowAddress, body.kind, body.requestId, body.orderId, body.transactionHash, json(body.encryptedReference)])
      : await app.db.query(`UPDATE pending_operations SET transaction_hash=$3,encrypted_reference=$4,version=version+1,updated_at=now()
        WHERE id=$1 AND owner=$2 AND version=$5 AND kind=$6 AND request_id IS NOT DISTINCT FROM $7 AND order_id IS NOT DISTINCT FROM $8::numeric AND chain_id=$9 AND contract=$10 RETURNING id,version`,
      [id, wallet, body.transactionHash, json(body.encryptedReference), body.expectedVersion, body.kind, body.requestId, body.orderId, deployment.chainId, escrowAddress]);
    if (!result.rows[0]) throw new ApiError(409, "PENDING_OPERATION_CHANGED");
    return result.rows[0];
  });
  app.get("/pending", async request => {
    const wallet = await identity(request), query = parse(page.extend({ after: z.uuid().optional() }), request.query);
    const rows = (await app.db.query(`SELECT id,kind,request_id,order_id::text,transaction_hash,encrypted_reference,version FROM pending_operations
      WHERE owner=$1 AND chain_id=$4 AND contract=$5 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`, [wallet, query.after ?? null, query.limit + 1, deployment.chainId, escrowAddress])).rows;
    return { items: rows.slice(0, query.limit).map(row => ({ ...row, encrypted_reference: JSON.parse(row.encrypted_reference) as unknown })), nextCursor: rows.length > query.limit ? rows[query.limit - 1].id : null };
  });
  app.delete("/pending/:id", async request => {
    const wallet = await identity(request), id = parse(uuidParams, request.params).id;
    const body = parse(z.strictObject({ expectedVersion: z.number().int().positive() }), request.body);
    const result = await app.db.query("DELETE FROM pending_operations WHERE id=$1 AND owner=$2 AND version=$3 AND chain_id=$4 AND contract=$5 RETURNING id", [id, wallet, body.expectedVersion, deployment.chainId, escrowAddress]);
    if (!result.rowCount) throw new ApiError(409, "PENDING_OPERATION_CHANGED");
    return { status: "deleted" };
  });
  app.get("/services/status", async request => {
    const wallet = await identity(request), block = await chain.anchor();
    const currentOwner = String((await chain.call("owner", [], block))[0]).toLowerCase();
    await chain.ensureCanonical(block);
    if (wallet !== currentOwner) throw new ApiError(403, "FORBIDDEN");
    return { indexing: await indexer.freshness(block.number), rpc: chain.metrics, graphql: indexer.metrics, finalizedBlock: block.number };
  });
};
