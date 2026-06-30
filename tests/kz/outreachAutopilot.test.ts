import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { KzStorage } from "../../src/kz/kzStorage.js";
import {
  computeOutreachDiff,
  diffToOutreachItems,
  finishOutreachRun,
  getLastCompletedRun,
  parseAmount,
  parseFlexibleDate,
  registerOutreachItems,
  startOutreachRun
} from "../../src/kz/outreachDigest.js";
import {
  buildFirstTouchMessage,
  buildFollowUpMessage,
  buildWaLink,
  formatTengeShort,
  normalizeKzPhone
} from "../../src/kz/outreachMessages.js";

const STAT_INSERT = `
  INSERT INTO stat_gov_data (bin, name, registration_date, oked, oked_name, address, director, legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code, sector_name, updated_at, raw_snapshot_path)
  VALUES (?, ?, '2015-01-01', '41200', 'Строительство', 'Астана', ?, 'active', NULL, NULL, NULL, 'ТОО', NULL, NULL, '2026-06-01', NULL)
`;

const REGISTRY_INSERT = `
  INSERT INTO goszakup_registry_data (bin, participant_id, name_ru, phone, email, director_name, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, '2026-06-01')
`;

const TENDER_INSERT = `
  INSERT INTO tender_data (source, bin, tender_number, tender_name, customer_name, budget_amount, currency, start_date, end_date, status, method, url, parsed_at)
  VALUES (?, ?, ?, ?, ?, ?, 'KZT', ?, NULL, ?, 'auction', ?, ?)
`;

function setupDb(): { db: Database.Database; storage: KzStorage } {
  const db = new Database(":memory:");
  const storage = new KzStorage({ db });
  return { db, storage };
}

function insertWinnerFixture(db: Database.Database): void {
  db.prepare(STAT_INSERT).run("061040006408", 'ТОО "ALAU"', "Иванов И.И.");
  db.prepare(REGISTRY_INSERT).run("061040006408", "p-1", 'ТОО "ALAU"', "+7 (777) 123-45-67", "alau@mail.kz", "Иванов И.И.");
  db.prepare(TENDER_INSERT).run(
    "goszakup.gov.kz", "061040006408", "CT-100",
    "Договор CT-100 (закупка A-1)", "ГУ Заказчик", "60000000",
    "2026-06-05", "Действует",
    "https://goszakup.gov.kz/ru/registry/contract/1", "2026-06-08T10:00:00.000Z"
  );
}

describe("computeOutreachDiff", () => {
  it("находит нового победителя с контактами и не показывает его повторно", () => {
    const { db, storage } = setupDb();
    try {
      insertWinnerFixture(db);

      const diff = computeOutreachDiff(db, { bins: ["061040006408"] });
      expect(diff.winners).toHaveLength(1);
      const winner = diff.winners[0];
      expect(winner.bin).toBe("061040006408");
      expect(winner.company_name).toBe('ТОО "ALAU"');
      expect(winner.contract_number).toBe("CT-100");
      expect(winner.customer_name).toBe("ГУ Заказчик");
      expect(winner.amount).toBe(60_000_000);
      expect(winner.phone).toBe("+7 (777) 123-45-67");
      expect(winner.email).toBe("alau@mail.kz");

      const runId = startOutreachRun(db);
      const registered = registerOutreachItems(db, runId, diffToOutreachItems(diff));
      expect(registered).toBeGreaterThan(0);
      finishOutreachRun(db, runId, { winners: 1 });

      const second = computeOutreachDiff(db, { bins: ["061040006408"] });
      expect(second.winners).toHaveLength(0);

      expect(getLastCompletedRun(db)?.id).toBe(runId);
    } finally {
      storage.close();
      db.close();
    }
  });

  it("включает A-компанию с новыми активными закупками в проспекты", () => {
    const { db, storage } = setupDb();
    try {
      insertWinnerFixture(db);

      const diff = computeOutreachDiff(db, { bins: ["061040006408"] });
      expect(diff.prospects).toHaveLength(1);
      const prospect = diff.prospects[0];
      expect(prospect.card.bin).toBe("061040006408");
      expect(prospect.card.lead_priority).toBe("A");
      expect(prospect.new_active_tenders).toHaveLength(1);
      expect(prospect.new_active_tenders[0].tender_number).toBe("CT-100");

      const runId = startOutreachRun(db);
      registerOutreachItems(db, runId, diffToOutreachItems(diff));
      finishOutreachRun(db, runId, {});

      expect(computeOutreachDiff(db, { bins: ["061040006408"] }).prospects).toHaveLength(0);
    } finally {
      storage.close();
      db.close();
    }
  });

  it("не считает победителем announce-записи и неактивные контракты", () => {
    const { db, storage } = setupDb();
    try {
      db.prepare(STAT_INSERT).run("990940012345", 'ТОО "BUILD"', "Петров П.П.");
      // announce (customer-side) — не победа
      db.prepare(TENDER_INSERT).run(
        "goszakup.gov.kz", "990940012345", "A-200",
        "Закуп строительных материалов", "ГУ Заказчик", "10000000",
        "2026-06-01", "Опубликовано", null, "2026-06-08T10:00:00.000Z"
      );
      // zakup-источник — игнорируется
      db.prepare(TENDER_INSERT).run(
        "zakup.sk.kz", "990940012345", "Z-1",
        "Договор Z-1", "Заказчик", "5000000",
        "2026-06-01", "Действует", null, "2026-06-08T10:00:00.000Z"
      );

      const diff = computeOutreachDiff(db, { bins: ["990940012345"] });
      expect(diff.winners).toHaveLength(0);
    } finally {
      storage.close();
      db.close();
    }
  });

  it("--since отсекает старые контракты по дате", () => {
    const { db, storage } = setupDb();
    try {
      db.prepare(STAT_INSERT).run("061040006408", 'ТОО "ALAU"', "Иванов И.И.");
      db.prepare(TENDER_INSERT).run(
        "goszakup.gov.kz", "061040006408", "CT-OLD",
        "Договор CT-OLD", "Заказчик", "60000000",
        "01.03.2026", "Действует", null, "2026-06-08T10:00:00.000Z"
      );
      db.prepare(TENDER_INSERT).run(
        "goszakup.gov.kz", "061040006408", "CT-NEW",
        "Договор CT-NEW", "Заказчик", "70000000",
        "05.06.2026", "Действует", null, "2026-06-08T10:00:00.000Z"
      );

      const diff = computeOutreachDiff(db, { bins: ["061040006408"], since: "2026-06-01" });
      expect(diff.winners.map((w) => w.contract_number)).toEqual(["CT-NEW"]);
    } finally {
      storage.close();
      db.close();
    }
  });
});

