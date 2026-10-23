import { DUMMY_TOKEN, siteKeys } from "./TestKeys.ts";

/**
 * The emulator's `api.js`: the widget's documented JavaScript API (`turnstile.render`, `reset`,
 * `remove`, `getResponse`, `isExpired`, `execute`, `ready`; implicit rendering of `.cf-turnstile`
 * elements unless `?render=explicit`; `?onload=<function>`) for the test site keys only, so
 * browser tests never load Cloudflare's script. What it does was recorded from Cloudflare's own
 * `api.js` in headless Chromium with the same keys (README.md): the passing keys hand the dummy
 * token to `callback` and to a hidden `cf-turnstile-response` input in the container, the
 * blocking keys call `error-callback` with `600010`, invisible keys take no space. An unknown site
 * key gets `400020` (invalid sitekey). Tokens expire after 300 seconds, as Cloudflare's do, and
 * the widget then refreshes itself (`refresh-expired: auto`).
 */
export const script = `(() => {
  "use strict";
  const DUMMY_TOKEN = "${DUMMY_TOKEN}";
  const PASSES = { "${siteKeys.passes}": true, "${siteKeys.passesInvisible}": false };
  const BLOCKS = { "${siteKeys.blocks}": true, "${siteKeys.blocksInvisible}": false };
  const INTERACTIVE = "${siteKeys.interactive}";
  const TOKEN_LIFETIME_MS = 300000;
  const widgets = new Map();

  const callback = (fn, ...args) => {
    const target = typeof fn === "string" ? window[fn] : fn;
    if (typeof target === "function") return target(...args);
  };
  const element = (container) =>
    typeof container === "string" ? document.querySelector(container) : container;
  const find = (id) => {
    if (id === undefined) return widgets.values().next().value;
    if (widgets.has(id)) return widgets.get(id);
    for (const widget of widgets.values()) if (widget.container === element(id)) return widget;
    return undefined;
  };
  const randomId = () => "cf-chl-widget-" + Math.random().toString(36).slice(2, 7);

  const settle = (widget, token) => {
    widget.token = token;
    widget.expired = false;
    widget.input.value = token;
    clearTimeout(widget.expiry);
    widget.expiry = setTimeout(() => {
      widget.token = undefined;
      widget.expired = true;
      widget.input.value = "";
      callback(widget.params["expired-callback"], token);
      run(widget);
    }, TOKEN_LIFETIME_MS);
    widget.status.textContent = "Success!";
    callback(widget.params.callback, token);
  };
  const fail = (widget, code) => {
    widget.status.textContent = "Error: " + code;
    callback(widget.params["error-callback"], code);
  };

  const run = (widget) => {
    const key = widget.params.sitekey;
    widget.status.textContent = "Verifying…";
    if (key in PASSES) setTimeout(() => settle(widget, DUMMY_TOKEN), 50);
    else if (key in BLOCKS) setTimeout(() => fail(widget, "600010"), 50);
    else if (key === INTERACTIVE) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.addEventListener("change", () => {
        label.remove();
        settle(widget, DUMMY_TOKEN);
      });
      label.append(box, " Verify you are human");
      widget.status.textContent = "";
      widget.status.append(label);
    } else setTimeout(() => fail(widget, "400020"), 0);
  };

  const render = (container, params = {}) => {
    const host = element(container);
    if (!host) throw new Error("[Cloudflare Turnstile] Unable to find a container.");
    const id = randomId();
    const isVisible = PASSES[params.sitekey] ?? BLOCKS[params.sitekey] ?? true;
    const frame = document.createElement("div");
    frame.style.cssText = isVisible
      ? "width:300px;height:65px;display:flex;align-items:center;padding:0 12px;box-sizing:border-box;border:1px solid #888;font:14px system-ui"
      : "width:0;height:0;overflow:hidden";
    const status = document.createElement("span");
    frame.append(status);
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = params["response-field-name"] ?? "cf-turnstile-response";
    input.id = id + "_response";
    host.append(frame, input);
    const widget = { id, container: host, params, frame, status, input, token: undefined, expired: false };
    widgets.set(id, widget);
    run(widget);
    return id;
  };

  const reset = (id) => {
    const widget = find(id);
    if (!widget) return;
    clearTimeout(widget.expiry);
    widget.token = undefined;
    widget.input.value = "";
    run(widget);
  };
  const remove = (id) => {
    const widget = find(id);
    if (!widget) return;
    clearTimeout(widget.expiry);
    widget.frame.remove();
    widget.input.remove();
    widgets.delete(widget.id);
  };

  window.turnstile = {
    render,
    reset,
    remove,
    getResponse: (id) => find(id)?.token,
    isExpired: (id) => find(id)?.expired ?? false,
    execute: (container, params) => (find(container) ? reset(container) : render(container, params)),
    ready: (fn) => fn(),
  };

  const query = new URL(document.currentScript ? document.currentScript.src : location.href).searchParams;
  const start = () => {
    if (query.get("render") !== "explicit") {
      for (const host of document.querySelectorAll(".cf-turnstile")) {
        const data = host.dataset;
        render(host, {
          sitekey: data.sitekey,
          action: data.action,
          callback: data.callback,
          "error-callback": data.errorCallback,
          "expired-callback": data.expiredCallback,
        });
      }
    }
    if (query.has("onload")) callback(query.get("onload"));
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
`;
