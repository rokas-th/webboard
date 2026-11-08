import { render } from "@testing-library/react";
import { it, expect } from "vitest";
import App from "./App";

it("the wordmark sits in the window's drag region", () => {
  const { container } = render(<App />);
  const header = container.querySelector("header[data-tauri-drag-region]");
  expect(header).not.toBeNull();
  expect(header?.textContent).toContain("WebBoard");
});
