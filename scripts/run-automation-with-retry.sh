#!/usr/bin/env sh
# Обёртка над run-automation.sh для GitHub Actions: если запуск упал из-за сети или
# недоступности портала, ждёт и пробует ещё раз. Падение по любой другой причине
# (ошибка кода, Bitrix, данные) не повторяется — оно должно быть видно сразу.
#
# Портал procurement.gov.kz с IP GitHub иногда отвечает ERR_CONNECTION_TIMED_OUT
# целыми периодами. Повтор целого запуска безопасен: дедупликация в Bitrix идёт
# по UF_CRM_PLAN_ID. Письмо о падении приходит только после последней попытки.
#
# Настройка: RETRY_ATTEMPTS (всего попыток, по умолчанию 3),
# RETRY_PAUSE_SECONDS (пауза между попытками, по умолчанию 600).
set -u

CONFIG="${1:-config/automation.json}"
LOG="${2:-runs/scheduler.log}"
ATTEMPTS="${RETRY_ATTEMPTS:-3}"
PAUSE="${RETRY_PAUSE_SECONDS:-600}"

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
case "$LOG" in
  /*) ;;
  *) LOG="$root/$LOG" ;;
esac
mkdir -p -- "$(dirname -- "$LOG")" || exit 1

NETWORK_PATTERN='net::ERR_|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|page\.goto: Timeout|fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up'

attempt=1
while :; do
  # Смотрим только строки, появившиеся в логе за эту попытку.
  if [ -f "$LOG" ]; then before=$(wc -l < "$LOG"); else before=0; fi

  sh "$root/scripts/run-automation.sh" "$CONFIG" "$LOG"
  code=$?
  [ "$code" -eq 0 ] && exit 0

  if ! tail -n "+$((before + 1))" "$LOG" | grep -Eq "$NETWORK_PATTERN"; then
    exit "$code"
  fi
  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    exit "$code"
  fi

  printf '%s scheduler network failure, retry %s/%s in %ss\n' \
    "$(date -Iseconds)" "$attempt" "$((ATTEMPTS - 1))" "$PAUSE" >>"$LOG"
  sleep "$PAUSE"
  attempt=$((attempt + 1))
done
