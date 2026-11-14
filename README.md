# Dispatch-mottagare

Program för en Raspberry Pi med en RTL-SDR-sticka. Mottagaren lyssnar på en frekvens, avkodar positionerna som Ericsson Aurora (C50) skickar med FFSK och mäter signalstyrkan. Positionerna skickas till Dispatch och visas i lagret Radio 90 på kartan. Avkodaren lyssnar hela tiden, oberoende av squelchen. Mottagaren kan också spela in det som squelchen öppnar för och skicka inspelningarna till Dispatch; squelchen styr bara inspelningarna.

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

## Signalstyrka och förstärkning

Sedan version 0.4.0 läser mottagaren radiosignalen med `rtl_sdr` och mäter signalstyrkan för varje meddelande (Mottagning: Signalstyrka i Dispatch). Värdet är effekten i kanalen i dBFS, och Dispatch räknar om det till ungefärliga dBm med förstärkningen och mottagarens kalibrering. Signalstyrkan kräver fast förstärkning; med Automatisk ändrar stickan förstärkningen själv och värdena går inte att jämföra.

Stickan har inget kalibrerat mått. Fältet Kalibrering i Dispatch rättar värdet: mät med ett instrument eller en radio som visar signalstyrkan på samma plats och skriv in skillnaden.

Ställ in förstärkning automatiskt (knappen i Dispatch) provar förstärkningsstegen. Vid låg förstärkning är brusgolvet omvandlarens eget brus och står still; när förstärkningen höjs börjar stickans och antennens brus synas och brusgolvet stiger. Mottagaren föreslår det lägsta steget där brusgolvet ligger minst 8 dB över det lägsta, utan klippning, och där även nästa steg ligger minst 6 dB över (så att en enstaka mätning som slår fel inte avgör). Varje steg mäts i 3 sekunder. Högre förstärkning än så ger inte bättre känslighet, bara mindre marginal mot starka signaler. Gör mätningen när ingen sänder på kanalen.

Förstärkningen 0 dB går inte att använda: rtl_sdr och rtl_fm tolkar 0 som automatisk förstärkning. Den lägsta fasta förstärkningen är 0,9 dB (sedan 0.4.2).

Mottagning: Endast ljud använder `rtl_fm` som före 0.4.0, utan signalstyrka. Den finns som reserv om avkodningen skulle bli sämre med den nya demoduleringen.

## Serieport (J3 på en Aurora)

Sedan version 0.4.1 kan mottagaren läsa kontakten J3 på en Ericsson Aurora med GPS i stället för en RTL-SDR-sticka. Radion skriver en rad (`$PNIGPS`) för varje FFSK-position den tar emot från en annan radio, i 4 800 baud. Anslut J3 till Pi:n med en USB-adapter för RS-232 och välj Källa: Serieport, porten och hastigheten i Dispatch. Ange radions kanal som frekvens om missade meddelanden ska räknas i Täckning (mottagare).

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

Knappen Uppdatera i Dispatch hämtar den senaste taggen (`0.3.0`, `0.3.1` …) från det här repot. Taggarna skapas automatiskt när versionen ändras. Det som ligger på `main` utan tagg installeras aldrig. Startar den nya versionen inte inom 90 sekunder går mottagaren tillbaka till den förra. Resultatet visas på mottagaren i Dispatch.

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

`test/test_e2e.js` kör mottagaren mot den riktiga Dispatch-testservern och kräver Dispatch-repot bredvid (`../dispatch`) eller `DISPATCH_DIR`. Den använder en falsk `nmcli`, en falsk `rtl_sdr` och en falsk `rtl_fm` i `test/falska/`.
