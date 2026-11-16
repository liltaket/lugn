# Lugn for iPhone: design

This is the design source for the native app. It decides how the app looks,
moves, sounds, feels in the hand and speaks. Engineers start with
[IMPLEMENTATION-BRIEF.md](IMPLEMENTATION-BRIEF.md), which lists the build
order and the exact values. This document explains why those values are what
they are.

## What is in this folder

| Path                                               | What it is                                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [screens/index.html](screens/index.html)           | Gallery of every prototype with its screenshot.                                                                              |
| `screens/*.html`                                   | Self-contained, clickable prototypes at 402 × 874 pt. Open one in a wide window to get designer notes and a live haptic log. |
| `png/*.png`                                        | The same screens rendered at 2x (804 × 1748 px) with headless Chrome.                                                        |
| `src/`                                             | Prototype sources. `node src/build.mjs` rebuilds `screens/`, `src/shoot.sh` re-renders `png/`.                               |
| [IMPLEMENTATION-BRIEF.md](IMPLEMENTATION-BRIEF.md) | Ordered build list for the SwiftUI engineer, with every value.                                                               |

The prototypes use Inter where the app uses SF Pro, because they are rendered
on Linux. On a Mac the same files pick up the real SF Pro. Newsreader loads
from `web/fonts/` in this repository; Inter comes from Google Fonts.

Keys in any prototype: `s` shows safe areas and the thumb zone, `t` switches
light and dark, `g` turns glass off (Reduce Transparency).

## 1. Concept

**The room speaks one sentence, and the app is lit by the room.**

Two ideas carry the whole app. Everything else is ordinary, quiet iOS.

1. **A sentence, not a dashboard.** Hem opens on one line of serif text that
   says what is true right now: _Mysljus i sovrummet. Du är här. Musiken spelar
   lågt._ Lugn's whole point is that it can explain itself, so its home screen
   is an explanation. The same voice writes every decision in the Varför feed.
2. **Skenet, the light field.** The background of the app is the room's own
   light: its colours, its brightness, and nothing else. Mysljus makes the app
   glow amber. Fokus makes it pale. Helt släckt makes it night. There is no
   brand gradient and no artwork tint. If the screen is warm, the room is
   warm.

### Principles

1. **You have your answer before the lamps do.** Every touch shows its result
   at once. Confirmation arrives later and quietly. Nothing waits behind a
   spinner.
2. **Fill means light.** A filled scene tile is a claim that the room is lit
   that way, or about to be. When Lugn does not know, the tile is an outline.
   The app never shows knowledge it does not have.
3. **Mint means Lugn did it.** One accent, one meaning. A mint dot is an
   automatic decision or a live connection. Your own actions are white.
   Decoration never uses mint.
4. **The app is never brighter than the room.** If the room is dark, the app
   is dark, whatever the system appearance says.
5. **Show the notification layer only when it has something to say.** Wrong,
   upcoming, or needs you. Otherwise the row is not there and the scenes move
   up.
6. **A non-action is an action.** "Tände inte: rummet var tomt" gets the same
   typeface, the same row and the same respect as "Tände".
7. **Hold for everything.** Tap does the common thing. Holding any control
   opens all of it. There is no third gesture to learn.
8. **Works when it fails.** Offline, the app still tells you what it last
   knew and when. It refuses commands honestly instead of queueing them into
   the dark.
9. **One signature motion.** Light spreads from where you touched. No other
   decorative motion exists in the app.

### What we are not doing

- No per-screen brand colour, no artwork-tinted backgrounds, no glass under
  text that matters.
- No radar sweep, pulsing rings, shimmer placeholders or skeleton screens.
- No colour picker behind a menu. Colour sits beside brightness, always.
- No "smart" summaries written by a model. Every sentence is assembled from
  state by fixed rules (section 2).
- No onboarding carousel. Pairing is one field for the code.

## 2. Voice and Swedish copy

Lugn talks like a calm person who lives in the house: short, exact, a little
dry. It reports what happened in the past tense and what is true in the
present tense. It never sells, never apologises and never guesses out loud.

### Rules

- **Verb first, cause after a colon.** `Släckte: tomt i 5 min`. The colon is
  the word "because".
- **Non-actions use the same form with "inte".** `Tände inte: du är borta`.
  When the verb would be clumsy, name the missing thing:
  `Ingen musik: du pausade själv`.
- **Say "du" and "Lugn".** Never "användaren", "systemet", "enheten".
- **Uncertainty is stated, not hidden.** `Vet inte om någon är här.` is a
  complete, acceptable sentence.
- **No exclamation marks, no emoji, no ellipsis for progress.** "Skickar" is
  enough.
- **Sentence case everywhere.** No capitals for emphasis, no all-caps labels.
- **Time is 24-hour (`14:02`).** Decimals use a comma (`21,4°`). A
  non-breaking space sits before `%`, `K`, `ppm`, `min`, `s`, `h`.
- **People are counted in words up to four:** en person, två personer.
- **The Varför strip holds 34 characters.** Longer server text scales to 85 %
  and then truncates; the full sentence is one tap away.
- **Errors say what still works.**
  `Taklampan svarar inte. Fem av sex lampor lyser.`
- **Buttons say what happens, and keep their word.** "Spara i Mysljus" leads
  to "Sparat i Mysljus."

### Glossary

| Use                  | Not                       | Why                                                  |
| -------------------- | ------------------------- | ---------------------------------------------------- |
| scen                 | preset, förval, läge      | The Hub and the panel already say scen.              |
| lampa                | enhet, entitet, ljuskälla | People have lamps.                                   |
| förtända             | prelight, förhandstända   | One Swedish verb for the temporary entry light.      |
| tyst tid             | quiet hours, nattläge     | 23–06, when music never starts by itself.            |
| Lugn styr / Jag styr | Auto / Manuell            | Says who, not which mode.                            |
| para ihop            | länka, ansluta, synka     | Matches iOS Bluetooth wording.                       |
| närvarosensorn       | LiDAR, STL27L, radarn     | Hardware names stay in Inställningar.                |
| ledtråd              | signal, kontext, data     | What the phone gives Lugn. Explains the trust model. |
| det Lugn gör själv   | automation, regel         | Plain description of the same thing.                 |

### The hero sentence

The sentence on Hem is assembled from three clauses in a fixed order. Each
clause is one short sentence. A clause is dropped when it has nothing to say.

