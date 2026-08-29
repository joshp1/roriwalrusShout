#!/bin/sh
set -eu

root=/home/roriwalr/forum-staging
archive=/home/roriwalr/rw-cpanel-abb0f6c.tar.gz
checksum_file="$archive.sha256"
stage="$root/.stage-abb0f6c"
expected_payload_files=175
expected_database_hash=924c3d636eadd8c28bf44f15d39ec0fef8dd1ad3c1c24d7c8ae02ce6bd27a628
expected_predecessor_database_hash=d32a97c13a52292d4f97d91c8cf9061078149bea7ca4e11e87cd4e96ea672cfa

test -f "$archive"
test -f "$checksum_file"
test ! -e "$stage"
(cd /home/roriwalr && sha256sum --check "$(basename "$checksum_file")" >/dev/null)
if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo unsafe_archive_path >&2
  exit 1
fi
if tar -tvzf "$archive" | awk 'substr($1,1,1) != "-" && substr($1,1,1) != "d" { found=1 } END { exit !found }'; then
  echo unsafe_archive_type >&2
  exit 1
fi

mkdir -m 700 "$stage"
tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$stage"
test -f "$stage/SHA256SUMS"
test -f "$stage/PREDECESSOR-SHA256SUMS"
test -z "$(find "$stage" -type l -print -quit)"
test -z "$(find "$stage" -mindepth 1 ! -type d ! -type f -print -quit)"
test "$(wc -l < "$stage/SHA256SUMS")" -eq "$expected_payload_files"
test "$(wc -l < "$stage/PREDECESSOR-SHA256SUMS")" -eq "$expected_payload_files"
(cd "$stage" && sha256sum --check SHA256SUMS >/dev/null)
sed 's/^[0-9a-f]\{64\}  //' "$stage/SHA256SUMS" | sort > "$stage/.expected-files"
(cd "$stage" && find . -type f ! -name SHA256SUMS ! -name PREDECESSOR-SHA256SUMS ! -name .expected-files ! -name .actual-files -print | sort > .actual-files)
cmp "$stage/.expected-files" "$stage/.actual-files"
rm "$stage/.expected-files" "$stage/.actual-files"
test "$(sha256sum "$stage/database.js" | cut -d ' ' -f 1)" = "$expected_database_hash"
test "$(sed -n 's/^\([0-9a-f]\{64\}\)  \.\/database\.js$/\1/p' "$stage/PREDECESSOR-SHA256SUMS")" = "$expected_predecessor_database_hash"
grep -v '  \./database.js$' "$stage/PREDECESSOR-SHA256SUMS" \
  | (cd "$stage" && sha256sum --check - >/dev/null)
(cd "$root" && sha256sum --check "$stage/PREDECESSOR-SHA256SUMS" >/dev/null)
test "$(cat "$root/web/deployment-status.json")" = '{"inProgress":false}'
printf 'stage=%s\n' "$stage"
printf 'staged_payload_files=%s\n' "$expected_payload_files"
printf 'active_predecessor_hashes=%s\n' "$expected_payload_files"
printf 'changed_payload=database.js\n'