# Dispatch-mottagare

Program för en Raspberry Pi med en RTL-SDR-sticka. Mottagaren lyssnar på en frekvens och avkodar positionerna som Ericsson Aurora (C50) skickar med FFSK. Positionerna skickas till Dispatch och visas i lagret Radio 90 på kartan. Avkodaren lyssnar hela tiden, oberoende av squelchen. Mottagaren kan också spela in det som squelchen öppnar för och skicka inspelningarna till Dispatch; squelchen styr bara inspelningarna.

Formatet står i [docs/aurora-ffsk.md](docs/aurora-ffsk.md).

Allt som mottagaren ska göra ställs in i Dispatch, under Adminportalen → Mottagare. På Pi:n finns bara Dispatch-adressen och mottagarens nyckel.

## Det här behövs

- Raspberry Pi 4 eller 5
- Raspberry Pi OS Lite 64-bit, Bookworm eller senare (de använder NetworkManager, som mottagaren kräver)
- RTL-SDR-sticka, till exempel RTL-SDR Blog V3 eller V4
- Antenn för frekvensen
- Internet under installationen

## Installation

1. Installera Raspberry Pi OS Lite 64-bit med Raspberry Pi Imager. Ange värdnamn, användare, SSH-nyckel och wifi i Imager.
2. Logga in på Pi:n med SSH och kör:

   ```
   curl -fsSL https://raw.githubusercontent.com/DynamiteBob/dispatch-mottagare/main/install.sh | sudo bash -s -- https://dispatch.gyld.se
   ```

   Adressen på slutet går att utelämna; den kan anges senare på inställningssidan eller med `sudo dispatch-mottagare adress <url>`.
3. Skriptet skriver ut en kod, till exempel `K7F-29Q`. Gå till Dispatch, Adminportalen → Mottagare, kontrollera att koden stämmer och tryck Godkänn.
4. Ange frekvensen i Dispatch. Mottagaren börjar lyssna inom en sekund.

Skriptet går att köra igen. Det uppdaterar programmet och systemfilerna men behåller inställningarna.

## Eget wifi och inställningssidan

Har mottagaren ingen anslutning två minuter efter start, eller tappar den anslutningen i tio minuter, startar den ett eget wifi: `Dispatch-mottagare-XXXX`, där XXXX är slutet av Pi:ns serienummer. Lösenordet visas av installationsskriptet, av `sudo dispatch-mottagare status` och på mottagaren i Dispatch.

Anslut med en telefon. Inställningssidan öppnas av sig själv (annars `http://10.42.0.1`). Där väljer du wifi-nät och anger Dispatch-adressen. När mottagaren ansluter till nätet stängs det egna wifi:t. Misslyckas anslutningen startar det igen inom en minut.

Med nätkabel ansluten startar det egna wifi:t inte. Från det vanliga nätet visar sidan bara läget.

## Kommandoraden

```
sudo dispatch-mottagare status       läget, koden, eget wifi med lösenord
sudo dispatch-mottagare logg         loggen (Ctrl+C avslutar)
sudo dispatch-mottagare uppdatera    hämta senaste versionen nu
sudo dispatch-mottagare adress <url> byt Dispatch-adress
sudo dispatch-mottagare hotspot      starta det egna wifi:t nu
sudo dispatch-mottagare omstart      starta om programmet
```

## Uppdateringar

Knappen Uppdatera i Dispatch hämtar den senaste taggen (`v0.1.0`, `v0.1.1` …) från det här repot. Startar den nya versionen inte inom 90 sekunder går mottagaren tillbaka till den förra. Resultatet visas på mottagaren i Dispatch.

## Mappar på Pi:n

- `/opt/dispatch-mottagare`: programmet (git)
- `/var/lib/dispatch-mottagare`: inställningar (`state.json`), kön med inspelningar som inte skickats (`kö/`) och avkodade meddelanden som inte skickats (`meddelanden.json`, högst 2 000)
- `/etc/systemd/system/dispatch-mottagare.service`: tjänsten
- `/etc/sudoers.d/dispatch-mottagare`: rätt att köra nmcli, reboot och uppdateringen
- `/etc/modprobe.d/dispatch-mottagare-rtlsdr.conf`: stänger av Linux DVB-drivrutin för stickan

## Tester

```
node test/kor_alla.js
```

`test/test_e2e.js` kör mottagaren mot den riktiga Dispatch-testservern och kräver Dispatch-repot bredvid (`../dispatch`) eller `DISPATCH_DIR`. Den använder en falsk `nmcli` och en falsk `rtl_fm` i `test/falska/`.
