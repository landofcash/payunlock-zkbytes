import sharp from "sharp";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ApiError } from "../domain.js";

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export type OfferImage = { id: string; url: string; thumbnailUrl: string; width: number; height: number };
export function imageDescriptor(id: string, width: number, height: number): OfferImage {
  return { id, width, height, url: `/v1/media/${id}/image`, thumbnailUrl: `/v1/media/${id}/thumbnail` };
}
export async function processOfferImage(input: Buffer) {
  if (!input.length || input.length > MAX_IMAGE_BYTES) throw new ApiError(400, "IMAGE_MUST_BE_UNDER_15_MB");
  try {
    const source = sharp(input, { limitInputPixels: 40000000, failOn: "warning" });
    const metadata = await source.metadata();
    if (!["jpeg", "png", "webp", "heif"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1 || (metadata.format === "heif" && metadata.compression !== "av1")) throw new Error("format");
    const { data: image, info } = await source.rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
    const thumbnail = await sharp(image).resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    return { image, thumbnail, width: info.width, height: info.height };
  } catch { throw new ApiError(400, "INVALID_IMAGE_USE_JPEG_PNG_WEBP_AVIF_MAX_40_MEGAPIXELS"); }
}
export async function saveOfferImage(db: Pool, owner: string, input: Buffer) {
  const result = await processOfferImage(input), id = randomUUID();
  await db.query("INSERT INTO offer_images(id,owner,width,height,image,thumbnail) VALUES($1,$2,$3,$4,$5,$6)", [id, owner, result.width, result.height, result.image, result.thumbnail]);
  return imageDescriptor(id, result.width, result.height);
}
