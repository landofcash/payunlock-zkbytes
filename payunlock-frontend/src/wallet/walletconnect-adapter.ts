import type {AppKit} from "@reown/appkit";
import {reownProjectId} from "@/config/reown";
import {walletNetwork} from "@/config/wallet";
import {WalletError} from "./errors";
import {sendReviewedTransaction} from "./transactions";
import {validateTokenAuthorization} from "./typed-data";
import type {LabWalletAdapter, LabWalletSession, WalletSessionEvent,} from "./types";

const network = {
  id: Number(walletNetwork.chainId),
  name: walletNetwork.name,
  nativeCurrency: {name: "MON", symbol: "MON", decimals: 18},
  rpcUrls: {default: {http: [walletNetwork.rpcUrl]}},
  blockExplorers: {
    default: {name: "MonadVision", url: "https://testnet.monadvision.com"},
  },
  testnet: true,
};

export type WalletConnectKit = Pick<
  AppKit,
  | "ready"
  | "open"
  | "close"
  | "disconnect"
  | "getAccount"
  | "getProvider"
  | "getProviderType"
  | "getChainId"
  | "getWalletInfo"
  | "subscribeAccount"
  | "subscribeProviders"
  | "subscribeState"
  | "subscribeNetwork"
  | "switchNetwork"
  | "resetWalletConnectUri"
  | "resetConnectingWallet"
>;

interface Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

let kitPromise: Promise<WalletConnectKit> | undefined;

function getKit() {
  const projectId = reownProjectId;
  if (!projectId) return Promise.reject(new WalletError("configuration"));
  kitPromise ??= Promise.all([
    import("@reown/appkit"),
    import("@reown/appkit-adapter-ethers"),
  ])
    .then(([{createAppKit}, {EthersAdapter}]) =>
      createAppKit({
        adapters: [new EthersAdapter()],
        networks: [network],
        defaultNetwork: network,
        projectId,
        metadata: {
          name: "PayUnlock",
          description: "Private delivery",
          url: window.location.origin,
          icons: [`${window.location.origin}/favicon.svg`],
        },
        themeMode: "light",
        enableReconnect: false,
        enableInjected: false,
        enableEIP6963: false,
        enableCoinbase: false,
        defaultAccountTypes: {eip155: "eoa"},
        features: {
          analytics: false,
          email: false,
          socials: [],
          swaps: false,
          onramp: false,
          send: false,
          receive: false,
          history: false,
        },
      }),
    )
    .catch((error) => {
      kitPromise = undefined;
      throw error;
    });
  return kitPromise;
}

function validAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
}

function hexChain(value: unknown): string | undefined {
  if (
    (typeof value === "number" || typeof value === "string") &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0
  )
    return `0x${Number(value).toString(16)}`;
  return undefined;
}

export function createWalletConnectAdapter(
  loadKit: () => Promise<WalletConnectKit> = getKit,
): LabWalletAdapter {
  return {
    kind: "walletconnect",
    label: "WalletConnect",
    async connect() {
      const kit = await loadKit();
      await kit.ready();
      // Never adopt a previous session implicitly. This click starts a fresh connection.
      if (kit.getAccount("eip155")?.isConnected) await kit.disconnect("eip155");
      return new Promise<LabWalletSession>((resolve, reject) => {
        let opened = false;
        let settled = false;
        let verifying = false;
        const subscriptions: (() => void)[] = [];

        function cleanup() {
          subscriptions.splice(0).forEach((stop) => stop());
        }

        async function fail(error: unknown) {
          if (settled) return;
          settled = true;
          cleanup();
          kit.resetWalletConnectUri();
          kit.resetConnectingWallet();
          try {
            await kit.close();
            await kit.disconnect("eip155");
          } catch {
            /* Release the local operation regardless. */
          }
          reject(error);
        }

        async function tryConnected() {
          if (settled || verifying) return;
          const account = kit.getAccount("eip155");
          const provider = kit.getProvider<Provider>("eip155");
          if (
            !account?.isConnected ||
            !validAddress(account.address) ||
            !provider
          )
            return;
          verifying = true;
          try {
            // The dedicated button must not silently select an injected/embedded wallet.
            if (kit.getProviderType("eip155") !== "WALLET_CONNECT")
              throw new WalletError("unsupported");
            const accounts = await provider.request({method: "eth_accounts"});
            if (
              !Array.isArray(accounts) ||
              !accounts.some(
                (value) =>
                  typeof value === "string" &&
                  value.toLowerCase() === account.address!.toLowerCase(),
              )
            )
              throw new WalletError("wrong-account");
            if (settled) {
              return;
            }
            const latest = kit.getAccount("eip155");
            if (
              !latest?.isConnected ||
              latest.address?.toLowerCase() !== account.address.toLowerCase() ||
              kit.getProvider<Provider>("eip155") !== provider
            )
              throw new WalletError("wrong-account");
            const session = connectedSession(kit, provider, account.address);
            settled = true;
            cleanup();
            void kit.close().catch(() => {
            });
            resolve(session);
          } catch (error) {
            await fail(error);
          } finally {
            verifying = false;
          }
        }

        subscriptions.push(
          kit.subscribeAccount(() => {
            void tryConnected();
          }, "eip155"),
        );
        subscriptions.push(
          kit.subscribeProviders(() => {
            void tryConnected();
          }),
        );
        subscriptions.push(
          kit.subscribeState((state) => {
            if (state.open) opened = true;
            else if (opened && !settled) {
              // AppKit closes its modal on success too; examine account state first.
              if (kit.getAccount("eip155")?.isConnected) void tryConnected();
              else void fail(new WalletError("cancelled"));
            }
          }),
        );
        void kit
          .open({view: "Connect", namespace: "eip155"})
          .then(() => {
            void tryConnected();
          })
          .catch(fail);
      });
    },
  };
}

