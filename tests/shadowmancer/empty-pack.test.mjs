/**
 * Robustness: the Codex spells pack is EMPTY — what the user hit when a pack
 * rebuild ran while Foundry was open and left the LevelDB packs blank.
 *
 * Today's behaviour (recorded by the plain `it`s): a Shadowmancer silently learns
 * nothing at all. Official necrotic is still blocked for the necrotic re-homes
 * (CLASS_SPELL_REMAP) even though the Codex school replacing it has no spells,
 * the rewritten grants point at Codex UUIDs that do not resolve, and no one is
 * told. Other casters are NOT affected the same way: the coverage filter only
 * drops official spells the Codex actually covers, so with an empty pack a Mage
 * falls back to the official fire/ice/lightning spells.
 */
import { describe, expect, it } from 'vitest';
import { adoptActor, createCharacter, renderSheet, setupWorld, spellSummary } from '../harness/index.mjs';
import { expectedShadowSpells, shadowmancerProgression, shadowmancerTier } from './helpers.mjs';

const uuidsOf = (list) => list.map((s) => s.uuid ?? s.source).sort();

describe('empty Codex spells pack — what happens today', () => {
	it('a Shadowmancer created and levelled to 5 owns no spells at all, with no warning', async () => {
		const run = await shadowmancerProgression({ emptyCodexSpells: true }, { maxLevel: 5 });
		expect(run.env.game.packs.get('blue-codex-package.blue-codex-spells').index.size).toBe(0);
		for (let level = 1; level <= 5; level += 1) expect(run.snaps[level].spells, `L${level}`).toEqual([]);
		// Nobody is told: no notification, no dialog, no hook error.
		expect(run.env.notifications.all).toEqual([]);
		expect(run.env.dialogs.log).toEqual([]);
		expect(run.env.Hooks.errors).toEqual([]);
		// …and the remap's high-water mark still advanced as if tiers 0-2 had been granted.
		expect(run.snaps[5].flags.classSchools).toEqual({ classId: 'shadowmancer', grantedTier: 2 });
	});

	it('the official necrotic spells were offered by the rules but vetoed (necrotic re-home is unconditional)', async () => {
		const { env } = await setupWorld({ emptyCodexSpells: true, replaceSpells: false });
		// Same world with Codex magic OFF: the Shadowmancer gets official necrotic → the
		// spells exist; it is the Codex re-home that removes them.
		const { actor } = await createCharacter(env, { classId: 'shadowmancer' });
		expect(spellSummary(actor).length).toBeGreaterThan(0);
		expect(spellSummary(actor).every((s) => s.school === 'necrotic')).toBe(true);
	});

	it('contrast: a Mage in the same empty-pack world falls back to the official spells', async () => {
		const { env } = await setupWorld({ emptyCodexSpells: true });
		const { actor } = await createCharacter(env, { classId: 'mage' });
		const spells = spellSummary(actor);
		expect(spells.length).toBeGreaterThan(0);
		expect(spells.every((s) => s.source.startsWith('Compendium.nimble.'))).toBe(true);
	});

	it('the next native level-up after the pack is repopulated heals the spell list', async () => {
		const broken = await shadowmancerProgression({ emptyCodexSpells: true }, { maxLevel: 5 });
		const data = broken.actor.toObject();
		// "Reload Foundry" with the packs rebuilt.
		const { env } = await setupWorld();
		const actor = adoptActor(env, data);
		await actor.triggerLevelUp();
		expect(uuidsOf(spellSummary(actor))).toEqual(uuidsOf(expectedShadowSpells(6)));
		expect(env.Hooks.errors).toEqual([]);
	});
});

describe('empty Codex spells pack — expected behaviour (bugs)', () => {
	it.fails('BUG-bc-1: a Shadowmancer with an empty Codex spells pack must not silently learn nothing (GM warning or official fallback)', async () => {
		const run = await shadowmancerProgression({ emptyCodexSpells: true }, { maxLevel: 5 });
		const warned = [...run.env.notifications.messages('warn'), ...run.env.notifications.messages('error')].some((m) =>
			/codex|spell/i.test(m),
		);
		const learned = run.snaps[5].spells.length > 0;
		expect(warned || learned).toBe(true);
	});

	it.fails('BUG-bc-2: after the Codex pack is repopulated, opening the sheet back-fills the spells the empty pack could not grant', async () => {
		const broken = await shadowmancerProgression({ emptyCodexSpells: true }, { maxLevel: 5 });
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
