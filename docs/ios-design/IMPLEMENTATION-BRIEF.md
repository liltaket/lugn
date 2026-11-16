# Lugn for iPhone: implementation brief

Build these six things first, in this order. Together they are about 80 % of
how the app feels. Everything after them is layout.

1. Tokens and the voice font
2. Haptics helper
3. `LightField`
4. `SceneTile`
5. `Fader`
6. Hem: hero sentence, instruments, notice row, Varför strip

The reasoning is in [DESIGN.md](DESIGN.md). The reference for every pixel is
the prototype in `screens/` and its screenshot in `png/`. When this brief and
a prototype disagree, the prototype's CSS in `src/shared.css` is the measured
truth; tell design.

The Swift below is a sketch. It was written without a compiler (this branch
was produced on Linux), so treat names and signatures as intent and fix them
against the SDK. The numbers are exact.

Target: iOS 26 or later APIs, SwiftUI only, no third-party packages. Tokens
and components belong in the design module (`LugnDesign`); they must not
import networking.

## 1. Tokens and the voice font

Done when: a preview shows every colour in both appearances, and "Mysljus i
sovrummet." renders in Newsreader at 38 pt with optical size applied.

### Colour

```swift
import SwiftUI

/// sRGB triple kept as numbers so the light field can do maths on it.
struct RGB: Equatable {
    var r, g, b: Double
    init(_ hex: UInt32) {
        r = Double((hex >> 16) & 0xFF) / 255
        g = Double((hex >> 8) & 0xFF) / 255
        b = Double(hex & 0xFF) / 255
    }
    init(r: Double, g: Double, b: Double) { (self.r, self.g, self.b) = (r, g, b) }
    var color: Color { Color(.sRGB, red: r, green: g, blue: b) }

    func mix(_ other: RGB, _ t: Double) -> RGB {
        RGB(r: r + (other.r - r) * t, g: g + (other.g - g) * t, b: b + (other.b - b) * t)
    }
    /// WCAG relative luminance.
    var luminance: Double {
        func lin(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }
}

enum LugnColor {
    // Use an asset catalogue or a dynamic provider; values are dark / light.
    static let page       = dyn(0x06090D, 0xEDF1F0)
    static let raised     = dyn(0x0D1319, 0xF8FAF9)
    static let raised2    = dyn(0x121A22, 0xFFFFFF)
    static let raised3    = dyn(0x18222C, 0xE3E9E7)
    static let ink        = dyn(0xECF0F2, 0x0C1613)
    static let ink2       = dyn(0xAAB5BE, 0x43514C)
    static let ink3       = dyn(0x7F8B96, 0x5F6C67)
    static let inkField2  = dyn(0xD3DADE, 0x43514C)   // secondary text on the light field
    static let mint       = dyn(0x8FF0C4, 0x0B7A55)
    static let mintInk    = dyn(0x032015, 0xFFFFFF)
    static let warn       = dyn(0xF2D38C, 0x7A5200)
    static let bad        = dyn(0xFF9D94, 0xB3362B)
    static let nightInk   = Color(.sRGB, red: 0xC9 / 255, green: 0xB8 / 255, blue: 0xA8 / 255) // Nattbläck
    // line: 0xD6E4EE at 10 % (dark), 0x0C1613 at 9 % (light)
    // lineStrong: 0xD6E4EE at 20 % (dark), 0x0C1613 at 18 % (light)
    // washes for notice icons: mint 12 %, warn 12 %, bad 12 % (dark); 10 %, 14 %, 9 % (light)
}
```

### Scenes

