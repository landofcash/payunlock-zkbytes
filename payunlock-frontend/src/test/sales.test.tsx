import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { Sales, sellerOrderStatus } from "@/commerce/Sales";
import type { PublicOrder } from "@/commerce/client";
const mocks = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn(), list: vi.fn() }));
vi.mock("@/commerce/client", async original => ({ ...await original<typeof import("@/commerce/client")>(), useCommerce: () => ({ read: mocks.read, request: mocks.request }), useCommerceAccess: () => ({ address: '0x1111111111111111111111111111111111111111', authenticated: false }) }));
vi.mock("@/commerce/ui", async original => ({ ...await original<typeof import("@/commerce/ui")>(), journal: { list: mocks.list } }));
const address = '0x1111111111111111111111111111111111111111', token = '0x2222222222222222222222222222222222222222', contract = '0x3333333333333333333333333333333333333333';
function order(id = '1', state = 1): PublicOrder { return { orderId: id, canceled: false, block: { number: 100, hash: 'hash', timestamp: 1000 }, offer: { id: 'offer', title: 'Workshop ' + id, description: '' }, order: { buyer: token, seller: address, state, publicationDeadline: '1100', reviewDeadline: '1200', responseDeadline: '1300', terms: { token, price: '1000000', hasEventEnd: false, eventEnd: '0', reviewWindow: '86400', responseWindow: '259200', commitmentWindow: '600' } } }; }
beforeEach(() => { mocks.list.mockReset().mockResolvedValue([]); mocks.request.mockReset(); mocks.read.mockReset().mockImplementation(async (path: string) => path === '/deployment' ? { chainId: 10143, contract } : path === '/products/offer' ? { id: 'offer', title: 'Workshop', images: [{ id: 'image', url: '/workshop', thumbnailUrl: '/workshop-thumb', width: 200, height: 150 }] } : path.startsWith('/public/assets/') ? { symbol: 'USDC', decimals: 6 } : path.startsWith('/public/orders?') ? { items: [order(), order('2', 8)], nextCursor: '2' } : order(path.split('/').at(-1))); });
function mount() { return render(<MemoryRouter><Sales /></MemoryRouter>); }
it('formats seller cards and provides action links without signing', async () => {
  mount(); expect(await screen.findByText('Workshop 1')).toBeInTheDocument();
  expect((await screen.findAllByText('1 USDC')).length).toBe(2);
  expect(await screen.findByRole('img', { name: 'Workshop 1' })).toHaveAttribute('src', '/workshop-thumb');
  expect(mocks.read.mock.calls.filter(([path]) => path === '/products/offer')).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'Prepare delivery' })).toHaveAttribute('href', '/sales/orders/1');
  expect(screen.queryByText(/base units/)).not.toBeInTheDocument();
  expect(screen.queryByText('Access saved operations')).not.toBeInTheDocument();
  expect(mocks.request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Needs delivery', expanded: false }));
  expect(screen.getByRole('tooltip')).toHaveTextContent('Prepare and review');
});
it('filters loaded orders and keeps pagination available', async () => {
  mount(); await screen.findByText('Workshop 1');
  fireEvent.click(screen.getByRole('button', { name: 'Needs attention' }));
  expect(screen.queryByText('Workshop 2')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'More orders' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
  expect(screen.getByText('Workshop 2')).toBeInTheDocument(); expect(screen.queryByText('Workshop 1')).not.toBeInTheDocument();
});
it('shows only current-deployment unfinished seller work and merges loaded order recovery', async () => {
  const row = (id: string, progress: string, target = contract) => ({ id, orderId: id, account: address, deployment: { chainId: 10143, contract: target }, progress, hashes: [] });
  mocks.list.mockResolvedValue([row('1', 'checking'), row('3', 'review'), row('4', 'finalized'), row('5', 'review', token)]);
  mount(); await waitFor(() => expect(screen.getAllByRole('link', { name: 'Check status' })).toHaveLength(1));
  expect(screen.queryByRole('link', { name: 'Prepare delivery' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Continue unfinished work' })).toHaveAttribute('href', '/sales/orders/3');
  expect(screen.queryByText('Order #4')).not.toBeInTheDocument(); expect(screen.queryByText('Order #5')).not.toBeInTheDocument();
  expect(mocks.request).not.toHaveBeenCalled();
});
it('uses finalized time and seller settlement semantics', () => {
  const view = order(); view.order.state = 7; expect(sellerOrderStatus(view)).toMatchObject({ action: 'Claim payment', attention: true }); expect(sellerOrderStatus(view).completed).toBeUndefined();
  view.order.state = 2; expect(sellerOrderStatus(view).action).toBe('Continue delivery');
  view.block.timestamp = 1100; expect(sellerOrderStatus(view).action).toBeUndefined();
  view.order.state = 3; view.block.timestamp = 1200; expect(sellerOrderStatus(view).action).toBe('Claim payment');
  view.order.state = 4; view.block.timestamp = 1299; expect(sellerOrderStatus(view).action).toBe('Reply');
  view.block.timestamp = 1300; expect(sellerOrderStatus(view).action).toBeUndefined();
  view.order.state = 5; expect(sellerOrderStatus(view).action).toBe('Claim payment');
});
