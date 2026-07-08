# Pebble / 溪石 Visual Identity

This is the brand VI direction for replacing legacy assets with Pebble assets.
It defines brand visuals only. Product UI layout, interaction, and component
styling continue to follow `docs/STYLEGUIDE.md`.

## Naming

- English product name: `Pebble`.
- Chinese product name: `溪石`.
- Technical identifiers, package names, CLI names, environment variables, URLs,
  and repo paths remain English/stable unless there is a separate migration plan.

## Brand Idea

Pebble is built around the idea of "pebbling": a small, specific object shared
because it made someone think of you. In product terms, Pebble is an agentic
workspace where many small, precise, useful contributions accumulate into
durable work.

The brand should feel:

- soft but not childish;
- warm but still technical;
- daily-life friendly but production-grade;
- tactile but vector-legible;
- personal without becoming mascot-driven.

The mark should not be a literal animal. The primary metaphor is the pebble:
small, held, chosen, given, and assembled into something larger.

## 2026 Context Notes

- 2026 brand design should not look like generic AI output. The useful signal is
  tactility: visible texture, natural light, imperfect material, and evidence of
  human selection.
- Material 3 Expressive and the broader platform direction point toward more
  personal, fluid, colorful, glanceable systems. Pebble should borrow the
  "expressive but usable" principle, not copy Android's bubbly UI styling.
- Consumer-facing technical products increasingly need warmth and personality
  without losing operational clarity. Pebble should therefore pair a soft,
  lifestyle-friendly palette with a small-size-safe mark and precise geometry.
- The brand should feel 2026-native: generated with AI, but disciplined through
  a reference-locked DAG, production vector cleanup, and exact asset slots.

Reference links:

- https://blog.google/products-and-platforms/platforms/android/material-3-expressive-android-wearos-launch/
- https://www.creativebloq.com/design/graphic-design/texture-warmth-and-tactile-rebellion-the-big-graphic-design-trends-for-2026
- https://www.vogue.com/article/the-anti-ai-slop-playbook

## Design Principles

### 1. Pebble Geometry

Use rounded, slightly asymmetrical geometry. Avoid perfect circles, sharp
triangles, or hard tech hexagons. The silhouette should feel like a smooth stone
that has been held in a hand.

Selected production direction:

- a single rounded pebble silhouette with a terminal prompt cut into the face;
- the `>_` signal links the brand to agentic terminal work without becoming a
  generic terminal app icon;
- the outer silhouette stays organic and tactile, while the inner prompt is
  precise and technical;
- source raster: `resources/brand/generated/pebble-logo/selected-logo.png`.

Secondary exploration directions:

- a single rounded pebble silhouette with a precise negative-space signal;
- a compact path/caret cut through one pebble, suggesting a terminal prompt;
- a small constellation of pebble dots arranged as a share/send gesture;
- a stacked cairn silhouette only if it reads as balanced stones, not body parts.

Avoid logo structures made from one large oval plus one small oval. That shape
language is too easy to read as anatomical and is banned for primary marks.

### 2. Flat-Skeuomorphic Balance

The brand should sit between flat vector and soft material:

- strong, simple silhouette first;
- one main material highlight;
- one soft grounding shadow;
- no busy stone veins at small sizes;
- no photoreal gravel, no glossy corporate chrome.

### 3. Small Gift, Real Work

Pebble is soft because the philosophy is personal. It is technical because the
product does real work. Every asset should keep both sides visible:

- personal side: warm stone, blush, shell, rounded form;
- technical side: precise edge, stable grid, high contrast, small-size clarity.

### 4. Lifestyle-Friendly, Not Disposable

The visual system can support Xiaohongshu-style softness: warm light, gentle
pink, desk objects, ceramic tactility, quiet editorial spacing. Avoid trends
that age quickly:

- no sticker overload;
- no decorative blobs or random gradient orbs;
- no heavy beige-only palette;
- no cute mascot as the primary identity.

### 5. Brand Kit Must Be Reproducible

The primary logo must be hand-vectorized and reproducible in SVG. AI-generated
raster output is only for exploration, hero scenes, texture, and variant icons.

## Color System

These colors are brand asset colors, not application UI token replacements.
When brand assets are embedded inside the app, prefer existing product tokens
from `src/renderer/src/assets/main.css`.

| Token | Hex | Role |
|---|---|---|
| Pebble Mist | `#F4F0EA` | warm neutral background, app icon base |
| Warm Stone | `#D8D0C4` | pebble body, calm neutral mass |
| Shell Pink | `#F6D7D2` | soft lifestyle tint, gentle glow |
| Clay Rose | `#E8A7A1` | emotional accent, small highlights |
| Moss Sage | `#AAB8A5` | natural counter-accent |
| Tide Blue | `#9CB7C8` | technical/cool counter-accent |
| Soft Lilac | `#C8B7D8` | optional secondary accent, use sparingly |
| Ink Graphite | `#2D3033` | mark contrast, wordmark, dark proofing |

