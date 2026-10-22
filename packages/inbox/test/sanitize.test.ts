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
});
