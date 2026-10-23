import { permissionPattern } from "./Server.ts";

/**
 * The extension's `manifest.json` (Manifest V3), one source for both browsers (PLAN.md §20.35).
 * They differ in two places: Chromium runs the background as a service worker, Firefox as an
 * event page (`background.scripts`; it has no extension service workers), and Firefox wants an
 * add-on ID and its data-collection declaration under `browser_specific_settings`.
 */

export type Target = "chromium" | "firefox";

export interface Options {
  readonly target: Target;
  readonly version: string;
  /**
   * Origins granted at install (`https://alias.example`): the server the build signs in to by
   * default. Any other server is asked for at sign-in, from `optional_host_permissions`.
   */
  readonly hostOrigins: ReadonlyArray<string>;
}

/**
 * The add-on ID AMO signs (a UUID, which claims no domain). It must never change once published:
 * Firefox ties updates, storage and the OAuth redirect URI to it.
 */
const GECKO_ID = "{a029072d-06a7-41c0-8b45-d5e14c0c7e46}";

/**
 * Extension pages run only the bundle's own scripts: no remote code, no `eval`, no plugins, and
 * no `<base>` or form posts to redirect them. Network access is left to host permissions, so a
 * self-hoster's server works without a rebuild.
 */
export const CONTENT_SECURITY_POLICY =
  "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const ICONS = {
  "16": "icons/16.png",
  "32": "icons/32.png",
  "48": "icons/48.png",
  "128": "icons/128.png",
};

/**
 * What each permission is for, and why nothing broader is asked:
 * - `activeTab`: the open tab's address (for "alias for this site") and the right to fill a field
 *   in it, granted only by a click on the toolbar button or the context menu, for that tab alone.
 *   No content script runs on any page by itself.
 * - `scripting`: to run the fill function in that tab once `activeTab` allows it.
 * - `contextMenus`: "Alias → …" on editable fields.
 * - `identity`: `launchWebAuthFlow`, the OAuth sign-in window.
 * - `storage`: the sign-in (see `Session.ts`).
 */
const PERMISSIONS = ["activeTab", "contextMenus", "identity", "scripting", "storage"];

/** Servers a self-hoster may point the extension at, asked for one at a time at sign-in. */
const OPTIONAL_HOSTS = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"];

export const manifest = (options: Options) => ({
  manifest_version: 3,
  name: "Alias",
  description: "Create an email alias right in a sign-up form.",
  version: options.version,
  icons: ICONS,
  action: { default_popup: "popup.html", default_title: "Alias", default_icon: ICONS },
  background:
    options.target === "chromium"
      ? { service_worker: "background.js", type: "module" }
      : { scripts: ["background.js"], type: "module" },
  permissions: PERMISSIONS,
  host_permissions: options.hostOrigins.map(permissionPattern),
  optional_host_permissions: OPTIONAL_HOSTS,
  content_security_policy: { extension_pages: CONTENT_SECURITY_POLICY },
  ...(options.target === "chromium"
    ? { minimum_chrome_version: "121" }
    : {
        browser_specific_settings: {
          gecko: {
            id: GECKO_ID,
            // The first version with built-in data-collection consent.
            strict_min_version: "140.0",
            // Sent to the Alias server the user signs in to, and nowhere else: the sign-in, and
            // the site's domain when they ask for an alias named after it.
            data_collection_permissions: { required: ["authenticationInfo", "browsingActivity"] },
          },
        },
      }),
});