function connectedSession(
  kit: WalletConnectKit,
  provider: Provider,
  initialAddress: string,
): LabWalletSession {
  let address = initialAddress;
  let chainId = hexChain(kit.getChainId());
  let connected = true;
  let revision = 0;
  const listeners = new Set<(event: WalletSessionEvent) => void>();
  const emit = (event: WalletSessionEvent) => {
    for (const listener of listeners) listener(event);
  };

  function disconnected() {
    if (connected) {
      connected = false;
      revision++;
      emit("disconnect");
    }
  }

  const subscriptions = [
    kit.subscribeAccount((account) => {
      if (!account.isConnected || !validAddress(account.address)) {
        disconnected();
        return;
      }
      if (account.address.toLowerCase() !== address.toLowerCase()) {
        address = account.address;
        revision++;
        emit("accountsChanged");
      }
    }, "eip155"),
    kit.subscribeNetwork(() => {
      const next = hexChain(kit.getChainId());
      if (next !== chainId) {
        chainId = next;
        revision++;
        emit("chainChanged");
      }
    }),
    kit.subscribeProviders(() => {
      if (kit.getProvider<Provider>("eip155") !== provider) disconnected();
    }),
  ];

  function dispose() {
    connected = false;
    revision++;
    subscriptions.forEach((stop) => stop());
    listeners.clear();
  }

  async function verify(expected: string, version: number) {
    if (!connected || kit.getProvider<Provider>("eip155") !== provider)
      throw new WalletError("disconnected");
    const accounts = await provider.request({method: "eth_accounts"});
    if (!connected) throw new WalletError("disconnected");
    if (
      revision !== version ||
      kit.getAccount("eip155")?.address?.toLowerCase() !==
      expected.toLowerCase() ||
      !Array.isArray(accounts) ||
      !accounts.some(
        (value) =>
          typeof value === "string" &&
          value.toLowerCase() === expected.toLowerCase(),
      )
    )
      throw new WalletError("wrong-account");
  }

  const peerName = kit
    .getWalletInfo("eip155")
    ?.name?.replace(/\p{Cc}/gu, "")
    .slice(0, 80);
  return {
    kind: "walletconnect",
    walletName: peerName ? `${peerName} via WalletConnect` : "WalletConnect",
    transport: "managed",
    get address() {
      return address;
    },
    get chainId() {
      return chainId;
    },
    async signMessage(message) {
      const expected = address;
      const version = revision;
      await verify(expected, version);
      const hex =
        "0x" +
        Array.from(new TextEncoder().encode(message), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      const signature = await provider.request({
        method: "personal_sign",
        params: [hex, expected],
      });
      await verify(expected, version);
      if (typeof signature !== "string") throw new WalletError("unsupported");
      return signature;
    },
    async signTypedData(request) {
      const expected = address, version = revision;
      await verify(expected, version);
      const {domain, types, primaryType, message} = validateTokenAuthorization(request, expected);
      const signature = await provider.request({
        method: "eth_signTypedData_v4",
        params: [expected, JSON.stringify({domain, types, primaryType, message})]
      });
      await verify(expected, version);
      if (typeof signature !== "string") throw new WalletError("unsupported");
      return signature;
    },
    async disconnect() {
      dispose();
      await kit.disconnect("eip155");
    },
    async sendTransaction(transaction) {
      const expected = address, version = revision;
      return sendReviewedTransaction(args => provider.request(args), transaction, expected, () => verify(expected, version));
    },
    async switchNetwork() {
      if (!connected) throw new WalletError("disconnected");
      await kit.switchNetwork(network, {throwOnFailure: true});
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose,
  };
}

export const walletconnectAdapter = createWalletConnectAdapter();
