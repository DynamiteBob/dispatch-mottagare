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

## Delarna

- `src/main.js` kopplar ihop allt och kör kommandona från Dispatch (restart, reboot, update).
- `src/state.js` sparar `state.json` (Dispatch-adress, nyckel, inställningar, hotspotens lösenord).
- `src/dispatch.js` pratar med Dispatch: anmälan, long polling (`/api/mottagare/poll`), livssignal, uppladdning, kvittenser.
- `src/net.js` styr NetworkManager och mottagarens eget wifi (hotspot, 10.42.0.1).
- `src/portal.js` är inställningssidan på port 80, utan skript.
- `src/sdr.js` startar `rtl_fm`; `src/squelch.js` är brussquelchen och inspelningen; `src/queue.js` kön på disk.
- `bin/uppdatera.sh` uppdaterar och går tillbaka om den nya versionen inte skriver `/run/dispatch-mottagare/ok`.
- `bin/dispatch-mottagare` är kommandoraden.

Dispatch-sidan finns i `mottagare.js` i Dispatch-repot (API) och "MOTTAGARE" i `private/app.js` (Adminportalen → Mottagare).
Ändras API:t ska båda repona ändras, och `test/test_e2e.js` här ska gå igenom mot Dispatch.

## Tester

`node test/kor_alla.js`. `test_e2e.js` kräver Dispatch-repot bredvid eller `DISPATCH_DIR`. Falska `nmcli`, `rtl_fm`
och uppdatering finns i `test/falska/`. Miljövariablerna `MOTTAGARE_*` (se källfilerna) byter sökvägar och tider i testerna.

## Nästa steg (planerat)

FFSK-avkodning av Aurora-positioner (MPT1327-liknande, 1200 bit/s, 1200/1800 Hz). Formatet tas fram ur inspelningarna
från version 0.1. Underlag: GPS Parametrar i Aurora rev 4 och P500/C50/F50 programming manual TC-1452 (i claude.ai-projektet).
