import "fake-indexeddb/auto";
import { getBytes, Transaction } from "ethers";
import { createManagedSession } from "@/wallet/managed-session";
import type { LabWalletSession } from "@/wallet/types";
import { sellerDeliveryAbi, orderActionAbi } from "@/wallet/seller-authorization";
const deliveryReference = { serviceId: 1, preparedAt: "100", creator: `0x${"11".repeat(32)}`, buyerEnvelope: `0x03${"11".repeat(64)}`, sellerEnvelope: `0x03${"22".repeat(64)}`, contentHash: `0x${"33".repeat(32)}` };
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { OrderPage, publicRefundAction } from "@/commerce/Orders";
import { eventLabel, orderNext } from "@/commerce/OrderPresentation";
import type { OrderView } from "@/commerce/client";
const mocks = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn(), address: '0x1111111111111111111111111111111111111111', authenticated: true, session: undefined as LabWalletSession | undefined, authorize: vi.fn(), runOperation: vi.fn(), runOfferKeysOperation: vi.fn(), openDelivery: vi.fn(), restoreReceiving: vi.fn(), prepareDelivery: vi.fn(), upload: vi.fn(), rows: [] as unknown[], ops: [] as unknown[] }));
vi.mock("@/commerce/client", async original => ({ ...await original<typeof import("@/commerce/client")>(), useCommerce: () => ({ read: mocks.read, request: mocks.request }), useCommerceAccess: () => ({ address: mocks.address, authenticated: mocks.authenticated, authorize: mocks.authorize }), ProtectedAccess: ({ label }: { label: string }) => <button>{label}</button> }));
vi.mock("@/wallet/session-store", () => ({ useSession: () => ({ session: mocks.session ?? { address: mocks.address }, sessionEpoch: 1, busy: false, runOperation: mocks.runOperation, runOfferKeysOperation: mocks.runOfferKeysOperation }) }));
vi.mock("@/commerce/ui", async original => ({ ...await original<typeof import("@/commerce/ui")>(), journal: { list: async () => mocks.ops, save: async (record: { version: number }) => ({ ...record, version: record.version + 1 }) } }));
vi.mock("@/commerce/lifecycle", async original => ({ ...await original<typeof import("@/commerce/lifecycle")>(), protocolOrder: (view: OrderView, deployment: unknown) => ({ deployment, orderId: view.orderId, buyer: { context: {}, publicKey: view.order.buyerReceiving.publicKey }, seller: { context: {}, publicKey: view.order.sellerReceiving.publicKey } }), deliveryRecord: () => ({}), storageService: () => ({ id: 1, client: { upload: mocks.upload } }), reference: () => deliveryReference }));
vi.mock("@/commerce/protocol", async original => ({ ...await original<typeof import("@/commerce/protocol")>(), openDelivery: (...args: unknown[]) => mocks.openDelivery(...args), restoreReceiving: (...args: unknown[]) => mocks.restoreReceiving(...args), prepareDelivery: (...args: unknown[]) => mocks.prepareDelivery(...args) }));
const buyer = mocks.address, seller = '0x2222222222222222222222222222222222222222';
let view: OrderView;
beforeEach(() => {
  mocks.session = undefined; mocks.address = buyer; mocks.authenticated = true; mocks.authorize.mockReset(); mocks.ops = []; mocks.rows = []; mocks.runOperation.mockReset(); mocks.runOfferKeysOperation.mockReset(); mocks.openDelivery.mockReset(); mocks.restoreReceiving.mockReset(); mocks.prepareDelivery.mockReset(); mocks.upload.mockReset();
  view = { orderId: '7', block: { number: 50, hash: '0x00', timestamp: 100 }, canceled: false, eligibility: { confirmReceipt: true, openDispute: true }, offer: { status: 'public', title: 'Private workshop', description: 'Workshop access' }, order: { state: 3, buyer, seller, requestId: '0x00', productKey: '0x00', terms: { token: '0x0000000000000000000000000000000000000000', price: '1000000000000000000', hasEventEnd: false, eventEnd: '0', reviewWindow: '86400', responseWindow: '259200', commitmentWindow: '600' }, publicationDeadline: '0', reviewDeadline: '500', responseDeadline: '0', turn: '0', deliveryHash: '0x00', buyerReceiving: { publicKey: 'buyer-key', nonce: 'buyer-nonce' }, sellerReceiving: { publicKey: 'seller-key', nonce: 'seller-nonce' } } };
  mocks.read.mockReset().mockImplementation(async (path: string) => path.startsWith('/public/orders/') ? view : path === '/deployment' ? { chainId: 10143, contract: '0x3333333333333333333333333333333333333333' } : path === '/arbitrators' ? { items: [], nextCursor: null } : path === '/storage-services' ? { items: [{ id: 1, label: 'zkbytes' }] } : {});
  mocks.request.mockReset().mockImplementation(async (path: string) => path === '/orders/7' ? view : path.endsWith('/records') ? { items: mocks.rows, nextCursor: null } : path.endsWith('/history') ? { items: [{ id: 'event', name: 'Purchased', blockNumber: '40', transactionHash: '0xtx', timestamp: 90 }], nextCursor: null } : { items: [], nextCursor: null });
});
function orderTree(path = mocks.address === seller ? "/sales/orders/7" : "/purchases/7") { return <MemoryRouter initialEntries={[path]}><Routes><Route path="/purchases/:id" element={<OrderPage role="buyer" />} /><Route path="/sales/orders/:id" element={<OrderPage role="seller" />} /><Route path="/arbitration/:id" element={<OrderPage role="arbitrator" />} /></Routes></MemoryRouter>; }
function mount(path?: string) { return render(orderTree(path)); }
it.each([false, true])('keeps the order summary mounted during refresh when authenticated is %s', async authenticated => {
  mocks.authenticated = authenticated;
  mount();
  const heading = await screen.findByRole('heading', { name: 'Private workshop', level: 1 });
  const refresh = screen.getByRole('button', { name: 'Refresh order' });
  await waitFor(() => expect(refresh).toBeEnabled());
  let finish!: (value: OrderView) => void;
  const client = authenticated ? mocks.request : mocks.read;
  client.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(refresh);
  expect(refresh).toHaveAttribute('aria-busy', 'true');
  expect(refresh.querySelector('svg.spin')).toBeInTheDocument();
  expect(refresh).toBeDisabled();
  expect(heading).toBeInTheDocument();
  expect(screen.queryByText('Working...')).not.toBeInTheDocument();
  expect(screen.queryByText('Loading order...')).not.toBeInTheDocument();
  finish(view);
  await waitFor(() => expect(refresh).toBeEnabled());
  expect(heading).toBeInTheDocument();
});
it('keeps public offer details when unlocking history returns a private order without a saved offer', async () => {
  mocks.authenticated = false;
  view.offer.images = [{ id: 'cover', url: '/offer-image', thumbnailUrl: '/offer-thumbnail', width: 640, height: 480 }];
  mocks.request.mockImplementation(async (path: string) => path === '/orders/7' ? { ...view, offer: { status: 'unavailable' } } : path.endsWith('/history') ? { items: [], nextCursor: null } : { items: [], nextCursor: null });
  const page = mount();
  expect(await screen.findByRole('heading', { name: 'Private workshop', level: 1 })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Order history' })).getByRole('button', { name: 'View history' }));
  expect(mocks.authorize).toHaveBeenCalledWith(buyer);
  mocks.authenticated = true;
  page.rerender(orderTree());
  await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('/orders/7'));
  expect(screen.getByRole('heading', { name: 'Private workshop', level: 1 })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Private workshop' })).toHaveAttribute('src', '/offer-thumbnail');
  expect(screen.queryByText('Purchased offer')).not.toBeInTheDocument();
});
it('prefers the recorded purchase details over the public offer', async () => {
  mocks.request.mockImplementation(async (path: string) => path === '/orders/7' ? { ...view, offer: { status: 'recorded', title: 'Purchased version', description: 'Original details' } } : { items: [], nextCursor: null });
  mount();
  expect(await screen.findByRole('heading', { name: 'Purchased version', level: 1 })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Private workshop', level: 1 })).not.toBeInTheDocument();
});
it.each([false, true])('shows the purchased offer image when authenticated is %s', async authenticated => {
  mocks.authenticated = authenticated;
  view.offer.images = [{ id: 'cover', url: '/offer-image', thumbnailUrl: '/offer-thumbnail', width: 640, height: 480 }];
  mount();
  expect(await screen.findByRole('img', { name: 'Private workshop' })).toHaveAttribute('src', '/offer-thumbnail');
});
it('keeps the readable public summary and defers private access while locked', async () => {
  mocks.authenticated = false; mount();
  expect(await screen.findByRole('heading', { name: 'Private workshop', level: 1 })).toBeInTheDocument();
  expect(await screen.findByText('1 MON')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open delivery' })).toBeInTheDocument();
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.runOperation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh order' }));
  await waitFor(() => expect(mocks.read.mock.calls.filter(([path]) => path === '/public/orders/7')).toHaveLength(2));
});
it.each([['buyer', buyer], ['seller', seller]] as const)('does not offer delivery access for a refunded %s order while locked', async (_role, address) => {
  mocks.address = address; mocks.authenticated = false; view.order.state = 9; view.eligibility = {};
  mount();
  expect(await screen.findByRole('button', { name: 'Status: Refunded' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open delivery' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Order details' })).toBeInTheDocument();
  expect(mocks.authorize).not.toHaveBeenCalled();
});
it('places delivery before acceptance and explains the consequence before preparing a transaction', async () => {
  mocks.rows = [{ turn: '0', sender: seller, commitment: 'hash', reference: { serviceId: 1 } }];
  mocks.runOperation.mockImplementation(async action => action({ address: buyer }, () => true));
  mocks.restoreReceiving.mockResolvedValue({ privateKey: new Uint8Array(32) });
  mocks.openDelivery.mockResolvedValue({ payload: { text: 'Your private content', tickets: [] } });
  mount();
  const open = await screen.findByRole('button', { name: 'Open delivery' });
  expect(screen.queryByRole('button', { name: 'Accept delivery' })).not.toBeInTheDocument();
  await waitFor(() => expect(open).toBeEnabled());
  fireEvent.click(open);
  const delivery = await screen.findByRole('dialog', { name: 'Delivery' });
  expect(await within(delivery).findByText('Your private content')).toBeInTheDocument();
  expect(within(delivery).getByText('Content verified')).toBeInTheDocument();
  fireEvent.click(within(delivery).getByRole('button', { name: 'Accept delivery' }));
  const dialog = screen.getByRole('dialog', { name: 'Accept delivery' });
  expect(within(dialog).getByText(/ends your ability to dispute/)).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Review transaction' })).toBeInTheDocument();
  expect(mocks.request.mock.calls.some(([path]) => path === '/transactions/prepare')).toBe(false);
});
async function acceptanceReview(builtin: boolean, selfPay: boolean, wrongOrder = false) {
  const prompt = vi.fn(async () => true), session = createManagedSession(getBytes(`0x${"67".repeat(32)}`), prompt);
  mocks.session = builtin ? session : { ...session, kind: 'metamask' };
  mocks.address = session.address.toLowerCase(); view.order.buyer = mocks.address;
  mocks.rows = [{ turn: '0', sender: seller, commitment: 'hash', reference: { serviceId: 1 } }];
  mocks.restoreReceiving.mockResolvedValue({ privateKey: new Uint8Array(32) });
  mocks.openDelivery.mockResolvedValue({ payload: { text: 'Reviewed delivery content', tickets: [] } });
  mocks.runOperation.mockImplementation(async action => action(mocks.session, () => true));
  const contract = '0x3333333333333333333333333333333333333333', router = '0x4444444444444444444444444444444444444444';
  const data = orderActionAbi.encodeFunctionData('confirmReceipt', [wrongOrder ? 99 : 7]);
  const read = mocks.read.getMockImplementation()!, request = mocks.request.getMockImplementation()!;
  mocks.read.mockImplementation(async (path: string) => path === '/deployment' ? { chainId: 10143, contract, router } : read(path));
  mocks.request.mockImplementation(async (path: string, ...args: unknown[]) => {
    if (path === '/transactions/prepare' || path === '/transactions/request') {
      if (!view.eligibility.confirmReceipt) throw new Error('This action is no longer available.');
      return { chainId: 10143, to: contract, data, value: '0', gas: '100000', nonce: 0, maxFeePerGas: '1000000000', maxPriorityFeePerGas: '100000000', balance: '1000000000000000000' };
    }
    if (path === '/relay/payments') return { id: 'acceptance-job' };
    return request(path, ...args);
  });
  const page = mount('/purchases/7');
  try {
    const open = await screen.findByRole('button', { name: 'Open delivery' });
    await waitFor(() => expect(open).toBeEnabled()); fireEvent.click(open);
    await screen.findByText('Reviewed delivery content');
    const accept = screen.getByRole('button', { name: 'Accept delivery' });
    await waitFor(() => expect(accept).toBeEnabled()); fireEvent.click(accept);
    const dialog = await screen.findByRole('dialog', { name: 'Accept delivery' });
    if (!builtin) fireEvent.click(within(dialog).getByRole('button', { name: 'Review transaction' }));
    const confirm = await within(dialog).findByRole('button', { name: builtin ? 'Confirm acceptance' : 'Accept delivery' });
    await waitFor(() => expect(confirm).toBeEnabled());
    if (selfPay) { const toggle = within(dialog).getByRole('switch'); fireEvent.click(toggle); await waitFor(() => expect(toggle).toBeChecked()); }
    await waitFor(() => expect(confirm).toBeEnabled());
    mocks.runOperation.mockClear();
    return { prompt, session, page, dialog, confirm };
  } catch (error) { page.unmount(); session.lock(); throw error; }
}
it.each([[true, false], [true, true], [false, false], [false, true]])('reviews acceptance once for built-in wallets and preserves device approval (builtin: %s, self paid: %s)', async (builtin, selfPay) => {
  const { prompt, session, page, dialog, confirm } = await acceptanceReview(builtin!, selfPay!);
  try {
    expect(within(dialog).getByText(/Accepting delivery ends your ability to dispute/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Review transaction' })).not.toBeInTheDocument();
    expect(prompt).not.toHaveBeenCalled(); expect(mocks.runOperation).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.request.mock.calls.some(([path]) => path === (selfPay ? '/transactions/broadcast' : '/relay/payments'))).toBe(true));
    expect(mocks.runOperation).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledTimes(builtin ? 0 : 1);
    await session.signMessage('unrelated');
    expect(prompt).toHaveBeenCalledTimes(builtin ? 1 : 2); // The scoped approval was released.
  } finally { page.unmount(); session.lock(); }
});
it('can cancel the built-in acceptance review without signing or submitting', async () => {
  const { prompt, session, page, dialog } = await acceptanceReview(true, false);
  try {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Accept delivery' })).not.toBeInTheDocument();
    expect(prompt).not.toHaveBeenCalled(); expect(mocks.runOperation).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.some(([path]) => ['/relay/payments', '/transactions/broadcast'].includes(path))).toBe(false);
  } finally { page.unmount(); session.lock(); }
});
it.each([false, true])('rejects a different order in an acceptance request before signing (self paid: %s)', async selfPay => {
  const { prompt, session, page, confirm } = await acceptanceReview(true, selfPay, true);
  try {
    fireEvent.click(confirm);
    await screen.findByText('Order action changed. Review it again.');
    expect(prompt).not.toHaveBeenCalled(); expect(mocks.runOperation).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.some(([path]) => ['/relay/payments', '/transactions/broadcast'].includes(path))).toBe(false);
  } finally { page.unmount(); session.lock(); }
});
it('stops acceptance if eligibility changed after review', async () => {
  const { prompt, session, page, confirm } = await acceptanceReview(true, false);
  try {
    view.order.state = 6; view.eligibility = {};
    fireEvent.click(confirm);
    await screen.findByText('This action is no longer available.');
    expect(prompt).not.toHaveBeenCalled(); expect(mocks.runOperation).not.toHaveBeenCalled();
  } finally { page.unmount(); session.lock(); }
});
it('requires another review when acceptance fees increase', async () => {
  const { prompt, session, page, confirm } = await acceptanceReview(true, true);
  try {
    const request = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (path: string, ...args: unknown[]) => {
      const value = await request(path, ...args);
      return path === '/transactions/prepare' ? { ...value, maxFeePerGas: '2000000000' } : value;
    });
    fireEvent.click(confirm);
    await screen.findByText('Transaction details changed. Prepare and review again.');
    expect(prompt).not.toHaveBeenCalled(); expect(mocks.runOperation).not.toHaveBeenCalled();
  } finally { page.unmount(); session.lock(); }
});
it('keeps dispute entry available with missing content and opens the composer only on request', async () => {
  mount(); const open = await screen.findByRole('button', { name: 'Open delivery' });
  expect(screen.queryByRole('button', { name: 'Report a problem' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
  await waitFor(() => expect(open).toBeEnabled());
  fireEvent.click(open);
  const delivery = screen.getByRole('dialog', { name: 'Delivery' });
  expect(within(delivery).queryByRole('button', { name: 'Accept delivery' })).not.toBeInTheDocument();
  fireEvent.click(within(delivery).getByRole('button', { name: 'Report a problem' }));
  const dialog = screen.getByRole('dialog', { name: 'Report a problem' });
  fireEvent.change(within(dialog).getByLabelText('Message'), { target: { value: 'Delivery cannot be opened' } });
  expect(within(dialog).queryByLabelText('Draft recovery passphrase')).not.toBeInTheDocument();
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Review content' })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole('button', { name: 'Review content' }));
  expect(within(dialog).getByText(/opens a dispute/)).toBeInTheDocument();
  expect(mocks.runOperation).not.toHaveBeenCalled();
  expect(within(dialog).getByRole('button', { name: 'Continue to transaction' })).toBeInTheDocument();
  expect(within(dialog).queryByText('Recovery options')).not.toBeInTheDocument();
  expect(within(dialog).queryByText('Restore from backup')).not.toBeInTheDocument();
});
it('keeps problem reporting available when the delivery cannot be decrypted', async () => {
  mocks.rows = [{ turn: '0', sender: seller, commitment: 'hash', reference: { serviceId: 1 } }];
  mocks.runOperation.mockImplementation(async action => action({ address: buyer }, () => true));
  mocks.restoreReceiving.mockResolvedValue({ privateKey: new Uint8Array(32) });
  mocks.openDelivery.mockRejectedValue(new Error('Delivery could not be decrypted'));
  mount();
  const open = await screen.findByRole('button', { name: 'Open delivery' });
  await waitFor(() => expect(open).toBeEnabled());
  fireEvent.click(open);
  const dialog = await screen.findByRole('dialog', { name: 'Delivery' });
  expect(await within(dialog).findByText('Delivery could not be decrypted')).toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: 'Accept delivery' })).not.toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Report a problem' })).toBeEnabled();
});
it('uploads a problem report and opens transaction review without a saved draft', async () => {
  mocks.runOperation.mockImplementation(async action => action({ address: buyer }, () => true));
  mocks.prepareDelivery.mockImplementation(async ({ order, kind, turn, payload }) => ({
    record: { order, kind, turn, sender: buyer, serviceId: 1 }, recordHash: 'message-hash',
    item: { seed: 'seed' }, opening: { payload },
  }));
  mocks.upload.mockResolvedValue({});
  const request = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (path: string, ...args: unknown[]) => path === '/transactions/prepare'
    ? { chainId: 10143, to: '0x3333333333333333333333333333333333333333', data: '0x', value: '0', gas: '21000', nonce: 0, maxFeePerGas: '1000000000', maxPriorityFeePerGas: '100000000', balance: '1000000000000000000' }
    : request(path, ...args));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Open delivery' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Delivery' })).getByRole('button', { name: 'Report a problem' }));
  const dialog = screen.getByRole('dialog', { name: 'Report a problem' });
  fireEvent.change(within(dialog).getByLabelText('Message'), { target: { value: 'Delivery cannot be opened' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Review content' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Continue to transaction' }));
  await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('/transactions/prepare', expect.objectContaining({ kind: 'openDispute', orderId: '7' })));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Report a problem' })).not.toBeInTheDocument());
  const review = await screen.findByRole('dialog', { name: 'Send problem report' });
  expect(within(review).getByText('Maximum network fee')).toBeInTheDocument();
  expect(within(review).getByRole('button', { name: 'Send problem report' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Review and send' })).not.toBeInTheDocument();
  fireEvent.click(within(review).getByRole('button', { name: 'Close dialog' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue sending' }));
  expect(screen.getByRole('dialog', { name: 'Send problem report' })).toBeInTheDocument();
  expect(screen.queryByText('You have an unfinished message')).not.toBeInTheDocument();
});
it('reopens a saved conversation transaction from the Conversation section', async () => {
  mocks.ops = [{ id: 'lifecycle:message', account: buyer, deployment: { chainId: 10143, contract: '0x3333333333333333333333333333333333333333' }, orderId: '7', action: { kind: 'openDispute', orderId: '7' }, hashes: [], progress: 'checking', version: 1 }];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Check message status' }));
  const review = screen.getByRole('dialog', { name: 'Send problem report' });
  expect(within(review).getByText('Waiting for confirmation. You can close this dialog and check again later.')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Review and send' })).not.toBeInTheDocument();
});
it('reviews a seller reply transaction in the Conversation dialog', async () => {
  mocks.address = seller; view.order.state = 4; view.order.turn = '1'; view.eligibility = { reply: true };
  mocks.runOperation.mockImplementation(async action => action({ address: seller }, () => true));
  mocks.prepareDelivery.mockImplementation(async ({ order, kind, turn, payload }) => ({
    record: { order, kind, turn, sender: seller, serviceId: 1 }, recordHash: 'reply-hash',
    item: { seed: 'seed' }, opening: { payload },
  }));
  mocks.upload.mockResolvedValue({});
  const request = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (path: string, ...args: unknown[]) => path === '/transactions/prepare'
    ? { chainId: 10143, to: '0x3333333333333333333333333333333333333333', data: '0x', value: '0', gas: '21000', nonce: 0, maxFeePerGas: '1000000000', maxPriorityFeePerGas: '100000000', balance: '1000000000000000000' }
    : request(path, ...args));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
  const composer = screen.getByRole('dialog', { name: 'Reply' });
  fireEvent.change(within(composer).getByLabelText('Message'), { target: { value: 'Here are the delivery details' } });
  await waitFor(() => expect(within(composer).getByRole('button', { name: 'Review content' })).toBeEnabled());
  fireEvent.click(within(composer).getByRole('button', { name: 'Review content' }));
  fireEvent.click(within(composer).getByRole('button', { name: 'Continue to transaction' }));
  const review = await screen.findByRole('dialog', { name: 'Send reply' });
  expect(within(review).getByText('Maximum network fee')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Review and send' })).not.toBeInTheDocument();
});
it('gives the seller a prepare-review flow without prompting the wallet for preview', async () => {
  mocks.address = seller; view.order.state = 1; view.eligibility = {}; mount();
  const prepare = await screen.findByRole('button', { name: 'Prepare delivery' });
  await waitFor(() => expect(prepare).toBeEnabled());
  fireEvent.click(prepare);
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Delivery content'), { target: { value: 'Access code: ABC' } });
  expect(within(dialog).queryByLabelText('Draft recovery passphrase')).not.toBeInTheDocument();
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Review content' })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole('button', { name: 'Review content' }));
  expect(within(dialog).getByText('Access code: ABC')).toBeInTheDocument();
  expect(within(dialog).getByText(/two transactions/)).toBeInTheDocument();
  expect(mocks.runOfferKeysOperation).not.toHaveBeenCalled();
});
it('opens seller delivery transaction review in a dialog after preparing content', async () => {
  mocks.address = seller; view.order.state = 1; view.eligibility = {};
  mocks.runOfferKeysOperation.mockImplementation(async (_context, _publicKey, action) => action({}, { address: seller }, () => true));
  mocks.prepareDelivery.mockImplementation(async ({ order, kind, turn, payload }) => ({
    record: { order, kind, turn, sender: seller, serviceId: 1 }, recordHash: 'delivery-hash',
    item: { seed: 'seed' }, opening: { payload },
  }));
  mocks.upload.mockResolvedValue({});
  const request = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (path: string, ...args: unknown[]) => path === '/transactions/prepare'
    ? { chainId: 10143, to: '0x3333333333333333333333333333333333333333', data: '0x', value: '0', gas: '21000', nonce: 0, maxFeePerGas: '1000000000', maxPriorityFeePerGas: '100000000', balance: '1000000000000000000' }
    : request(path, ...args));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare delivery' }));
  const composer = screen.getByRole('dialog', { name: 'Prepare delivery' });
  fireEvent.change(within(composer).getByLabelText('Delivery content'), { target: { value: 'Access code: ABC' } });
  fireEvent.click(within(composer).getByRole('button', { name: 'Review content' }));
  fireEvent.click(await within(composer).findByRole('button', { name: 'Send delivery' }));
  const review = await screen.findByRole('dialog', { name: 'Delivery processing' });
  expect(within(review).getByText('Maximum network fee')).toBeInTheDocument();
  expect(within(review).getByRole('button', { name: 'Confirm delivery' })).toBeInTheDocument();
  expect(document.querySelectorAll('.order-pending .transaction-panel')).toHaveLength(0);
});
it.each([false, true])('completes built-in delivery after one confirmation (self paid: %s)', async selfPay => {
  const prompt = vi.fn(async () => false), session = createManagedSession(getBytes(`0x${"34".repeat(32)}`), prompt);
  mocks.session = session; mocks.address = session.address.toLowerCase();
  view.order.seller = mocks.address; view.order.state = 1; view.eligibility = {};
  const contract = '0x3333333333333333333333333333333333333333', router = '0x4444444444444444444444444444444444444444', hash = `0x${"55".repeat(32)}`;
  const submissions: string[] = [];
  const read = mocks.read.getMockImplementation()!, request = mocks.request.getMockImplementation()!;
  function finalized() {
    view.order.state = submissions.length === 1 ? 2 : 3;
    view.order.publicationDeadline = String(Math.floor(Date.now() / 1000) + 600);
    if (view.order.state === 3) mocks.rows = [{ turn: '0', sender: mocks.address, commitment: 'delivery-hash', reference: deliveryReference }];
  }
  mocks.read.mockImplementation(async (path: string) => {
    if (path === '/deployment') return { chainId: 10143, contract, router };
    if (path.startsWith('/relay/jobs/')) { finalized(); return { status: 'finalized', transactionHash: hash }; }
    return read(path);
  });
  mocks.request.mockImplementation(async (path: string, body?: { kind?: string; reference?: unknown; actionData?: string; raw?: string }) => {
    if (path === '/transactions/prepare' || path === '/transactions/request') return { chainId: 10143, to: contract, data: sellerDeliveryAbi.encodeFunctionData(body!.kind!, body!.kind === 'reserveDelivery' ? [7] : [7, body!.reference]), value: '0', gas: '600000', nonce: view.order.state === 1 ? 0 : 1, maxFeePerGas: '1000000000', maxPriorityFeePerGas: '100000000', balance: '1000000000000000000' };
    if (path === '/relay/payments') { submissions.push(body!.actionData!); return { id: `job-${submissions.length}` }; }
    if (path === '/transactions/broadcast') { submissions.push(Transaction.from(body!.raw).data); return {}; }
    if (path.startsWith('/transactions/0x')) { finalized(); return { status: 'finalized_success' }; }
    if (path.endsWith('/publication-check')) return { eligible: true };
    if (path.endsWith('/history')) return { items: [{ name: 'DeliveryReserved', transactionHash: hash }], nextCursor: null };
    return request(path, body);
  });
  mocks.runOperation.mockImplementation(async action => action(session, () => true));
  mocks.runOfferKeysOperation.mockImplementation(async (_context, _publicKey, action) => action({}, session, () => true));
  mocks.prepareDelivery.mockImplementation(async ({ order, kind, turn, payload }) => ({ record: { order, kind, turn, sender: mocks.address, serviceId: 1, expiresAt: new Date(Date.now() + 86400 * 365000).toISOString() }, recordHash: 'delivery-hash', item: { seed: 'seed' }, opening: { payload } }));
  mocks.upload.mockResolvedValue({});
  const page = mount('/sales/orders/7');
  try {
    const prepare = await screen.findByRole('button', { name: 'Prepare delivery' });
    await waitFor(() => expect(prepare).toBeEnabled()); fireEvent.click(prepare);
    const composer = screen.getByRole('dialog', { name: 'Prepare delivery' });
    fireEvent.change(within(composer).getByLabelText('Delivery content'), { target: { value: 'Reviewed access code' } });
    await waitFor(() => expect(within(composer).getByRole('button', { name: 'Review content' })).toBeEnabled());
    fireEvent.click(within(composer).getByRole('button', { name: 'Review content' }));
    const review = await screen.findByRole('dialog', { name: 'Delivery processing' });
    expect(within(review).getByText('Reviewed access code')).toBeInTheDocument();
    expect(mocks.upload).not.toHaveBeenCalled(); expect(submissions).toHaveLength(0); expect(prompt).not.toHaveBeenCalled();
    if (selfPay) {
      const toggle = await within(review).findByRole('switch', { name: 'Pay network fee myself' });
      fireEvent.click(toggle); await waitFor(() => expect(toggle).toBeChecked());
      expect(within(review).getByText('0.002 MON')).toBeInTheDocument();
    }
    const send = within(review).getByRole('button', { name: 'Send delivery' });
    await waitFor(() => expect(send).toBeEnabled()); fireEvent.click(send);
    await waitFor(() => expect(submissions).toHaveLength(1));
    if (selfPay) {
      const close = within(review).getByRole('button', { name: 'Close dialog' });
      await waitFor(() => expect(close).toBeEnabled()); fireEvent.click(close);
      await waitFor(() => expect(submissions).toHaveLength(2), { timeout: 7000 });
      expect(screen.queryByRole('dialog', { name: 'Delivery processing' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Check delivery status' }));
    } else {
      const check = await screen.findByRole('button', { name: 'Check status' });
      await waitFor(() => expect(check).toBeEnabled()); fireEvent.click(check);
      await waitFor(() => expect(submissions).toHaveLength(2));
    }
    expect(submissions).toEqual([sellerDeliveryAbi.encodeFunctionData('reserveDelivery', [7]), sellerDeliveryAbi.encodeFunctionData('publishDelivery', [7, deliveryReference])]);
    expect(mocks.request.mock.calls.filter(([path]) => path === '/relay/payments')).toHaveLength(selfPay ? 0 : 2);
    expect(mocks.upload).toHaveBeenCalledOnce(); expect(prompt).not.toHaveBeenCalled();
    const finalCheck = await screen.findByRole('button', { name: 'Check status' });
    await waitFor(() => expect(finalCheck).toBeEnabled()); fireEvent.click(finalCheck);
    await screen.findByText('Content published and finalized. Temporary draft cleared.');
  } finally { page.unmount(); session.lock(); }
}, 15000);
it('keeps case tools contextual and replaces sequence entry with selectable messages', async () => {
  view.order.state = 4; view.eligibility = { requestArbitration: true }; mocks.rows = [{ turn: '0', sender: seller }, { turn: '1', sender: buyer }]; mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Explore arbitration' }));
  const evidence = await screen.findByRole('button', { name: 'Prepare or restore evidence' });
  await waitFor(() => expect(evidence).toBeEnabled());
  fireEvent.click(evidence);
  const dialog = screen.getByRole('dialog', { name: 'Prepare evidence' });
  const checkbox = await within(dialog).findByRole('checkbox', { name: 'Seller delivery' });
  expect(checkbox).toBeChecked(); fireEvent.click(checkbox); expect(checkbox).not.toBeChecked();
  expect(within(dialog).queryByLabelText(/comma-separated/)).not.toBeInTheDocument();
});
it('uses finalized time for expired next steps and translates real contract event names', () => {
  view.block.timestamp = 600;
  expect(orderNext(view, buyer)).toMatch(/review period has ended/);
  expect(eventLabel('RecordPublished', { sequence: '0' })).toBe('Delivery published');
  expect(eventLabel('StateChanged', { state: '7' })).toBe('Delivery accepted');
  expect(eventLabel('Settled', { state: '9' })).toBe('Buyer refunded');
});
it('shows next-step help through the prominent status and keeps details in dialogs', async () => {
  mocks.rows = [{ turn: '0', sender: seller, commitment: 'hash' }]; mount();
  const status = await screen.findByRole('button', { name: 'Status: Delivered' });
  expect(screen.queryByText('What happens next')).not.toBeInTheDocument();
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  fireEvent.mouseEnter(status.parentElement!);
  expect(screen.getByRole('tooltip')).toHaveTextContent('Open and review');
  fireEvent.mouseLeave(status.parentElement!);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  fireEvent.click(status); expect(status).toHaveAttribute('aria-expanded', 'true');
  fireEvent.keyDown(status, { key: 'Escape' }); expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  fireEvent.focus(status); expect(screen.getByRole('tooltip')).toBeInTheDocument(); fireEvent.blur(status);
  expect(screen.queryByText('Purchased')).not.toBeInTheDocument();
  expect(screen.queryByText('Event end')).not.toBeInTheDocument();
  const open = await screen.findByRole('button', { name: 'Open delivery' });
  expect(open.closest('.order-summary')).not.toContainElement(screen.queryByRole('button', { name: 'Accept delivery' }));
  fireEvent.click(screen.getByRole('button', { name: 'Order details' }));
  let dialog = screen.getByRole('dialog', { name: 'Order details' });
  expect(within(dialog).getByRole('button', { name: 'Copy seller wallet' })).toHaveAttribute('title', seller);
  expect(within(dialog).queryByText('Event end')).not.toBeInTheDocument();
  expect(within(dialog).getByText('1 day after delivery')).toBeInTheDocument();
  expect(dialog).toHaveTextContent('Review ends:');
  expect(dialog).toHaveTextContent('Check the delivery before accepting it. If something is wrong, report a problem during the review period. Accepting ends your review and lets the seller claim payment.');
  expect(dialog).not.toHaveTextContent('Delivery publication window');
  expect(dialog).not.toHaveTextContent('Response window');
  expect(dialog).not.toHaveTextContent('Encrypted content is stored');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  dialog = screen.getByRole('dialog', { name: 'Order history' }); expect(await within(dialog).findByText('Purchased')).toBeInTheDocument();
});
it('shows only the deadline relevant to the current order state', async () => {
  mocks.authenticated = false;
  view.order.state = 2;
  view.order.publicationDeadline = '400';
  view.order.reviewDeadline = '500';
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Order details' }));
  const dialog = screen.getByRole('dialog', { name: 'Order details' });
  expect(dialog).toHaveTextContent('Complete delivery by:');
  expect(dialog).not.toHaveTextContent('Review ends:');
  expect(dialog).not.toHaveTextContent('Deadlines do not transfer funds automatically');
});
it('shows the event end and later-of timing when an order has an event', async () => {
  view.order.terms.hasEventEnd = true;
  view.order.terms.eventEnd = '1735689600';
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Order details' }));
  const dialog = screen.getByRole('dialog', { name: 'Order details' });
  expect(within(dialog).getByText('Event end')).toBeInTheDocument();
  expect(within(dialog).getByText('1 day after delivery or event end, whichever is later')).toBeInTheDocument();
});
it('opens public order details without authentication or a separate order-actions section', async () => {
  mocks.authenticated = false; mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Order details' }));
  const dialog = screen.getByRole('dialog', { name: 'Order details' });
  expect(dialog).toHaveTextContent('Review period');
  expect(within(dialog).getByRole('button', { name: 'Copy seller wallet' })).toHaveAttribute('title', seller);
  expect(screen.queryByRole('heading', { name: 'Order actions' })).not.toBeInTheDocument();
  expect(mocks.request).not.toHaveBeenCalled();
});

it('shows a refund before sign-in and resumes its review after fresh eligibility is checked', async () => {
  mocks.authenticated = false; view.order.state = 1; view.eligibility = { claimRefund: true };
  const result = mount();
  const refund = await screen.findByRole('button', { name: 'Claim refund' });
  expect(screen.queryByRole('button', { name: 'Continue order' })).not.toBeInTheDocument();
  expect(mocks.request).not.toHaveBeenCalled();
  fireEvent.click(refund); expect(mocks.authorize).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog', { name: 'Claim refund' })).not.toBeInTheDocument();
  mocks.authenticated = true;
  result.rerender(orderTree('/purchases/7'));
  expect(await screen.findByRole('dialog', { name: 'Claim refund' })).toHaveTextContent('Return the full order payment to the buyer');
  expect(mocks.request).toHaveBeenCalledWith('/orders/7');
  expect(mocks.request.mock.calls.some(([path]) => path === '/transactions/prepare')).toBe(false);
});
it('keeps refund transaction review in the dialog and lets the buyer reopen it', async () => {
  view.order.state = 1; view.eligibility = { claimRefund: true };
  mocks.request.mockImplementation(async (path: string) => path === '/orders/7' ? view : path === '/transactions/prepare' ? { chainId: 10143, to: '0x3333333333333333333333333333333333333333', data: '0x', value: '0', gas: '21000', nonce: 0, maxFeePerGas: '1000000000', maxPriorityFeePerGas: '100000000', balance: '1000000000000000000' } : path.endsWith('/history') ? { items: [], nextCursor: null } : { items: [], nextCursor: null });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Claim refund' }));
  const dialog = screen.getByRole('dialog', { name: 'Claim refund' });
  expect(within(dialog).getByRole('button', { name: 'Review transaction' })).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Review transaction' }));
  const review = await screen.findByRole('dialog', { name: 'Review refund' });
  expect(within(review).getByText('Maximum network fee')).toBeInTheDocument();
  expect(within(review).getByRole('button', { name: 'Confirm refund' })).toBeInTheDocument();
  expect(document.querySelectorAll('.order-detail > .transaction-panel')).toHaveLength(0);
  fireEvent.click(within(review).getByRole('button', { name: 'Close dialog' }));
  expect(screen.getByRole('button', { name: 'Continue refund' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Continue refund' }));
  expect(screen.getByRole('dialog', { name: 'Review refund' })).toBeInTheDocument();
});
it('keeps seller claim review and confirmation in a reopenable dialog', async () => {
  mocks.address = seller; view.order.state = 7; view.eligibility = { withdrawSeller: true };
  mocks.request.mockImplementation(async (path: string) => path === '/orders/7' ? view : path === '/transactions/prepare' ? { chainId: 10143, to: '0x3333333333333333333333333333333333333333', data: '0x', value: '0', gas: '21000', nonce: 0, maxFeePerGas: '1000000000', maxPriorityFeePerGas: '100000000', balance: '1000000000000000000' } : { items: [], nextCursor: null });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Claim payment' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Claim payment' })).getByRole('button', { name: 'Review transaction' }));
  const dialog = await screen.findByRole('dialog', { name: 'Claim payment' });
  expect(await within(dialog).findByRole('button', { name: 'Claim payment' })).toBeInTheDocument();
  expect(document.querySelectorAll('.order-detail > .transaction-panel')).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue claim payment' }));
  expect(screen.getByRole('dialog', { name: 'Claim payment' })).toHaveTextContent('Maximum network fee');
});
it.each([
  ['withdrawSeller', false], ['withdrawSeller', true], ['claimResponseTimeout', false], ['claimResponseTimeout', true],
] as const)('prepares a built-in %s claim on opening and signs once (self paid: %s)', async (kind, selfPay) => {
  const prompt = vi.fn(async () => false), session = createManagedSession(getBytes(`0x${"56".repeat(32)}`), prompt);
  mocks.session = session; mocks.address = session.address.toLowerCase(); view.order.seller = mocks.address;
  view.order.state = kind === 'withdrawSeller' ? 7 : 5; view.eligibility = { [kind]: true };
  const contract = '0x3333333333333333333333333333333333333333', router = '0x4444444444444444444444444444444444444444';
  const data = orderActionAbi.encodeFunctionData(kind, [7]);
  const read = mocks.read.getMockImplementation()!, request = mocks.request.getMockImplementation()!;
  mocks.read.mockImplementation(async (path: string) => path === '/deployment' ? { chainId: 10143, contract, router } : read(path));
  mocks.request.mockImplementation(async (path: string, ...args: unknown[]) => path === '/transactions/prepare' || path === '/transactions/request'
    ? { chainId: 10143, to: contract, data, value: '0', gas: '200000', nonce: 0, maxFeePerGas: '1000000000', maxPriorityFeePerGas: '100000000', balance: '1000000000000000000' }
    : path === '/relay/payments' ? { id: 'claim-job' } : request(path, ...args));
  mocks.runOperation.mockImplementation(async action => action(session, () => true));
  const page = mount('/sales/orders/7');
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Claim payment' }));
    const dialog = await screen.findByRole('dialog', { name: 'Claim payment' });
    const confirm = await within(dialog).findByRole('button', { name: 'Claim payment' });
    expect(within(dialog).queryByRole('button', { name: 'Review transaction' })).not.toBeInTheDocument();
    expect(prompt).not.toHaveBeenCalled(); expect(mocks.runOperation).not.toHaveBeenCalled();
    if (selfPay) { const toggle = await within(dialog).findByRole('switch'); fireEvent.click(toggle); await waitFor(() => expect(toggle).toBeChecked()); }
    await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
    await waitFor(() => expect(mocks.request.mock.calls.some(([path]) => path === (selfPay ? '/transactions/broadcast' : '/relay/payments'))).toBe(true));
    expect(prompt).not.toHaveBeenCalled();
    expect(mocks.runOperation).toHaveBeenCalledOnce();
    await expect(session.signMessage('unrelated')).rejects.toThrow('declined');
  } finally { page.unmount(); session.lock(); }
});
it('reopens a saved arbitration action in a transaction dialog', async () => {
  view.eligibility = { requestArbitration: true };
  mocks.ops = [{ id: 'lifecycle:saved-arbitration', account: buyer, deployment: { chainId: 10143, contract: '0x3333333333333333333333333333333333333333' }, orderId: '7', action: { kind: 'requestArbitration', orderId: '7', wallet: '0x4444444444444444444444444444444444444444', expectedKeyVersion: '1', expectedFeeVersion: '1', expectedFee: '0', expectedFeeAsset: '0x5555555555555555555555555555555555555555', evidence: { contentRef: { serviceId: 1, preparedAt: '100', creator: `0x${'11'.repeat(32)}`, buyerEnvelope: `0x03${'11'.repeat(64)}`, sellerEnvelope: `0x03${'22'.repeat(64)}`, contentHash: `0x${'33'.repeat(32)}` }, arbitratorEnvelope: `0x03${'44'.repeat(64)}` } }, hashes: [], progress: 'checking', version: 1 }];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Check transaction status' }));
  expect(screen.getByRole('dialog', { name: 'Arbitration transaction' })).toHaveTextContent('Waiting for confirmation.');
  expect(document.querySelectorAll('.order-pending .transaction-panel')).toHaveLength(0);
});
it('reopens a saved seller delivery transaction in its dialog', async () => {
  mocks.address = seller; view.order.state = 2; view.order.publicationDeadline = '500'; view.eligibility = {};
  mocks.ops = [{ id: 'lifecycle:saved-delivery', account: seller, deployment: { chainId: 10143, contract: '0x3333333333333333333333333333333333333333' }, orderId: '7', action: { kind: 'reserveDelivery', orderId: '7' }, hashes: [], progress: 'checking', version: 1 }];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Check delivery status' }));
  const dialog = screen.getByRole('dialog', { name: 'Delivery processing' });
  expect(within(dialog).getByText('Waiting for confirmation. You can close this dialog and check again later.')).toBeInTheDocument();
  expect(document.querySelectorAll('.order-pending .transaction-panel')).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check delivery status' }));
  expect(screen.getByRole('dialog', { name: 'Delivery processing' })).toBeInTheDocument();
});
it('offers a way to check a saved refund after reopening the order', async () => {
  view.order.state = 1; view.eligibility = { claimRefund: true };
  mocks.ops = [{ id: 'saved-refund', account: buyer, deployment: { chainId: 10143, contract: '0x3333333333333333333333333333333333333333' }, orderId: '7', action: { kind: 'claimRefund', orderId: '7' }, hashes: [], progress: 'checking', version: 1 }];
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Check refund status' }));
  expect(screen.getByRole('dialog', { name: 'Review refund' })).toHaveTextContent('Waiting for confirmation.');
});
it('does not continue a refund when eligibility changed while signing in', async () => {
  mocks.authenticated = false; view.order.state = 1; view.eligibility = { claimRefund: true };
  const result = mount(); fireEvent.click(await screen.findByRole('button', { name: 'Claim refund' }));
  view = { ...view, eligibility: {}, order: { ...view.order, state: 2, publicationDeadline: '500' } }; mocks.authenticated = true;
  result.rerender(orderTree('/purchases/7'));
  expect(await screen.findByText('A refund is no longer available. The order status has changed.')).toBeInTheDocument();
  expect(screen.queryByRole('dialog', { name: 'Claim refund' })).not.toBeInTheDocument();
  expect(mocks.request.mock.calls.some(([path]) => path === '/transactions/prepare')).toBe(false);
});
it('uses finalized time and cancellation to determine public refund availability', () => {
  const order = { ...view, offer: null };
  order.order.state = 2; order.order.publicationDeadline = '101';
  expect(publicRefundAction(order)).toBeUndefined();
  order.canceled = true; expect(publicRefundAction(order)).toBe('claimRefund');
  order.canceled = false; order.block.timestamp = 101; expect(publicRefundAction(order)).toBe('claimRefund');
  order.order.state = 4; order.order.responseDeadline = '101'; expect(publicRefundAction(order)).toBe('claimResponseTimeout');
  order.order.state = 6; expect(publicRefundAction(order)).toBeUndefined();
});

it('redirects a seller on a buyer URL to the fulfillment workspace', async () => {
  mocks.address = seller; view.order.state = 1; view.eligibility = {}; mount('/purchases/7');
  expect(await screen.findByRole('heading', { name: 'Delivery progress' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Prepare delivery' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Claim refund' })).not.toBeInTheDocument();
});
it('does not fetch protected data for a non-participant on a seller URL', async () => {
  mocks.address = '0x9999999999999999999999999999999999999999'; mount('/sales/orders/7');
  expect(await screen.findByText(/This account is not the seller/)).toBeInTheDocument();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Prepare delivery' })).not.toBeInTheDocument();
});
it('opens the arbitrator case workspace directly without participant delivery controls', async () => {
  const arbitrator = '0x9999999999999999999999999999999999999999'; mocks.address = arbitrator;
  view.order.state = 6; view.eligibility = { resolveArbitration: true }; view.assignment = { wallet: arbitrator, publicKey: 'key', keyVersion: '1', revision: '1', fee: '0', requester: buyer, handoverRecorded: true };
  const read = mocks.read.getMockImplementation()!;
  mocks.read.mockImplementation(async (path: string) => path.startsWith('/public/orders/') ? { ...view, arbitrator } : read(path));
  mount('/arbitration/7');
  expect(await screen.findByRole('heading', { name: 'Case details' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Request evidence' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Prepare delivery' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Accept delivery' })).not.toBeInTheDocument();
});

it('lets a seller prepare again under the original reservation without backup controls', async () => {
  mocks.address = seller; view.order.state = 2; view.order.publicationDeadline = '500'; view.eligibility = {};
  mount(); const button = await screen.findByRole('button', { name: 'Prepare delivery again' });
  await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
  const dialog = screen.getByRole('dialog', { name: 'Prepare delivery again' });
  expect(within(dialog).queryByText('Recovery options')).not.toBeInTheDocument();
  expect(within(dialog).queryByText('Restore from backup')).not.toBeInTheDocument();
  expect(within(dialog).queryByLabelText('Draft recovery passphrase')).not.toBeInTheDocument();
  fireEvent.change(within(dialog).getByLabelText('Delivery content'), { target: { value: 'Replacement content' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Review content' }));
  expect(within(dialog).getByText(/original deadline/)).toBeInTheDocument();
  expect(mocks.runOfferKeysOperation).not.toHaveBeenCalled();
});
