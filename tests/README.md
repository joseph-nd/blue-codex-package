# Tests

Vitest runs the module's real `scripts/main.mjs` under Node against mocked Foundry v14 + Nimble globals and the
**real** pack data, read from JSON (never from the built LevelDB `packs/`, so a test run never touches them):

- `../FoundryVTT-Nimble/packs/**` — the system (classes, class features, subclasses, spells, secret spells);
- `pack-sources/**` — this module, with ids from `pack-sources/ids.json`;
- `../nim-plus-package/pack-sources/**` — optional, mounted only when a test asks for Nim+.

```bash
pnpm test                                   # run once (vitest run)
pnpm test:watch                             # watch mode
npx vitest run tests/shadowmancer           # one directory
npx vitest run -t "ladder"                  # tests whose name matches
```

The sibling checkout `../FoundryVTT-Nimble` must exist; `../nim-plus-package` is needed only by the Nim+ variants.
The harness was adapted from `../nim-plus-package/tests/harness` (copied, not imported).

## Layout

```
tests/
  harness/          the mock Foundry world — import from harness/index.mjs
    foundry.mjs       installFoundry(), importScripts(), Hooks/settings/dialogs/uuid mocks, libWrapper mock
    foundry-utils.mjs ported foundry.utils (mergeObject, expandObject, deepClone…), operators, Collection
    documents.mjs     mock Item/Actor + Nimble's Character (classes, mana max, highestUnlockedSpellTier,
                      triggerLevelUp)
    compendium.mjs    CompendiumCollection + database mirroring v14 index semantics
    packs.mjs         loadPackData(), installPacks(), findDoc(s), codexSpells(), nimPlusSupersede()
    nimble.mjs        ports of Nimble's spell index, grant rules, class-feature index, character creator and
                      level-up (createCharacter, runLevelUp via actor.triggerLevelUp, buildCharacterByLevelUps)
    nimplus.mjs       installNimPlus(): Nim+ as blue-codex sees it (module + api + setting + index hiding)
    scenario.mjs      setupWorld(), adoptActor()
  examples/         harness smoke tests
  shadowmancer/     the Shadowmancer battery (tier ladder, Codex grants L1-20, remaps, empty pack, existing chars)
  content-sync/     owned Codex spell copies synced with the packs (toast, no dialog, version-gated startup)
  class-refresh/    Refresh Codex class content + Lifebinding Spirit conversion (automatic, toast + card, loop guard)
  command-shadows/  Codex Command Shadows automation (own scene/combat stand-ins: group attack per target, no distance gate, no Shadow turns, 1/turn)
```

Test files must be named `*.test.mjs`.

## Writing a test

```js
import { describe, expect, it } from 'vitest';
import { setupWorld, createCharacter, spellSummary } from '../harness/index.mjs';

describe('shadowmancer', () => {
	it('learns tier 2 at level 5', async () => {
		const { env, main } = await setupWorld({ nimPlus: true });     // boots main.mjs to `ready`
		const { actor } = await createCharacter(env, { classId: 'shadowmancer', abilities: { dexterity: 3 } });
		for (let level = 2; level <= 5; level += 1) await actor.triggerLevelUp();
		expect(spellSummary(actor).some((s) => s.tier === 2)).toBe(true);
		expect(env.Hooks.errors).toEqual([]);
	});
});
```

`setupWorld(opts)` = `installFoundry` + `installPacks` [+ `installNimPlus`] + `importScripts('scripts/main.mjs')` +
`env.boot({until: 'ready'})` (main.mjs installs its patches on `ready`). Options: `replaceSpells` (the
`replaceOfficialSpells` world setting, default `true`), `nimPlus`, `playtest`, `nimPlusApi`, `emptyCodexSpells`,
`libWrapper`, `packs` (`installPacks` options incl. `transform`), `boot`, `isGM`, `settings`, `dialogFallback`.
It returns `{env, main}`; `main.__test__` exposes a few internal helpers/tables (a test-only export at the bottom of
main.mjs — it adds no behaviour).

Call `setupWorld()` / `installFoundry()` per test or per `beforeAll`: it replaces every global and creates fresh
document and `CompendiumCollection` classes, so prototype patches made by main.mjs never leak between worlds. Each
call re-imports main.mjs with a fresh module registry (its caches start empty).

