import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Server from "../src/Server.ts";

describe("Server.parse", () => {
  it("takes an origin, adding https when no scheme is typed", () => {
    expect(Server.parse(" alias.example ")).toEqual(Option.some("https://alias.example"));
    expect(Server.parse("https://alias.example/aliases?x")).toEqual(
      Option.some("https://alias.example"),
    );
    expect(Server.parse("https://alias.example:8443")).toEqual(
      Option.some("https://alias.example:8443"),
    );
  });

  it("allows plain HTTP to this machine only", () => {
    expect(Server.parse("http://localhost:5173")).toEqual(Option.some("http://localhost:5173"));
    expect(Server.parse("http://127.0.0.1:8787")).toEqual(Option.some("http://127.0.0.1:8787"));
    expect(Server.parse("http://alias.example")).toEqual(Option.none());
  });

  it("refuses what isn't a server", () => {
    const inputs = [
      "",
      "intranet",
      "ftp://alias.example",
      "https://ada:pw@alias.example",
      "javascript:alert(1)",
    ];
    expect(Arr.map(inputs, Server.parse)).toEqual(Arr.map(inputs, () => Option.none()));
  });

  it("names the host permission an origin needs", () => {
    expect(Server.permissionPattern("https://alias.example:8443")).toBe("https://alias.example/*");
    expect(Server.permissionPattern("http://localhost:5173")).toBe("http://localhost/*");
  });
});
