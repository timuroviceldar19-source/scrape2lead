// Вид товара и диагональ по названию: для позиции склада 1С, лота Радара и пункта плана.
// Группа и вид — те же функции, что у Радара (`classifyProductGroup` / `classifyKind`), здесь только
// отсев принадлежностей («Кронштейн для панели») и диагональ панелей и мониторов.

import { classifyKind, classifyProductGroup } from "../radar/aggregate.js";

export type StockGroup = "ИП" | "КТ";

export interface StockClass {
  group: StockGroup;
  kind: string;
  diagonal: number | null;
}

/** Виды, у которых есть смысл различать диагональ. */
export const DIAGONAL_KINDS: ReadonlySet<string> = new Set(["Интерактивные панели", "Мониторы"]);

const SIZE = "(100|110|55|65|75|85|86|98)";
// Перед числом не буква, не цифра и не дробная часть: «IFP7502», «1,75» не диагональ.
const BEFORE = "(?<![\\p{L}\\d.,])(?<!№\\s?)";
/** Число с маркером дюйма: 75″, 86", 65 дюймов, 98-дюймовая, 110”. */
const MARKED = new RegExp(`${BEFORE}${SIZE}(?:[.,]0)?\\s*(?:["″”“]|''|’’|-?\\s*(?:ти\\s*)?дюйм|inch)`, "giu");
/** Просто число в названии панели — если за ним не штуки, сантиметры, ватты или разрешение. */
const BARE = new RegExp(
  `${BEFORE}${SIZE}(?![\\d\\p{L}]|[.,]\\d|\\s*(?:шт|ед|компл)|\\s*(?:см|мм|м|кг|вт|гц|мс|кд)(?!\\p{L})|\\s*%|\\s*[x×х*]\\s*\\d)`,
  "giu"
);

/**
 * Диагональ панели или монитора: число из списка 55/65/75/85/86/98/100/110 с маркером дюйма, а у панели —
 * и просто числом в названии со словом «панель». Нет числа, другой вид или две разные диагонали — null.
 */
export function stockDiagonal(kind: string, name: string): number | null {
  if (!DIAGONAL_KINDS.has(kind)) return null;
  const text = String(name || "");
  const found = new Set<number>();
  for (const m of text.matchAll(MARKED)) found.add(Number(m[1]));
  if (kind === "Интерактивные панели" && /панел/i.test(text)) {
    for (const m of text.matchAll(BARE)) found.add(Number(m[1]));
  }
  return found.size === 1 ? [...found][0] : null;
}

const PRODUCT_WORD = /панел|доск|мультимедийн|комплект|компьютер|системн|ноутбук|лэптоп|моноблок|монитор|мфу|многофункциональн|принтер/u;
// Принадлежности: название начинается с них («Кронштейн …», «Картридж …», «Пульт ДУ …»).
const ACCESSORY_HEAD = /^\s*(?:кабел|кронштейн|креплен|стойк|подставк|тележк|пульт|стилус|маркер|чехол|сумк|рюкзак|мыш|клавиатур|картридж|тонер|блок\s+питания|адаптер|переходник|зарядн|запчаст|лиценз|программн|камер|динамик|колонк|наушник|гарнитур)/u;
const FOR_WORD = /(?<!\p{L})для(?!\p{L})/u;

/** Группа, вид и диагональ позиции по названию; принадлежности и не ИП/КТ — null. */
export function classifyStockName(name: string): StockClass | null {
  const n = String(name || "").toLowerCase().replace(/ё/g, "е");
  if (ACCESSORY_HEAD.test(n)) return null;
  // «… для интерактивной панели»: товар здесь — то, что стоит до «для».
  const forAt = n.search(FOR_WORD);
  const productAt = n.search(PRODUCT_WORD);
  if (forAt >= 0 && productAt >= 0 && forAt < productAt) return null;
  const group = classifyProductGroup("", name);
  if (!group) return null;
  const kind = classifyKind(group, "", name);
  return { group, kind, diagonal: stockDiagonal(kind, name) };
}

/** Ключ строки склада: «ИП|Интерактивные панели|75», без диагонали — «КТ|Ноутбуки|». */
export function stockKey(group: StockGroup, kind: string, diagonal: number | null): string {
  return `${group}|${kind}|${diagonal ?? ""}`;
}

/** Ключ позиции склада по названию (для строки спроса на «Финансах»); не классифицируется — null. */
export function stockKeyOfName(name: string): string | null {
  const c = classifyStockName(name);
  return c ? stockKey(c.group, c.kind, c.diagonal) : null;
}
