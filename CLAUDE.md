# CLAUDE.md – Dispatch-mottagare

Instruktioner för Claude. Svara alltid på svenska. Ägaren och arbetsgången är desamma som för Dispatch
(repot `DynamiteBob/dispatch`, se dess CLAUDE.md): fråga först med numrerade frågor och rekommendationer,
leverera genom push till `main`, skriv text enligt skillen naturlig-text.

## Om programmet

- Node.js utan npm-paket (Node 18 eller senare, det som följer med Raspberry Pi OS). Lägg inte till beroenden.
- Körs som tjänsten `dispatch-mottagare` (användaren `mottagare`, inte root). sudo bara för `nmcli`, `reboot` och
  uppdateringen (`/etc/sudoers.d/dispatch-mottagare` i `install.sh`).
- Versionen står bara i `package.json`, formatet `0.<release>.<rättning>`. Varje version taggas `v<version>`;
  knappen Uppdatera i Dispatch hämtar den senaste taggen. Utan tagg når en ändring inte Pi:erna.
- Varje ny version skrivs i `CHANGELOG.md`, nyast överst, med rubrikerna Nytt, Ändrat och Rättat. Texten ska gå att förstå
  för den som sköter mottagarna. Kräver versionen en viss version av Dispatch står det först under versionen.

## Delarna

- `src/main.js` kopplar ihop allt och kör kommandona från Dispatch (restart, reboot, update).
- `src/state.js` sparar `state.json` (Dispatch-adress, nyckel, inställningar, hotspotens lösenord).
- `src/dispatch.js` pratar med Dispatch: anmälan, long polling (`/api/mottagare/poll`), livssignal, uppladdning, kvittenser.
- `src/net.js` styr NetworkManager och mottagarens eget wifi (hotspot, 10.42.0.1).
- `src/portal.js` är inställningssidan på port 80, utan skript.
- `src/sdr.js` startar `rtl_fm`; `src/squelch.js` är brussquelchen och inspelningen; `src/queue.js` kön på disk.
- `src/ffsk.js` avkodar FFSK (0.2.0). `src/ffskstream.js` (0.3.0) kör avkodaren på hela ljudströmmen i fönster om 2 s med
  0,6 s överlapp, oberoende av squelchen; squelchen (`src/squelch.js`) styr bara inspelningarna. `src/aurora.js` tolkar
  Aurora-meddelandet; `src/msgqueue.js` är kön för meddelandena (`meddelanden.json`). Dispatch tolkar om rådata själv
  (`radio90.js` i Dispatch-repot), så ett fel i tolkningen kan rättas i Dispatch utan att mottagarna uppdateras.
  Formatet: `docs/aurora-ffsk.md`. Inställningarna `decode` (förvalt på) och `record` styr avkodning och inspelning var för sig.
- `bin/uppdatera.sh` uppdaterar och går tillbaka om den nya versionen inte skriver `/run/dispatch-mottagare/ok`.
- `bin/dispatch-mottagare` är kommandoraden.

Dispatch-sidan finns i `mottagare.js` och `radio90.js` i Dispatch-repot (API), "MOTTAGARE" och "RADIO 90 I ADMINPORTALEN" i
`private/app.js` (Adminportalen → Mottagare) och "RADIO 90" i `private/karta.js` (lagret på kartan).
Ändras API:t ska båda repona ändras, och `test/test_e2e.js` här ska gå igenom mot Dispatch.

## Tester

`node test/kor_alla.js`. `test_e2e.js` kräver Dispatch-repot bredvid eller `DISPATCH_DIR`. Falska `nmcli`, `rtl_fm`
och uppdatering finns i `test/falska/`. Miljövariablerna `MOTTAGARE_*` (se källfilerna) byter sökvägar och tider i testerna.

## Integritet

Repot är publikt. Lägg aldrig in inspelningar, rådata eller exempel med verkliga positioner eller verkliga radio-ID.
Testerna och dokumentationen använder påhittade värden (ID 12345, 59° 20,1234′ N 018° 04,5678′ E).

## Kvar att undersöka

Vad byte 1 (0x12) och halvbytet i longituden betyder, och om radion kan skicka fler fält (GPS Parametrar rev 4). Andra
värden än 0x12 skickas som rådata och visas i Adminportalen → Mottagare → Radio 90.
