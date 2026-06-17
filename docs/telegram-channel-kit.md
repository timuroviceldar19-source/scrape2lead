# Telegram-канал AI Leads KZ — kit запуска

Freemium-воронка: дайджест в канале (без телефонов) + **демо Excel 50–100 строк с маскировкой** подписчикам в личку + платные нишевые выгрузки. Полная модель: [freemium-tiers.md](./freemium-tiers.md).

---

## 1. Создать канал (вручную, 10 минут)

1. Telegram → **Новый канал**
2. **Название:** `AI Leads KZ · Госзакупки B2B`
3. **Username (публичная ссылка):** `t.me/ai_leads_kz` (или свободный вариант, например `ai_leads_goszakup`)
4. **Тип:** публичный канал

### Добавить бота админом

1. Создайте бота через [@BotFather](https://t.me/BotFather) (если ещё нет) — токен в `.env` как `TELEGRAM_BOT_TOKEN`
2. Канал → **Администраторы** → добавить бота
3. Права: **Публикация сообщений** (обязательно)

### `.env`

```env
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_private_chat_id
TELEGRAM_CHANNEL_ID=@ai_leads_kz
# или числовой id: -1001234567890

# Опционально
TELEGRAM_CHANNEL_DIGEST_ROWS=10
TELEGRAM_CHANNEL_NICHE_LABEL=Строительство
TELEGRAM_CHANNEL_CTA_URL=https://t.me/ai_leads_kz
```

`TELEGRAM_CHAT_ID` — личные уведомления оператору (файлы Excel).  
`TELEGRAM_CHANNEL_ID` — публичный дайджест для подписчиков.

---

## 2. Описание канала

```
Победители госзакупок Казахстана 🇰🇿
Каждый понедельник — свежий дайджест: компания, сумма, предмет контракта.
Телефоны и полный Excel — в личку / платные пакеты.

📎 Демо Excel для подписчиков (~50 строк, маскировка): @TheMainGame12
WhatsApp для заказа: +77009781336
Kaspi-селлеры — отдельный продукт, пишите в личку.

Instagram: https://www.instagram.com/ai.leads.kz/
Threads: https://www.threads.com/@ai.leads.kz
```

---

## 3. Закреплённый пост (первый пост + pin)

```
Добро пожаловать в AI Leads KZ 👋

Что здесь:
• Еженедельный дайджест победителей тендеров goszakup.gov.kz
• Компания + сумма контракта + предмет закупки + ссылка на источник
• Без спама — 1 пост в неделю

Что НЕ в открытой ленте канала:
• Полные телефоны и email (в демо — маскировка, в личку после подписки)
• Полный Excel под вашу нишу
• Подбор по ключевым словам (ПСД, освещение, стройка…)
• Kaspi-селлеры по категории

📎 Демо Excel для подписчиков (~50 строк, маскировка) — напишите @TheMainGame12
WhatsApp для заказа:
https://wa.me/77009781336?text=Привет!%20Интересуют%20лиды%20goszakup

Telegram личка: @TheMainGame12
```

**Закрепить:** долгий тап на пост → Закрепить.

---

## Профили (актуальные ссылки)

| Площадка | URL |
|----------|-----|
| **Telegram-канал** | https://t.me/ai_leads_kz |
| **Instagram** | https://www.instagram.com/ai.leads.kz/ |
| **Threads** | https://www.threads.com/@ai.leads.kz |
| **WhatsApp** | https://wa.me/77009781336 |
| **Telegram личка** | @TheMainGame12 |

---

## 4. Bio Instagram / Threads

**Instagram bio:**
```
B2B-лиды из goszakup 🇰🇿 + Kaspi-селлеры
Свежие лиды → Telegram ↓
Демо Excel для подписчиков
```

**Ссылка в профиле IG:** https://t.me/ai_leads_kz (основная — канал)

**Threads bio:**
```
Дайджест победителей тендеров → t.me/ai_leads_kz
Instagram: instagram.com/ai.leads.kz
```

---

## 5. Первый пост в канале (ручной, до autopilot)

Используйте пример из [telegram-digest-template.md](./telegram-digest-template.md) — ниша «ПСД / освещение», **без телефонов**.

---

## 6. Автопостинг (понедельник)

```powershell
cd C:\Users\Madara\Desktop\Scrapper
npm run kz:autopilot -- --max-pages 5 --channel-niche "Строительство"
```

Публикует:
- в **личный чат** (`TELEGRAM_CHAT_ID`) — полные Excel + сводка
- в **канал** (`TELEGRAM_CHANNEL_ID`) — публичный дайджест без телефонов

Флаги:
- `--skip-channel` — только личные уведомления
- `--channel-niche "ПСД / освещение"` — подпись ниши в заголовке поста

Ручной пост без enrich:
```powershell
npm run kz:channel-digest
```

### Демо-файл для подписчиков (не в ленту!)

```powershell
npm run kz:freemium-demo
npm run kz:freemium-demo -- --rows 100
npm run kz:freemium-demo -- --mini
```

Файлы: `exports/freemium-demo-YYYY-MM-DD.xlsx` (50 строк) или `freemium-mini-*` (15 строк за репост/комментарий).  
Выдавать в личку после проверки подписки — **не прикреплять к посту в канале**.

---

## 7. Метрики (30 дней)

| Метрика | Цель |
|---------|------|
| Подписчики канала | 200+ |
| Платных пакетов | 2+ |
| Запросов в личку/нед | 5+ |

---

## 8. Риски

- **Не публикуйте телефоны в канале** — убьёт платные продажи
- **Бот без прав админа** — пост не уйдёт, смотрите лог autopilot
- **Жёсткий гейт «подпишись на 3 соцсети»** — не используйте для B2B; канал — основной бесплатный слой

См. также: [dm-scripts-freemium.md](./dm-scripts-freemium.md), [freemium-tiers.md](./freemium-tiers.md)