```swift
struct SceneLook {
    var pools: [RGB]          // bed lamp, desk lamp, wash (dark appearance)
    var poolsLight: [RGB]
    var k: Double             // field strength, dark
    var kLight: Double
    var fill: [RGB]           // lit tile gradient, top-leading to bottom-trailing
    var litInk: RGB
    var ember: RGB            // idle pictogram, dark
    var emberLight: RGB
}

let looks: [String: SceneLook] = [
    "scene.all_off": .init(pools: [.init(0x16263A), .init(0x0E1A2A), .init(0x0A121C)],
                           poolsLight: [.init(0xC9D6DE), .init(0xD6DFE4), .init(0xDFE6E8)],
                           k: 0.55, kLight: 0.50, fill: [], litInk: .init(0xECF0F2),
                           ember: .init(0xAAB5BE), emberLight: .init(0x43514C)),
    "scene.soft_light": .init(pools: [.init(0xFF9A45), .init(0xFFB066), .init(0xC85F2A)],
                              poolsLight: [.init(0xFFC48A), .init(0xFFD3A6), .init(0xFFE1C2)],
                              k: 0.90, kLight: 0.95, fill: [.init(0xFFB873), .init(0xF0934A)],
                              litInk: .init(0x2B1505), ember: .init(0xFFA95C), emberLight: .init(0xB85A12)),
    "scene.everyday_light": .init(pools: [.init(0xFFC07C), .init(0xFFD29C), .init(0xF0A45C)],
                                  poolsLight: [.init(0xFFD9AE), .init(0xFFE6C8), .init(0xFFF0DC)],
                                  k: 0.80, kLight: 0.90, fill: [.init(0xFFE0B8), .init(0xFFC88C)],
                                  litInk: .init(0x2A1A08), ember: .init(0xFFCF9A), emberLight: .init(0xA86A14)),
    "scene.movie_light": .init(pools: [.init(0xC9542A), .init(0x3F5BF0), .init(0x7A2F22)],
                               poolsLight: [.init(0xF2B89C), .init(0xB9C6FF), .init(0xF3D6C8)],
                               k: 0.80, kLight: 0.80, fill: [.init(0xA94A22), .init(0x7A3224), .init(0x2B3F9E)],
                               litInk: .init(0xFFF3EA), ember: .init(0xE8743C), emberLight: .init(0xA8421A)),
    "scene.focus_light": .init(pools: [.init(0xF6ECDC), .init(0xDFE9F4), .init(0xFFF3DF)],
                               poolsLight: [.init(0xFFFFFF), .init(0xD6E4F5), .init(0xFFF1D6)],
                               k: 0.76, kLight: 1.00, fill: [.init(0xFFFAF2), .init(0xECEFEE)],
                               litInk: .init(0x14181A), ember: .init(0xF3EDE2), emberLight: .init(0x4D5A56)),
    "scene.party": .init(pools: [.init(0xFF3F9A), .init(0x3CC4FF), .init(0x7A4CFF)],
                         poolsLight: [.init(0xFFB3D8), .init(0xB3E6FF), .init(0xD2C2FF)],
                         k: 0.95, kLight: 0.90, fill: [.init(0xD81F84), .init(0x7438EA), .init(0x1487C9)],
                         litInk: .init(0xFFFFFF), ember: .init(0xFF6FB5), emberLight: .init(0xB8257A)),
]
```

Filmkväll's gradient stops sit at 0 %, 52 % and 135 % along a 150° line;
Party's at 0 %, 55 % and 120 % along 135°. Two-stop fills run at 165°.

The scene ids above are the ones in `docs/api/fixtures/state.json`; the Party
id is a guess, read it from state. A scene without a look gets one derived
from its lamps (DESIGN.md, section 3).

Kelvin ramp, linear in sRGB between stops: 2000 `FF8C3A`, 2200 `FFA24F`, 2700
`FFBE7D`, 4000 `FFE9CF`, 5000 `F7F3EE`, 6500 `DFE9FF`.

### Shape and space

```swift
enum LugnMetric {
    static let gutter: CGFloat = 20
    static let tileGap: CGFloat = 10
    static let cardGap: CGFloat = 12
    static let sectionAbove: CGFloat = 26
    static let sectionBelow: CGFloat = 10

    static let rSheet: CGFloat = 38
    static let rFader: CGFloat = 30
    static let rCard: CGFloat = 26
    static let rTile: CGFloat = 22
    static let rNotice: CGFloat = 20
    static let rLampRow: CGFloat = 18
    static let rEvent: CGFloat = 16

    static let tileMinHeight: CGFloat = 96
    static let tilePadding = EdgeInsets(top: 14, leading: 16, bottom: 13, trailing: 14)
    static let pictogramCircle: CGFloat = 38     // glyph 22, stroke 1.6
    static let buttonHeight: CGFloat = 54
    static let faderHeight: CGFloat = 292
    static let faderWidth: CGFloat = 138         // brightness
    static let faderNarrow: CGFloat = 78         // warmth, colour
    static let lampRowHeight: CGFloat = 58
    static let volumeHeight: CGFloat = 56
    static let hairline: CGFloat = 1             // inside stroke, LugnColor.line
}
```

