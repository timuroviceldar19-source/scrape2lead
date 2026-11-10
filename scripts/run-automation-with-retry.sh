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
# GZ_PORTAL_HANDOFF=1: первый отказ до старта робота возвращает 76 без паузы.
# GZ_SIMULATE_PORTAL_BLOCK=1: тестовый отказ probe без сети, с явной строкой в логе.
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

NETWORK_PATTERN='net::ERR_|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|page\.goto: Timeout|Timeout [0-9]+ms exceeded|TimeoutError|fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up'

cd -- "$root" || exit 1
# Отдельно от кэша manifests; ключ не позволяет принять состояние прошлого job/повтора.
STATE="$LOG.portal-probe-state"
STATE_KEY="${GITHUB_RUN_ID:-local}:${GITHUB_RUN_ATTEMPT:-1}${GZ_PORTAL_MACHINE:+:$GZ_PORTAL_MACHINE}"
started=0
printf '%s:probing\n' "$STATE_KEY" > "$STATE" || exit 1
attempt=1
while :; do
  if [ "${GZ_SIMULATE_PORTAL_BLOCK:-0}" = "1" ]; then
    printf '%s\n' 'portal probe: unreachable: simulated' >>"$LOG"
    probe_code=75
  else
    npx --no-install tsx "$root/scripts/gz-portal-probe.mts" >>"$LOG" 2>&1
    probe_code=$?
  fi
  if [ "$probe_code" -eq 75 ]; then
    if [ "${GZ_PORTAL_HANDOFF:-0}" = "1" ] && [ "$attempt" -eq 1 ] && [ "$started" -eq 0 ]; then
      printf '%s:handoff\n' "$STATE_KEY" > "$STATE" || exit 1
      printf '%s\n' 'портал недоступен с этой машины GitHub, сбор передан следующей машине' >>"$LOG"
      exit 76
    fi
    code=1
  else
    if [ "$probe_code" -ne 0 ]; then
      printf 'portal probe: inconclusive (probe exit %s)\n' "$probe_code" >>"$LOG"
    fi
    started=1
    printf '%s:started\n' "$STATE_KEY" > "$STATE" || exit 1
    # Проверку не включаем в классификацию ошибки самого прогона.
    before=$(wc -l < "$LOG")
    sh "$root/scripts/run-automation.sh" "$CONFIG" "$LOG"
    code=$?
  fi
  [ "$code" -eq 0 ] && exit 0

  if [ "$probe_code" -ne 75 ] && ! tail -n "+$((before + 1))" "$LOG" | grep -Eq "$NETWORK_PATTERN"; then
    exit "$code"
  fi
  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    if [ "$started" -eq 0 ]; then
      printf '%s:blocked\n' "$STATE_KEY" > "$STATE" || exit 1
      printf '%s\n' 'портал недоступен с этой машины GitHub, прогон не начинался' >>"$LOG"
    fi
    exit "$code"
  fi

  printf '%s scheduler network failure, retry %s/%s in %ss\n' \
    "$(date -Iseconds)" "$attempt" "$((ATTEMPTS - 1))" "$PAUSE" >>"$LOG"
  sleep "$PAUSE"
  attempt=$((attempt + 1))
done
