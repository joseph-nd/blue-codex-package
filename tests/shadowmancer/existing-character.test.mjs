/**
 * Shadowmancers that already exist when something changes: Codex magic switched
 * on for an official-necrotic character, a high-water flag written by the old
 * (pre-ladder, floor(L/2)) grant cap, and a player (non-GM) owner levelling up.
 */
import { describe, expect, it } from 'vitest';
import { adoptActor, renderSheet, setupWorld, spellSummary } from '../harness/index.mjs';
import { expectedShadowSpells, shadowmancerProgression, shadowmancerTier } from './helpers.mjs';

const uuidsOf = (list) => list.map((s) => s.uuid ?? s.source).sort();

describe('Codex magic switched on for an official-necrotic Shadowmancer', () => {
	it('the first sheet render prunes official necrotic and grants the Codex shadow tiers of its level', async () => {
		const legacy = await shadowmancerProgression({ replaceSpells: false }, { maxLevel: 5 });
		expect(legacy.snaps[5].spells.every((s) => s.school === 'necrotic')).toBe(true);
		expect(legacy.snaps[5].spells.length).toBeGreaterThan(0);

		const { env } = await setupWorld(); // reload with the setting on
		const actor = adoptActor(env, legacy.actor.toObject());
		await renderSheet(env, actor);
		expect(uuidsOf(spellSummary(actor))).toEqual(uuidsOf(expectedShadowSpells(5)));
		expect(actor.flags['blue-codex-package'].classSchools).toEqual({ classId: 'shadowmancer', grantedTier: 2 });

		// Its owned features still carry the official necrotic rules; level-ups keep
		// working through the veto + the remap sync.
		await actor.triggerLevelUp();
		await actor.triggerLevelUp();
		expect(uuidsOf(spellSummary(actor))).toEqual(uuidsOf(expectedShadowSpells(7)));
		expect(env.Hooks.errors).toEqual([]);
	});
});

describe('a high-water flag written by the old floor(L/2) cap', () => {
	it('does not over-grant (tier 2 still waits for L5), and L5 brings tier 2', async () => {
		const run = await shadowmancerProgression({}, { maxLevel: 4 });
		const data = run.actor.toObject();
		data.flags['blue-codex-package'].classSchools.grantedTier = 2; // old cap at L4
		const { env } = await setupWorld();
		const actor = adoptActor(env, data);
		await renderSheet(env, actor);
		expect(Math.max(...spellSummary(actor).map((s) => s.tier))).toBe(shadowmancerTier(4));
		await actor.triggerLevelUp();
		expect(uuidsOf(spellSummary(actor))).toEqual(uuidsOf(expectedShadowSpells(5)));
	});
});

describe('a player-owned Shadowmancer levelled by its player', () => {
	it('learns the same spells as the GM-driven one', async () => {
		const { env } = await setupWorld({ isGM: false });
		const { createCharacter } = await import('../harness/index.mjs');
		const { actor } = await createCharacter(env, { classId: 'shadowmancer', ownedByPlayer: true });
		expect(actor.isOwner).toBe(true);
		for (let level = 2; level <= 5; level += 1) await actor.triggerLevelUp();
		expect(uuidsOf(spellSummary(actor))).toEqual(uuidsOf(expectedShadowSpells(5)));
		expect(env.Hooks.errors).toEqual([]);
	});
});
