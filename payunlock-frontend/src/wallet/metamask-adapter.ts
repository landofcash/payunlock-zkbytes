import type {EIP1193Provider, MetamaskConnectEVM,} from "@metamask/connect-evm";
import type {LabWalletAdapter, LabWalletSession, WalletSessionEvent,} from "./types";
import {WalletError} from "./errors";
import {sendReviewedTransaction} from "./transactions";
import {validateTokenAuthorization} from "./typed-data";
import {walletNetwork} from "@/config/wallet";

let clientPromise: Promise<MetamaskConnectEVM> | undefined;

// Lazy singleton: no connection, restoration or signing work on mount/reload.
function getClient() {
  clientPromise ??= import("@metamask/connect-evm")
    .then(({createEVMClient}) =>
      createEVMClient({
        dapp: {
          name: "PayUnlock",
          url: window.location.origin,
          iconUrl: `${window.location.origin}/favicon.svg`,
        },
        api: {
          supportedNetworks: {[walletNetwork.chainId]: walletNetwork.rpcUrl},
        },
        analytics: {enabled: false},
        ui: {preferExtension: true, showInstallModal: false},
        debug: false,
      }),
    )
    .catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  return clientPromise;
}

type MetaMaskClient = Pick<
  MetamaskConnectEVM,
  "connect" | "disconnect" | "getProvider" | "switchChain"
>;

function accountFrom(value: unknown): string {
  if (
    !Array.isArray(value) ||
    typeof value[0] !== "string" ||
    !/^0x[0-9a-f]{40}$/i.test(value[0])
  )
    throw new WalletError("disconnected");
  return value[0];
}

// Factory keeps provider behavior testable without an installed extension.
export function createMetaMaskAdapter(
  loadClient: () => Promise<MetaMaskClient> = getClient,
): LabWalletAdapter {
  return {
    kind: "metamask",
    label: "MetaMask",
    async connect() {
      const client = await loadClient();
      const provider: EIP1193Provider = client.getProvider();
      const result = await client.connect({
        chainIds: [walletNetwork.chainId],
      });
      let address = accountFrom(result.accounts);
      let chainId: string | undefined = result.chainId;
      let connected = true;
      let revision = 0;
      const listeners = new Set<(event: WalletSessionEvent) => void>();

      function emit(event: WalletSessionEvent) {
        for (const listener of listeners) listener(event);
      }

      function accountsChanged(accounts: unknown) {
        let next: string;
        try {
          next = accountFrom(accounts);
        } catch {
          disconnected();
          return;
        }
        if (next.toLowerCase() === address.toLowerCase()) return;
        address = next;
        revision++;
        emit("accountsChanged");
      }

      function chainChanged(next: string) {
        if (!/^0x[0-9a-f]+$/i.test(next) || next === chainId) return;
        chainId = next;
        revision++;
        emit("chainChanged");
      }

      function disconnected() {
        connected = false;
        revision++;
        emit("disconnect");
      }

      provider.on("accountsChanged", accountsChanged);
      provider.on("chainChanged", chainChanged);
      provider.on("disconnect", disconnected);

      function dispose() {
        connected = false;
        revision++;
        provider.removeListener("accountsChanged", accountsChanged);
        provider.removeListener("chainChanged", chainChanged);
        provider.removeListener("disconnect", disconnected);
        listeners.clear();
      }

      async function verifyAccount(expected: string, version: number) {
        if (!connected) throw new WalletError("disconnected");
        const accounts = await provider.request({method: "eth_accounts"});
        if (!connected) throw new WalletError("disconnected");
        if (
          revision !== version ||
          accountFrom(accounts).toLowerCase() !== expected.toLowerCase()
        )
          throw new WalletError("wrong-account");
      }

      try {
        await verifyAccount(address, revision);
      } catch (error) {
        dispose();
        throw error;
      }
      const session: LabWalletSession = {
        kind: "metamask",
        walletName: "MetaMask",
        transport: "managed",
        get address() {
          return address;
        },
        get chainId() {
          return chainId;
        },
        async signMessage(message) {
          if (!connected) throw new WalletError("disconnected");
          if (chainId?.toLowerCase() !== walletNetwork.chainId)
            throw new WalletError("network");
          const expected = address;
          const version = revision;
          await verifyAccount(expected, version);
          const hex =
            "0x" +
            Array.from(new TextEncoder().encode(message), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("");
          const signature = await provider.request({
            method: "personal_sign",
            params: [hex, expected],
          });
          await verifyAccount(expected, version);
          if (typeof signature !== "string")
            throw new WalletError("unsupported");
          return signature;
        },
        async signTypedData(request) {
          if (!connected || chainId?.toLowerCase() !== walletNetwork.chainId) throw new WalletError("network");
          const expected = address, version = revision;
          await verifyAccount(expected, version);
          const {domain, types, primaryType, message} = validateTokenAuthorization(request, expected);
          const signature = await provider.request({
            method: "eth_signTypedData_v4",
            params: [expected, JSON.stringify({domain, types, primaryType, message})]
          });
          await verifyAccount(expected, version);
          if (typeof signature !== "string") throw new WalletError("unsupported");
          return signature;
        },
        async disconnect() {
          dispose();
          await client.disconnect();
        },
        async sendTransaction(transaction) {
          const expected = address, version = revision;
          return sendReviewedTransaction(args => provider.request(args), transaction, expected, () => verifyAccount(expected, version));
        },
        async switchNetwork() {
          if (!connected) throw new WalletError("disconnected");
          const chainConfiguration = {
            chainId: walletNetwork.chainId,
            chainName: walletNetwork.name,
            nativeCurrency: {name: "MON", symbol: "MON", decimals: 18},
            rpcUrls: [walletNetwork.rpcUrl],
            blockExplorerUrls: ["https://testnet.monadvision.com"],
          };
          try {
            await client.switchChain({
              chainId: walletNetwork.chainId,
              chainConfiguration,
            });
          } catch (error) {
            const code =
              typeof error === "object" && error !== null
                ? "code" in error
                  ? error.code
                  : "rpcCode" in error
                    ? error.rpcCode
                    : undefined
                : undefined;
            if (Number(code) !== 4902) throw error;
            await provider.request({
              method: "wallet_addEthereumChain",
              params: [chainConfiguration],
            });
            await client.switchChain({chainId: walletNetwork.chainId});
          }
          const selectedChain = await provider.request({
            method: "eth_chainId",
          });
          if (typeof selectedChain === "string") chainChanged(selectedChain);
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        dispose,
      };
      return session;
    },
  };
}

export const metamaskAdapter = createMetaMaskAdapter();