All rounded rectangles use `style: .continuous`. No shadows on content
surfaces.

### Motion

```swift
enum LugnMotion {
    static let tryckNed = Animation.spring(response: 0.16, dampingFraction: 1.0)
    static let tryckUpp = Animation.spring(response: 0.30, dampingFraction: 0.72)
    static let sken     = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.46)
    static let rinnerUr = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.50)
    static let falt     = Animation.easeInOut(duration: 1.2)
    static let faltBack = Animation.easeInOut(duration: 0.8)
    static let bock     = Animation.easeOut(duration: 0.32).delay(0.05)
    static let blad     = Animation.spring(response: 0.42, dampingFraction: 0.90)
    static let reglage  = Animation.spring(response: 0.22, dampingFraction: 0.90)
    static let siffra   = Animation.snappy(duration: 0.25)

    static let pressScale: CGFloat = 0.965
    static let holdDelay: Duration = .milliseconds(380)
    static let waitingAfter: Duration = .milliseconds(260)
    static let slowAfter: Duration = .milliseconds(2500)
    static let failAfter: Duration = .seconds(8)
    static let confirmHapticWindow: Duration = .seconds(5)
}
```

With `accessibilityReduceMotion`: `sken` and `rinnerUr` become
`.easeInOut(duration: 0.2)` opacity changes, `falt` becomes 0.3 s, `tryckUpp`
uses `dampingFraction: 1`.

### Voice font

Bundle the upstream Newsreader variable TTF (roman only, `opsz` and `wght`
axes) and list it under `UIAppFonts`. Ship the upstream `OFL.txt` and show it
in Inställningar › Om.

```swift
import UIKit
import CoreText

extension Font {
    /// Newsreader with optical size set from the point size.
    static func voice(_ size: CGFloat, weight: CGFloat = 400,
                      relativeTo style: UIFont.TextStyle = .largeTitle,
                      maxScale: CGFloat = 1.6) -> Font {
        let opsz = min(max(size, 6), 72)
        let axes: [NSNumber: NSNumber] = [
            0x6F70_737A: opsz as NSNumber,     // 'opsz'
            0x7767_6874: weight as NSNumber,   // 'wght'
        ]
        let key = UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String)
        let descriptor = UIFontDescriptor(fontAttributes: [.family: "Newsreader", key: axes])
        let base = UIFont(descriptor: descriptor, size: size)
        let scaled = UIFontMetrics(forTextStyle: style)
            .scaledFont(for: base, maximumPointSize: size * maxScale)
        return Font(scaled)
    }
}
```

Confirm the family name with `UIFont.familyNames` after registering. If the
font is missing, fall back to `.system(size:weight:design: .serif)`.

| Style         | Call                                              | Line height | Tracking |
| ------------- | ------------------------------------------------- | ----------- | -------- |
| `voiceTime`   | `.voice(92, weight: 300)`                         | 96          | −3.5     |
| `voiceMoment` | `.voice(44)`                                      | 48          | −1.0     |
| `voiceHero`   | `.voice(38)`                                      | 42          | −0.75    |
| `voiceState`  | `.voice(34)`                                      | 38          | −0.6     |
| `voiceTitle`  | `.voice(32, weight: 500, relativeTo: .title1)`    | 36          | −0.5     |
| `voiceSheet`  | `.voice(26, weight: 500, relativeTo: .title2)`    | 30          | −0.4     |
| `voiceLine`   | `.voice(19, relativeTo: .body, maxScale: 2.2)`    | 25          | −0.15    |
| `voiceNote`   | `.voice(16, relativeTo: .callout, maxScale: 2.2)` | 22          | −0.05    |

SF Pro styles (`.system`, with `.monospacedDigit()` where marked):