| Clause   | Source                          | Forms                                                                                                   |
| -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Light    | `lighting.currentSceneId`, room | `Mysljus i sovrummet.` · `Släckt i sovrummet.` · `Eget ljus i sovrummet.` (overrides present)           |
| Presence | `presence.state`, `personCount` | `Du är här.` · `Två personer här.` · `Någon är kvar.` · `Rummet är tomt.` · `Vet inte om någon är här.` |
| Sound    | `music.targets[0].observed`     | `Musiken spelar lågt.` (< 30 %) · `Musiken spelar.` · `Det är tyst.` · `Pausad av dig.`                 |

Overrides replace the whole sentence:
`Når inte Lugn. Senast 14:02: Mysljus, en person här.` and
`Godnatt. Släckt om 11 min.`

### Example strings

| #   | Where                     | Swedish                                                              |
| --- | ------------------------- | -------------------------------------------------------------------- |
| 1   | Hem, hero                 | Mysljus i sovrummet. Du är här. Musiken spelar lågt.                 |
| 2   | Hem, hero, stationary     | Mysljus i sovrummet. Någon är kvar. Det är tyst.                     |
| 3   | Hem, hero, unknown        | Släckt i sovrummet. Vet inte om någon är här.                        |
| 4   | Hem, hero, offline        | Når inte Lugn. Senast 14:02: Mysljus, en person här.                 |
| 5   | Varför, acted             | Tände: någon kom in                                                  |
| 6   | Varför, acted             | Släckte: tomt i 5 min                                                |
| 7   | Varför, acted             | Förtände: någon var på väg in                                        |
| 8   | Varför, acted             | Sänkte musiken till 24 %: kvällskurvan                               |
| 9   | Varför, skipped           | Tände inte: du är borta                                              |
| 10  | Varför, skipped           | Förtände inte: Helt släckt gäller                                    |
| 11  | Varför, skipped           | Släckte inte: väntar 60 s på att du kommer tillbaka                  |
| 12  | Varför, skipped           | Ingen musik: du pausade själv                                        |
| 13  | Varför, skipped           | Ingen musik: tyst tid till 06                                        |
| 14  | Varför, skipped           | Rörde inte skrivbordslampan: du ändrade den för hand                 |
| 15  | Varför, you               | Bytte till Fokus: du valde det                                       |
| 16  | Varför, failed            | Kunde inte tända taklampan. Försökte tre gånger.                     |
| 17  | Varför, empty             | Inget har hänt i dag.                                                |
| 18  | Scene tile, sending       | Skickar                                                              |
| 19  | Scene tile, waiting       | Väntar på lamporna                                                   |
| 20  | Scene tile, confirmed     | Aktiv                                                                |
| 21  | Scene tile, slow          | Svarar långsamt                                                      |
| 22  | Scene tile, failed        | Gick inte. Tryck igen.                                               |
| 23  | Scene tile, stale         | Senast 14:02                                                         |
| 24  | Scene tile, offline tap   | Når inte Lugn                                                        |
| 25  | Belysning, hint           | Håll kvar på en scen för att justera den.                            |
| 26  | Hold sheet, note          | Osparat gäller tills du byter scen.                                  |
| 27  | Hold sheet, button        | Spara i Mysljus                                                      |
| 28  | Hold sheet, all off       | Släckt är alltid släckt. Reglagen gäller bara nu.                    |
| 29  | Lamp row, override        | Ändrad för hand, Lugn rör den inte                                   |
| 30  | Notice, error             | Taklampan svarar inte. Fem av sex lampor lyser. Försöker igen.       |
| 31  | Notice, upcoming          | Godnatt i kväll. Väckning 07:00. Lamporna tänder själva.             |
| 32  | Notice, offline           | Offline sedan 14:02. Nytt försök om 8 s, eller tryck här.            |
| 33  | Stale values              | Mätt 14:02. Visas tills Lugn svarar igen.                            |
| 34  | Musik, lead               | Spelar lågt. Lugn sköter volymen.                                    |
| 35  | Musik, manual             | Du styr. Lugn tar tillbaka volymen när rummet varit tomt i 20 min.   |
| 36  | Musik, paused             | Pausad av dig. Lugn startar den inte igen.                           |
| 37  | Musik, because            | Kvällskurvan: 30 % i grunden, minus 6 efter 21:30.                   |
| 38  | Närvaro, moving           | En person i rummet. Rör sig vid skrivbordet. Sedd nyss.              |
| 39  | Närvaro, still            | Någon är kvar. Ingen rörelse på 12 min.                              |
| 40  | Närvaro, exit pending     | Rummet verkar tomt. Släcker om 42 s om ingen kommer tillbaka.        |
| 41  | Närvaro, unknown          | Vet inte om någon är här. Lugn släcker ingenting så länge.           |
| 42  | Närvaro, correction       | Fel antal? Rätta här. · Sensorn räknar nu 1.                         |
| 43  | Godnatt, question         | När vill du vakna?                                                   |
| 44  | Godnatt, helper           | Om 8 h 26 min. Samma tid som telefonens alarm.                       |
| 45  | Godnatt, choice           | Tänd själv. Ljuset stiger i 20 min från 07:00.                       |
| 46  | Godnatt, button and note  | Starta Godnatt · Tonar ned på 15 min. Stänger du sparas inget.       |
| 47  | Godnatt, running and done | Godnatt. Släckt om 14:32 · Släckt. Sov gott.                         |
| 48  | Telefon, lead             | Telefonen ger Lugn ledtrådar. Närvarosensorn avgör alltid.           |
| 49  | Telefon, signal           | Säger när du lämnar hemmet och när du är tillbaka. Aldrig var du är. |
| 50  | Telefon, state            | Senast skickat: Kom hem, 17:58 · Skickas inte                        |
| 51  | Telefon, ledger note      | Listan visar allt, ord för ord. Ingen molntjänst, ingen position.    |
| 52  | Pairing                   | Skriv koden från kontrollpanelen. Den gäller i fem minuter.          |
| 53  | Pairing, revoked          | Telefonen är inte ihopparad längre. Para ihop igen.                  |
| 54  | Rutiner, empty            | Inga rutiner än. Börja med Godnatt.                                  |

## 3. Colour

Dark is the design. Light exists and is finished, but dark is where every
decision was made.

### Dark (default)

