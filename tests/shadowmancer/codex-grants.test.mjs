/**
 * Codex spell grants for a Shadowmancer at every level 1-20, driven through the
 * real grant paths: the ported Nimble creator / level-up (./harness/nimble.mjs)
 * reading pack indexes through main.mjs's getIndex patch and features through
 * its fromUuid rewrite, the preCreateItem vetoes, and main.mjs's own
 * `classSpellRemapSync` (CLASS_SPELL_REMAP shadowmancer → shadow) fired from the
 * class-level `updateItem` hook and the sheet render.
 *
 * The Shadowmancer is a necrotic re-home (CLASS_SPELL_REMAP), NOT a class-level
 * school choice: CLASS_SPELL_CHOICE (Dark Knowledge) belongs to the Specter and
 * must never prompt a Shadowmancer — asserted below.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { codexSpells, isCodexSpellUuid, spellIndexEntries } from '../harness/index.mjs';
import {
	CODEX_SHADOW_BLAST,
	CODEX_SUMMON_SHADOW,
	LEVELS,
	NP_COMMAND_SHADOWS,
	expectedShadowSpells,
	shadowmancerProgression,
	shadowmancerTier,
} from './helpers.mjs';

const VARIANTS = [
	['Codex only', {}],
	['Nim+ 0.2 copies present (playtest on)', { nimPlus: true }],
	['Nim+ installed, playtest off', { nimPlus: true, playtest: false }],
	['Nim+ 0.2 without its api (flag-index fallback)', { nimPlus: true, nimPlusApi: false }],
	['libWrapper active', { libWrapper: true }],
	['libWrapper + Nim+ 0.2', { libWrapper: true, nimPlus: true }],
];

const uuidsOf = (list) => list.map((s) => s.uuid ?? s.source).sort();

describe.each(VARIANTS)('Shadowmancer grants — %s', (_label, world) => {
	let run;
	beforeAll(async () => {
		run = await shadowmancerProgression(world);
	});

	it.each(LEVELS)('L%i owns exactly the Codex shadow spells its ladder unlocks', (level) => {
		const snap = run.snaps[level];
		expect(snap.level).toBe(level);
		expect(uuidsOf(snap.spells)).toEqual(uuidsOf(expectedShadowSpells(level)));
	});

	it.each(LEVELS)('L%i: no granted spell exceeds the ladder, no official/Nim+ spell, no duplicate', (level) => {
		const { spells } = run.snaps[level];
		const cap = shadowmancerTier(level);
		for (const spell of spells) {
			expect(spell.tier, `${spell.name} at L${level}`).toBeLessThanOrEqual(cap);
			expect(isCodexSpellUuid(spell.source), `${spell.name} source ${spell.source}`).toBe(true);
			expect(spell.school).toBe('shadow');
		}
		const sources = spells.map((s) => s.source);
		expect(new Set(sources).size).toBe(sources.length);
		// The highest tier unlocked is actually owned (every Codex shadow tier 0-7 has a spell).
		expect(Math.max(...spells.map((s) => s.tier))).toBe(level < 2 ? 0 : cap);
	});

	it('L1 learns its cantrips: Codex Shadow Blast + Summon Shadow (Conduit of Shadow, remapped)', () => {
		const { spells } = run.snaps[1];
		expect(spells.length).toBeGreaterThanOrEqual(1);
		expect(uuidsOf(spells)).toEqual([CODEX_SHADOW_BLAST, CODEX_SUMMON_SHADOW].sort());
		expect(spells.every((s) => s.tier === 0)).toBe(true);
	});

	it('L2 adds the rest of the shadow cantrips and tier 1 (Master of Darkness, rewritten to shadow)', () => {
		const created = run.snaps[2].created;
		expect(created.map((s) => s.tier).sort()).toEqual([0, 0, 0, 1]);
		expect(created.every((s) => s.school === 'shadow')).toBe(true);
	});

	it('L3/L4 add nothing (tier 2 waits for L5 on the Shadowmancer ladder)', () => {
		expect(run.snaps[3].created).toEqual([]);
		expect(run.snaps[4].created).toEqual([]);
		expect(Math.max(...run.snaps[4].spells.map((s) => s.tier))).toBe(1);
	});

	it('levelling 4 → 5 adds the tier-2 shadow spells', () => {
		const tier2 = codexSpells('shadow').filter((s) => s.tier === 2).map((s) => s.name).sort();
		expect(tier2.length).toBeGreaterThan(0);
		expect(run.snaps[5].created.filter((s) => s.tier === 2).map((s) => s.name).sort()).toEqual(tier2);
		expect(run.snaps[5].created.every((s) => s.tier === 2)).toBe(true);
	});

	it.each(LADDER_STEPS())('ladder step L%i adds exactly tier %i', (level, tier) => {
		const created = run.snaps[level].created;
		expect(created.length).toBeGreaterThan(0);
		expect([...new Set(created.map((s) => s.tier))]).toEqual([tier]);
	});

	it('the casting cap matches the grant ladder once the Shadowmancer has mana (L2+)', () => {
		expect(run.snaps[1].highestUnlockedSpellTier).toBeNull();
		for (const level of LEVELS.filter((l) => l > 1)) {
			expect(run.snaps[level].highestUnlockedSpellTier, `L${level}`).toBe(shadowmancerTier(level));
		}
	});

	it('the classSchools high-water mark tracks the ladder', () => {
		for (const level of LEVELS) {
			expect(run.snaps[level].flags.classSchools, `L${level}`).toEqual({ classId: 'shadowmancer', grantedTier: shadowmancerTier(level) });
		}
	});

	it('never grants Command Shadows (dropped: the Codex Summon Shadow already carries the command)', () => {
		expect(run.snaps[20].spells.some((s) => s.source === NP_COMMAND_SHADOWS || s.name === 'Command Shadows')).toBe(false);
	});

	it('no Dark Knowledge prompt, no dialogs, no hook errors, no warnings', () => {
		expect(run.env.dialogs.log).toEqual([]);
		expect(run.snaps[20].hookErrors).toBe(0);
		expect(run.env.notifications.messages('warn')).toEqual([]);
		expect(run.env.notifications.messages('error')).toEqual([]);
		expect(run.snaps[20].flags.classSpellChoice).toBeUndefined();
	});

	it('the level-up grant index hides official necrotic spells from the Shadowmancer', () => {
		// Every level-up's spell index (built inside the wrapped triggerLevelUp) was
		// free of official/Nim+ necrotic; the preview never offered one.
		for (const level of LEVELS.filter((l) => l > 1)) {
			const preview = run.snaps[level].preview;
			for (const entry of [...preview.autoGrant, ...preview.spellSelections.flatMap((g) => g.availableSpells)]) {
				expect(isCodexSpellUuid(entry.uuid), `L${level} preview ${entry.name} ${entry.uuid}`).toBe(true);
			}
		}
	});
});

/** [level, tier] for each Shadowmancer ladder step above tier 1 (L5 → 2 … L19 → 7). */
function LADDER_STEPS() {
	return [
		[5, 2],
		[7, 3],
		[10, 4],
		[13, 5],
		[16, 6],
		[19, 7],
	];
}

