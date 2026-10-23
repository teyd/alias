import { describe, expect, it } from "@effect/vitest";
import { CONTENT_SECURITY_POLICY, manifest } from "../src/Manifest.ts";

const options = { version: "1.2.3", hostOrigins: ["https://alias.example"] };

describe("manifest", () => {
  it("runs the background as Chromium's service worker or Firefox's event page", () => {
    const chromium = manifest({ ...options, target: "chromium" });
    const firefox = manifest({ ...options, target: "firefox" });
    expect(chromium.background).toEqual({ service_worker: "background.js", type: "module" });
    expect(firefox.background).toEqual({ scripts: ["background.js"], type: "module" });
    expect(chromium).not.toHaveProperty("browser_specific_settings");
    expect(firefox).toMatchObject({
      browser_specific_settings: {
        gecko: {
          id: expect.stringMatching(/^\{[0-9a-f-]{36}\}$/),
          data_collection_permissions: { required: ["authenticationInfo", "browsingActivity"] },
        },
      },
    });
  });

  it("asks for no host and no content script beyond the server", () => {
    const built = manifest({ ...options, target: "chromium" });
    expect(built.manifest_version).toBe(3);
    expect(built.permissions).toEqual([
      "activeTab",
      "contextMenus",
      "identity",
      "scripting",
      "storage",
    ]);
    expect(built.host_permissions).toEqual(["https://alias.example/*"]);
    expect(built).not.toHaveProperty("content_scripts");
    expect(built).not.toHaveProperty("externally_connectable");
    expect(built).not.toHaveProperty("web_accessible_resources");
    expect(manifest({ ...options, hostOrigins: [], target: "firefox" }).host_permissions).toEqual(
      [],
    );
  });

  it("lets extension pages run only their own scripts", () => {
    expect(manifest({ ...options, target: "firefox" }).content_security_policy).toEqual({
      extension_pages: CONTENT_SECURITY_POLICY,
    });
    expect(CONTENT_SECURITY_POLICY.split("; ")).toEqual(
      expect.arrayContaining(["script-src 'self'", "object-src 'none'", "base-uri 'none'"]),
    );
  });
});
