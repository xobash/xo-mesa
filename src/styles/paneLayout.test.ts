// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { readStylesheet } from "./source";

// Viewers sit in the flex row `.media-view`. A viewer that does not grow and
// shrink with that row is sized to its content: in the native app the
// spreadsheet's Save button was pushed past the pane edge at half width.
// The whole stylesheet in cascade order, so a later partial cannot override the rule unseen.
const css = readStylesheet();

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

it("lets the workbook view fill the media pane and shrink with it", () => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  document.body.innerHTML = '<div class="media-view"><div class="sheet-view"></div></div>';
  const view = getComputedStyle(document.querySelector(".sheet-view")!);
  expect(view.flexGrow).toBe("1");
  expect(view.flexShrink).toBe("1");
  expect(view.minWidth).toBe("0px");
});

it("stacks the password notice above the Office view in one shrinkable column", () => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  document.body.innerHTML = '<div class="media-view"><div class="office-gate"><div></div><div></div></div></div>';
  const gate = getComputedStyle(document.querySelector(".office-gate")!);
  expect(gate.flexDirection).toBe("column");
  expect(gate.flexGrow).toBe("1");
  expect(gate.minWidth).toBe("0px");
});

// Buttons get only font and cursor globally, and browsers do not pass text
// colour down into buttons; a matching rule must declare it (the recent-vault
// list drew default grey buttons). jsdom inherits colour, so read declarations.
it("gives recent-vault and saved-search buttons the theme text colour", () => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  document.body.innerHTML = '<button class="vault-menu-item"></button><button class="saved-search-run"></button>';
  for (const selector of [".vault-menu-item", ".saved-search-run"]) {
    expect(declared(style, document.querySelector(selector)!, "color"), selector).toBe("var(--text)");
    expect(declared(style, document.querySelector(selector)!, "background-color"), selector).toBe("transparent");
  }
});

// jsdom drops a border shorthand that contains var(), so read the declared
// value of the last matching rule (all of these are single-class selectors).
it("keeps the rule under the help card header", () => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  document.body.innerHTML = '<div class="ov-help-head"></div>';
  const head = document.querySelector(".ov-help-head")!;
  expect(declared(style, head, "border-bottom") || declared(style, head, "border-bottom-style")).toContain("solid");
});

/** Last value a plain (non-pseudo) rule declares for `property` on `element`. */
function declared(style: HTMLStyleElement, element: Element, property: string): string {
  let value = "";
  for (const rule of Array.from(style.sheet!.cssRules)) {
    if (!(rule instanceof CSSStyleRule) || rule.selectorText.includes(":") || !element.matches(rule.selectorText)) continue;
    const own = rule.style.getPropertyValue(property) || (property === "background-color" ? rule.style.getPropertyValue("background") : "");
    if (own) value = own;
  }
  return value;
}
