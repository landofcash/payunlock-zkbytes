import {keccak256, toUtf8Bytes} from "ethers";
import {parseStrictJson} from "@zkbytes/sdk";

// Our protocol uses only JSON values, safe integers, and decimal strings for uint256.
// Object keys sort by UTF-16 code units; strings are never normalized.
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("Unsupported canonical value");
}

export const commitment = (domain: string, value: unknown) => keccak256(toUtf8Bytes(`${domain}\n${canonical(value)}`));
export const strictJson = (text: string): unknown => parseStrictJson(text);
export const utf8 = (text: string) => new TextEncoder().encode(text);
