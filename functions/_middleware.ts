// Промежуточный код Cloudflare Pages: каждый запрос к пульту проходит проверку входа.
// Логика и тесты — в src/bitrix/salesPult/gate. Конфиг ролей собирает шаг выкладки
// (scripts/pult-gate-config.mts) из секрета PULT_ROLES; в репозитории его нет.

import { handleGateRequest, type GateAssets } from "../src/bitrix/salesPult/gate/handler.js";
import type { PultGateConfig } from "../src/bitrix/salesPult/gate/config.js";
import config from "../exports/pult-gate/config.json";

interface Env {
  ASSETS: GateAssets;
}

export const onRequest = (context: { request: Request; env: Env }): Promise<Response> =>
  handleGateRequest(context.request, { config: config as PultGateConfig | null, assets: context.env.ASSETS });
