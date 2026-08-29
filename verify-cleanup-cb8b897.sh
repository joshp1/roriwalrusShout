#!/bin/sh
set -eu

root=/home/roriwalr/forum-staging
stage="$root/.stage-cb8b897"
archive=/home/roriwalr/rw-cpanel-cb8b897.tar.gz
checksum_file="$archive.sha256"
expected_payload_files=8

test -d "$stage"
test "$(find "$stage" -type f ! -name SHA256SUMS | wc -l)" -eq "$expected_payload_files"
(cd "$stage" && sha256sum --check SHA256SUMS >/dev/null)
(cd "$root" && sha256sum --check "$stage/SHA256SUMS" >/dev/null)
temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT
curl --fail --silent --show-error --max-time 10 \
  -H 'Accept-Encoding: identity' \
  https://test.roriwalrus.net/web-runtime-version.json \
  -o "$temporary_directory/web-runtime-version.json"
cmp "$temporary_directory/web-runtime-version.json" "$stage/web/web-runtime-version.json"
readiness=$(curl --fail --silent --show-error --max-time 10 \
  https://test.roriwalrus.net/api/readiness)
test "$readiness" = '{"service":"forum-api","status":"ready"}'
test ! -e "$root/recovery-required"
restart_before_cleanup=$(stat -c %y "$root/tmp/restart.txt")
rm -rf "$stage"
rm -f "$archive" "$checksum_file" \
  /home/roriwalr/stage-cb8b897.sh \
  /home/roriwalr/deploy-cb8b897.sh \
  /home/roriwalr/verify-cleanup-cb8b897.sh
restart_after_cleanup=$(stat -c %y "$root/tmp/restart.txt")
test "$restart_before_cleanup" = "$restart_after_cleanup"
readiness_after_cleanup=$(curl --fail --silent --show-error --max-time 10 \
  https://test.roriwalrus.net/api/readiness)
test "$readiness_after_cleanup" = '{"service":"forum-api","status":"ready"}'
printf 'verified_active_payload_hashes=%s\n' "$expected_payload_files"
printf 'served_runtime_version=byte-identical\n'
printf 'cleanup_restart_touches=0\n'
printf 'readiness_after_cleanup=%s\n' "$readiness_after_cleanup"