import type {
  RawCompanyCard,
  RawCardDetail,
  RawContacts,
  Lead
} from "../../types.js";

/**
 * Extract shop cards from Kaspi API payload.
 * Specifically targets data.filters[id="allMerchants"].rows as confirmed by DevTools.
 */
export function extractShopsFromPayload(payload: unknown, category: string, geo: string): RawCompanyCard[] {
  const merchants = findMerchantsInFilters(payload);
  if (!merchants || merchants.length === 0) return [];

  const shopMap = new Map<string, Record<string, unknown>>();

  // Helper to build a clean city slug for URLs
  const citySlug = geo.toLowerCase().trim()
    .replace(/алматы/g, "almaty")
    .replace(/астана|nur-sultan/g, "astana")
    .replace(/актобе/g, "aktobe")
    .replace(/караганда/g, "karaganda")
    .replace(/шымкент/g, "shymkent")
    .replace(/[^a-z0-9-]/g, "") || "almaty";

  for (const merchant of merchants) {
    // Temporarily disabled hide/active filter to test if the new URL format works for these merchants
    // const rawId = String(merchant.id ?? merchant.merchantId ?? "");
    const rawId = String(merchant.id ?? merchant.merchantId ?? "");
    // Clean the ID: remove ":allMerchants:" prefix if present
    const cleanId = rawId.replace(/^:allMerchants:/, "");
    const shopId = cleanId || Math.random().toString(36).substring(7);

    if (!shopMap.has(shopId)) {
      // Use the exact confirmed working URL structure for Kaspi merchant info pages
      const shopUrl = `https://kaspi.kz/shop/info/merchant/${cleanId}/reviews/`;

      const rawName = String(merchant.name ?? merchant.title ?? "Неизвестный магазин");
      // Reject generic Kaspi UI text that sometimes leaks into merchant names
      const cleanName = /выберите ваш город|страница не найдена|not found/i.test(rawName) 
        ? "Неизвестный магазин" 
        : rawName;

      shopMap.set(shopId, {
        id: shopId,
        name: cleanName,
        url: shopUrl,
        rating: merchant.rating ?? merchant.score,
        reviewCount: merchant.reviewCount ?? merchant.reviews,
        productCount: merchant.productCount ?? merchant.itemsCount ?? merchant.count,
        categories: merchant.categories ?? merchant.category,
        whatsapp: merchant.whatsapp,
        telegram: merchant.telegram,
        city: geo,
        category: category
      });
    }
  }

  return Array.from(shopMap.values()).map((shop) => ({
    source: "kaspi" as const,
    externalId: String(shop.id),
    name: String(shop.name),
    category: String(shop.category),
    city: String(shop.city),
    address: "",
    url: normalizeKaspiUrl(String(shop.url)),
    payload: shop
  }));
}

/**
 * Map detailed shop information.
 */
export function mapDetail(card: RawCompanyCard, payload: unknown): RawCardDetail {
  const data = extractDataObject(payload);

  // Aggressively prevent generic Kaspi UI text from becoming the company name
  const rawName = String(data.name ?? card.name ?? "Неизвестный магазин");
  const isGenericName = /выберите ваш город|страница не найдена|not found|ошибка|error|404/i.test(rawName);
  
  // If the extracted name is generic, try to fall back to the original card name, 
  // and if THAT is also generic, default to "Неизвестный магазин"
  let safeName = rawName;
  if (isGenericName) {
    safeName = /выберите ваш город|страница не найдена|not found|ошибка|error|404/i.test(card.name) 
      ? "Неизвестный магазин" 
      : (card.name ?? "Неизвестный магазин");
  }

  // Fallback to the Kaspi shop URL if no external website is provided
  const resolvedWebsite = data.website || data.external_website || card.url || null;

  return {
    ...card,
    name: safeName,
    category: String(data.category ?? card.category),
    city: String(data.city ?? card.city),
    address: String(data.address ?? card.address),
    url: normalizeKaspiUrl(String(data.url ?? card.url)),
    website: resolvedWebsite ? String(resolvedWebsite) : null,
    phones: extractPhones(data),
    email: data.email ? String(data.email) : null,
    socialLinks: extractSocialLinks(data),
    messengerLinks: extractMessengerLinks(data),
    payload
  };
}

/**
 * Map contacts from detail payload.
 */
export function mapContacts(detail: RawCardDetail, payload: unknown): RawContacts {
  const data = extractDataObject(payload);
  
  // Fallback to the detail URL (Kaspi shop link) if no external website is found
  const resolvedWebsite = detail.website || data.website || data.external_website || detail.url || null;

  return {
    externalId: detail.externalId,
    phones: detail.phones ?? extractPhones(data),
    email: detail.email ?? (data.email ? String(data.email) : null),
    website: resolvedWebsite ? String(resolvedWebsite) : null,
    socialLinks: detail.socialLinks ?? extractSocialLinks(data),
    messengerLinks: detail.messengerLinks ?? extractMessengerLinks(data),
    payload
  };
}

