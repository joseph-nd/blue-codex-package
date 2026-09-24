/**
 * Robustness: the Codex spells pack is EMPTY — what the user hit when a pack
 * rebuild ran while Foundry was open and left the LevelDB packs blank.
 *
 * BUG-bc-1 (fixed 0.9.1): a Shadowmancer (and Shepherd) used to silently learn
 * nothing — official necrotic was vetoed unconditionally by the necrotic re-home
 * (CLASS_SPELL_REMAP) even though the Codex school replacing it had no spells.
 * Now the re-home only applies when the Codex actually provides the target school
 * (the same coverage rule every other school follows: a Mage falls back to official
 * fire/ice/lightning), so these casters fall back to the official necrotic spells,
 * and the GM gets ONE warning per session that the Codex spells pack is empty.
 */
import { describe, expect, it } from 'vitest';
import {
	adoptActor,
	buildCharacterByLevelUps,
	createCharacter,
	renderSheet,
	setupWorld,
	spellSummary,
} from '../harness/index.mjs';
import { expectedShadowSpells, shadowmancerProgression, shadowmancerTier } from './helpers.mjs';

const uuidsOf = (list) => list.map((s) => s.uuid ?? s.source).sort();
const CODEX_WARNING = /Codex spells pack is empty or unavailable/;
const codexWarnings = (env) => env.notifications.messages('warn').filter((m) => CODEX_WARNING.test(m));
const isOfficial = (s) => String(s.source).startsWith('Compendium.nimble.');

/** The spells a class owns at `level` with Codex magic OFF in the same empty-pack world (the official baseline). */
async function officialBaseline(classId, level, opts = {}) {
	const { env } = await setupWorld({ emptyCodexSpells: true, replaceSpells: false });
	const { actor } = await buildCharacterByLevelUps(env, classId, level, opts);
	return spellSummary(actor);
}

describe('empty Codex spells pack — official fallback (BUG-bc-1 fixed)', () => {
	it('a Shadowmancer created and levelled to 5 learns the official necrotic spells', async () => {
		const run = await shadowmancerProgression({ emptyCodexSpells: true }, { maxLevel: 5 });
		expect(run.env.game.packs.get('blue-codex-package.blue-codex-spells').index.size).toBe(0);
		for (let level = 1; level <= 5; level += 1) {
			const spells = run.snaps[level].spells;
			expect(spells.length, `L${level}`).toBeGreaterThan(0);
			expect(spells.every((s) => s.school === 'necrotic' && isOfficial(s)), `L${level}`).toBe(true);
		}
		// Exactly what the same Shadowmancer gets with Codex magic off.
		const baseline = await officialBaseline('shadowmancer', 5, { abilities: { dexterity: 2 } });
		expect(uuidsOf(run.snaps[5].spells)).toEqual(uuidsOf(baseline));
		expect(run.env.dialogs.log).toEqual([]);
		expect(run.env.Hooks.errors).toEqual([]);
		// No re-home happened, so no high-water mark: a repaired pack still re-homes later.
		expect(run.snaps[5].flags.classSchools).toBeUndefined();
	});

	it('the GM is warned exactly once per session, however many syncs/level-ups fall back', async () => {
		const run = await shadowmancerProgression({ emptyCodexSpells: true }, { maxLevel: 5 });
		await renderSheet(run.env, run.actor);
		await renderSheet(run.env, run.actor);
		expect(codexWarnings(run.env)).toHaveLength(1);
		expect(run.env.notifications.messages('error')).toEqual([]);
	});

	it('a player (non-GM) client is not warned', async () => {
		const { env } = await setupWorld({ emptyCodexSpells: true, isGM: false });
		expect(codexWarnings(env)).toEqual([]);
	});

	it('a Shepherd in an empty-pack world falls back to its official spells (necrotic included)', async () => {
		const { env } = await setupWorld({ emptyCodexSpells: true });
		const { actor } = await buildCharacterByLevelUps(env, 'shepherd', 5);
		const spells = spellSummary(actor);
		expect(spells.length).toBeGreaterThan(0);
		expect(spells.every(isOfficial)).toBe(true);
		expect(spells.some((s) => s.school === 'necrotic')).toBe(true);
		expect(uuidsOf(spells)).toEqual(uuidsOf(await officialBaseline('shepherd', 5)));
		expect(actor.flags['blue-codex-package']?.classSchools).toBeUndefined();
		expect(codexWarnings(env)).toHaveLength(1);
		expect(env.Hooks.errors).toEqual([]);
	});

	it('with Codex magic off the empty pack changes nothing and nobody is warned', async () => {
		const { env } = await setupWorld({ emptyCodexSpells: true, replaceSpells: false });
		const { actor } = await createCharacter(env, { classId: 'shadowmancer' });
		expect(spellSummary(actor).length).toBeGreaterThan(0);
		expect(spellSummary(actor).every((s) => s.school === 'necrotic')).toBe(true);
		expect(codexWarnings(env)).toEqual([]);
	});

	it('contrast: a Mage in the same empty-pack world falls back to the official spells', async () => {
		const { env } = await setupWorld({ emptyCodexSpells: true });
		const { actor } = await createCharacter(env, { classId: 'mage' });
		const spells = spellSummary(actor);
		expect(spells.length).toBeGreaterThan(0);
		expect(spells.every(isOfficial)).toBe(true);
	});

	it('fixed BUG-bc-1: a Shadowmancer with an empty Codex spells pack must not silently learn nothing (GM warning or official fallback)', async () => {
		const run = await shadowmancerProgression({ emptyCodexSpells: true }, { maxLevel: 5 });
		const warned = [...run.env.notifications.messages('warn'), ...run.env.notifications.messages('error')].some((m) =>
			/codex|spell/i.test(m),
		);
		const learned = run.snaps[5].spells.length > 0;
		expect(warned || learned).toBe(true);
		expect(warned && learned).toBe(true); // both, in fact
	});
});