describe('Shadowmancer grants with a subclass', () => {
	it('Pact of the Abyssal Depths (system, Master of Nightfrost → Codex ice) stays inside the ladder', async () => {
		const run = await shadowmancerProgression({}, { maxLevel: 12, subclass: 'Pact of the Abyssal Depths' });
		for (let level = 3; level <= 12; level += 1) {
			const { spells } = run.snaps[level];
			const cap = shadowmancerTier(level);
			expect(spells.every((s) => s.tier <= cap), `L${level}`).toBe(true);
			expect(spells.every((s) => isCodexSpellUuid(s.source)), `L${level} official leak`).toBe(true);
			// Shadow is untouched by the subclass.
			expect(uuidsOf(spells.filter((s) => s.school === 'shadow'))).toEqual(uuidsOf(expectedShadowSpells(level)));
			// Master of Nightfrost grants Codex ice (the Codex covers ice, so official ice is filtered out).
			const ice = spells.filter((s) => s.school === 'ice');
			const expectedIce = codexSpells('ice').filter((s) => s.tier <= cap);
			expect(uuidsOf(ice), `L${level} ice`).toEqual(uuidsOf(expectedIce));
		}
		expect(run.env.Hooks.errors).toEqual([]);
	});

	it('a Blue Codex pact (Pact of the Mesmer) does not disturb the shadow grants', async () => {
		const run = await shadowmancerProgression({}, { maxLevel: 7, subclass: 'Pact of the Mesmer' });
		expect(run.actor.items.some((i) => i.type === 'subclass' && i.name === 'Pact of the Mesmer')).toBe(true);
		for (let level = 1; level <= 7; level += 1) {
			expect(uuidsOf(run.snaps[level].spells), `L${level}`).toEqual(uuidsOf(expectedShadowSpells(level)));
		}
		// The only prompts are the pact's invocation pools (left unanswered = deferred);
		// nothing asks about spell schools.
		expect(run.env.dialogs.log.map((d) => d.title).filter((t) => !/Invocations$/.test(t))).toEqual([]);
		expect(run.env.Hooks.errors).toEqual([]);
	});
});

