import type { MarketConfig, MarketView } from "./types.js";
import { loadMarketConfig } from "./config.js";
import { DEFAULT_MARKET_UNITS_PATH, loadStoredMarketData } from "./fetchMarket.js";
import { buildMarketGroupView, buildMarketView } from "./aggregate.js";
import { applyEducationVerdicts, loadEducationVerdicts } from "./educationVerdicts.js";

export interface LoadMarketOptions {
  unitsFilePath?: string;
  todayAlmaty: string;
  cfg?: MarketConfig;
  educationVerdictsFilePath?: string;
}

export function loadMarketView(options: LoadMarketOptions): MarketView {
  const {
    unitsFilePath = DEFAULT_MARKET_UNITS_PATH,
    todayAlmaty,
    cfg = loadMarketConfig()
  } = options;

  // Даже пустой кэш не должен скрывать ошибку обязательного файла решений.
  const verdicts = loadEducationVerdicts(options.educationVerdictsFilePath);

  const { units: storedUnits, updatedAt } = loadStoredMarketData(unitsFilePath);

  if (storedUnits.length === 0) {
    console.log(`[Рынок] Кэш ${unitsFilePath} не найден или пуст`);
    return {
      asOf: todayAlmaty,
      ip: null,
      kt: null,
      educationPending: {},
      months: [],
      error: "Данные рынка ещё собираются."
    };
  }

  const hiddenKinds = new Set(cfg.hiddenKinds ?? []);
  const shown = hiddenKinds.size ? storedUnits.filter((u) => !hiddenKinds.has(u.kind)) : storedUnits;
  const filtered = applyEducationVerdicts(shown, verdicts);
  const view = buildMarketView(filtered.units, todayAlmaty, cfg, undefined, updatedAt, filtered.educationPending);
  // Кэш был прочитан: если отфильтровано всё, показываем нулевой рынок, а не ошибку сбора.
  view.ip ??= buildMarketGroupView("ИП", [], todayAlmaty, cfg);
  view.kt ??= buildMarketGroupView("КТ", [], todayAlmaty, cfg);
  console.log(`[Рынок] Учебные комплекты: исключено договоров: ${filtered.excludedContracts}, на проверке: ${filtered.pendingContracts}`);
  if (hiddenKinds.size) console.log(`[Рынок] Скрыто позиций (${[...hiddenKinds].join(", ")}): ${storedUnits.length - shown.length}`);
  return view;
}
