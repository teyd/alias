import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Site from "../src/Site.ts";

describe("Site.fromUrl", () => {
  it("names an alias after the registrable domain", () => {
    expect(Site.fromUrl("https://shop.example.co.uk/signup?x=1")).toEqual(
      Option.some({ domain: "example.co.uk", localPart: "example" }),
    );
    expect(Site.fromUrl("https://www.GitHub.com/join")).toEqual(
      Option.some({ domain: "github.com", localPart: "github" }),
    );
    expect(Site.fromUrl("http://news.ycombinator.com:8080/")).toEqual(
      Option.some({ domain: "ycombinator.com", localPart: "ycombinator" }),
    );
  });

  it("keeps sites under private suffixes apart", () => {
    expect(Site.fromUrl("https://ada.github.io/")).toEqual(
      Option.some({ domain: "ada.github.io", localPart: "ada" }),
    );
  });

  it("keeps internationalized domains in their ASCII form", () => {
    expect(Site.fromUrl("https://bücher.de/")).toEqual(
      Option.some({ domain: "xn--bcher-kva.de", localPart: "xn--bcher-kva" }),
    );
  });

  it("names nothing for pages that aren't a site", () => {
    const inputs = [
      "chrome://extensions",
      "about:blank",
      "file:///tmp/form.html",
      "http://127.0.0.1:3000/",
      "http://[::1]/",
      "http://localhost:5173/",
      "https://co.uk/",
      "not a url",
    ];
    expect(Arr.map(inputs, Site.fromUrl)).toEqual(Arr.map(inputs, () => Option.none()));
  });
});
