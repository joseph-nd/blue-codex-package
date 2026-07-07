# Blue Codex Package

A [Foundry VTT](https://foundryvtt.com/) module that brings the content of
**Blue's Codex** (a third-party Nimble supplement, v1.3) to the
[Nimble system](https://github.com/nimble-co/FoundryVTT-Nimble).

> **Status: early scaffold.** The repository structure, build pipeline and
> release tooling are in place; compendium content is not yet authored.
> See `CLAUDE.md` for the development hand-off notes.

## Planned scope

Blue's Codex contains:

- **Heroes** — two new classes: the **Engineer** (turrets, weapon kits,
  gadgets) and the **Specter** (soul sculpting), each with subclasses.
- **Subclasses** — one new subclass for every core Nimble class
  (Berserker, The Cheat, Commander, Hunter, Mage, Oathsworn, Shadowmancer,
  Shepherd, Songweaver, Stormshifter, Zephyr).
- **Spells** — utility spells plus four spell books: the Book of Elements
  (fire, ice, earth, lightning, water, wind), the Book of Ether (illusion,
  domination, inspiration), the Book of Radiance (radiant, protection,
  divination, nature) and the Book of Ruin (shadow, death, blood, curse),
  plus secret spells.
- **Traveler's Guide to Tyria** — Guild Wars–inspired ancestries and
  backgrounds.
- **Bestiary** — monsters (skritt and friends).
- **GM tools & rules** — optional rules and gameplay guidance.

## Installation

Once released: paste the manifest URL into Foundry's *Install Module* dialog:

```
https://github.com/joseph-nd/blue-codex-package/releases/latest/download/module.json
```

## Development

```bash
pnpm install
pnpm build     # compiles pack-sources/**.json into LevelDB packs/
```

Compendium documents are authored as one JSON file per document under
`pack-sources/<sourceDir>/`; `pnpm build` assigns stable `_id`s (tracked in
`pack-sources/ids.json`), rewrites cross-references and writes the LevelDB
packs Foundry reads. The authoring conventions are the same as
[nim-plus-package](https://github.com/joseph-nd/nim-plus-package) — see its
`CONTRIBUTING.md` for the document JSON guides.

### Releasing

1. Bump `version` in `module.json` and `package.json`, update `CHANGELOG.md`.
2. Tag `vX.Y.Z` and push the tag — the GitHub Actions workflow builds the
   packs, bundles `dist/module.zip` + `dist/module.json` and publishes the
   release.

## Credits

- **Blue's Codex** by its respective author(s) — an independent product
  published under the Nimble 3rd Party Creator License.
- **Nimble** © 2025 Nimble Co.
- Guild Wars and associated marks are trademarks of NCSOFT Corporation.
- Module implementation: Joseph Nunez.
