import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { version } from "../../../package.json";
import { AboutText, HOLIDAY_ATTRIBUTION } from "./About";

afterEach(cleanup);

describe("AboutText", () => {
  it("shows the mark above the app name, then the holiday attribution", () => {
    const { container } = render(<AboutText />);
    const mark = container.querySelector("img.about-mark");
    if (mark === null) throw new Error("About renders no img.about-mark");
    expect(mark.getAttribute("src")).toBe("/logo-mark.svg");
    expect(mark.getAttribute("alt")).toBe("");
    expect(mark.getAttribute("width")).toBe("48");
    expect(mark.getAttribute("height")).toBe("48");
    const lines = [...container.querySelectorAll("p")].map((p) => p.textContent);
    expect(lines).toEqual([`WebBoard ${version}`, HOLIDAY_ATTRIBUTION]);
    const name = container.querySelector("p");
    if (name === null) throw new Error("About renders no app name line");
    expect(mark.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
