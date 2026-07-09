# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-07-09

### Fixed

- **Redrawn drifted icons** — regenerated 275 icons (142 spells and 133
  subclass features) whose v0.2.0 art had drifted off-theme, most often into an
  unrelated weapon or object. Abstract spell effects now render as their actual
  effect (or a clean school-colored arcane sigil for concept spells with no
  physical form), and each spell still shares its school's accent color. No
  mechanics changed — art only.

## [0.2.0] - 2026-07-08

### Added

- **Core-class subclasses** — all 32 Blue's Codex subclasses for the ten core
  classes (Berserker, The Cheat, Commander, Hunter, Mage, Oathsworn,
  Shadowmancer, Shepherd, Songweaver, Stormshifter, and Zephyr), each with its
  level 3/7/11/15 features and themed ability pools. (The Engineer and Specter
  hero classes are still to come.)
- **Subclass spell-school swaps** — subclasses that change a caster's spell
  schools (Invoker of Ether/Elements, the Luminaries, the Circles, the Heralds)
  now work: taking one asks you to choose your schools, then updates your
  spellbook to match as you level. Re-open the choice any time with
  `game.modules.get('blue-codex-package').api.chooseSpellSchools()`.
- **Themed subclass pools as choices** — each subclass's ability pool (Savage
  Arsenal, Chimeric Boons, Sacred Decrees, Invocations, etc.) is a set of
  pickable features, offered as a "choose one" at the right levels showing only
  your own subclass's options.
- **Zephyr Air & Water Forms** — all 32 forms are gained automatically at the
  level matching their rank as you level a Zephyr.
- **Functional spell upcasting** — upcasting now applies the higher-level effect
  (extra damage, targets, range, area, duration, save DC, and more) instead of
  doing nothing; "either/or" upcasts let you pick in the dialog. Effects the
  system can't model are still spelled out in the upcast text.
- **Rollable subclass features** — subclass features and Zephyr forms that deal
  damage, heal, or grant temporary HP now roll dice with an Apply Damage button,
  and attack forms crit and can miss where appropriate. Passive features stay
  descriptive.
- **Spell crit/miss corrected to the rules** — only single-target attack spells
  crit and can miss; area spells no longer crit unless their own text says so.
  Every crit-capable spell now shows the CRIT/MISS banner on its chat card.
- **Custom icons** — a dark-fantasy icon for all 215 spells and all 341 subclass
  features, replacing the placeholder art. Every spell in a school shares one
  accent color (fire orange, curse green, radiant gold, …) so a school reads at
  a glance.
- **Spell-school filters** — the Spells tab now has a filter tab and per-spell
  marker for the Codex's extra schools (earth, water, illusion, domination,
  inspiration, protection, divination, nature, shadow, death, blood, curse), in
  the same style as the built-in schools.
- **Compendium organization** — class-feature folders mirror the core subclasses
  (fixed features, with the ability pools in a nested sub-folder), and every
  entry shows its level(s) and sorts by level.

### Fixed

- **Subclass pool picks no longer double** — a subclass's pool options now appear
  alongside the base class's in the level-up window as one combined "Choose N",
  instead of forcing a second pick afterward (e.g. a Stormshifter chooses 2
  Chimeric Boons, not 4).
- **Level-up preview shows the right spells for school-swapping subclasses** — the
  "Granted Spells" list no longer previews the base-class schools you're about to
  replace; it shows the spells you actually gain (Book of Ether for an Invoker of
  Ether, Earth for a Circle of Earth, …) under the correct headers.

## [0.1.0] - 2026-07-07

### Added

- **Spells compendium** — all 215 spells from Blue's Codex, organized into
  Book of Elements (fire, ice, earth, lightning, water, wind), Book of Ether
  (illusion, domination, inspiration), Book of Radiance (radiant, protection,
  divination, nature), Book of Ruin (shadow, death, blood, curse), and the
  Utility and Secret Spells chapters. Each spell carries its full activation
  roll tree (attacks, saving throws, healing, conditions), tier,
  range/reach/template, and upcast / high-level scaling.
- **Blue's Codex as the default magic system** — the `replaceOfficialSpells`
  world setting (on by default) makes leveling spellcasters receive the Codex
  version of each spell instead of the official Nimble one, for every school
  the Codex re-authors. Schools it does not cover (e.g. necrotic) keep the
  official spells, so no caster is ever left without spells.
- **Compendium quality-of-life** — the Blue Codex Spells compendium shows each
  spell's tier as a badge in the list and sorts spells by tier within each
  school folder, so you can tell a spell's tier at a glance without opening it.
- Repository scaffold: module manifest, compendium build pipeline
  (`pack-sources/` → LevelDB `packs/`), release tooling, GitHub Actions release
  workflow, and a runtime entry point (`scripts/main.mjs`).

### Notes

- The Classes, Subclasses, Class Features, Items, Companions, Monsters,
  Ancestries, and Backgrounds compendia ship empty in this release and will be
  populated in future versions.
- Spell icons currently use Foundry core placeholder art pending custom icon
  generation.