/**
 * Normalize to the canonical Lead model with CRM-ready enrichment.
 */
export function toLead(detail: RawCardDetail, contacts: RawContacts, searchCity?: string): Lead {
  const now = new Date().toISOString();
  const data = extractDataObject(detail.payload);

  // 1. Phone normalization and validation
  const rawPhone = (contacts.phones?.[0] || "").trim();
  const normalizedPhone = normalizeKzPhone(rawPhone);
  const phoneStatus = normalizedPhone ? "valid" : (rawPhone ? "invalid" : "empty");

  // 2. Email validation
  const rawEmail = (contacts.email || "").trim();
  const emailStatus = rawEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? "valid" : (rawEmail ? "invalid" : "empty");

  // 3. City conflict detection
  const merchantCityGuess = extractCityFromName(detail.name) || detail.city || "Неизвестно";
  const cityStatus = searchCity && merchantCityGuess !== "Неизвестно" && merchantCityGuess !== searchCity ? "mismatch" : "ok";

  // 4. Website separation (Kaspi profile vs real website)
  const rawWebsite = contacts.website || detail.url || "";
  const isKaspiUrl = rawWebsite.includes("kaspi.kz");
  const kaspiProfileUrl = isKaspiUrl ? rawWebsite : undefined;
  const realWebsite = !isKaspiUrl && rawWebsite ? rawWebsite : undefined;

  // 5. Messenger flags
  const messengerFlags = buildMessengerFlags(detail, data);

  // 6. Parser notes (catch placeholders like "22")
  const parserNotes: string[] = [];
  if (detail.address === "22" || detail.address === "null") parserNotes.push("address_placeholder_22_or_null");
  if (rawEmail === "22") parserNotes.push("email_placeholder_22");

  // 7. Lead scoring and CRM status
  const rating = extractNumber(data, "rating") ?? extractNumber(data, "global") ?? 0;
  const reviewCount = extractNumber(data, "reviewCount") ?? extractNumber(data, "reviews") ?? extractNumber(data, "reviewsCount") ?? extractNumber(data, "numberOfReviews") ?? 0;
  const productCount = extractNumber(data, "productCount") ?? extractNumber(data, "itemsCount") ?? extractNumber(data, "count") ?? 0;

  let leadScore = Math.round(rating * 10);
  if (reviewCount > 1000) leadScore += 20;
  else if (reviewCount > 100) leadScore += 10;
  if (productCount > 5000) leadScore += 10;

  const contactability = phoneStatus === "valid" ? "Phone ready" : "No usable contact";
  let priority: "A" | "B" | "C" | "D" = "D";
  if (contactability === "Phone ready") {
    if (leadScore >= 80) priority = "A";
    else if (leadScore >= 60) priority = "B";
    else priority = "C";
  } else if (cityStatus === "mismatch" || leadScore >= 40) {
    priority = "C";
  }

  const crmStatus = contactability === "Phone ready" ? "Ready to call" : "Needs enrichment";
  let nextAction = "Нет действий";
  if (crmStatus === "Needs enrichment") {
    nextAction = `Найти телефон через 2GIS / Google / Instagram (${detail.name} ${merchantCityGuess})`;
  } else if (cityStatus === "mismatch") {
    nextAction = `Позвонить, подтвердить филиал/город (${merchantCityGuess}), найти сайт/Instagram`;
  } else {
    nextAction = "Позвонить, проверить ЛПР, уточнить сайт/Instagram";
  }

  return {
    source: detail.source,
    external_id: detail.externalId,
    company_name: detail.name,
    category: detail.category ?? "",
    city: detail.city ?? "",
    address: detail.address ?? "",
    phones: contacts.phones ?? [],
    email: contacts.email ? normalizeEmail(contacts.email) : null,
    website: contacts.website ? normalizeUrl(contacts.website) : null, // Keep legacy for now
    social_links: contacts.socialLinks ?? [],
    messenger_links: contacts.messengerLinks ?? [],
    parsed_at: now,
    incomplete: !contacts.phones?.length && !contacts.email && !contacts.website,
    
    // Kaspi-specific fields
    rating,
    review_count: reviewCount,
    product_count: productCount,
    shop_categories: extractCategories(data),

    // CRM-ready fields
    lead_id: `${detail.source.toUpperCase()}-${detail.externalId}`,
    source_search_city: searchCity,
    merchant_city_guess: merchantCityGuess,
    city_status: cityStatus,
    address_raw: detail.address,
    address_clean: detail.address !== "22" && detail.address !== "null" ? detail.address : undefined,
    phone_raw: rawPhone || undefined,
    phone_normalized: normalizedPhone || undefined,
    phone_status: phoneStatus,
    email_raw: rawEmail || undefined,
    email_status: emailStatus,
    kaspi_profile_url: kaspiProfileUrl,
    real_website: realWebsite,
    messenger_flags: messengerFlags,
    lead_score: leadScore,
    priority,
    contactability,
    crm_status: crmStatus,
    next_action: nextAction,
    parser_note: parserNotes.length > 0 ? parserNotes.join("; ") : undefined
  };
}

