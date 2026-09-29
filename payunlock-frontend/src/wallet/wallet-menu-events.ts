export const OPEN_WALLET_MENU_EVENT = "payunlock:open-wallet-menu";

export function requestWalletMenuOpen() {
  window.dispatchEvent(new Event(OPEN_WALLET_MENU_EVENT));
}
