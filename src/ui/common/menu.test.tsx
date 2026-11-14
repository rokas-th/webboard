import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../../platform";
import { LINUX, MAC, setPlatform } from "../../test/platform";
import { NewItemMenu } from "./NewItemMenu";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const at = (left: number): void => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(this.getAttribute("aria-haspopup") === "menu" ? left : 0, 0, 75, 44);
  });
};

const opened = (): HTMLElement => {
  render(<NewItemMenu label="+ New" className="button-primary" disabled={false} onPick={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "+ New" }));
  return screen.getByRole("menu");
};

describe("a menu's side", () => {
  it.each<Platform>([MAC, LINUX])("stays trailing-aligned on %o wherever its button sits", (platform) => {
    setPlatform(platform);
    at(100);
    expect(opened().className).toBe("plan-menu-list");
  });
});
