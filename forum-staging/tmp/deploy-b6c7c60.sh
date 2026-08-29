#!/bin/sh
set -eu

root=/home/roriwalr/forum-staging
stage="$root/.stage-b6c7c60"
expected_payload_files=177
expected_active_files=177
deployment_started=0
phase=preflight

record_failure() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$deployment_started" -eq 1 ]; then
    printf '%s\n' "$phase" > "$root/recovery-required"
    chmod 600 "$root/recovery-required"
  fi
  exit "$status"
}
trap record_failure EXIT

test -d "$stage"
test -f "$stage/SHA256SUMS"
test -f "$stage/ACTIVE_SHA256SUMS"
test -f "$root/tmp/restart.txt"
test "$(stat -c %a "$root/tmp/restart.txt")" = 600
test ! -e "$root/recovery-required"
test -z "$(find "$root" -maxdepth 1 -type d -name '.stage-*' ! -path "$stage" -print -quit)"
test -z "$(find "$stage" -type l -print -quit)"
test "$(wc -l < "$stage/SHA256SUMS")" -eq "$expected_payload_files"
test "$(wc -l < "$stage/ACTIVE_SHA256SUMS")" -eq "$expected_active_files"
(cd "$stage" && sha256sum --check SHA256SUMS >/dev/null)
(cd "$root" && sha256sum --check "$stage/ACTIVE_SHA256SUMS" >/dev/null)
test "$(cat "$root/web/deployment-status.json")" = '{"inProgress":false}'

status_file="$root/web/deployment-status.json"
status_temp="$root/web/.deployment-status-b6c7c60.tmp"
printf '%s\n' '{"inProgress":true}' > "$status_temp"
chmod 644 "$status_temp"
mv "$status_temp" "$status_file"
deployment_started=1
phase=activation

while read -r checksum source; do
  relative_path=${source#./}
  if [ "$relative_path" = 'web/deployment-status.json' ]; then
    continue
  fi
  destination="$root/$relative_path"
  mkdir -p "$(dirname "$destination")"
  cp "$stage/$relative_path" "$destination"
done < "$stage/SHA256SUMS"

while read -r checksum source; do
  relative_path=${source#./}
  if [ "$relative_path" != 'web/deployment-status.json' ]; then
    printf '%s  %s\n' "$checksum" "$source"
  fi
done < "$stage/SHA256SUMS" | (cd "$root" && sha256sum --check --strict - >/dev/null)

phase=restart
restart_before=$(stat -c %y "$root/tmp/restart.txt")
touch "$root/tmp/restart.txt"
restart_after=$(stat -c %y "$root/tmp/restart.txt")
test "$restart_before" != "$restart_after"
readiness=$(curl --fail --silent --show-error --retry 20 --retry-all-errors \
  --retry-delay 1 --retry-max-time 45 --max-time 5 \
  https://test.roriwalrus.net/api/readiness)
test "$readiness" = '{"service":"forum-api","status":"ready"}'
test ! -e "$root/recovery-required"

phase=finalize
cp "$stage/web/deployment-status.json" "$status_temp"
chmod 644 "$status_temp"
test "$(sha256sum "$status_temp" | cut -d ' ' -f 1)" = 398390c8ed5bfd580891b6cdbfe1a3945f727b5bb8e1d5551eccb03f4bde18c9
mv "$status_temp" "$status_file"
(cd "$root" && sha256sum --check "$stage/SHA256SUMS" >/dev/null)
deployment_started=0
phase=complete

printf 'database_backup=not_applicable_no_schema_change\n'
printf 'active_hashes=%s\n' "$expected_payload_files"
printf 'passenger_restart_touches=1\n'
printf 'restart_before=%s\n' "$restart_before"
printf 'restart_after=%s\n' "$restart_after"
printf 'readiness=%s\n' "$readiness"