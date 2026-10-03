import type { OfferImage } from "./offer-images.js";

export const restrictedImage: OfferImage = {
  id: "00000000-0000-0000-0000-000000000000",
  url: "/v1/media/restricted", thumbnailUrl: "/v1/media/restricted", width: 640, height: 400,
};
export const restrictedImageSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#e5e7eb"/><path d="M320 120l55 22v52c0 36-23 65-55 80-32-15-55-44-55-80v-52z" fill="none" stroke="#6b7280" stroke-width="6"/><text x="320" y="325" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#4b5563">Restricted offer</text></svg>`;

// Apply current moderation to both current metadata and purchase-time revisions.
export function offerPresentation<T extends { title: string; description: string; images?: OfferImage[]; restricted?: boolean }>(offer: T): T {
  return offer.restricted ? { ...offer, title: "Restricted offer", description: "This offer's content is hidden by the platform administrator.", images: [restrictedImage] } : offer;
}
