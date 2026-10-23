import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Browser from "./Browser.ts";

/**
 * Puts `address` into the page's focused field: the one right-clicked, or the one the cursor was
 * in when the toolbar button was clicked. Without a focused text field, the first empty email
 * field. Sets the value through the element's own setter and fires `input` and `change`, so
 * frameworks that track their inputs (React, Vue) see it typed. Answers whether it filled one.
 *
 * It runs inside the page (`scripting.executeScript` serializes the function's source), so it
 * must not use anything from outside its own body. It reads nothing from the page and returns
 * only a boolean.
 */
/* oxlint-disable effect/prefer-option-over-null -- runs in the page, where `effect` isn't loaded */
const fillField = (address: string): boolean => {
  const TEXT_TYPES = ["", "email", "text"];
  /** The focused element, looking into open shadow roots. */
  const focused = (root: Document | ShadowRoot): Element | null => {
    const active = root.activeElement;
    return active?.shadowRoot ? (focused(active.shadowRoot) ?? active) : active;
  };
  const isFillable = (element: Element | null): element is HTMLInputElement | HTMLTextAreaElement =>
    (element instanceof HTMLInputElement &&
      TEXT_TYPES.includes(element.type) &&
      !element.disabled &&
      !element.readOnly) ||
    (element instanceof HTMLTextAreaElement && !element.disabled && !element.readOnly);
  const fallback = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input[type="email"], input[autocomplete~="email"]',
    ),
  ).find((input) => isFillable(input) && input.value === "");
  const current = focused(document);
  const target = isFillable(current) ? current : fallback;
  if (target === undefined) return false;
  const prototype =
    target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  target.focus();
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(target, address);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
};
/* oxlint-enable effect/prefer-option-over-null */

/** Fills `address` into a frame of the tab (the top one when `frameId` is none). */
export const fill = Effect.fn("Fill.fill")(function* (
  tabId: number,
  frameId: Option.Option<number>,
  address: string,
) {
  const result = yield* Browser.execute(tabId, frameId, fillField, address);
  return Schema.is(Schema.Boolean)(result) && result;
});
