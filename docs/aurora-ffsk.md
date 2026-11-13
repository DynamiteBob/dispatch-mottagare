# Positionsmeddelandet från Ericsson Aurora (FFSK)

Formatet är taget fram ur inspelningar från en Aurora C50 med GPS, i november 2026, och jämfört med positionen på radions display. Radions programmering följer dokumentet GPS Parametrar i Aurora rev 4 (fälten position, fart, ID och status). Alla exempel här är påhittade.

## Modulation

- FFSK, 1200 bit/s. 1200 Hz är 1 och 1800 Hz är 0. Fasen fortsätter mellan bitarna.
- Förspel med 1010… och sedan synkordet SYNT, `0x3B28` (16 bitar), som i MPT 1327.
- Efter synkordet kommer fyra kodord om 64 bitar.

Mottagaren tar FM-demodulerat ljud från `rtl_fm` (24 kHz) och avkodar hela strömmen, oberoende av squelchen (sedan 0.3.0), i fönster om 2 sekunder med 0,6 sekunders överlapp. Varje ram räknas i exakt ett fönster. Avkodaren provar alla bitlägen inom en bit och båda polariteterna (synkordet inverterat), eftersom det beror på mottagaren vilket håll diskriminatorn ger.

## Kodorden

Varje kodord är 64 bitar, mest signifikanta biten först:

| Bitar | Innehåll |
|---|---|
| 63–16 | 48 bitar information |
| 15–1 | kontrollsumma, CRC med g(x) = x¹⁵ + x¹⁴ + x¹³ + x¹¹ + x⁴ + x² + 1, sista biten inverterad |
| 0 | jämn paritet över de 63 bitarna före |

Ett kodord räknas som rätt bara när både kontrollsumman och pariteten stämmer. Avkodaren läser kodord efter synkordet tills ett är fel (högst åtta) och kräver minst två, där det första börjar med en etta (adresskodord).

Det första kodordet har hittills alltid varit `810004E02000`. De tre följande ger 18 byte data. En ram med färre än fyra kodord har brutits av (oftast svag signal); mottagaren skickar den inte till Dispatch utan räknar den som ofullständig.

## Data (18 byte)

| Byte | Innehåll | Exempel |
|---|---|---|
| 0 | flaggor. Bit 7 = GPS-fix. `83` med fix, `03` utan. | `83` |
| 1 | `12` i alla meddelanden hittills, troligen vilka fält som är med | `12` |
| 2–5 | latitud, BCD gg mm mmmm | `59 20 12 34` = 59° 20,1234′ N |
| 6–10 | longitud, BCD ggg h mm mmmm. h är ett halvbyte, troligen väderstreck, `0` i Sverige | `01 80 04 56 78` = 018° 04,5678′ E |
| 11–12 | fart i tiondels km/h, BCD. `EE EE` utan fix | `03 75` = 37,5 km/h |
| 13–15 | radions ID, BCD: fem siffror och en extra siffra (#0) | `12 34 50` = 12345 |
| 16 | status, BCD (W0 W1), `00` = ingen | `33` |
| 17 | utfyllnad | `00` |

Hela exemplet som hex: `831259201234018004567803751234503300`.

Farten jämfördes i november 2026 med en telefon med Traccar i samma bil: `0375` när telefonen visade 37,6 km/h.

Utan GPS-fix är positionen nollor och farten `EEEE`, men ID och status är med. Dispatch sparar meddelandet och visar radion som Ingen GPS-fix.

## Sändningen

Radion sänder samma meddelande två eller tre gånger med 1–3 sekunders mellanrum. Dispatch slår ihop samma radio och samma innehåll inom 10 sekunder till ett meddelande och räknar hur många gånger det hördes och av vilka mottagare.

## Statuskoderna

Koderna i byte 16 är radions statusknappar enligt GPS Parametrar. Texterna ställs in i Dispatch (Adminportalen → Mottagare → Radio 90) och ändrar inte resursernas status.

## Kvar att undersöka

- Vad byte 1 betyder, och hur meddelandet ser ut med andra fältval. Ett meddelande med en annan byte 1 tolkas inte, men rådata sparas i Dispatch.
- Halvbytet i longituden (väderstreck) väster om Greenwich eller söder om ekvatorn.
- Vad adresskodordet `810004E02000` innehåller.

## Koden

- `src/ffsk.js`: diskriminatorn, kontrollen av kodorden och avkodningen. `encodeBits()` bygger en ram för testerna.
- `src/ffskstream.js`: avkodningen av hela strömmen i överlappande fönster.
- `src/aurora.js`: tolkningen ovan. Samma tolkning finns i Dispatch (`radio90.js`), som tolkar om rådata själv.
- `test/test_ffsk.js`: ramar med påhittade värden, modulerade med brus och avkodade igen.
