import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar } from "./Avatar";

afterEach(() => {
  cleanup();
});

const shown = (el: Element | null): [string, string | null, string | null, string | null] => {
  if (!(el instanceof HTMLElement)) throw new Error("no avatar");
  return [el.className, el.textContent, el.style.getPropertyValue("--person") || null, el.getAttribute("aria-hidden")];
};

describe("Avatar", () => {
  it("shows a live person's initials on their slot colour", () => {
    const { container } = render(<Avatar assignee={{ kind: "live", person: { id: "mira", name: "Mira Okafor", initials: "MO", colour: "violet", order: "a0" } }} />);
    expect(shown(container.firstElementChild)).toEqual(["avatar", "MO", "var(--s-violet)", "true"]);
  });

  it("shows a former person's initials, dashed, with no slot colour", () => {
    const { container } = render(<Avatar assignee={{ kind: "former", id: "dana", name: "Dana Lee", initials: "DL", colour: "sky" }} />);
    expect(shown(container.firstElementChild)).toEqual(["avatar former", "DL", null, "true"]);
  });

  it("shows ? for a former person whose initials are unknown", () => {
    const { container } = render(<Avatar assignee={{ kind: "former", id: "gone", name: null, initials: null, colour: null }} />);
    expect(shown(container.firstElementChild)).toEqual(["avatar former", "?", null, "true"]);
  });
});
