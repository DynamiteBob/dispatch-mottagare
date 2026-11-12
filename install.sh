#!/bin/bash
# ============================================================================
# Installerar Dispatch-mottagaren på en Raspberry Pi (Raspberry Pi OS Lite 64-bit, Bookworm eller senare).
#
#   curl -fsSL https://raw.githubusercontent.com/DynamiteBob/dispatch-mottagare/main/install.sh | sudo bash
#   curl -fsSL https://raw.githubusercontent.com/DynamiteBob/dispatch-mottagare/main/install.sh | sudo bash -s -- https://dispatch.exempel.se
#
# Skriptet kan köras igen: det uppdaterar programmet och skriver om systemfilerna, men behåller inställningarna.
#  - paketen git, nodejs, rtl-sdr, network-manager, dnsmasq-base
#  - Linux egen DVB-drivrutin för stickan stängs av (annars kommer rtl_fm inte åt den)
#  - användaren mottagare (systemanvändare) med rätt till USB-stickan och sudo för nmcli, reboot och uppdateringen
#  - programmet i /opt/dispatch-mottagare (git, senaste taggen v*), inställningarna i /var/lib/dispatch-mottagare
#  - tjänsten dispatch-mottagare (systemd) som startar vid uppstart och startas om om den stannar
#  - NetworkManagers dnsmasq svarar 10.42.0.1 på alla namn när hotspoten är igång (telefonen öppnar inställningssidan)
# ============================================================================
set -euo pipefail

REPO="${MOTTAGARE_REPO:-https://github.com/DynamiteBob/dispatch-mottagare.git}"
DIR=/opt/dispatch-mottagare
STATE=/var/lib/dispatch-mottagare
USER_NAME=mottagare
DISPATCH_URL="${1:-}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mFEL: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Kör skriptet med sudo."
command -v apt-get >/dev/null || die "Skriptet kräver Raspberry Pi OS eller Debian (apt-get)."

say "1/7 Installerar paket"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git nodejs rtl-sdr network-manager dnsmasq-base sudo ca-certificates curl >/dev/null
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js $NODE_MAJOR är för gammal (minst 18 krävs). Använd Raspberry Pi OS Bookworm eller senare."
systemctl is-active --quiet NetworkManager || die "NetworkManager körs inte. Raspberry Pi OS Bookworm och senare använder NetworkManager; äldre versioner stöds inte."

say "2/7 Stänger av Linux DVB-drivrutin för RTL-SDR"
cat > /etc/modprobe.d/dispatch-mottagare-rtlsdr.conf <<'EOF'
# Dispatch-mottagare: RTL-SDR-stickan används av rtl_fm, inte som TV-mottagare
blacklist dvb_usb_rtl28xxu
blacklist rtl2832
blacklist rtl2830
blacklist rtl2832_sdr
EOF
for m in rtl2832_sdr dvb_usb_rtl28xxu rtl2832 rtl2830; do modprobe -r "$m" 2>/dev/null || true; done

say "3/7 Skapar användaren $USER_NAME"
if ! id "$USER_NAME" >/dev/null 2>&1; then
    useradd --system --home-dir "$STATE" --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
fi
for g in plugdev dialout; do getent group "$g" >/dev/null && usermod -aG "$g" "$USER_NAME"; done

say "4/7 Hämtar programmet"
if [ -d "$DIR/.git" ]; then
    git -C "$DIR" fetch --quiet --tags --force origin
else
    rm -rf "$DIR"
    git clone --quiet "$REPO" "$DIR"
fi
TAG=$(git -C "$DIR" tag -l 'v*' --sort=-v:refname | head -1)
if [ -n "$TAG" ]; then git -C "$DIR" -c advice.detachedHead=false checkout --quiet --force "$TAG"; else git -C "$DIR" checkout --quiet --force origin/main; fi
chown -R root:root "$DIR"
VERSION=$(node -p "require('$DIR/package.json').version")
echo "Version $VERSION (${TAG:-main})"
ln -sf "$DIR/bin/uppdatera.sh" /usr/local/sbin/dispatch-mottagare-uppdatera
ln -sf "$DIR/bin/dispatch-mottagare" /usr/local/bin/dispatch-mottagare
chmod 755 "$DIR/bin/uppdatera.sh" "$DIR/bin/dispatch-mottagare"

say "5/7 Behörigheter (sudo) och hotspotens namnserver"
cat > /etc/sudoers.d/dispatch-mottagare <<EOF
# Dispatch-mottagare: nätet, omstart och uppdatering
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/nmcli
$USER_NAME ALL=(root) NOPASSWD: /usr/sbin/reboot
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemd-run --unit=dispatch-mottagare-uppdatering --collect /usr/local/sbin/dispatch-mottagare-uppdatera
EOF
chmod 0440 /etc/sudoers.d/dispatch-mottagare
visudo -cf /etc/sudoers.d/dispatch-mottagare >/dev/null || { rm -f /etc/sudoers.d/dispatch-mottagare; die "sudo-filen blev fel."; }
mkdir -p /etc/NetworkManager/dnsmasq-shared.d
cat > /etc/NetworkManager/dnsmasq-shared.d/dispatch-mottagare.conf <<'EOF'
# Dispatch-mottagare: på hotspoten pekar alla namn på mottagaren, så att telefonen öppnar inställningssidan
address=/#/10.42.0.1
EOF

say "6/7 Tjänsten dispatch-mottagare"
install -m 0644 "$DIR/systemd/dispatch-mottagare.service" /etc/systemd/system/dispatch-mottagare.service
mkdir -p "$STATE"
chown "$USER_NAME:$USER_NAME" "$STATE"
chmod 0700 "$STATE"
if [ -n "$DISPATCH_URL" ]; then
    mkdir -p /etc/systemd/system/dispatch-mottagare.service.d
    printf '[Service]\nEnvironment=MOTTAGARE_DISPATCH_URL=%s\n' "$DISPATCH_URL" > /etc/systemd/system/dispatch-mottagare.service.d/adress.conf
fi
systemctl daemon-reload
systemctl enable --quiet dispatch-mottagare
systemctl restart dispatch-mottagare

say "7/7 Väntar på att mottagaren startar"
for i in $(seq 1 30); do [ -s "$STATE/state.json" ] && break; sleep 1; done
sleep 2
/usr/local/bin/dispatch-mottagare status || true

cat <<EOF

Klart. Mottagaren startar automatiskt när Pi:n startar.
 - Har mottagaren inget nät startar den ett eget wifi (namn och lösenord ovan). Anslut med telefonen,
   så öppnas inställningssidan (annars: http://10.42.0.1).
 - Ange Dispatch-adressen på inställningssidan (eller: sudo dispatch-mottagare adress https://dispatch.exempel.se).
 - Godkänn mottagaren i Dispatch: Adminportalen → Mottagare. Koden visas ovan och på inställningssidan.
 - Loggen: sudo dispatch-mottagare logg
EOF
