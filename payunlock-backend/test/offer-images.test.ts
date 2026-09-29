import sharp from "sharp";
import { expect, it } from "vitest";
import { MAX_IMAGE_BYTES, processOfferImage } from "../src/services/offer-images.js";

it("decodes, optimizes and strips metadata while producing a small thumbnail", async () => {
  const input = await sharp({ create: { width: 2600, height: 1300, channels: 3, background: "red" } }).jpeg().withMetadata().toBuffer();
  const result = await processOfferImage(input);
  expect(result.width).toBe(2400); expect(result.height).toBe(1200);
  const full = await sharp(result.image).metadata(), thumb = await sharp(result.thumbnail).metadata();
  expect(full.format).toBe("webp"); expect(full.exif).toBeUndefined(); expect(thumb.width).toBe(480);
});
it("rejects oversized, empty, malformed and unsupported image data", async () => {
  for (const data of [Buffer.alloc(MAX_IMAGE_BYTES + 1), Buffer.alloc(0), Buffer.from("not an image"), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')]) {
    await expect(processOfferImage(data)).rejects.toMatchObject({ statusCode: 400 });
  }
});
