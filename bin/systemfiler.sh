#!/bin/bash
# ============================================================================
# Systemfilerna som följer med programmet (0.4.3): sudo-regeln (systemd/sudoers) och nmcli-skriptet (bin/nmcli-dispatch).
# Körs som root av systemd innan tjänsten startar (ExecStartPre=-+ i dispatch-mottagare.service), och av bin/uppdatera.sh.
# Så kommer filerna på plats även när uppdateringen till 0.4.3 görs av ett äldre uppdateringsskript.
# MOTTAGARE_DIR, MOTTAGARE_USER, MOTTAGARE_SUDOERS och MOTTAGARE_SBIN byter sökvägarna i testerna.
# ============================================================================
set -u
DIR=${MOTTAGARE_DIR:-/opt/dispatch-mottagare}
USER_NAME=${MOTTAGARE_USER:-mottagare}
SUDOERS=${MOTTAGARE_SUDOERS:-/etc/sudoers.d/dispatch-mottagare}
SBIN=${MOTTAGARE_SBIN:-/usr/local/sbin}

if [ -f "$DIR/bin/nmcli-dispatch" ]; then
    chmod 755 "$DIR/bin/nmcli-dispatch"
    ln -sf "$DIR/bin/nmcli-dispatch" "$SBIN/dispatch-mottagare-nmcli"
fi
src="$DIR/systemd/sudoers"
[ -f "$src" ] || exit 0
t=$(mktemp /tmp/dispatch-mottagare-sudoers-ny.XXXXXX) || exit 1
trap 'rm -f "$t"' EXIT
sed "s/^mottagare /$USER_NAME /" "$src" > "$t"
if [ -f "$SUDOERS" ] && cmp -s "$t" "$SUDOERS"; then exit 0; fi
if command -v visudo >/dev/null 2>&1 && ! visudo -cf "$t" >/dev/null; then
    echo "Sudo-regeln i $src är fel och installerades inte." >&2
    exit 1
fi
install -m 0440 "$t" "$SUDOERS"
echo "Sudo-regeln $SUDOERS är uppdaterad."