| Style        | Size / line | Weight   | Tracking | Digits  |
| ------------ | ----------- | -------- | -------- | ------- |
| `readout`    | 30 / 34     | medium   | −0.9     | tabular |
| `instrument` | 21 / 25     | medium   | −0.5     | tabular |
| `tileName`   | 17 / 21     | semibold | −0.35    |         |
| `body`       | 17 / 22     | regular  | −0.3     |         |
| `rowTitle`   | 16 / 21     | medium   | −0.25    |         |
| `label`      | 15 / 20     | regular  | −0.15    |         |
| `status`     | 13 / 18     | regular  | 0        | tabular |
| `caption`    | 12 / 16     | regular  | 0        |         |

Set line height with `.lineSpacing(lineHeight - font.lineHeight)` or a small
`ViewModifier`; do not rely on defaults for Newsreader.

## 2. Haptics helper

Done when: every entry below can be triggered from a debug screen on a real
phone and feels different from its neighbours.

```swift
enum Haptics {
    static let tileDown      = SensoryFeedback.impact(flexibility: .soft, intensity: 0.5)
    static let confirmed     = SensoryFeedback.impact(flexibility: .soft, intensity: 0.4)
    static let failed        = SensoryFeedback.error
    static let refused       = SensoryFeedback.warning
    static let holdOpened    = SensoryFeedback.impact(weight: .medium)
    static let faderStep     = SensoryFeedback.impact(flexibility: .soft, intensity: 0.35)
    static let faderDetent   = SensoryFeedback.selection
    static let faderEnd      = SensoryFeedback.impact(flexibility: .rigid, intensity: 0.7)
    static let hourDetent    = SensoryFeedback.impact(flexibility: .rigid, intensity: 0.6)
    static let choice        = SensoryFeedback.selection
    static let transport     = SensoryFeedback.impact(weight: .light)
    static let bedtimeStart  = SensoryFeedback.impact(weight: .heavy, intensity: 0.6)
    static let saved         = SensoryFeedback.success
}
```

Attach with `.sensoryFeedback(_:trigger:)` on a value that changes exactly
once per event (a counter or the state enum). Faders fire many times a second:
there, hold a `UIImpactFeedbackGenerator(style: .soft)` and a
`UISelectionFeedbackGenerator`, call `prepare()` at touch down, and fire
directly from the gesture.

Confirmation haptic rule: fire `confirmed` only if the command was sent by
this phone, less than 5 s ago, and the scene is active (`scenePhase ==
.active`). No haptic for anything the user did not cause.

## 3. `LightField`

Done when: switching between Mysljus, Fokus, Filmkväll and Helt släckt in a
preview changes the whole background over 1.2 s, text placed anywhere in the
top half stays readable, and the field looks like `png/hem.png`.

One instance, placed behind the `TabView`, driven by an observable model:

```swift
struct FieldState: Equatable {
    var pools: [RGB]      // 3 colours
    var k: Double         // scene strength
    var level: Double     // 0.35 + 0.65 * mean brightness of lamps that are on
    var dim: Double = 1   // 0.45 confirmed empty, 0.30 unknown, 0.55 offline
    var frozen = false    // offline or stale: no drift, 15 % saturation
}
```

Rendering:

```swift
struct LightField: View {
    var state: FieldState
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 20, paused: reduceMotion || state.frozen)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            MeshGradient(width: 3, height: 4, points: points(t), colors: colors())
        }
        .overlay(Grain().opacity(scheme == .dark ? 0.07 : 0.05).blendMode(.overlay))
        .ignoresSafeArea()
        .animation(LugnMotion.falt, value: state)
    }
}
```

- **Grid.** 3 columns, 4 rows. Row y positions: 0, 0.26, 0.60, 1.
- **Colours.** With `page` as the base and `a`, `b`, `c` the three pools:

  | Row        | Left       | Centre     | Right      |
  | ---------- | ---------- | ---------- | ---------- |
  | 0 (top)    | `a × 0.35` | `c × 0.50` | `b × 1.00` |
  | 1 (y 0.26) | `a × 1.00` | `c × 0.70` | `b × 0.55` |
  | 2 (y 0.60) | page       | page       | page       |
  | 3 (bottom) | page       | page       | page       |

  `x × w` means `clamp(page.mix(x, t × w))` with
  `t = 0.5 × k × level × dim` in dark and `t = 0.5 × kLight × level × dim` in
  light (`t` capped at 0.5).

