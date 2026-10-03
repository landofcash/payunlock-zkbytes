import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { offerPresentation, restrictedImage } from "../src/services/offer-presentation.js";
import { CatalogRepository } from "../src/repositories/catalog-repository.js";

it("masks restricted metadata without mutating originals or transaction identifiers", () => {
  const original = { id: "offer", title: "Original", description: "Original text", revision: 4, restricted: true, images: [{ ...restrictedImage, url: "/original", thumbnailUrl: "/thumbnail" }] };
  expect(offerPresentation(original)).toEqual({ ...original, title: "Restricted offer", description: "This offer's content is hidden by the platform administrator.", images: [restrictedImage] });
  expect(original.title).toBe("Original"); expect(original.images[0]!.url).toBe("/original");
  expect(offerPresentation({ ...original, restricted: false }).title).toBe("Original");
});
it("applies the current restriction to recorded purchase revisions and public order summaries", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ id: "offer", title: "Old title", description: "Old description", images: [], revision: 1, restricted: true }] });
  const repository = new CatalogRepository({ query } as unknown as Pool);
  expect(await repository.offer("1")).toMatchObject({ status: "recorded", title: "Restricted offer", revision: 1, images: [restrictedImage] });
  expect(await repository.publicOffer("seller", "key")).toMatchObject({ id: "offer", title: "Restricted offer", images: [restrictedImage] });
});