| Token           | Hex               | Use                                                    | Contrast on `page` |
| --------------- | ----------------- | ------------------------------------------------------ | ------------------ |
| `page` Natt     | `#06090D`         | Screen background, the base of the light field         |                    |
| `raised`        | `#0D1319`         | Tiles, cards, rows                                     |                    |
| `raised2`       | `#121A22`         | Selected "Helt släckt", solid stand-in for glass       |                    |
| `raised3`       | `#18222C`         | Fader tracks, switch off-state, pressed segment        |                    |
| `line`          | `#D6E4EE` at 10 % | Hairlines, card edges                                  |                    |
| `lineStrong`    | `#D6E4EE` at 20 % | Room outline in the radar, Increase Contrast edges     |                    |
| `ink`           | `#ECF0F2`         | Primary text, primary buttons                          | 17.4 : 1           |
| `ink2`          | `#AAB5BE`         | Secondary text on solid surfaces                       | 9.6 : 1            |
| `ink3`          | `#7F8B96`         | Hints and idle tile status, on solid surfaces only     | 5.7 : 1            |
| `inkField2`     | `#D3DADE`         | Secondary text on the light field                      | 5.0 : 1 at peak    |
| `mint` Mynta    | `#8FF0C4`         | Lugn acted, live, switch on, radar person, Lugn's goal | 14.7 : 1           |
| `mintInk`       | `#032015`         | Text on mint                                           | 12.6 : 1 on mint   |
| `warn` Bärnsten | `#F2D38C`         | Needs you: offline, exit pending                       | 12.9 : 1 on raised |
| `bad` Korall    | `#FF9D94`         | Failed, unreachable lamp                               | 9.3 : 1 on raised  |

These are the web panel's values, unchanged. The phone and the panel are the
same product.

### Light

| Token        | Hex               | Contrast on `page` |
| ------------ | ----------------- | ------------------ |
| `page` Dimma | `#EDF1F0`         |                    |
| `raised`     | `#F8FAF9`         |                    |
| `raised2`    | `#FFFFFF`         |                    |
| `raised3`    | `#E3E9E7`         |                    |
| `line`       | `#0C1613` at 9 %  |                    |
| `lineStrong` | `#0C1613` at 18 % |                    |
| `ink`        | `#0C1613`         | 16.2 : 1           |
| `ink2`       | `#43514C`         | 7.3 : 1            |
| `ink3`       | `#5F6C67`         | 4.8 : 1            |
| `inkField2`  | `#43514C`         | 5.7 : 1 at peak    |
| `mint`       | `#0B7A55`         | 4.7 : 1            |
| `warn`       | `#7A5200`         | 6.6 : 1 on raised  |
| `bad`        | `#B3362B`         | 5.8 : 1 on raised  |

Light mode is north-window daylight: a cool, slightly green grey with white
surfaces. It is deliberately not cream. Warmth in this app always comes from
a lamp.

### The light-mode decision

The app has an appearance setting with three values. The default is the first.

1. **Följ rummet** (default). Use the system appearance, except that the app
   is forced dark whenever the room is dark: scene is Helt släckt, no lamp is
   on, or Godnatt is running or has run tonight. Opening a white app in a dark
   bedroom is the opposite of the product's name.
2. **Alltid mörkt.**
3. **Följ systemet.** Plain iOS behaviour, for people who dislike the rule.

**Nattbläck.** From the start of Godnatt until the morning plan fires (or
06:00), text uses `#C9B8A8` instead of `ink` (10.4 : 1 on `page`), mint drops
to 60 % opacity and no surface is brighter than `raised2`. The screen stays
readable and stops being a light source.

### Scene light signatures

Each scene owns a small palette: the pools it puts in the light field, the
fill of its lit tile, the ink on that fill and its ember (the idle pictogram
colour). The light itself is the tile's fill, so no tile is ever mint.

| Scene       | Field pools (dark)            | `k`  | Lit tile fill                            | Ink on fill | Ember (dark / light)  |
| ----------- | ----------------------------- | ---- | ---------------------------------------- | ----------- | --------------------- |
| Helt släckt | `#16263A` `#0E1A2A` `#0A121C` | 0.55 | none: `raised2` with a 1.5 pt `ink` edge | `ink`       | `ink2`                |
| Mysljus     | `#FF9A45` `#FFB066` `#C85F2A` | 0.90 | `#FFB873` to `#F0934A`                   | `#2B1505`   | `#FFA95C` / `#B85A12` |
| Vardagsljus | `#FFC07C` `#FFD29C` `#F0A45C` | 0.80 | `#FFE0B8` to `#FFC88C`                   | `#2A1A08`   | `#FFCF9A` / `#A86A14` |
| Filmkväll   | `#C9542A` `#3F5BF0` `#7A2F22` | 0.80 | `#A94A22`, `#7A3224`, `#2B3F9E`          | `#FFF3EA`   | `#E8743C` / `#A8421A` |
| Fokus       | `#F6ECDC` `#DFE9F4` `#FFF3DF` | 0.76 | `#FFFAF2` to `#ECEFEE`                   | `#14181A`   | `#F3EDE2` / `#4D5A56` |
| Party       | `#FF3F9A` `#3CC4FF` `#7A4CFF` | 0.95 | `#D81F84`, `#7438EA`, `#1487C9`          | `#FFFFFF`   | `#FF6FB5` / `#B8257A` |

Filmkväll carries a blue pool because the scene turns the monitor backlight
on. Helt släckt has a faint moonlit blue so the screen is night rather than
dead.

Ink on every lit fill is at least 4.5 : 1 where text sits (Mysljus 7.4,
Vardagsljus 11.1, Filmkväll 5.2, Fokus 15.4, Party 4.7 to 6.0). The status
line under the name uses the same ink at 86 % (5.3 : 1 on Mysljus).

User-made scenes get their signature from their lamps: the three most
different lamp colours become the pools, the brightest becomes the fill, and
the ink is `#14181A` or `#FFFFFF`, whichever clears 4.5 : 1.

### Kelvin ramp

Physically exact colour temperatures look orange on a phone. This ramp is
tuned so that 2700 K reads as "warm lamp" and 4000 K as "neutral white" on an
OLED screen next to the real lamp.

| Kelvin | Name     | Hex       |
| ------ | -------- | --------- |
| 2000   | Glöd     | `#FF8C3A` |
| 2200   | Glöd     | `#FFA24F` |
| 2700   | Varmt    | `#FFBE7D` |
| 4000   | Neutralt | `#FFE9CF` |
| 5000   | Svalt    | `#F7F3EE` |
| 6500   | Dagsljus | `#DFE9FF` |

Interpolate linearly in sRGB between stops.

## 4. Skenet: the room light field

### What drives it

