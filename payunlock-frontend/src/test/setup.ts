import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
afterEach(cleanup);
// jsdom does not measure layout; observer-driven visuals are checked in Chromium.
vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});
vi.stubGlobal("IntersectionObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});
// jsdom has no native Popover API; browser interaction is checked in Chromium.
if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.showPopover) {
  HTMLElement.prototype.showPopover = function () { this.hidden = false; this.dispatchEvent(Object.assign(new Event("toggle"), { newState: "open" })); };
  HTMLElement.prototype.hidePopover = function () { this.hidden = true; this.dispatchEvent(Object.assign(new Event("toggle"), { newState: "closed" })); };
}
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
}
