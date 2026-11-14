import type { ReadOnlyBitrixClient } from "../reporting/readOnlyClient.js";

/** `inactive` (если передан) получает ID сотрудников, которых Битрикс отметил неактивными (`active: false`). */
export async function enrichManagerNames(
  reader: ReadOnlyBitrixClient, ids: Iterable<string>, names: Map<string, string>, inactive?: Set<string>
): Promise<void> {
  for (const id of new Set(ids)) {
    if (!id || names.has(id)) continue;
    // Запасное имя также запоминаем, чтобы не повторять неудачный запрос.
    names.set(id, `сотрудник ID ${id}`);
    try {
      const user = await reader.call("im.user.get", { ID: Number(id) }) as {
        name?: string; first_name?: string; last_name?: string; active?: boolean;
      } | null;
      if (user?.active === false) inactive?.add(id);
      const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
      const name = text(user?.name) || [text(user?.first_name), text(user?.last_name)].filter(Boolean).join(" ");
      if (name) names.set(id, name);
      else console.warn(`[Пульт] Не удалось загрузить имя сотрудника ID ${id} через im.user.get`);
    } catch {
      console.warn(`[Пульт] Не удалось загрузить имя сотрудника ID ${id} через im.user.get`);
    }
  }
}