Palette rules:

- Dominant field should be warm stone or mist, not saturated pink.
- Use rose/pink as an accent, not a whole-screen wash.
- Use Tide Blue to keep the system from reading as cosmetics-only.
- Avoid dominant purple/blue gradients and beige-only monotony.
- Icon contrast must survive 48 px and dark Dock/taskbar backgrounds.

## Material Language

Preferred materials:

- matte river stone;
- soft ceramic glaze;
- sanded mineral;
- translucent milky glass only as a highlight layer;
- fine paper grain for marketing backgrounds.

Avoid:

- chrome;
- wet glass;
- gemstone fantasy;
- literal beach gravel;
- high-frequency marble veins;
- heavy plastic toy shading.

## Typography

The app UI should keep its existing type system. Brand materials can use a
rounded geometric sans wordmark direction:

- titlecase `Pebble` for product clarity;
- rounded terminals;
- open counters;
- medium weight for small labels;
- no handwritten script as the core wordmark.

If model-generated text appears in raster outputs, discard it and overlay text
in post-production.

## Logo System

### Primary Mark

The primary mark is a compact pebble terminal symbol:

- one unified pebble mass;
- a clean `>_` terminal prompt cut into the face;
- it should not rely on a literal `P`;
- the prompt must read as a tool/workflow signal, not as decorative text;
- mark should work as one-color SVG.

Hard bans for logo shape:

- no phallic, anatomical, or suggestive silhouette;
- no one-large-one-small oval composition;
- no protruding stem, shaft, droplet, or paired bulb shape;
- no mascot, animal, face, or legacy whale mark.

### App Icon

Classic production icon:

- rounded square field in Pebble Mist or Warm Stone;
- tactile but simple pebble mark in Ink Graphite or warm off-white;
- subtle highlight from upper-left;
- soft shadow below mark;
- no literal letter unless the abstract mark fails at 48 px.

### Variant Icons

Keep three runtime options:

- `classic`: default production mark, quiet and high contrast.
- `watercolor`: soft editorial variant, warmer rose/sage texture.
- `blue`: cooler mineral/technical variant, Tide Blue restrained.

The IDs should remain stable for user settings compatibility. Labels can be
renamed after final art selection.

## Image System

### Hero Backgrounds

Hero images should show the brand idea as a lived object:

- smooth pebbles on a desk next to a laptop or notebook;
- warm morning/evening light;
- a small selected stone placed intentionally;
- subtle technical traces such as faint grid paper or terminal glow;
- no dark, generic, blurred stock mood.

### Social And README Cards

Use generated image as background only. Compose product screenshots, logo, and
copy separately for reliable text and exact layout.

### Onboarding Backgrounds

Backgrounds should be low-contrast mineral/paper surfaces. Product demos and
feature-wall GIFs remain the informational layer.

## Prompt System Rules

Global rules for all generation prompts:

- Set ratio through CLI/DAG `ratio`, not inside prompt text.
- Avoid long text in the generated image.
- Ask for centered, high-contrast, vector-friendly output for logo/icon tasks.
- For mox/gpt-image-2 transparent needs, use chroma key green `#00FF00`, then
  key out locally.
- Use generated raster output as exploration. Final production glyph must be SVG.

## DAG Reference Strategy

Generation should use serial reference locking for visual consistency. Do not
ask every material to rediscover the brand from prompt text alone.

The generation graph is staged:

1. `foundation-material-board` locks color, stone material, paper grain, and
   light direction.
2. `foundation-pebbling-symbols` references the material board and turns the
   pebbling philosophy into simple motifs.
3. `core-mark-seed` references both boards to create the first single-pebble
   `>_` primary mark.
4. `core-mark-production-clean` references the seed and removes clutter before
   downstream use.
5. `app-icon-classic` references the production mark and material board. This
   becomes the no-background desktop icon anchor for variants and public
   materials.
6. Hero, social, mobile splash, onboarding, and overview outputs reference the
   icon/material/symbol anchors as needed.

This staged graph intentionally spends early generations on consistency. It
reduces drift across icon variants, backgrounds, and marketing materials, and
gives the final SVG vectorization pass a clearer source to simplify.

Quality bar:

- recognizable at 48 px;
- no accidental animal mascot;
- no legacy whale glyph;
- no unlicensed third-party logo resemblance;
- no illegible model-rendered wordmarks;
- app icon silhouette remains distinct on macOS, Windows, Linux, and mobile.
