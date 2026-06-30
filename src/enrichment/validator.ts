export function validatePhone(phone: string | undefined | null): { raw: string; normalized: string | null; status: "valid" | "invalid" | "empty" } {
  if (!phone || phone.trim() === "") return { raw: "", normalized: null, status: "empty" };
  const raw = phone.trim();
  const digits = raw.replace(/\D/g, "");

  if (digits.length === 11 && (digits.startsWith("87") || digits.startsWith("77"))) {
    return { raw, normalized: `+7${digits.substring(1)}`, status: "valid" };
  }
  if (raw.startsWith("+7") && digits.length === 11 && digits.startsWith("77")) {
    return { raw, normalized: `+7${digits.substring(1)}`, status: "valid" };
  }

  return { raw, normalized: null, status: "invalid" };
}

export function validateAddress(address: string | undefined | null): { status: "valid" | "invalid" | "empty"; clean: string | null } {
  if (!address || address.trim() === "") return { status: "empty", clean: null };
  const clean = address.trim();

  // Отсекаем чисто цифровой мусор (22, 36, 2400 и т.д.)
  if (/^\d{1,4}$/.test(clean)) return { status: "invalid", clean: null };
  // Если длина меньше 6 символов — слишком коротко для нормального адреса
  if (clean.length < 6) return { status: "invalid", clean: null };
  // Если нет букв — это не адрес
  if (!/[а-яёa-z]/i.test(clean)) return { status: "invalid", clean: null };

  return { status: "valid", clean };
}

export function validateWebsite(url: string | undefined | null): { status: "valid" | "invalid" | "empty"; clean: string | null } {
  if (!url || url.trim() === "") return { status: "empty", clean: null };
  const clean = url.trim().toLowerCase();

  // Kaspi-ссылки идут только в kaspi_profile_url, в real_website они запрещены
  if (clean.includes("kaspi.kz") || clean.includes("kaspi.com")) {
    return { status: "invalid", clean: null };
  }

  try {
    const normalized = clean.startsWith("http") ? clean : `https://${clean}`;
    new URL(normalized);
    return { status: "valid", clean: normalized };
  } catch {
    return { status: "invalid", clean: null };
  }
}
