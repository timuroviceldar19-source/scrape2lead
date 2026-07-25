import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KgdProgressStore } from "../../src/kz/kgdProgress.js";

describe("atomic KGD progress", () => {
  it("persists completed stages and never stores browser secrets", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kgd-progress-")), "progress.json");
    const store = new KgdProgressStore(file);
    store.saveStage("000240001420", "counterparty", { name: "A", cookie: "secret", captchaToken: "secret" });
    const reloaded = new KgdProgressStore(file);
    expect(reloaded.getStage("000240001420", "counterparty")).toEqual({ name: "A" });
    expect(fs.readFileSync(file, "utf8")).not.toContain("secret");
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });
});