describe('outside a level-up the official necrotic spells stay in the grant index', () => {
	it('Mage/Songweaver necrotic choices keep working (only the Shadowmancer level-up drops them)', async () => {
		const { setupWorld, buildSpellIndex } = await import('../harness/index.mjs');
		const { env } = await setupWorld();
		const index = await buildSpellIndex();
		const necrotic = spellIndexEntries(index).filter((s) => s.school === 'necrotic');
		expect(necrotic.length).toBeGreaterThan(0);
		expect(necrotic.every((s) => s.uuid.startsWith('Compendium.nimble.'))).toBe(true);
		expect(env.Hooks.errors).toEqual([]);
	});
});

describe('Shadowmastery (L6 / L8 / L14: necrotic UTILITY spells)', () => {
	const utilityGroups = (step) => step.preview.spellSelections.filter((g) => g.utilityOnly);

	it('control — Codex magic off: L6 and L8 each offer a necrotic utility pick, L14 grants the rest', async () => {
		const run = await shadowmancerProgression({ replaceSpells: false }, { maxLevel: 14 });
		const utility = (level) => run.snaps[level].spells.filter((s) => s.school === 'necrotic' && s.tier === 0);
		expect(utility(6).length).toBe(utility(5).length + 1);
		expect(utility(8).length).toBe(utility(7).length + 1);
		expect(utility(14).length).toBeGreaterThan(utility(13).length);
	});

	// By design (Blue's Codex magic): the Codex re-homes the Shadowmancer on the shadow
	// school, which has no utility spells, so Shadowmastery grants nothing. Formerly
	// logged as BUG-bc-3; the user confirmed it is intended.
	it('by design, with Codex magic on: the rules are rewritten to "shadow utility", which does not exist → nothing offered', async () => {
		const { env } = await (await import('../harness/index.mjs')).setupWorld();
		const { buildCharacterByLevelUps } = await import('../harness/index.mjs');
		const { steps } = await buildCharacterByLevelUps(env, 'shadowmancer', 8);
		expect(utilityGroups(steps[5])).toEqual([]); // L6
		expect(utilityGroups(steps[7])).toEqual([]); // L8
		expect(codexSpells('shadow').filter((s) => (s.doc.system.properties?.selected ?? []).includes('utilitySpell'))).toEqual([]);
	});
});
