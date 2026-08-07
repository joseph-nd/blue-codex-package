# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-08-07

**The cast dialog, made usable for the Shadowmancer and honest about upcasts.**
A class that always casts at its highest tier was having its whole dialog
answered for it, and 57 spells described an upcast the dialog had no way to
offer. Plus one deliberate balance change to *Grasping Shadows*.

### Changed

- **Grasping Shadows deals 2d12 instead of 3d12** (shadow, tier 1). This is
  the module's first deliberate departure from the published text, made on a
  GM's call rather than to correct a porting error: at 3d12 that can't miss,
  a tier-1 spell available at level 2 dealt 75% of the damage of *Writhing
  Dark* — the tier-6 shadow spell — for one action instead of two and no
  concentration, on top of Restraining the target. At 2d12 it averages 13,
  which still leads every other 1-action tier-1 spell that can't miss
  (*Seiche*, 2d10) and sits alongside the 2-action *Arc Lightning* (3d8).
  Everything else about the spell is untouched, including the upcast.
- **Every spell that describes an upcast now offers it in the cast dialog.**
  The system draws upcast options as radio buttons only for spells whose
  `scaling.mode` is `upcastChoice` with a populated `choices` array; 57 spells
  described their upcast in prose only, so the player saw a mana slider with
  nothing to say what spending the mana would do. All 57 were converted, and
  every tier-1-and-up spell carrying upcast text — 122 of them — now names its
  options. Labels are drawn from the zine's own wording.
  - Options are only split apart where the text says "or". A clause joined by
    "and" stays one option, because splitting it would let the player take half
    an upcast; a conditional rider ("if 5+ mana is spent, …") is not an option
    at all, since it happens on its own.
  - **No mechanics were added or removed.** In `upcastChoice` mode the system
    applies the selected choice's deltas and ignores the spell's top-level
    ones, so each of the 31 spells that already automated its upcast had that
    delta moved into the option it implements — verified against the previous
    revision, with none dropped. Options with no existing automation are
    labels only for now, which is most of them: flat `+N HP` healing, Armor,
    speed and multiplier bonuses have no operation in the system's vocabulary
    to express them.

### Fixed

- **A Shadowmancer's cast dialog no longer closes before it can be used.** The
  class always casts at its highest available tier, and that rule was being
  enforced by answering the whole dialog on the player's behalf the instant it
  rendered — so the window vanished, taking with it every other decision it
  carries: advantage and disadvantage, situational modifiers, the primary-die
  fields, and which upcast option to take. The dialog now opens and waits. Only
  the tier is still forced, by intercepting the player's own submission on its
  way past, so everything else they chose survives. In place of the system's
  mana slider — which offers a choice this class does not have, and whose
  option radios only appear once it has been dragged — the dialog shows the
  tier being cast at and, when the spell's upcast has real alternatives, the
  radio group to pick one. If the system's markup ever moves, nothing is
  injected and the cast still works.

### Known issues

- **If the upcast section is missing entirely, check the character, not the
  spell.** The system only draws it when
  `min(mana.current, highestUnlockedSpellTier) > spell.tier`. That tier cap is
  a *stored* field assigned with `??=`, so once anything writes a number to it
  — including one click of the +/- stepper on the sheet's Settings tab — it is
  pinned there and never recomputed on level-up. A character showing a cap of 1
  cannot upcast anything, with no warning. Fix it with **Settings tab → Reset
  spell tier**. This is system behaviour, not something this module sets:
  the module's own cap override is gated to Shadowmancers.

## [0.5.0] - 2026-07-22

### Added

- **Fiendish Boon automation.** Picking the Shadowmancer Greater Invocation
  *Fiendish Boon* now prompts for DEX or INT, applies the +1 ability bonus
  and the −1 maximum Hit Die as native rules on the feature (so they follow
  the character automatically, including across level-ups), and works
  retroactively for characters who already own an un-automated copy the
  next time their sheet opens. Each additional copy taken prompts again.
- **Pilfered Power character sheet.** The Shadowmancer's sheet no longer
  says "Mana": the resource is relabeled **Pilfered Power** with a crescent
  moon icon and a shadow-violet bar, matching the class's own casting
  identity. Presentation only — the underlying resource is unchanged, so
  all casting automation still works, and other classes' sheets are
  untouched.

### Fixed

