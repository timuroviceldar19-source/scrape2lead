import fs from "node:fs";
import path from "node:path";
import type { ReadOnlyBitrixClient } from "../../reporting/readOnlyClient.js";
import type { StageTransition } from "../metrics.js";
import type { UserProfileInfo } from "../collect.js";
import type { RegisterView } from "./types.js";
import { fetchLatestRegisterFromDisk } from "./diskClient.js";
import { parseRegisterExcel } from "./parseExcel.js";
import { groupRegisterContracts, matchRegisterWithCrm } from "./matchCrm.js";
import { fetchCrmWonDealsForRegister } from "./fetchCrmWon.js";
import { buildRegisterView } from "./buildView.js";

export interface LoadRegisterOptions {
  reader: ReadOnlyBitrixClient;
  diskFolderId?: number;
  managerAliases?: Record<string, string>;
  registerFilePath?: string;
  todayAlmaty: string;
  contractTransitions: StageTransition[];
  userProfiles: Map<string, UserProfileInfo>;
}

export async function loadRegisterView(options: LoadRegisterOptions): Promise<RegisterView> {
  const {
    reader,
    diskFolderId,
    managerAliases,
    registerFilePath,
    todayAlmaty,
    contractTransitions,
    userProfiles
  } = options;

  let excelBuffer: Buffer | null = null;
  let registerFileName = "";
  let asOf = todayAlmaty;

  if (registerFilePath) {
    if (fs.existsSync(registerFilePath)) {
      excelBuffer = fs.readFileSync(registerFilePath);
      registerFileName = path.basename(registerFilePath);
    } else {
      return { error: `Файл не найден: ${registerFilePath}` };
    }
  } else if (diskFolderId) {
    try {
      const diskFile = await fetchLatestRegisterFromDisk(reader, diskFolderId);
      if (diskFile) {
        excelBuffer = diskFile.buffer;
        registerFileName = diskFile.fileName;
      } else {
        return { error: "Реестр не подключён: файл в папке не найден" };
      }
    } catch (diskErr) {
      return {
        error: `Реестр не подключён: ${diskErr instanceof Error ? diskErr.message : String(diskErr)}`
      };
    }
  } else {
    return { error: "Реестр не подключён: папка на Диске не настроена" };
  }

  if (!excelBuffer) {
    return { error: "Реестр не подключён: нет файла Excel" };
  }

  try {
    const parsed = await parseRegisterExcel(excelBuffer, registerFileName, managerAliases);
    asOf = parsed.asOf || todayAlmaty;
    const contracts = groupRegisterContracts(parsed.rows);

    const wonDeals = await fetchCrmWonDealsForRegister(
      reader,
      contractTransitions,
      userProfiles
    );

    const matchResult = matchRegisterWithCrm(contracts, wonDeals, {
      managerAliases
    });

    const view = buildRegisterView({
      rows: parsed.rows,
      plans: parsed.plans,
      missing: matchResult.missing,
      extraDealsCount: matchResult.extra.length,
      fileName: registerFileName,
      asOf,
      month: parsed.month || todayAlmaty.slice(0, 7)
    });

    console.log(
      `[Реестр] строк: ${parsed.rows.length}, договоров: ${contracts.length}, найдено в CRM: ${matchResult.matched.length}, нет в CRM: ${matchResult.missing.length}`
    );

    return view;
  } catch (err) {
    console.error("[Реестр] Ошибка обработки реестра:", err);
    return {
      error: `Реестр не подключён: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}