- **The clamp is the contrast law.** In dark mode, reduce the mix until
  relative luminance is at most 0.10:

  ```swift
  func clampToField(_ color: RGB, page: RGB, maxLuminance: Double = 0.10) -> RGB {
      var c = color
      var guardCount = 0
      while c.luminance > maxLuminance, guardCount < 24 {
          c = c.mix(page, 0.12)
          guardCount += 1
      }
      return c
  }
  ```

  In light mode clamp the other way: luminance at least 0.62. With Increase
  Contrast (`contrast == .increased`), halve `t`.

- **Drift.** Only the two interior points of row 1 and the centre point of row
  0 move: `x += 0.03 × sin(2π t / 9)`, `y += 0.025 × sin(2π t / 11)`, and the
  third on a 13 s period. Edge points never move.
- **Frozen.** Desaturate pool colours to 15 % (mix each toward its own grey)
  and pause the timeline.
- **Grain.** First version: a 160 pt tiled monochrome noise PNG. Better: a
  `layerEffect` or `colorEffect` shader that adds ±1.5 % luminance noise per
  pixel. It hides OLED banding.
- **Tall floor** (Godnatt fade, pairing): move row 2 to y 0.80.
- **Cost.** 20 fps is enough; this must not show up in Instruments as more
  than a few percent GPU. Pause in Low Power Mode
  (`ProcessInfo.processInfo.isLowPowerModeEnabled`) and when the scene phase
  is not active.

Text on the field may use `ink` and `inkField2` only. Add a debug overlay
that samples luminance under each text frame and asserts the ratios in
DESIGN.md section 4.

## 4. `SceneTile`

Done when: tapping fills from the exact touch point, the fill is visible
before any network call returns, a forced failure drains it back, and holding
0.38 s opens a sheet without also firing the scene. Compare with
`png/tillstand.png`.

```swift
enum TilePhase: Equatable {
    case idle
    case sending            // 0 ..< 0.26 s
    case waiting            // accepted, lamps not matching yet
    case confirmed
    case slow               // 2.5 s without confirmation
    case failed
    case stale(since: Date) // offline or stale data: outline only
}
```

Layout (402 pt wide screen, two columns, 10 pt gap, 20 pt gutters):

- Minimum height 96. Padding 14 / 16 / 13 / 14 (top, leading, bottom,
  trailing). Radius 22.
- Top-leading: 38 pt circle with the 22 pt pictogram (stroke 1.6).
- Bottom-leading: name in `tileName`, then one status line in `status`, 1 pt
  apart. The status line always occupies 17 pt so names line up across tiles.
- Idle: background `raised`, 1 pt inside stroke `line`, circle is the ember at
  15 %, glyph is the ember, status is `ink3`.
- Lit (sending, waiting, slow, confirmed): the fill gradient, stroke is white
  at 16 %, circle is black at 10 %, text and glyph are `litInk`, status is
  `litInk` at 86 %.
- Confirmed adds a 13 pt tick (stroke 2.2) before the status text.
- Waiting and slow add a 2 pt runner at the bottom edge: 40 % of the width,
  `litInk` at 50 %, 1.4 s ease-in-out loop.
- Failed: no fill, status in `bad`.
- Stale: no fill, 1.5 pt inside stroke in the ember at 55 %.
- Helt släckt never fills. Its lit state is `raised2` with a 1.5 pt `ink`
  stroke.
- Light appearance: Fokus lit is white with a 1.5 pt `ink` stroke.

Behaviour:

1. Touch down: record the location as a `UnitPoint`, scale to 0.965 with
   `tryckNed`, fire `Haptics.tileDown`, start a 0.38 s task.
2. Timer fires while still down: mark held, fire `Haptics.holdOpened`,
   present the hold sheet with a zoom from the tile. Releasing now does
   nothing else.
3. Touch up before the timer: cancel it, scale back with `tryckUpp`, set
   `sending`, clear every other tile, tell `LightField` the new scene, and
   send the command. All of this in the same run-loop turn as the touch-up.
4. Fill: a `Circle` centred on the touch point, scaled from 0 to cover the
   farthest corner, animated with `sken`, clipped to the tile shape.