describe('populated Codex spells pack — unaffected by the fallback', () => {
	it('a Shadowmancer still learns only Codex shadow (no official necrotic, no warning)', async () => {
		const run = await shadowmancerProgression({}, { maxLevel: 5 });
		expect(uuidsOf(run.snaps[5].spells)).toEqual(uuidsOf(expectedShadowSpells(5)));
		expect(run.snaps[5].spells.some((s) => s.school === 'necrotic')).toBe(false);
		expect(run.snaps[5].flags.classSchools).toEqual({ classId: 'shadowmancer', grantedTier: shadowmancerTier(5) });
		expect(codexWarnings(run.env)).toEqual([]);
	});

	it('a Shepherd still learns death instead of necrotic (no warning)', async () => {
		const { env } = await setupWorld();
		const { actor } = await buildCharacterByLevelUps(env, 'shepherd', 5);
		const spells = spellSummary(actor);
		expect(spells.some((s) => s.school === 'necrotic')).toBe(false);
		expect(spells.some((s) => s.school === 'death')).toBe(true);
		expect(actor.flags['blue-codex-package']?.classSchools?.classId).toBe('shepherd');
		expect(codexWarnings(env)).toEqual([]);
	});
});

describe('empty Codex spells pack — repairing the pack', () => {
	it('the next native level-up after the pack is repopulated re-homes the spell list', async () => {
		const broken = await shadowmancerProgression({ emptyCodexSpells: true }, { maxLevel: 5 });
		const data = broken.actor.toObject();
		// "Reload Foundry" with the packs rebuilt.
		const { env } = await setupWorld();
		const actor = adoptActor(env, data);
		await actor.triggerLevelUp();
		expect(uuidsOf(spellSummary(actor))).toEqual(uuidsOf(expectedShadowSpells(6)));
		expect(env.Hooks.errors).toEqual([]);
	});

	it('opening the sheet after the pack is repopulated re-homes the fallback necrotic spells', async () => {
		const broken = await shadowmancerProgression({ emptyCodexSpells: true }, { maxLevel: 5 });
		const data = broken.actor.toObject();
		const { env } = await setupWorld();
		const actor = adoptActor(env, data);
		await renderSheet(env, actor);
		expect(uuidsOf(spellSummary(actor))).toEqual(uuidsOf(expectedShadowSpells(5)));
		expect(codexWarnings(env)).toEqual([]);
	});
});

describe('partial Codex spells pack — expected behaviour (bugs)', () => {
	// BUG-bc-2 (PARKED). With the BUG-bc-1 fix an EMPTY pack no longer advances the
	// classSchools mark (the re-home is skipped), so the repro uses a pack that has the
	// shadow cantrips but lost the higher shadow tiers: the re-home applies, the mark
	// advances to tier 2, but no tier-1/2 spell lands.
	const partialPack = {
		packs: {
			transform: (doc, pack) =>
				pack.collection === 'blue-codex-package.blue-codex-spells' &&
				doc?.system?.school === 'shadow' &&
				Number(doc?.system?.tier ?? 0) > 0
					? null
					: doc,
		},
	};

	it.fails('BUG-bc-2: after the Codex pack is repopulated, opening the sheet back-fills the spells the broken pack could not grant', async () => {
		const broken = await shadowmancerProgression(partialPack, { maxLevel: 5 });
		const data = broken.actor.toObject();
		const { env } = await setupWorld();
		const actor = adoptActor(env, data);
		await renderSheet(env, actor); // the sync main.mjs runs on every sheet render
		const tier = shadowmancerTier(5);
		const shadow = spellSummary(actor).filter((s) => s.school === 'shadow');
		// Expected: tiers 1..2 at least (the remap owns tiers above the L1 cantrips).
		expect(shadow.some((s) => s.tier === tier)).toBe(true);
	});
});

describe('Codex spell snapshot diagnostics (api)', () => {
	it('reports the fallback in an empty-pack world and the re-home in a populated one', async () => {
		const empty = await setupWorld({ emptyCodexSpells: true });
		const status = empty.env.game.modules.get('blue-codex-package').api.codexSpellStatus();
		expect(status).toMatchObject({
			loaded: true,
			schools: [],
			spellCount: 0,
			remaps: { shadowmancer: null, shepherd: null },
			officialNecroticVetoed: { shadowmancer: false, shepherd: false },
			fallbackWarned: true,
		});
		const full = await setupWorld();
		const ok = full.env.game.modules.get('blue-codex-package').api.codexSpellStatus();
		expect(ok.remaps).toEqual({ shadowmancer: 'shadow', shepherd: 'death' });
		expect(ok.officialNecroticVetoed).toEqual({ shadowmancer: true, shepherd: true });
		expect(ok.fallbackWarned).toBe(false);
	});
});
