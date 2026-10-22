import { describe, expect, it } from "@effect/vitest";
import { sanitize } from "../src/Sanitize.ts";

describe("sanitize", () => {
  it("removes everything that runs, submits or frames", () => {
    const { html } = sanitize(
      '<p onclick="steal()">Hi<script>alert(1)</script></p><iframe src="https://x.example"></iframe>' +
        '<form action="https://x.example"><input name="pw"></form><a href="javascript:alert(1)">x</a>' +
        '<svg onload="alert(1)"></svg><object data="x"></object><meta http-equiv="refresh" content="0">',
    );
    expect(html).toBe('<p>Hi</p><a target="_blank" rel="noopener noreferrer nofollow">x</a>');
  });

  it("blocks remote images and counts them; keeps inline ones", () => {
    const result = sanitize(
      '<img src="https://track.example/p.gif" width="1"><img src="http://cdn.example/hero.jpg" alt="Hero">' +
        '<img src="data:image/png;base64,iVBORw0KGgo=" alt="logo"><img src="cid:logo@x" alt="cid">' +
        '<img srcset="https://cdn.example/a.jpg 2x">',
    );
    expect(result.blockedImageCount).toBe(2);
    expect(result.html).not.toContain("example/");
    expect(result.html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(result.html).toContain('src="cid:logo@x"');
  });

  it("keeps formatting but no style that loads anything", () => {
    const { html } = sanitize(
      "<style>body{background:url(https://x.example/a)}</style>" +
        '<table width="600" bgcolor="#fff"><tr><td style="color:red;background-image:url(https://x.example/b);padding:4px" background="https://x.example/c">A</td></tr></table>',
    );
    expect(html).not.toContain("x.example");
    expect(html).toContain('width="600"');
    expect(html).toContain("color:red");
    expect(html).toContain("padding:4px");
  });

  it("opens links in a new tab without referrer, http(s)/mailto/tel only", () => {
    const { html } = sanitize(
      '<a href="https://app.example/verify?t=1&amp;u=2">Verify</a><a href="mailto:a@b.example">m</a><a href="ftp://x.example">f</a>',
    );
    expect(html).toContain(
      '<a href="https://app.example/verify?t=1&amp;u=2" target="_blank" rel="noopener noreferrer nofollow">Verify</a>',
    );
    expect(html).toContain('href="mailto:a@b.example"');
    expect(html).not.toContain("ftp:");
  });

  // SR-18 (PLAN.md §20.25): the old filter matched text, so escapes and other loading functions
  // got past it. Each of these would make a browser fetch from x.example.
  it.each([
    ["an escaped url()", "background:u\\72l(https://x.example/a)"],
    ["an escaped function name with a space", "background-image:\\75 rl(https://x.example/a)"],
    ["an entity-encoded url()", "background:u&#114;l(https://x.example/a)"],
    ["an uppercase URL()", "background:URL(https://x.example/a)"],
    ["image-set()", 'background-image:image-set("https://x.example/a" 1x)'],
    ["-webkit-image-set()", "background-image:-webkit-image-set(url(//x.example/a) 1x)"],
    ["image()", 'background-image:image("https://x.example/a")'],
    ["cross-fade()", "background:cross-fade(url(https://x.example/a), red 50%)"],
    ["a url() behind a comment", "background:url/**/(https://x.example/a)"],
    ["an escaped property name", "b\\61ckground-image:url(https://x.example/a)"],
    ["a custom property", "--x:url(https://x.example/a);background:var(--x)"],
    ["list-style-image", "list-style-image:url(https://x.example/a)"],
    ["a border image", "border-image:url(https://x.example/a) 30"],
    ["content", 'content:url("https://x.example/a")'],
    ["@import", "@import 'https://x.example/a.css'"],
    ["expression()", "width:expression(fetch('https://x.example/a'))"],
    ["a closing brace", "color:red}*{background:url(https://x.example/a)"],
  ])("drops %s from inline styles", (_, style) => {
    const { html } = sanitize(`<p style="${style.replaceAll('"', "&quot;")}">Hi</p>`);
    expect(html).not.toContain("x.example");
    expect(html).toContain("Hi");
  });

  it("keeps ordinary formatting, colors included", () => {
    const { html } = sanitize(
      '<td style="color:rgb(0 0 0 / 50%);background-color:#fafafa;font-family:&quot;Helvetica Neue&quot;, Arial;font-size:14px;border:1px solid #ccc;padding:4px 8px !important">A</td>',
    );
    expect(html).toContain("color:rgb(0 0 0 / 50%)");
    expect(html).toContain("background-color:#fafafa");
    expect(html).toContain("font-family:&quot;Helvetica Neue&quot;, Arial");
    expect(html).toContain("border:1px solid #ccc");
    expect(html).toContain("padding:4px 8px !important");
  });

  it("drops layout that can cover the reader's screen", () => {
    const { html } = sanitize(
      '<div style="position:fixed;top:0;left:0;z-index:9999;color:red">Pay here</div>',
    );
    expect(html).toBe('<div style="color:red">Pay here</div>');
  });
});
