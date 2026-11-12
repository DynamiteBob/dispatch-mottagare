#!/bin/bash
# ============================================================================
# Uppdaterar Dispatch-mottagaren till den senaste taggen v* (utan taggar: main) och går tillbaka om den nya versionen
# inte startar. Körs som root: av kommandot Uppdatera i Dispatch (via systemd-run, så att skriptet överlever att tjänsten
# startas om) eller med sudo dispatch-mottagare uppdatera.
# Resultatet skrivs i /var/lib/dispatch-mottagare/uppdatering.json: { at, ok, from, to, message }. Programmet skickar det
# till Dispatch som svar på kommandot.
# En ny version godkänns när tjänsten är igång och har skrivit /run/dispatch-mottagare/ok med den nya versionen (efter 15 s).
# ============================================================================
set -u

DIR=${MOTTAGARE_DIR:-/opt/dispatch-mottagare}
STATE=${MOTTAGARE_STATE_DIR:-/var/lib/dispatch-mottagare}
OKFILE=${MOTTAGARE_RUN_DIR:-/run/dispatch-mottagare}/ok
UNIT_DIR=${MOTTAGARE_UNIT_DIR:-/etc/systemd/system}
RESULT="$STATE/uppdatering.json"
SERVICE=dispatch-mottagare
WAIT_S=${MOTTAGARE_UPDATE_WAIT_S:-90}

ver() { node -p "require('$DIR/package.json').version" 2>/dev/null || echo "?"; }
now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
result() {   # ok från till meddelande
    local msg
    msg=$(printf '%s' "$4" | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '{"at":"%s","ok":%s,"from":"%s","to":"%s","message":"%s"}\n' "$(now)" "$1" "$2" "$3" "$msg" > "$RESULT.tmp"
    chown mottagare:mottagare "$RESULT.tmp" 2>/dev/null || true
    mv "$RESULT.tmp" "$RESULT"
    echo "$4"
}

cd "$DIR" || { result false "?" "?" "Programmappen $DIR saknas."; exit 1; }
PREV=$(git rev-parse HEAD)
FROM=$(ver)
if ! git fetch --quiet --tags --force origin 2>/tmp/dispatch-mottagare-fetch.log; then
    result false "$FROM" "$FROM" "Kunde inte hämta från GitHub: $(tail -1 /tmp/dispatch-mottagare-fetch.log)"
    exit 1
fi
TARGET=$(git tag -l 'v*' --sort=-v:refname | head -1)
[ -n "$TARGET" ] || TARGET=origin/main
NEW=$(git rev-parse "$TARGET^{commit}")
if [ "$NEW" = "$PREV" ]; then
    result true "$FROM" "$FROM" "Redan senaste versionen ($FROM)."
    exit 0
fi
git -c advice.detachedHead=false checkout --quiet --force "$TARGET" || { result false "$FROM" "$FROM" "Kunde inte byta till $TARGET."; exit 1; }
TO=$(ver)
# Systemfiler som följer med programmet
install -m 0644 "$DIR/systemd/dispatch-mottagare.service" "$UNIT_DIR/dispatch-mottagare.service" && systemctl daemon-reload
chmod 755 "$DIR/bin/uppdatera.sh" "$DIR/bin/dispatch-mottagare"
rm -f "$OKFILE"
systemctl restart "$SERVICE"
for i in $(seq 1 $WAIT_S); do
    sleep 1
    if systemctl is-active --quiet "$SERVICE" && [ -f "$OKFILE" ] && grep -qx "$TO" "$OKFILE"; then
        result true "$FROM" "$TO" "Uppdaterad från $FROM till $TO."
        exit 0
    fi
done
# Startade inte: tillbaka till förra versionen
git -c advice.detachedHead=false checkout --quiet --force "$PREV"
install -m 0644 "$DIR/systemd/dispatch-mottagare.service" "$UNIT_DIR/dispatch-mottagare.service" && systemctl daemon-reload
rm -f "$OKFILE"
systemctl restart "$SERVICE"
result false "$FROM" "$FROM" "Version $TO startade inte inom $WAIT_S s. Mottagaren gick tillbaka till $FROM."
exit 1
