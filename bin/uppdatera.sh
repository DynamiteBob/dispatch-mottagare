#!/bin/bash
# ============================================================================
# Uppdaterar Dispatch-mottagaren till den senaste taggen (versionen utan v, till exempel 0.3.1) och går tillbaka om den nya versionen
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
SERVICE=dispatch-mottagare
WAIT_S=${MOTTAGARE_UPDATE_WAIT_S:-90}

USER_NAME=${MOTTAGARE_USER:-mottagare}
SUDOERS=${MOTTAGARE_SUDOERS:-/etc/sudoers.d/dispatch-mottagare}
SBIN=${MOTTAGARE_SBIN:-/usr/local/sbin}

ver() { node -p "require('$DIR/package.json').version" 2>/dev/null || echo "?"; }
now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }

# 0.4.3: mappen $STATE ägs av användaren mottagare. Root skriver aldrig där med namn (en symbolisk länk som programmet lagt
# dit skulle annars följas med roots rättigheter): resultatet skrivs som mottagare.
asuser() {
    if [ "$(id -u)" = 0 ] && id -u "$USER_NAME" >/dev/null 2>&1; then runuser -u "$USER_NAME" -- "$@"; else "$@"; fi
}
result() {   # ok från till meddelande
    local msg
    msg=$(printf '%s' "$4" | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '{"at":"%s","ok":%s,"from":"%s","to":"%s","message":"%s"}\n' "$(now)" "$1" "$2" "$3" "$msg" |
        asuser sh -c 'umask 077; t=$(mktemp "$1/.uppdatering.XXXXXX") && cat > "$t" && mv -fT "$t" "$1/uppdatering.json"' sh "$STATE" ||
        echo "Resultatet kunde inte sparas i $STATE." >&2
    echo "$4"
}

# 0.4.3: sudo-regeln och nmcli-skriptet följer med programmet. Före uppdateringen sparas den gamla regeln, så att den
# kan läggas tillbaka om mottagaren går tillbaka till en version som inte har filen systemd/sudoers.
SUDOERS_BAK=$(mktemp /tmp/dispatch-mottagare-sudoers.XXXXXX) || exit 1
FETCHLOG=$(mktemp /tmp/dispatch-mottagare-fetch.XXXXXX) || exit 1
trap 'rm -f "$SUDOERS_BAK" "$FETCHLOG"' EXIT
[ -f "$SUDOERS" ] && cat "$SUDOERS" > "$SUDOERS_BAK"
install_system_files() {
    install -m 0644 "$DIR/systemd/dispatch-mottagare.service" "$UNIT_DIR/dispatch-mottagare.service" && systemctl daemon-reload
    chmod 755 "$DIR/bin/uppdatera.sh" "$DIR/bin/dispatch-mottagare"
    if [ -f "$DIR/bin/systemfiler.sh" ]; then
        MOTTAGARE_DIR="$DIR" MOTTAGARE_USER="$USER_NAME" MOTTAGARE_SUDOERS="$SUDOERS" MOTTAGARE_SBIN="$SBIN" bash "$DIR/bin/systemfiler.sh"
    elif [ -s "$SUDOERS_BAK" ]; then
        install -m 0440 "$SUDOERS_BAK" "$SUDOERS"
    fi
}

cd "$DIR" || { result false "?" "?" "Programmappen $DIR saknas."; exit 1; }
PREV=$(git rev-parse HEAD)
FROM=$(ver)
if ! git fetch --quiet --tags --force origin 2>"$FETCHLOG"; then
    result false "$FROM" "$FROM" "Kunde inte hämta från GitHub: $(tail -1 "$FETCHLOG")"
    exit 1
fi
# 0.3.1: bara taggar som heter som en version (x.y.z, utan v); main används aldrig
TARGET=$(git tag -l '[0-9]*' --sort=-v:refname | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)
if [ -z "$TARGET" ]; then
    result false "$FROM" "$FROM" "Det finns ingen version att uppdatera till (inga taggar på GitHub)."
    exit 1
fi
NEW=$(git rev-parse "$TARGET^{commit}")
if [ "$NEW" = "$PREV" ]; then
    result true "$FROM" "$FROM" "Redan senaste versionen ($FROM)."
    exit 0
fi
git -c advice.detachedHead=false checkout --quiet --force "$TARGET" || { result false "$FROM" "$FROM" "Kunde inte byta till $TARGET."; exit 1; }
TO=$(ver)
# Systemfiler som följer med programmet (tjänsten, sudo-regeln och nmcli-skriptet)
install_system_files
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
install_system_files
rm -f "$OKFILE"
systemctl restart "$SERVICE"
result false "$FROM" "$FROM" "Version $TO startade inte inom $WAIT_S s. Mottagaren gick tillbaka till $FROM."
exit 1