5. 0.26 s later, if not confirmed: `waiting`. At 2.5 s: `slow`.
6. Confirmed when every reachable lamp in the scene reports `matchesIntent`
   in a state patch newer than the command. Draw the tick with `bock`.
7. Failed on an HTTP error or after 8 s with no answer: animate the circle
   back to 0 with `rinnerUr`, restore the previous scene's tile and field
   (`faltBack`), fire `Haptics.failed`.
8. Offline: do not send. Run the `nej` push-back (scale 0.97, 1.012, 1 over
   0.42 s), show "Når inte Lugn" for 2 s, fire `Haptics.refused`.

Use a `DragGesture(minimumDistance: 0)` for touch location, and cancel the
press if the finger moves more than 10 pt so scrolling still works. Reuse the
same `requestId` for retries of one tap.

Accessibility: one button, label is the scene name, value is the phase in
words, selected trait when confirmed, custom action "Justera" opens the hold
sheet.

## 5. `Fader`

Done when: dragging slowly you feel a tick at each 5 %, a firmer click that
holds the value at 25, 50 and 75 %, and a wall at 0 and 100 %; dragging fast
you feel only the walls. Compare with `png/belysning-hall-blad.png`.

```swift
struct FaderSpec {
    var range: ClosedRange<Double> = 0...100
    var detents: [Double] = [0, 1, 25, 50, 75, 100]
    var magnet: Double = 2.5        // snap zone, ± units
    var step: Double = 5            // soft tick spacing
    var releaseSpeed: Double = 220  // units per second: above this, detents do not grab
    var quietSpeed: Double = 160    // above this, soft ticks are muted
}
```

Per drag sample:

1. `raw` = finger position mapped to the range (bottom is the minimum).
2. `speed` = |`raw` − previous `raw`| ÷ Δt, in units per second.
3. `d` = the detent within `magnet` of `raw`, if any.
4. If `d` exists and `speed < releaseSpeed`, `value = d`. Otherwise
   `value = raw`.
5. If `d` exists and differs from the last detent fired: fire `faderEnd` for
   the range ends, `faderDetent` for the others.
6. Else if `round(value / step)` changed and `speed < quietSpeed`: fire
   `faderStep`.
7. Never animate `value` during a drag. On release, if within `magnet` of a
   detent, settle with `reglage`.

Presets:

| Fader      | Range       | Detents                                 | Magnet | Step  |
| ---------- | ----------- | --------------------------------------- | ------ | ----- |
| Brightness | 0 to 100 %  | 0, 1, 25, 50, 75, 100                   | 2.5    | 5     |
| Warmth     | 2000–6500 K | 2200, 2700, 4000, 6500                  | 135 K  | none  |
| Colour     | hue 0 to 1  | none; soft tick entering each of 8 hues |        | 0.125 |
| Lamp row   | 0 to 100 %  | 0, 25, 50, 75, 100                      | 3      | none  |
| Volume     | 0 to 100    | every 5                                 | 1.2    | none  |

Drawing (brightness): track 138 × 292, radius 30, `raised3` with a 1 pt
`line` stroke. Fill from the bottom in the current light colour (kelvin ramp
or chosen hue). A 38 × 5 pt grip, black at 28 %, sits 15 pt below the fill's
top edge and fades out below 8 %. A scale of 21 ticks runs down the left
side: 7 pt every 5 %, 13 pt every 25 %, 18 pt and `ink` on the active detent.
Readout above in `readout`: "35 %", or "Av" at 0.

Warmth and colour: 78 × 292, radius 30, gradient track, a 12 pt tall white
bar thumb inset 7 pt with a 1.5 pt dark edge. Whichever of the two was touched
last is active; the other drops to 38 % opacity with a hollow thumb, and its
readout says "Av".

Sending: at most one command per 120 ms while dragging, always one on
release. The readout shows the finger's value at all times.

Accessibility: `.accessibilityRepresentation { Slider(value:in:step:) }` with
a 5 % step and a spoken value ("35 procent", "2200 kelvin, glöd").

## 6. Hem

Done when: the app launched from a cached state shows `png/hem.png` in the
first frame, without a loading state.

Top to bottom on a 402 × 874 screen:

| Element       | Position and size                                 | Notes                                                                                                                                                                               |
| ------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Room switcher | y 62, height 44, gutter 20                        | Active room `body` semibold in `ink`; other room `body` regular in `inkField2`; 16 pt apart. Presence chip right: 32 pt capsule, `ink` at 9 %, `person` symbol 17 pt and the count. |
| Hero sentence | 30 pt below, max width 350                        | `voiceHero`, `ink`, left aligned, up to 4 lines.                                                                                                                                    |
| Instruments   | 22 pt below, three columns 26 pt apart            | Value `instrument` in `ink`, unit `status` in `inkField2`, label `caption` in `inkField2`.                                                                                          |
| Notice row    | 22 pt below, min height 60, radius 20             | Only when there is something. 36 pt icon circle, title `label` semibold, detail `status` in `ink2`, 16 pt chevron in `ink3`.                                                        |
| Scenes        | 20 pt below, 2 × 2 tiles                          | The four for this room and hour.                                                                                                                                                    |
| Music row     | 10 pt below, radius 22, padding 10                | 46 pt artwork (radius 12), title `label` semibold, detail `status`, volume `status` medium, 44 pt play/pause circle.                                                                |
| Varför strip  | bottom accessory: 46 pt capsule, 22 pt side inset | 8 pt dot, sentence in `label` medium, time in `status`. `.tabViewBottomAccessory`.                                                                                                  |
| Tab bar       | system                                            | Hem, Belysning, Musik, Rutiner, Inställningar.                                                                                                                                      |

Build the hero from state with the rules in DESIGN.md section 2. It is plain
string assembly; keep it in one pure function with tests for every clause.

Notice priority, highest first, at most two shown: offline, failed lamp,
exit pending, running routine, upcoming routine within 12 hours, suggestion.

Outcome dots (Varför strip and timeline): acted is an 8 pt `mint` disc;
skipped is an 8 pt ring, 1.6 pt, `ink2`; observed is a 6 pt `ink3` disc;
failed is an 8 pt `bad` disc; your own action is an 8 pt `ink` disc.

## After the first six

In this order. Each has a prototype and a screenshot.

1. **Offline and stale** (`offline.html`). It is mostly the same Hem with
   `FieldState.frozen`, stale tiles and one notice. Do it early; it shapes the
   store.
2. **Hold sheet** (`belysning.html?sheet=mys`): three `Fader`s, scope chips,
   "Spara i …" and "Ångra". Sheet detent 0.72 of the screen. Zoom transition
   from the tile.
3. **Lamp rows** (`belysning.html`): 58 pt rows that are horizontal faders.
   Fill is the lamp colour at 30 % over `raised` with a 2 pt edge line in the
   full colour.
4. **Musik** (`musik.html`): volume fader 56 pt tall, radius 20, `ink` fill,
   mint target marker. Dragging takes authority.
5. **Varför timeline** (`varfor.html`): 46 pt time column, cause line in
   `label` semibold with the trigger right-aligned in `caption`, events in
   `voiceLine` with a 1 pt connecting rail.
6. **Närvaro** (`narvaro.html`): `Canvas` radar, 318 pt tall card. Person is
   a mint disc of radius 8 pt; trail is 26 segments fading over 6 s; the held
   state is two rings of radius 16 and 24 pt (70 % and 35 % opacity). The timeline is paused whenever
   nothing moves.
7. **Godnatt** (`godnatt.html`): `voiceTime`, three radio rows, one toggle,
   the fifteen `FadeBars` (heights from 100 % down in 6.2 % steps, 5 pt gap,
   radius 4).
8. **Telefonen** (`telefon.html`).
9. **Live Activity and Dynamic Island** (`godnatt-live.html`): when the paid
   developer account exists.

## Checks before calling a screen done

- Runs at 120 Hz on device with the field on; no hitch when a sheet opens.
- Largest Dynamic Type size: nothing truncates in the middle of a word, tiles
  are one column.
- VoiceOver reads the hero as one sentence and every tile with its phase.
- Reduce Motion, Reduce Transparency and Increase Contrast each look
  intentional, not broken.
- Airplane mode: every screen still shows something true, with its age.
- Light and dark, and the forced-dark rule when the room is off.
