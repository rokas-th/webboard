import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { version } from "../../../package.json";
import { About } from "./About";

afterEach(cleanup);

const markAbove = (root: HTMLElement): void => {
  const mark = root.querySelector("img.about-mark");
  if (mark === null) throw new Error("About renders no img.about-mark");
  expect(mark.getAttribute("src")).toBe("/logo-mark.svg");
  expect(mark.getAttribute("alt")).toBe("");
  expect(mark.getAttribute("width")).toBe("48");
  expect(mark.getAttribute("height")).toBe("48");
  const name = [...root.querySelectorAll("p")].find((p) => p.textContent === `WebBoard ${version}`);
  if (name === undefined) throw new Error("About renders no app name line");
  expect(mark.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
};

describe("About", () => {
  it("shows the mark above the app name in the desktop dialog", () => {
    const { getByRole } = render(<About onClose={() => {}} />);
    markAbove(getByRole("dialog"));
  });

  it("shows the mark above the app name in the phone sheet", () => {
    const { getByRole } = render(<About frame="sheet" onClose={() => {}} />);
    markAbove(getByRole("dialog"));
  });
});