| Input                                    | Effect                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| Current scene, or observed lamp colours  | The three pool colours (table above; observed colours when overridden) |
| Mean brightness `b` of lamps that are on | Intensity: `level = 0.35 + 0.65 × b`                                   |
| Optimistic scene change                  | Pools start moving to the new colours at touch, over 1.2 s             |
| Command failure                          | Pools return to the previous colours over 0.8 s                        |
| Confirmed empty                          | `level × 0.45`: intent is remembered, the lamps are off                |
| Presence unknown                         | `level × 0.30`                                                         |
| Offline or stale                         | Saturation to 15 %, breathing stops, level × 0.55                      |
| Godnatt fade                             | `level` follows the remaining time down to 4 %                         |

The field is the same on every tab. Album artwork never tints it; artwork
colours stay inside the now-playing card.

### Shape

Three soft pools on a `page` base. Pool A sits low left (the bed lamp), pool
B high right (the desk lamp), pool C is a wide wash across the middle. They
never form a symmetrical glow behind a title. A 5 to 7 % monochrome grain sits
on top to stop OLED banding and to make the light look like light on a wall.

The field fades into solid `page` down the screen. This fade is called the
reading floor:

| Screen height | `page` mixed over the field |
| ------------- | --------------------------- |
| 0 to 20 %     | 0 %                         |
| 33 %          | 62 %                        |
| 46 %          | 90 %                        |
| 60 % and down | 100 % (solid)               |

Controls live below the floor on solid surfaces. Full-screen moments (Godnatt
fade, pairing) use a taller floor: clear to 52 %, solid at 92 %.

### Contrast law

Measured on the rendered prototypes, not estimated.

1. **Peak cap.** In dark mode no point of the field exceeds relative
   luminance 0.10. Each scene's `k` is tuned to that cap (measured peaks:
   Mysljus 0.094, Vardagsljus 0.095, Fokus 0.098, Party 0.095, Filmkväll
   0.026). `ink` is therefore at least 6.2 : 1 anywhere on the field.
2. **Only two inks touch the field:** `ink` and `inkField2` (at least 5.0 : 1
   at the peak). `ink2`, `ink3`, mint, amber and coral text never sit on the
   field; they need a solid surface.
3. **Below the floor the field is under 0.025** by 33 % of the screen height
   and under 0.008 from 40 %, so the instrument row (10 : 1) and everything
   after it reads as if on `page`.
4. **Light mode** mixes pool colours into `page` at up to 50 %. The darkest
   measured field point is luminance 0.67 (Filmkväll), which keeps `ink` at
   12.7 : 1 and `ink2` at 5.7 : 1.
5. **No blur under text.** The field is a gradient, not a material. Glass is
   chrome only (section 6).
6. **Increase Contrast** halves `k` and replaces `inkField2` with `ink`.
7. **User colours are clamped.** A saturated blue from the colour fader is
   mixed toward `page` until it passes rule 1 before it reaches the field.

### Breathing

The pools drift by at most 14 pt and scale between 1.00 and 1.06, on three
unrelated periods (9 s, 11 s, 13 s), easing in and out. At a glance the screen
is still; over a minute it is alive. Render at 20 fps. Stop when Reduce Motion
or Low Power Mode is on, when the scene is Helt släckt, and when offline.

## 5. Typography

### Decision

**One bundled typeface, Newsreader, for everything Lugn says. SF Pro for
everything you operate.** Familjen Grotesk is not carried over to iOS.

The web panel's own stylesheet states the rule this follows: serif for
headings, grotesk for everything you operate. On iOS the grotesk is the
system's.

| Option                             | For                                                                                                              | Against                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SF Pro + New York, nothing bundled | No bytes, no licence text, perfect Dynamic Type and optical sizing                                               | Lugn sounds like Apple Books. The serif is the brand's voice and New York is not that voice.                                                                                           |
| **Newsreader + SF Pro** (chosen)   | Keeps the one distinctive thing. Controls stay native: SF Symbols align, tabular digits, system text styles work | One font file (about 130 to 400 KB), one licence notice, a small helper for optical size                                                                                               |
| Newsreader + Familjen Grotesk      | Exact match with the web panel                                                                                   | Familjen has four weights and no optical sizes; at 12 to 15 pt beside SF Symbols it looks slightly off-system. Two families to register and test in widgets. Costs more than it gives. |

**Licensing.** Both families are under the SIL Open Font License 1.1. Bundling
in an app, including a paid one, is allowed. The licence text must ship with
the app (Inställningar › Om › Typsnitt) and the font cannot be sold by itself.
The `OFL.txt` in `web/fonts/` has a truncated copyright header; take the
licence file from the upstream Newsreader repository for the app. If the file
is subset or renamed, check upstream for a Reserved Font Name clause first.

**Performance.** Register the font once through `UIAppFonts` in Info.plist
(no runtime download, no flash of fallback). One variable TTF with the `opsz`
(6 to 72) and `wght` (200 to 800) axes covers every use. Do not ship the
italic. Widgets and Live Activities need the file in their own target; the
30 MB extension memory limit is not a concern for one font. Fall back to New
York (`.serif` design) if registration fails; never to a sans.

**Optical size.** `Font.custom` cannot set variation axes. Build the font
through `UIFontDescriptor` with `kCTFontVariationAttribute`, set `opsz` to the
point size (clamped 6 to 72) and `wght` to the weight, then scale with
`UIFontMetrics(forTextStyle:)`. The helper is in the brief.

### Scale

Sizes are points at the default Dynamic Type size. Line heights are absolute.

| Style         | Face       | Size / line | Weight  | Tracking | Scales with    | Used for                                  |
| ------------- | ---------- | ----------- | ------- | -------- | -------------- | ----------------------------------------- |
| `voiceTime`   | Newsreader | 92 / 96     | 300     | −3.5     | `.largeTitle`  | Wake time                                 |
| `voiceMoment` | Newsreader | 44 / 48     | 400     | −1.0     | `.largeTitle`  | "Godnatt."                                |
| `voiceHero`   | Newsreader | 38 / 42     | 400     | −0.75    | `.largeTitle`  | Hem sentence                              |
| `voiceState`  | Newsreader | 34 / 38     | 400     | −0.6     | `.largeTitle`  | Närvaro sentence, questions               |
| `voiceTitle`  | Newsreader | 32 / 36     | 500     | −0.5     | `.title`       | Screen titles                             |
| `voiceSheet`  | Newsreader | 26 / 30     | 500     | −0.4     | `.title2`      | Sheet title, track title                  |
| `voiceLine`   | Newsreader | 19 / 25     | 400     | −0.15    | `.body`        | Varför sentences, leads                   |
| `voiceNote`   | Newsreader | 16 / 22     | 400     | −0.05    | `.callout`     | "Because" lines under controls            |
| `readout`     | SF Pro     | 30 / 34     | 500     | −0.9     | `.title`       | Fader and volume values, tabular          |
| `instrument`  | SF Pro     | 21 / 25     | 500     | −0.5     | `.title3`      | Temperature, humidity, CO₂, tabular       |
| `tileName`    | SF Pro     | 17 / 21     | 600     | −0.35    | `.headline`    | Scene names, card titles, primary buttons |
| `body`        | SF Pro     | 17 / 22     | 400     | −0.3     | `.body`        | Navigation, room switcher                 |
| `rowTitle`    | SF Pro     | 16 / 21     | 500     | −0.25    | `.callout`     | Row titles, lamp names                    |
| `label`       | SF Pro     | 15 / 20     | 400–600 | −0.15    | `.subheadline` | Leads, notice titles, section names       |
| `status`      | SF Pro     | 13 / 18     | 400     | 0        | `.footnote`    | Tile status, details, timestamps          |
| `caption`     | SF Pro     | 12 / 16     | 400     | 0        | `.caption`     | Instrument labels, radar tags             |
| `tab`         | SF Pro     | 10 / 12     | 500     | +0.1     | system         | Tab bar labels                            |

