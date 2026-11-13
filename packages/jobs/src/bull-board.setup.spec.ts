import { describe, expect, it } from "vitest";

import { Secret } from "@base/common";
import { testCase } from "@base/testing";

import { boardAccess } from "./bull-board.setup.js";

const basic = (user: string, password: string): string =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

describe("boardAccess", () => {
  const token = Secret.of("board-token");

  it("admits the token as a bearer or as the Basic password", async () => {
    await testCase("NB-1202", "Bull Board: the admin token guards every request");
    expect(boardAccess("Bearer board-token", token)).toBe(true);
    expect(boardAccess(basic("admin", "board-token"), token)).toBe(true);
    expect(boardAccess(basic("", "board-token"), token)).toBe(true);
  });

  it("rejects everything else", async () => {
    await testCase("NB-1202", "Bull Board: the admin token guards every request");
    for (const header of [
      undefined,
      "",
      "Bearer ",
      "Bearer wrong",
      "bearer board-token",
      basic("board-token", "wrong"),
      basic("admin", ""),
      "Basic !!!",
      `Basic ${Buffer.from("no-colon").toString("base64")}`,
      "board-token",
    ]) {
      expect(boardAccess(header, token)).toBe(false);
    }
  });

  it("admits everyone when no token is configured", async () => {
    await testCase("NB-1203", "Bull Board: no token means no guard (local default)");
    expect(boardAccess(undefined, Secret.unset)).toBe(true);
    expect(boardAccess("Bearer anything", Secret.of(""))).toBe(true);
  });
});
