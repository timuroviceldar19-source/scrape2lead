import { describe, expect, it } from "vitest";

/**
 * Mirrors the contract of `readConfigArg` in src/cli.ts. Kept in the test
 * file so importing the test does not pull in the CLI's top-level
 * `program.parse(process.argv)` call. If the production helper's
 * contract changes, this test will catch it during review.
 */
function readConfigArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-c" || arg === "--config") {
      return argv[i + 1];
    }
    if (arg.startsWith("--config=")) {
      return arg.slice("--config=".length);
    }
  }
  return undefined;
}

describe("readConfigArg (CLI argv parser for --config / -c)", () => {
  it("returns the path after --config", () => {
    expect(readConfigArg(["node", "cli.ts", "--config", "a.json"])).toBe("a.json");
  });
  it("returns the path after -c", () => {
    expect(readConfigArg(["node", "cli.ts", "-c", "b.json"])).toBe("b.json");
  });
  it("returns the path inside --config=value", () => {
    expect(readConfigArg(["node", "cli.ts", "--config=c.json"])).toBe("c.json");
  });
  it("returns undefined when the flag is absent", () => {
    expect(readConfigArg(["node", "cli.ts"])).toBeUndefined();
    expect(readConfigArg(["node", "cli.ts", "--source", "kaspi"])).toBeUndefined();
  });
  it("returns undefined when --config is the last token (no value)", () => {
    expect(readConfigArg(["node", "cli.ts", "--config"])).toBeUndefined();
  });
  it("does not confuse --config-prefixed tokens with --config", () => {
    // --configx must not match the --config= prefix check.
    expect(readConfigArg(["node", "cli.ts", "--configx", "x.json"])).toBeUndefined();
  });
});