Rules:

- A screen has at most one Newsreader size above 30 pt.
- Numbers that change in place are SF Pro with `.monospacedDigit()`. Numbers
  inside a sentence are Newsreader.
- No italics, no all caps, no letter-spaced labels, no monospace.
- Hero text is left aligned and wraps with `.lineLimit(4)`; it never shrinks
  to fit.

## 6. Space, shape, depth

**Grid.** 4 pt base. Screen gutter 20. Gap between tiles 10. Gap between
stacked cards 10 to 12. Space above a section name 26, below it 10.

**Radii** (all `.continuous`):

| Element                         | Radius   |
| ------------------------------- | -------- |
| Sheet top corners               | 38       |
| Tab bar, round buttons, pills   | capsule  |
| Fader track (vertical)          | 30       |
| Card, radar, now playing        | 26       |
| Scene tile, music row           | 22       |
| Notice row, source tile, volume | 20       |
| Lamp row                        | 18       |
| Expanded Varför event           | 16       |
| Artwork thumbnail               | 12 to 16 |

Radii fall as elements get smaller and more nested. Nothing shares one
radius across the whole app.

**Depth.** There are three layers and no drop shadows between content
surfaces.

1. The field: `page` plus pools.
2. Content: solid `raised` surfaces with a 1 pt inside hairline (`line`). Lit
   tiles replace the hairline with white at 16 %.
3. Chrome: Liquid Glass. Tab bar, the Varför strip above it, sheets, and
   small round floating buttons. Glass never carries a paragraph and never
   sits under a value you need to read at a glance. With Reduce Transparency
   it becomes `raised2` with a hairline.

**Sizes.** Touch targets are at least 44 × 44. Scene tiles are at least 96 pt
tall. Primary buttons are 54 pt tall capsules. Fader tracks are 292 pt tall;
the brightness fader is 138 pt wide, the two colour faders 78 pt.

**Safe areas and reach** (402 × 874, top inset 62, bottom inset 34). See
`png/hem-sakra-ytor.png`.

| Zone   | Points from top | Contains                                              |
| ------ | --------------- | ----------------------------------------------------- |
| Read   | 62 to 380       | Room switcher, hero sentence, instruments, titles     |
| Thumb  | 380 to 730      | Everything you operate: notice, scenes, music, faders |
| Chrome | 733 to 849      | Varför strip (46 pt), tab bar (62 pt)                 |

Nothing essential is top-right only. Close buttons are duplicated by
swipe-down. The one top-right action (ny scen) is secondary.

## 7. Icons

**SF Symbols 7** for everything that is not a scene. Weight `.medium` at
body size, `.semibold` when selected. Rendering mode is monochrome or
hierarchical; never multicolour, never palette.

| Use             | Symbol                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------- |
| Tabs            | `house`, `lightbulb`, `music.note`, `clock`, `slider.horizontal.3` (system fills the selected one) |
| Presence chip   | `person`, with the count beside it                                                                 |
| Notices         | `moon.stars`, `wifi.slash`, `exclamationmark.triangle`                                             |
| Transport       | `backward.end.fill`, `play.fill`, `pause.fill`, `forward.end.fill`                                 |
| Confirm         | `checkmark`, drawn in with the Draw On symbol effect                                               |
| Steppers, close | `plus`, `minus`, `xmark`                                                                           |
| Navigation      | system back chevron, `chevron.right` in notice rows                                                |

Symbol effects are limited to two: Draw On for the confirmation tick and
Replace for play/pause. No bounce, no pulse, no variable-colour loops.

**Scene pictograms are custom**, because they are the product's own
vocabulary and already exist on the Hub: power (Helt släckt), crescent
(Mysljus), sun (Vardagsljus), screen with play (Filmkväll), desk lamp
(Fokus), mirror ball (Party).

- 24 pt grid, 1.6 pt stroke, round caps and joins, no fills, 2 pt optical
  margin.
- Drawn inside a 38 pt circle on the tile: ember colour at 15 % behind, ember
  stroke. On a lit tile the circle is black at 10 % and the stroke takes the
  tile ink.
- Ship them as custom symbols (SVG templates exported from the SF Symbols app
  with ultralight, regular and black masters) so they scale with Dynamic Type
  and accept symbol effects. The paths are in `src/shared.js` (`PIC`).
- User-made scenes have no pictogram: the circle shows the first letter of
  the name in `tileName`, as the Hub keeps text for scenes whose meaning it
  cannot infer.

## 8. Motion

Light does not bounce. Fingers do. That is the whole rule set: anything that
represents light or information moves on critically damped curves; only a
control under your finger may overshoot, and only on release.

