# Ändringslogg – Dispatch-mottagare

Alla ändringar som märks för den som använder eller sköter mottagarna skrivs här, nyast överst.

Versionsnumret står i `package.json` (fältet `"version"`) och är det enda stället där versionen anges.
Format: `0.<release>.<rättning>`. Varje version taggas `v<version>`; knappen Uppdatera programvaran i Dispatch hämtar den senaste taggen.

Rubrikerna under varje version:
- **Nytt** – nya funktioner
- **Ändrat** – funktioner som fungerar annorlunda än tidigare
- **Rättat** – fel som har rättats

## 0.2.0 – 2026-11-13

Kräver Dispatch 1.63.10 eller senare för att positionerna ska synas i Dispatch.

### Nytt
- Mottagaren avkodar positionsmeddelandena som Ericsson Aurora (C50) skickar med FFSK, 1200 bit/s. Varje meddelande skickas till Dispatch med radions ID, position, fart, status, om GPS:en har fix och rådata. I Dispatch syns de i lagret Radio 90 på kartan och i Adminportalen → Mottagare.
- Avkodningen gäller allt som squelchen släpper igenom, även korta sändningar som är för korta för att spelas in.
- Meddelanden som inte har kunnat skickas sparas på Pi:n (högst 2 000) och skickas när Dispatch nås igen.
- Ny inställning i Dispatch: Avkoda Radio 90 (förvald på). Inspelning och avkodning går att stänga av var för sig.
- Livssignalen till Dispatch visar hur många meddelanden mottagaren har avkodat, när den senast avkodade ett och hur många meddelanden som väntar på att skickas.
- Formatet beskrivs i `docs/aurora-ffsk.md`.

## 0.1.0 – 2026-11-12

### Nytt
- Första versionen. Mottagaren lyssnar på en frekvens med en RTL-SDR-sticka, spelar in det som squelchen släpper igenom och skickar inspelningarna till Dispatch som WAV-filer.
- Mottagaren anmäler sig själv till Dispatch med en kod och gör ingenting förrän en administratör har godkänt den.
- Alla inställningar görs i Dispatch (Adminportalen → Mottagare): frekvens, förstärkning, frekvensfel (ppm), squelch, inspelningens längsta tid, vilken sticka som används och lösenordet för det egna wifi:t. Mottagaren får ändringarna inom en sekund.
- Utan känt wifi startar mottagaren ett eget wifi, Dispatch-mottagare-XXXX, med en inställningssida där man väljer nät och anger Dispatch-adressen.
- Kommandon från Dispatch: Uppdatera programvaran, Starta om programmet och Starta om Pi:n. En uppdatering som inte startar går tillbaka till den förra versionen.
- Kommandoraden `dispatch-mottagare` på Pi:n.
