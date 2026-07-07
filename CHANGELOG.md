# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
