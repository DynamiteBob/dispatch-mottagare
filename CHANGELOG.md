# Ändringslogg – Dispatch-mottagare

Alla ändringar som märks för den som använder eller sköter mottagarna skrivs här, nyast överst.

Versionsnumret står i `package.json` (fältet `"version"`) och är det enda stället där versionen anges.
Format: `0.<release>.<rättning>`. Varje version taggas med versionen utan v (till exempel `0.3.1`). Taggen och releasen på GitHub skapas automatiskt när versionen ändras. Knappen Uppdatera programvaran i Dispatch hämtar den senaste taggen.

Rubrikerna under varje version:
- **Nytt** – nya funktioner
- **Ändrat** – funktioner som fungerar annorlunda än tidigare
- **Rättat** – fel som har rättats

## 0.4.0 – 2026-11-14

Kräver Dispatch 1.65.2 för att signalstyrkan, varningarna och Ställ in förstärkning automatiskt ska synas. Med en äldre Dispatch avkodar mottagaren som förut.

### Nytt
- Mottagaren mäter signalstyrkan för varje meddelande. Dispatch visar den i ungefärliga dBm på kartan och i Täckning (mottagare). Det kräver fast förstärkning.
- Livssignalen har stickans förstärkning, brusgolvet och hur mycket stickan klipper (överstyrs). Dispatch varnar när stickan är överstyrd eller när förstärkningen är för låg.
- Kommandot Ställ in förstärkning automatiskt: mottagaren provar förstärkningsstegen ett i taget i ungefär en minut och föreslår det lägsta steget där stickans och antennens brus hörs över omvandlarens eget brus, utan klippning. Förslaget sparas först när det godkänns i Dispatch. Under mätningen avkodas inget.
- Inställningen Mottagning i Dispatch: Signalstyrka (förvald) eller Endast ljud. Endast ljud är reserven och fungerar som före 0.4.0.

### Ändrat
- Mottagaren läser radiosignalen från stickan med `rtl_sdr` och FM-demodulerar själv, i stället för att använda `rtl_fm`. Stickan ställs in 60 kHz över kanalen så att dess likspänningsspik inte hamnar i kanalen. Med Endast ljud används `rtl_fm` som förut.
- Loggen kallar inspelningarnas nivå brusdämpning.

## 0.3.2 – 2026-11-13

Kräver Dispatch 1.63.13 för att klockan och de ofullständiga ramarna ska visas i Adminportalen. Med en äldre Dispatch fungerar mottagaren som förut.

### Nytt
- Livssignalen talar om ifall mottagarens klocka är synkad med NTP och vad klockan är. Dispatch visar hur mycket den går fel och varnar om det är mer än 5 sekunder, eftersom positionerna får mottagarens tid.

### Ändrat
- En ram som bröts av innan alla kodord kom fram (färre än fyra kodord, oftast svag signal) skickas inte längre till Dispatch. Den räknas som ofullständig i avkodarens läge.

### Rättat
- Farten tolkades som hela km/h men är tiondels km/h. 0375 är 37,5 km/h, inte 375 km/h. Jämfört med en telefon med Traccar i samma bil.

## 0.3.1 – 2026-11-13

### Ändrat
- Uppdateringen och installationen använder taggar som heter som versionen, utan v (till exempel 0.3.1). Det är så taggarna heter på GitHub.
- Finns ingen tagg att uppdatera till står det i resultatet i Dispatch. Tidigare tog mottagaren då det senaste på `main`, som kunde vara en version som inte var släppt.
- Taggen och releasen på GitHub skapas automatiskt när en ny version läggs upp.

### Rättat
- Uppdatera programvaran hittade inte taggarna 0.1.0–0.3.0, eftersom den letade efter taggar som började med v.

## 0.3.0 – 2026-11-13

Fungerar med Dispatch 1.63.10. Dispatch 1.63.11 visar också hur många meddelanden som kom medan squelchen var stängd.

### Ändrat
- Avkodaren lyssnar på hela ljudströmmen hela tiden, oberoende av squelchen. Sändningar som är för svaga för att öppna squelchen avkodas nu också, och en squelch som öppnar sent kan inte längre klippa bort början av ett meddelande.
- Squelchen styr bara inspelningarna. Med inspelning avstängd påverkar squelchinställningen ingenting.
- Livssignalen till Dispatch visar hur många meddelanden som avkodades medan squelchen var stängd.

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