describe("outreachMessages", () => {
  const stats = {
    companyCount: 30,
    totalActiveBudget: 44_200_000_000,
    withPhoneCount: 26,
    topContractBudget: 39_000_000_000
  };

  it("подставляет цифры в первое касание", () => {
    const message = buildFirstTouchMessage(stats);
    expect(message).toContain("список 30 строительных компаний");
    expect(message).toContain("44,2 млрд ₸");
    expect(message).toContain("26 из 30");
  });

  it("подставляет топ-контракт в фоллоу-ап", () => {
    expect(buildFollowUpMessage(stats)).toContain("39 млрд ₸");
  });

  it("formatTengeShort масштабирует суммы", () => {
    expect(formatTengeShort(44_200_000_000)).toBe("44,2 млрд ₸");
    expect(formatTengeShort(150_000_000)).toBe("150 млн ₸");
    expect(formatTengeShort(900_000)).toBe("900 тыс ₸");
    expect(formatTengeShort(500)).toBe("500 ₸");
  });

  it("normalizeKzPhone приводит к 7XXXXXXXXXX", () => {
    expect(normalizeKzPhone("+7 (777) 123-45-67")).toBe("77771234567");
    expect(normalizeKzPhone("8 707 123 45 67")).toBe("77071234567");
    expect(normalizeKzPhone("7071234567")).toBe("77071234567");
    expect(normalizeKzPhone("+7 777 123 45 67; +7 701 000 00 00")).toBe("77771234567");
    expect(normalizeKzPhone("12345")).toBeNull();
    expect(normalizeKzPhone(null)).toBeNull();
  });

  it("buildWaLink энкодит текст", () => {
    const link = buildWaLink("+7 (777) 123-45-67", "Привет! Цена — 50 000 ₸ & скидка?");
    expect(link).toMatch(/^https:\/\/wa\.me\/77771234567\?text=/);
    expect(link).not.toContain(" ");
    expect(link).toContain(encodeURIComponent("50 000 ₸ & скидка?"));
    expect(buildWaLink("нет телефона", "текст")).toBeNull();
  });
});

describe("парсеры", () => {
  it("parseAmount понимает пробелы и запятые", () => {
    expect(parseAmount("60 000 000")).toBe(60_000_000);
    expect(parseAmount("1 234 567,89")).toBeCloseTo(1_234_567.89);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount("н/д")).toBeNull();
  });

  it("parseFlexibleDate понимает ISO и dd.mm.yyyy", () => {
    expect(parseFlexibleDate("2026-06-05")?.toISOString()).toBe("2026-06-05T00:00:00.000Z");
    expect(parseFlexibleDate("05.06.2026")?.toISOString()).toBe("2026-06-05T00:00:00.000Z");
    expect(parseFlexibleDate("не дата")).toBeNull();
  });
});