// --- Helpers ---

function findMerchantsInFilters(payload: unknown): Record<string, unknown>[] | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;

  if (record.data && typeof record.data === "object") {
    const data = record.data as Record<string, unknown>;
    if (Array.isArray(data.filters)) {
      const allMerchantsFilter = data.filters.find((f: unknown) => {
        const filter = f as Record<string, unknown>;
        return filter.id === "allMerchants";
      });

      if (allMerchantsFilter && typeof allMerchantsFilter === "object") {
        const filterObj = allMerchantsFilter as Record<string, unknown>;
        if (Array.isArray(filterObj.rows)) {
          return filterObj.rows as Record<string, unknown>[];
        }
      }
    }
  }
  return null;
}

function extractDataObject(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  if (record.data && typeof record.data === "object") {
    return record.data as Record<string, unknown>;
  }
  return record;
}

function extractPhones(data: Record<string, unknown>): string[] {
  const phones: string[] = [];
  
  if (typeof data.phone === "string" && data.phone) phones.push(data.phone);
  if (Array.isArray(data.phones)) {
    phones.push(...data.phones.filter((p): p is string => typeof p === "string" && p.length > 0));
  }
  
  // Kaspi sometimes hides phones behind a reveal action; if not present, leave empty
  return [...new Set(phones)];
}

function extractSocialLinks(data: Record<string, unknown>): string[] {
  const links: string[] = [];
  if (typeof data.instagram === "string" && data.instagram) links.push(data.instagram);
  if (typeof data.facebook === "string" && data.facebook) links.push(data.facebook);
  return links;
}

function extractMessengerLinks(data: Record<string, unknown>): string[] {
  const links: string[] = [];
  if (typeof data.whatsapp === "string" && data.whatsapp) links.push(data.whatsapp);
  if (typeof data.telegram === "string" && data.telegram) links.push(data.telegram);
  return links;
}

function normalizeKaspiUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  return `https://kaspi.kz${url.startsWith("/") ? "" : "/"}${url}`;
}

function normalizeEmail(email: string | null): string | null {
  if (!email) return null;
  return email.trim().toLowerCase();
}

function normalizeUrl(url: string | null | undefined): string | null {
  if (!url || url === "null" || url === "undefined") return null;
  let normalized = url.trim();
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
    normalized = `https://${normalized}`;
  }
  return normalized;
}

function extractNumber(data: Record<string, unknown>, key: string): number | undefined {
  const val = data[key];
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const parsed = parseFloat(val);
    return isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function extractCategories(data: Record<string, unknown>): string[] | undefined {
  const cats = data.categories ?? data.category ?? data.tags;
  if (Array.isArray(cats)) {
    return cats.filter((c): c is string => typeof c === "string" && c.length > 0);
  }
  if (typeof cats === "string" && cats.length > 0) {
    return [cats];
  }
  return undefined;
}

// --- CRM Enrichment Helpers ---

function normalizeKzPhone(phone: string): string | null {
  if (!phone) return null;
  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, "");
  
  // Check for valid KZ formats: 87XXXXXXXXX or 77XXXXXXXXX (11 digits)
  if (digits.length === 11 && (digits.startsWith("87") || digits.startsWith("77"))) {
    return `+7${digits.substring(1)}`;
  }
  
  // Check for +77XXXXXXXXX (12 digits with +)
  if (phone.startsWith("+7") && digits.length === 11 && digits.startsWith("77")) {
    return `+7${digits.substring(1)}`;
  }
  
  return null; // Invalid or short number (like "2400" or "22")
}

function extractCityFromName(name: string): string | null {
  const cities = ["алматы", "астана", "актобе", "караганда", "шымкент", "павлодар", "актау", "атырау", "уральск", "костанай", "петропавловск", "тараз"];
  const lowerName = name.toLowerCase();
  
  for (const city of cities) {
    if (lowerName.includes(city)) {
      // Capitalize first letter
      return city.charAt(0).toUpperCase() + city.slice(1);
    }
  }
  return null;
}

function buildMessengerFlags(detail: RawCardDetail, data: Record<string, unknown>): string {
  const flags: string[] = [];
  const messengerText = (detail.messengerLinks?.join(" ") || "").toLowerCase();
  const payloadText = JSON.stringify(data).toLowerCase();
  
  if (messengerText.includes("whatsapp") || payloadText.includes("whatsapp")) {
    flags.push("WhatsApp mentioned");
  }
  if (messengerText.includes("telegram") || payloadText.includes("telegram")) {
    flags.push("Telegram mentioned");
  }
  
  if (flags.length === 0) return "None";
  return `${flags.join("; ")}, no direct URL`;
}