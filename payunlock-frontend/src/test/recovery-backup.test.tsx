import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RecoveryBackup } from "@/wallet/RecoveryBackup";

it("starts blurred without rendering secrets, toggles visibility, and preserves the bottom hide action", () => {
  const backup = "Recovery phrase: test-only recovery fixture", hide = vi.fn();
  const view = render(<RecoveryBackup backup={backup} onHide={hide} />);
  expect(view.container.textContent).not.toContain(backup);
  expect(screen.getByRole("alert")).toHaveTextContent("take your funds");
  fireEvent.click(screen.getByRole("button", { name: "Show recovery material" }));
  expect(screen.getByText(backup)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Blur recovery material" }));
  expect(view.container.textContent).not.toContain(backup);
  fireEvent.click(screen.getByRole("button", { name: "Hide recovery material" }));
  expect(hide).toHaveBeenCalledOnce();
  view.unmount();
  render(<RecoveryBackup backup={backup} onHide={hide} />);
  expect(screen.queryByText(backup)).not.toBeInTheDocument();
});
