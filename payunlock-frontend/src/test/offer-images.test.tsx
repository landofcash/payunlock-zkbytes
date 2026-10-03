import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
vi.mock("@/commerce/client", async importOriginal => ({ ...await importOriginal<typeof import("@/commerce/client")>(), useCommerce: () => ({ request: vi.fn() }) }));
import { OfferGallery, OfferImageEditor, validateOfferImages } from "@/commerce/OfferImages";
import { MediaOriginContext, type OfferImage } from "@/commerce/client";
const images: OfferImage[] = ["one", "two", "three"].map(id => ({ id, url: `/v1/media/${id}/image`, thumbnailUrl: `/v1/media/${id}/thumbnail`, width: 100, height: 100 }));
it("renders restricted placeholder URLs without enlargement controls", () => {
  render(<MediaOriginContext.Provider value="https://api.example.test"><OfferGallery images={[{ ...images[0]!, url: "/v1/media/restricted", thumbnailUrl: "/v1/media/restricted" }]} title="Restricted offer" /></MediaOriginContext.Provider>);
  expect(screen.getByRole("img", { name: "Restricted offer" })).toHaveAttribute("src", "https://api.example.test/v1/media/restricted");
  expect(screen.queryByRole("button", { name: "Enlarge offer image" })).not.toBeInTheDocument();
});
it("accepts 15 MB images and rejects larger files, unsupported types and excess count", () => {
  const file = new File([new Uint8Array(15 * 1024 * 1024)], "cover.png", { type: "image/png" });
  expect(() => validateOfferImages([file], 7)).not.toThrow();
  expect(() => validateOfferImages([file], 8)).toThrow("8 images");
  expect(() => validateOfferImages([new File([file, "x"], "large.png", { type: "image/png" })], 0)).toThrow("15 MB");
  expect(() => validateOfferImages([new File(["x"], "bad.svg", { type: "image/svg+xml" })], 0)).toThrow("JPEG");
});
it("supports choosing a cover, reordering and removing images", () => {
  function Fixture() { const [value, setValue] = useState(images); return <><OfferImageEditor images={value} onChange={setValue} onBusy={() => {}} /><output>{value.map(i => i.id).join(",")}</output></>; }
  render(<Fixture />);
  fireEvent.click(screen.getByRole("button", { name: "Make image 3 main" })); expect(screen.getByRole("status")).toHaveTextContent("three,one,two");
  fireEvent.click(screen.getByRole("button", { name: "Move image 1 later" })); expect(screen.getByRole("status")).toHaveTextContent("one,three,two");
  fireEvent.click(screen.getByRole("button", { name: "Remove image 2" })); expect(screen.getByRole("status")).toHaveTextContent("one,two");
});
it("keeps selected images local until the draft is saved", () => {
  function Fixture() { const [files, setFiles] = useState<File[]>([]); return <><OfferImageEditor images={[]} onChange={() => {}} onBusy={() => {}} stagedFiles={files} onStagedFilesChange={setFiles} /><output>{files.map(file => file.name).join(",")}</output></>; }
  render(<Fixture />);
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File(["cover"], "cover.png", { type: "image/png" })] } });
  expect(screen.getByRole("status")).toHaveTextContent("cover.png");
  expect(screen.getByText(/Selected images upload when you review the draft/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Remove image 1" }));
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});
it("switches thumbnails, enlarges, navigates by keyboard and handles broken images", () => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  render(<MediaOriginContext.Provider value="https://api.example.test"><OfferGallery images={images} title="Example" /></MediaOriginContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Show image 2" }));
  expect(screen.getByRole("button", { name: "Show image 2" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Enlarge offer image" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
  expect(screen.getByRole("button", { name: "Show image 3" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  const image = screen.getByRole("img", { name: "Example" });
  expect(image).toHaveAttribute("src", "https://api.example.test/v1/media/three/image");
  fireEvent.error(image); expect(screen.getByText("Image unavailable")).toBeVisible();
});
