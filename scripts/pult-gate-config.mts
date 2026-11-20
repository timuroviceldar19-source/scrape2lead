// Собирает конфиг ролей пульта из секрета PULT_ROLES для промежуточного кода Pages.
// Запускается в шаге выкладки. Почты не печатает: лог workflow публичный.
//
//   npx tsx scripts/pult-gate-config.mts exports/pult-gate/config.json

import fs from "node:fs";
import path from "node:path";
import { parseGateConfig } from "../src/bitrix/salesPult/gate/config.js";

const out = process.argv[2] || "exports/pult-gate/config.json";

let config;
try {
  config = parseGateConfig(process.env.PULT_ROLES);
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(config));

if (!config) {
  console.log("[Роли] выключены: PULT_ROLES не задан, все, кого пускает Access, видят полный пульт");
} else {
  const counts: Record<string, number> = {};
  for (const role of Object.values(config.users)) counts[role.kind] = (counts[role.kind] ?? 0) + 1;
  const total = Object.keys(config.users).length;
  const parts = Object.entries(counts).map(([kind, n]) => `${kind}: ${n}`).join(", ");
  console.log(`[Роли] включены, пользователей ${total} (${parts})${config.aud ? "" : "; aud не задан — проверяются подпись и издатель"}`);
}