- **Level-1 Shadowmancers no longer receive every shadow cantrip.** Two
  stacked bugs granted all five: the level-1 feature's two spell grants
  (Shadow Blast, Summon Shadow) were being widened into a whole-school
  grant, and the character-creation flow could re-grant the full cantrip
  school in the window between the class landing on the sheet and its
  spells arriving. A fresh Shadowmancer now starts with exactly Shadow
  Blast and Summon Shadow; the remaining cantrips and tier-1 spells still
  arrive at level 2 as before. (Characters created while the bug was live
  keep the extra cantrips — delete them or recreate the character.)
- **"Item does not exist" errors when leveling a school-swap caster.** The
  temporary spell-grant carrier used during a swap subclass's level-up
  could be deleted twice (the level-up's own cleanup racing the stale-item
  sweep), throwing red error toasts. The cleanup is now ordered and
  guarded, and a harmlessly lost race no longer reports an error.

## [0.4.0] - 2026-07-21

### Added

- **Shadow Magus automation.** Casters who own the Shadowmancer Greater
  Invocation *Shadow Magus* summon shadow minions with +4 Reach and d10
  damage (instead of d12), patched onto each summoned token's attack and
  sheet text. The spell's "Reach +1 every 5 levels" scaling is now applied
  automatically as well.
- **Swarming Shadows automation.** When a summoned shadow minion "would
  crit" (its damage die rolls its maximum face — the system suppresses real
  minion crits), a new shadow minion is summoned adjacent to the target,
  with a chat notice. Works for both individual minion attacks and minion
  group-attack cards, inherits combat-end cleanup and Shadow Magus boosts,
  and respects the summon cap (whispers when the swarm is at its limit).
- **Shadowmancer casting rules (Pilfered Power).**
  - The max castable spell tier now follows the Shadowmancer's own
    progression (tier 1 at level 2, then levels 5/7/10/13/16/19 for tiers
    2–7) instead of the generic caster table.
  - Tiered spells are automatically cast at the highest unlocked tier —
    the upcast dialog is answered and skipped.
  - Every tiered cast costs exactly 1 mana (one use of Pilfered Power),
    regardless of tier.
  - Overdraft: casting with 0 uses remaining still works — the patron
    "takes notice", dealing half the caster's max HP with a chat card.

### Notes

- Holding Alt to skip dialogs bypasses the automatic upcast (the cast goes
  off at base tier); the flat cost and overdraft still apply.
- On a multi-target minion group attack, all Swarming Shadows spawns are
  placed adjacent to the first target (the group card does not record
  per-minion targets).

## [0.3.0] - 2026-07-14

### Added

- **Companions compendium** — new Actor pack with the first two summonable
  companions: **Shadow Minion** and **Lifebinding Spirit**, each with a custom
  circular token (transparent, school-colored ring: shadow violet / radiant
  gold).
- **Summon automation.** Casting **Summon Shadow** or **Summon Lifebinding
  Spirit** now imports the companion (once) and places its token next to the
  caster automatically.
  - *Summon Shadow*: combat-only, capped at min(INT, level) minions, and all
    summoned shadows vanish when combat ends.
  - *Summon Lifebinding Spirit*: unique (one spirit at a time); recasting
    dismisses it **without spending mana**; the spirit tracks ability charges
    equal to the mana spent and dismisses itself when they run out or on a
    Safe Rest. Upcasting steps the Attack/Cure die (d6→d8→d10→d12) and the
    caster's WIL is baked into both formulas at summon time.
- **Empowered Companion (Sacred Grace) support** — when owned, the spirit
  gains +1 effective mana (one extra charge and die step), its die cap rises
  to d20, and the spell's upcast slider is no longer limited by your unlocked
  spell tier (real mana still applies).
- **School-gated spirit commands** — the Lifebinding Spirit automatically
  gains the seven bonus commands from the Codex (Courage, Twist Fate, Wild
  Bloom, Cloaked, Reap, Share Vitality, Misfortune) for exactly the spell
  schools the Shepherd knows at summon time; each consumes an ability charge.
- **Vicious Mockery** — new wind-school spell with icon.

### Fixed

- **Duplicate death-school grant at Shepherd creation** — the death school's
  spells could be granted twice when creating a Shepherd; grants are now
  deduplicated and already-affected characters are repaired automatically the
  next time their sheet is opened.
- Shadow Minion attacks no longer claim they can crit (minions do not crit).

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
