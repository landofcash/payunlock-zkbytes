import { HDNodeWallet, Wallet, getAddress } from "ethers";
import { z } from "zod";
import { encryptWithPassword, decryptWithPassword, type PasswordEnvelope } from "@/crypto/password-envelope";
import { strictJson } from "@/crypto/encoding";
import type { LocalStore } from "@/storage/local-store";

export const DERIVATION_PATH = "m/44'/60'/0'/0/0";
const SecretSchema = z.strictObject({ privateKey: z.string().regex(/^0x[\da-f]{64}$/i), mnemonic: z.string().nullable(), path: z.literal(DERIVATION_PATH) });
export type VaultSecret = z.infer<typeof SecretSchema>;
export type VaultRecord = { version: 1; address: string; envelope: PasswordEnvelope };
const binding = (address: string) => ({ domain: "payunlock-wallet-v1", address: getAddress(address).toLowerCase(), path: DERIVATION_PATH });
export class WalletVault {
  constructor(private readonly store: LocalStore) {}
  async create(password: string) {
    const wallet = HDNodeWallet.createRandom(undefined, DERIVATION_PATH);
    return this.save({ privateKey: wallet.privateKey, mnemonic: wallet.mnemonic!.phrase, path: DERIVATION_PATH }, password);
  }
  async import(input: string, password: string) {
    const wallet = /^0x[\da-f]{64}$/i.test(input.trim()) ? new Wallet(input.trim()) : HDNodeWallet.fromPhrase(input.trim().replace(/\s+/g, " "), undefined, DERIVATION_PATH);
    return this.save({ privateKey: wallet.privateKey, mnemonic: wallet instanceof HDNodeWallet ? wallet.mnemonic!.phrase : null, path: DERIVATION_PATH }, password);
  }
  private async save(secret: VaultSecret, password: string) {
    const address = new Wallet(secret.privateKey).address;
    if (await this.store.get(`wallet:${address}`)) throw new Error("Wallet already exists; unlock it instead.");
    const record: VaultRecord = { version: 1, address, envelope: await encryptWithPassword(JSON.stringify(secret), password, binding(address)) };
    await this.store.compareAndSwap(`wallet:${address}`, undefined, record);
    // One selected wallet, while retaining other imported records.
    await this.store.put("wallet:selected", address);
    return address;
  }
  async selected(): Promise<string | null> {
    const value = await this.store.get("wallet:selected");
    return typeof value === "string" ? getAddress(value) : null;
  }
  async export(address: string, password: string): Promise<VaultSecret> {
    const value = await this.store.get(`wallet:${getAddress(address)}`);
    const record = z.strictObject({ version: z.literal(1), address: z.string(), envelope: z.unknown() }).parse(value);
    if (record.address !== getAddress(address)) throw new Error("Wallet record mismatch.");
    const secret = SecretSchema.parse(strictJson(await decryptWithPassword(record.envelope, password, binding(address))));
    if (new Wallet(secret.privateKey).address !== record.address) throw new Error("Wallet key mismatch.");
    if (secret.mnemonic && HDNodeWallet.fromPhrase(secret.mnemonic, undefined, DERIVATION_PATH).privateKey !== secret.privateKey) throw new Error("Wallet recovery phrase mismatch.");
    return secret;
  }
}