## How the grant pipeline is driven

`tests/harness/nimble.mjs` ports the Nimble code paths that decide which spells a character gets (file list in its
header). They read every index through `pack.getIndex({fields})` with the system's own field lists — so main.mjs's
grant-index patch sees the real grant-path signature — resolve every feature/spell through the global `fromUuid` — so
the class-feature rule rewrite applies — create items through `createEmbeddedDocuments` — so the `preCreateItem`
vetoes apply — and then update the class item's `system.classLevel` (main.mjs's `updateItem` hook) and render the sheet
(`renderPlayerCharacterSheet`, where main.mjs installs its `triggerLevelUp` wrap and runs its syncs).

- `createCharacter(env, {classId, abilities, pickSpells, pickSchools, render, ownedByPlayer})` — the character creator
  at level 1.
- `actor.triggerLevelUp({subclass, pickSpells, pickSchools, pickFeatures})` — one native level-up (through main.mjs's
  wrap when installed). Returns `{level, spellIndex, preview, spellUuids, features, createdSpells, …}`.
- `buildCharacterByLevelUps(env, classId, level, opts)` — both, repeatedly.
- `adoptActor(env, actor.toObject())` — the same actor in a new world ("reload Foundry").

Dialog choices are callbacks: `pickSpells(group) → uuids`, `pickSchools(group) → schools` (default: the first
`count`), `pickFeatures(group, features) → features` (default: none). main.mjs's own DialogV2 prompts are scripted with
`env.dialogs` (see below); unscripted ones close (→ deferred).

## Scripting dialogs

Every `DialogV2.wait/confirm/prompt/input` consumes the first queued answer whose matcher accepts it; everything is
recorded in `env.dialogs.log` (`{kind, title, content, config, answer, result}`).

```js
env.dialogs
	.answer('confirm')                                     // next dialog: press "confirm"
	.answerWhen(/Dark Knowledge/, { action: 'confirm', checked: ['shadow', 'curse'] })
	.answerWhen('Remove', true)                            // confirm: yes
	.answerWhen(/Later/, null);                            // close the dialog
```

## Bug-reporting convention (MANDATORY)

1. Tests do not modify `scripts/` or `pack-sources/`. (Exception: a genuine fix the task asks for, with a
   regression test.)
2. When a test reveals a real bug, write the test for the **correct** behaviour and mark it
   `it.fails('BUG-bc-<n>: …')` so the suite stays green and documents the bug. Once fixed, the `it.fails` starts
   failing — turn it into a plain `it`.
3. Log it (id, where, repro, expected vs actual, severity) in the session's bug list.
4. If the harness (not the script) is wrong or can't simulate something, fix the harness or note it under "Gaps".

## Gaps — what the harness does NOT simulate

- **No DataModel schemas**: updates are not validated/cleaned; types are not coerced; defaults are not filled.
- **No Nimble rules engine**: `grantSpells` rules are applied only by the ported creator/level-up; `chargePool`,
  `grantItem`, predicates other than `level` are never evaluated.
- **Level-up / creator ports omit**: HP/hit dice/skills/ability increases, epic boons, the duplicate-source feature
  picker, `levelUpOptions` sub-choices, and feature selection groups unless `pickFeatures` returns something. Nimble's
  mana at level 1 is `baseMax` (0), so level-1 characters are not casters (`highestUnlockedSpellTier` null).
- **Mana formulas** are evaluated by a tiny evaluator (`@ability` = the ability mod, `@level`, `max/min/floor/ceil`).
- **Nim+** is a stand-in built from its JSON (supersede flags + `supersede-retired.mjs` UUIDs read as text); its
  scripts (class migration, indexDocument hiding, compendium-window purge) do not run.
- **libWrapper** mock supports `register` (WRAPPER/MIXED/OVERRIDE chaining) only.
- No ActiveEffects, tokens, canvas, combat, chat rendering, sheets or rendered HTML (`HTMLElement` is a stub class, so
  main.mjs's DOM paths no-op). Embedded CRUD is `Item` only. `Roll` does not roll.
- `Hooks.callAll` does not await async handlers (as in Foundry) — `env.flush()` waits for them, including
  `setTimeout(…, 0)` deferrals.
- Pack JSON is served as authored: the build's UUID-reference rewriting is not replayed.