| Name       | What moves                                          | SwiftUI                                                                               |
| ---------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `tryckNed` | Tile or button scales to 0.965 on touch down        | `.spring(response: 0.16, dampingFraction: 1.0)`                                       |
| `tryckUpp` | It returns on release                               | `.spring(response: 0.30, dampingFraction: 0.72)`                                      |
| `sken`     | Tile fill spreads from the touch point              | `.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.46)`                                      |
| `rinnerUr` | Fill drains back to the touch point on failure      | same curve, 0.50 s                                                                    |
| `falt`     | Light field changes colour or level                 | `.easeInOut(duration: 1.2)`; 0.8 s when reverting                                     |
| `bock`     | Confirmation tick draws                             | Draw On, or trim 0→1 with `.easeOut(duration: 0.32)` after 0.05 s                     |
| `lopare`   | Waiting runner: 40 % wide bar along the tile's base | 1.4 s ease-in-out loop, shown only after 0.26 s                                       |
| `blad`     | Sheet rises, hold-zoom from the tile                | `.spring(response: 0.42, dampingFraction: 0.90)`                                      |
| `reglage`  | Fader follows the finger                            | no animation while dragging; `.spring(response: 0.22, dampingFraction: 0.90)` on snap |
| `siffra`   | Values change in place                              | `.contentTransition(.numericText())` with `.snappy(duration: 0.25)`                   |
| `andning`  | Field pools drift                                   | 9, 11 and 13 s, ease-in-out, autoreversing                                            |
| `spar`     | Radar trail fades                                   | 6 s linear fade, drawn only while moving                                              |
| `nej`      | Offline push-back on a tile                         | scale 0.97 then 1.012 then 1, 0.42 s                                                  |

**The signature motion** is `sken` followed by `falt`: you touch a scene, the
tile fills outward from your fingertip in 0.46 s, and the whole screen takes
on that light over the next 1.2 s. It happens on touch-up, before the network
answers. When the lamps confirm, only the tick draws.

Timing thresholds: hold recognition 0.38 s; "Väntar på lamporna" appears at
0.26 s; "Svarar långsamt" at 2.5 s; a command with no HTTP answer fails at
8 s.

With Reduce Motion, `sken` and `rinnerUr` become a 0.2 s cross-fade, `falt`
becomes a 0.3 s cross-fade, `andning` and `spar` are off, sheets fade, and
`tryckUpp` uses a damping fraction of 1.

## 9. Haptics

Haptics answer the finger and confirm the room. They never announce
something the user did not cause.

| Moment                                      | SwiftUI `SensoryFeedback`                      | Notes                                                     |
| ------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| Touch down on a scene tile                  | `.impact(flexibility: .soft, intensity: 0.5)`  | The answer to the finger                                  |
| Lamps confirmed the scene                   | `.impact(flexibility: .soft, intensity: 0.4)`  | Only within 5 s of the tap and while the app is frontmost |
| Command failed                              | `.error`                                       |                                                           |
| Tap while offline                           | `.warning`                                     | With the `nej` motion                                     |
| Hold recognised, sheet opens                | `.impact(weight: .medium)`                     | At 0.38 s                                                 |
| Brightness fader, every 5 %                 | `.impact(flexibility: .soft, intensity: 0.35)` | Muted above 160 %/s finger speed                          |
| Brightness fader, detent at 1, 25, 50, 75 % | `.selection`                                   | Magnet zone ±2.5 %; released above 220 %/s                |
| Brightness fader, end stops 0 and 100 %     | `.impact(flexibility: .rigid, intensity: 0.7)` | A wall, not a tick                                        |
| Warmth fader, 2200, 2700, 4000, 6500 K      | `.selection`                                   |                                                           |
| Colour fader, entering a named colour       | `.impact(flexibility: .soft, intensity: 0.35)` |                                                           |
| Lamp row, detents at 0, 25, 50, 75, 100 %   | `.selection`, rigid at the ends                |                                                           |
| Volume, every 5 points                      | `.selection`                                   | Same step as the Hub buttons                              |
| Volume handed to Lugn or taken back         | `.selection`                                   |                                                           |
| Play, pause, source                         | `.impact(weight: .light)`                      |                                                           |
| Scope chip, filter chip, radio choice       | `.selection`                                   |                                                           |
| Count correction tap                        | `.impact(weight: .light)`                      |                                                           |
| Sensor acknowledged the count               | `.impact(flexibility: .soft, intensity: 0.4)`  |                                                           |
| Count at its limit                          | `.impact(flexibility: .rigid, intensity: 0.7)` |                                                           |
| Wake time, each 5 minutes                   | `.selection`                                   |                                                           |
| Wake time, each full hour                   | `.impact(flexibility: .rigid, intensity: 0.6)` |                                                           |
| Godnatt started                             | `.impact(weight: .heavy, intensity: 0.6)`      | Once. The last haptic of the day.                         |
| Saved into a scene, pairing succeeded       | `.success`                                     |                                                           |
| Switches                                    | system                                         | The native Toggle already ticks                           |

Never: on presence changes, on automatic scene changes, on incoming Varför
entries, on reconnect, on scrolling, on tab changes.

Faders call `prepare()` on a `UIImpactFeedbackGenerator` at touch down so the
first tick is not late; `sensoryFeedback` alone is fine everywhere else.

## 10. Sound

None. The app makes no sound of any kind: no taps, no confirmations, no
errors. The room already has its own voice (the entry and exit chime played
from the sensor's host, and the lamps themselves). A phone that clicks while
the lights change is two things confirming one action. There is no setting
for this.

## 11. States

The rule behind every state: show the newest thing you know, say how old it
is when that matters, and never draw a spinner.

### Data

| State                 | Trigger                                     | What the user sees                                                                                                                                                                              |
| --------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loaded from cache     | App start, before the first snapshot        | The last state, fully drawn, at once. Field breathing is off until live. No banner unless the cache is over 60 s old.                                                                           |
| Live                  | SSE snapshot or patch within 45 s           | Normal. No "live" badge; the absence of a warning is the signal.                                                                                                                                |
| Stale                 | No event for 45 s, or cache older than 60 s | Values get a dotted underline and one line: "Mätt 14:02. Visas tills Lugn svarar igen."                                                                                                         |
| Offline               | Requests fail, stream closed                | Hero changes to "Når inte Lugn. Senast …", amber notice with countdown and manual retry, field desaturated and still, active tile becomes an outline, music row removed. See `png/offline.png`. |
| Reconnected           | Stream resumes                              | Everything returns in one 0.3 s cross-fade. No toast, no haptic.                                                                                                                                |
| Empty                 | Nothing to list                             | One Newsreader line that says so and one action: "Inga rutiner än. Börja med Godnatt."                                                                                                          |
| Sensor value missing  | `environment.*.value` is null               | "–" in `ink3` with the label kept. Never 0.                                                                                                                                                     |
| Presence unknown      | `presence.state == unknown`                 | "Vet inte om någon är här." A `?` in the presence chip. Never shown as empty.                                                                                                                   |
| Not paired or revoked | 401                                         | Full-screen pairing with the code field. "Telefonen är inte ihopparad längre. Para ihop igen."                                                                                                  |

### Commands (scene tile; other controls follow the same clock)

See `png/tillstand.png` and `png/tillstand-ljus.png`.

| State     | When                                   | Tile                                                                 | Text                     | Haptic        |
| --------- | -------------------------------------- | -------------------------------------------------------------------- | ------------------------ | ------------- |
| Idle      |                                        | `raised`, ember pictogram                                            | "35 %, glöd"             |               |
| Sending   | 0 to 0.26 s after touch-up             | Fill spreads from the finger; field starts to follow                 | "Skickar"                | soft on touch |
| Waiting   | Accepted, lamps not yet matching       | Filled, thin runner along the base                                   | "Väntar på lamporna"     |               |
| Confirmed | `matchesIntent` for the scene's lamps  | Filled, tick draws                                                   | "Aktiv" / "Släckt"       | soft          |
| Slow      | 2.5 s without confirmation             | As waiting                                                           | "Svarar långsamt"        |               |
| Failed    | HTTP error, 502, or 8 s with no answer | Fill drains to the touch point; field reverts; previous tile refills | "Gick inte. Tryck igen." | error         |
| Stale     | Offline or stale data                  | Outline in the ember colour, no fill                                 | "Senast 14:02"           |               |
| Refused   | Tap while offline                      | `nej` push-back, nothing sent                                        | "Når inte Lugn" for 2 s  | warning       |

Rules:

- Sending and waiting look almost the same on purpose. The user already has
  their answer.
- Retries reuse the same `requestId`, so a retry can never act twice.
- A second tap on another scene while one is waiting cancels the first tile's
  visuals at once; the last tap wins.
- A lamp that stays unreachable moves from the tile to the notice row
  ("Taklampan svarar inte. Fem av sex lampor lyser."). The tile itself
  confirms when the reachable lamps match.
- Commands are never queued while offline. A scene that fires twenty minutes
  later when the phone finds the network is worse than a refusal.
- Faders send while dragging at most every 120 ms and once on release. Their
  readout always shows the finger's value; the track's edge marker shows the
  last reported value when the two differ.

## 12. Accessibility

**Dynamic Type.** Every style scales with the text style in the table in
section 5. Layout changes instead of shrinking text:

- From `accessibility1`: scene tiles go to one column, the instrument row
  stacks, the three faders in the hold sheet become a paged control (one
  fader per page with the same order), chip rows wrap.
- Newsreader styles above 30 pt stop growing at `accessibility2`; everything
  else scales to `accessibility5`.
- The tab bar and the Varför strip use the system Large Content Viewer.

**VoiceOver.**

| Element    | Label, value, hint                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hero       | One element, read as written. Marked as a header.                                                                                                |
| Scene tile | "Mysljus", value "aktiv" / "skickar" / "väntar på lamporna" / "gick inte", trait button and selected. Custom action "Justera" replaces the hold. |
| Faders     | Adjustable. "Ljusstyrka, 35 procent". Swipe up or down moves 5 %. Warmth reads "2200 kelvin, glöd".                                              |
| Lamp row   | Adjustable. "Sänglampa, 12 procent". "Ändrad för hand" is part of the value.                                                                     |
| Volume     | Adjustable. "Volym, 24 procent. Lugn styr, målet är 24."                                                                                         |
| Radar      | One element: "En person, rör sig vid skrivbordet". The canvas itself is hidden.                                                                  |
| Varför row | "Lugn lät bli: släckte inte, väntar 60 sekunder på att du kommer tillbaka. 21:46, närvarosensorn." The outcome word comes first.                 |
| Notice     | "Fel: taklampan svarar inte. Fem av sex lampor lyser." Trait button.                                                                             |
| Offline    | Announced once with `AccessibilityNotification.Announcement`: "Når inte Lugn."                                                                   |

State changes from the user's own command are announced ("Mysljus, aktiv").
Automatic changes are not; they are in the feed.

**Reduce Motion.** Section 8. Nothing loops and nothing travels.

**Reduce Transparency.** All glass becomes `raised2` with a hairline. The
field stays (it is colour, not transparency).

**Increase Contrast.** `line` becomes `lineStrong`, `ink2` becomes `ink`,
`ink3` becomes `ink2`, `k` is halved, tiles get a 1.5 pt edge.

**Differentiate Without Colour.** Already satisfied by shape: acted is a
filled dot, let-be is a ring, observed is a small dot, failed is a filled dot
with the outcome word in the text, "you" is a white dot. With the setting on,
failed additionally uses a triangle. A lit tile always has the word "Aktiv"
and a tick, never colour alone.

**Colour vision.** Mint against coral is the only red-green pair. They never
appear as the sole difference between two otherwise identical marks.

**StandBy and widgets** (later). StandBy's night mode renders everything in
red monochrome and the lock screen can render in vibrant monochrome. Design
for luminance only: check `isLuminanceReduced` and `widgetRenderingMode`, use
the bar heights and digits to carry meaning, and keep the scene colour as an
enhancement in full-colour mode. The fifteen fade bars work in one colour.

**One-handed use.** Section 6. Every control sits between 380 and 730 pt from
the top on the reference device.

## 13. Components

Names are the Swift types the brief asks for. "Native" is the API each one
should be built on. Verify signatures against the SDK on the Mac; these are
the iOS 26 names.

| Component                 | What it is                                          | Native API and notes                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LightField`              | The room light field behind every screen            | `MeshGradient(width: 3, height: 4, …)` inside `TimelineView(.animation(minimumInterval: 1/20, paused:))`. Bottom two rows are `page`. Grain through `.layerEffect` (or `.colorEffect`) with a small noise shader; a tiled noise image with `.blendMode(.overlay)` is an acceptable first version. Lives once, behind the `TabView`, so it never restarts between tabs. |
| `HeroSentence`            | The Newsreader sentence on Hem                      | `Text` with the voice font helper. Changes with `.contentTransition(.opacity)`, never numeric text. Collapses with `onScrollGeometryChange`: above 40 pt of scroll it fades and the room name stays.                                                                                                                                                                   |
| `InstrumentRow`           | Temperature, humidity, CO₂                          | `Grid`. Values use `.monospacedDigit()` and `.contentTransition(.numericText())`.                                                                                                                                                                                                                                                                                      |
| `NoticeRow`               | The notification layer                              | Plain `Button` on `raised`. Inserted and removed with `.transition(.opacity.combined(with: .move(edge: .top)))` inside `withAnimation(blad)`. At most two rows; more collapse into "2 saker till".                                                                                                                                                                     |
| `SceneTile`               | Scene button with the spread fill                   | Custom `ButtonStyle` is not enough: use `DragGesture(minimumDistance: 0)` to read the touch point plus a 0.38 s timer for hold. Fill is a `Circle` scaled from the touch `UnitPoint`, clipped by `RoundedRectangle(cornerRadius: 22, style: .continuous)`. Tick uses `.symbolEffect(.drawOn)`. `.sensoryFeedback` per state.                                           |
| `HoldSheet`               | Brightness, warmth and colour for a scene or lamp   | `.sheet` with `.presentationDetents([.fraction(0.72)])` and system glass background. Open with `matchedTransitionSource(id:in:)` on the tile and `.navigationTransition(.zoom(sourceID:in:))` on the sheet content.                                                                                                                                                    |
| `Fader`                   | Vertical fader with detents                         | `DragGesture(minimumDistance: 0)` on a clipped `RoundedRectangle`. No animation while dragging. Detent logic and haptics in the brief. `.accessibilityRepresentation { Slider(…) }`.                                                                                                                                                                                   |
| `KelvinFader`, `HueFader` | Narrow faders with a gradient track and a bar thumb | `LinearGradient` track with the stops from section 3. The inactive one drops to 38 % opacity with a hollow thumb.                                                                                                                                                                                                                                                      |
| `LampRow`                 | A row that is its own dimmer                        | Horizontal `Fader` variant. Uses `.simultaneousGesture` and only claims the drag after 8 pt of horizontal travel so the list still scrolls.                                                                                                                                                                                                                            |
| `VolumeFader`             | Volume with Lugn's target marker                    | Horizontal `Fader`. Marker is a 2 pt mint line with an 8 pt dot. Dragging switches authority to "Jag styr" without sending a volume until release.                                                                                                                                                                                                                     |
| `AuthoritySwitch`         | Lugn styr / Jag styr                                | Two buttons in a `raised` capsule. Selection highlight moves with `matchedGeometryEffect`. Reflects backend authority; shows neither when unknown.                                                                                                                                                                                                                     |
| `NowPlayingCard`          | Artwork, title, transport                           | Transport buttons in a `GlassEffectContainer` only when the card floats over artwork; on the solid card they are plain. Play/pause uses `.contentTransition(.symbolEffect(.replace))`.                                                                                                                                                                                 |
| `WhyStrip`                | The newest decision, above the tab bar on every tab | `.tabViewBottomAccessory { }`. Reads `tabViewBottomAccessoryPlacement` to drop the time when inline. New entries cross-fade; no slide, no badge.                                                                                                                                                                                                                       |
| `WhyTimeline`             | Decisions grouped by cause                          | `List` with plain style or `LazyVStack` in a `ScrollView`. Rows fade near the edges with `.scrollTransition`. Expanding uses `withAnimation(blad)`. The connecting line is a 1 pt `Rectangle` in a row background.                                                                                                                                                     |
| `PresenceRadar`           | Top-down room with trails                           | `Canvas` inside `TimelineView(.animation(paused: !isMoving))`, so it draws nothing while still. Room outline is static and cached with `.drawingGroup()`.                                                                                                                                                                                                              |
| `CountStepper`            | Correct the person count                            | Two 46 pt round buttons. The number changes only on acknowledgement, with `.contentTransition(.numericText())`.                                                                                                                                                                                                                                                        |
| `WakeTime`                | The large time in Godnatt                           | `Text` with `voiceTime`, vertical `DragGesture` (14 pt per 5 minutes) plus two glass steppers in a `GlassEffectContainer`. `.accessibilityAdjustableAction`.                                                                                                                                                                                                           |
| `FadeBars`                | Fifteen bars, one per minute                        | `HStack` of `RoundedRectangle`. Shared by the app, the Live Activity and the Dynamic Island.                                                                                                                                                                                                                                                                           |
| `SignalCard`              | One phone signal with its last sent value           | Native `Toggle` with `.tint(mint)`. The permission prompt is requested when the toggle is turned on, not before.                                                                                                                                                                                                                                                       |
| `Ledger`                  | What the phone has sent                             | Plain rows. Reads the same local log the upload queue writes.                                                                                                                                                                                                                                                                                                          |
| `RoomSwitcher`            | Sovrum / Skrivbord                                  | Two text buttons; the hero pages horizontally with `.scrollTargetBehavior(.paging)`.                                                                                                                                                                                                                                                                                   |
| Tab bar                   | Five tabs                                           | Native `TabView` with `Tab` values. Do not restyle it. `.tabBarMinimizeBehavior(.onScrollDown)` on Belysning and Varför.                                                                                                                                                                                                                                               |
| Live Activity             | Godnatt countdown (later)                           | ActivityKit. `Text(timerInterval:countsDown:)` and `ProgressView(timerInterval:)` so it ticks without updates.                                                                                                                                                                                                                                                         |
| `Haptics`                 | One place that owns the map in section 9            | `SensoryFeedback` values as static members; `UIImpactFeedbackGenerator.prepare()` for faders.                                                                                                                                                                                                                                                                          |

## 14. Screens

| Screen                 | Prototype                          | The idea in one line                                                                 |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| Hem, evening           | `screens/hem.html`                 | One sentence, three numbers, the four scenes that fit the hour, music, the last why. |
| Hem, day, light        | `screens/hem-ljus.html`            | The same screen in daylight, with a lamp error in the notice row.                    |
| Offline                | `screens/offline.html`             | What Lugn last knew, when, and when it will try again.                               |
| Belysning              | `screens/belysning.html`           | Six scenes, then every lamp as its own dimmer.                                       |
| Hold sheet             | `screens/belysning.html?sheet=mys` | Three faders side by side: brightness, warmth, colour.                               |
| Musik                  | `screens/musik.html`               | Who controls the volume, and why it is where it is.                                  |
| Närvaro                | `screens/narvaro.html`             | A radar that draws only what moved, and a held ring for someone sitting still.       |
| Godnatt                | `screens/godnatt.html`             | One question, three answers, then fifteen bars going dark.                           |
| Lock screen and island | `screens/godnatt-live.html`        | The same fifteen bars, for later.                                                    |
| Varför                 | `screens/varfor.html`              | Causes first, then what Lugn did and what it let be.                                 |
| Telefonen              | `screens/telefon.html`             | Four signals in plain words, and a ledger of exactly what was sent.                  |
| Tillstånd              | `screens/tillstand.html`           | Every state of a scene tile and the three kinds of notice.                           |

Hem orders its four scenes by room and hour, following the Hub roles: Sovrum
leads with Helt släckt and Mysljus, Skrivbord with Fokus and Vardagsljus. All
six are always one tab away.
