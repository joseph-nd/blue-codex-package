/**
 * The Shadowmancer's spell-tier ladder (tier T unlocks at [2,5,7,10,13,16,19][T-1])
 * vs every other caster, for both caps main.mjs owns:
 *   - the GRANT cap  `maxSpellTierForLevel(level, classId)` (Codex school grants);
 *   - the CASTING cap `system.resources.highestUnlockedSpellTier`, which main.mjs
 *     overrides for shadowmancers in a prepareDerivedData wrap (mana > 0 only).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createCharacter, nimbleHighestSpellTier, setupWorld } from '../harness/index.mjs';

/** Independent oracle: the Shadowmancer table from Blue's Codex / the Nimble class. */
const LADDER = [2, 5, 7, 10, 13, 16, 19];
const shadowmancerTier = (level) => LADDER.filter((l) => level >= l).length;
/** Generic Codex caster grant cap: tier T at level 2·T, capped at 9. */
const genericGrantTier = (level) => Math.min(9, Math.floor(level / 2));
const LEVELS = Array.from({ length: 20 }, (_, i) => i + 1);

/** Put a character at `level` (class item + classData.levels), re-preparing it. */
async function setLevel(actor, level) {
	const cls = actor.items.find((i) => i.type === 'class');
	await cls.update({ 'system.classLevel': level });
	await actor.update({ 'system.classData.levels': Array(level).fill(cls.identifier) });
	return actor;
}

describe('grant cap — maxSpellTierForLevel', () => {
	let T;
	beforeAll(async () => {
		({ main: { __test__: T } } = await setupWorld({ boot: false }));
	});

	it('exports the ladder main.mjs uses', () => {
		expect(T.SHADOWMANCER_TIER_THRESHOLDS).toEqual(LADDER);
	});

	it.each(LEVELS)('shadowmancer L%i follows the Shadowmancer ladder', (level) => {
		expect(T.maxSpellTierForLevel(level, 'shadowmancer')).toBe(shadowmancerTier(level));
		expect(T.shadowmancerHighestTier(level)).toBe(shadowmancerTier(level));
	});

	it.each(LEVELS)('other casters L%i keep tier T at level 2T', (level) => {
		for (const classId of ['mage', 'shepherd', 'songweaver', 'stormshifter', 'oathsworn', 'specter', null]) {
			expect(T.maxSpellTierForLevel(level, classId)).toBe(genericGrantTier(level));
		}
	});

	it('the ladder is slower than the generic cap at L4 and from L8 on, never faster', () => {
		for (const level of LEVELS) expect(T.maxSpellTierForLevel(level, 'shadowmancer')).toBeLessThanOrEqual(genericGrantTier(level));
		expect(T.maxSpellTierForLevel(4, 'shadowmancer')).toBe(1);
		expect(T.maxSpellTierForLevel(4, 'mage')).toBe(2);
		expect(T.maxSpellTierForLevel(5, 'shadowmancer')).toBe(2);
		expect(T.maxSpellTierForLevel(20, 'shadowmancer')).toBe(7);
		expect(T.maxSpellTierForLevel(20, 'mage')).toBe(9);
	});

	it('tolerates junk levels (0, undefined, strings)', () => {
		expect(T.maxSpellTierForLevel(0, 'shadowmancer')).toBe(0);
		expect(T.maxSpellTierForLevel(undefined, 'shadowmancer')).toBe(0);
		expect(T.maxSpellTierForLevel('5', 'shadowmancer')).toBe(2);
		expect(T.maxSpellTierForLevel(undefined, 'mage')).toBe(0);
	});
});

describe('casting cap — highestUnlockedSpellTier after prepareDerivedData', () => {
	let env;
	let T;
	beforeAll(async () => {
		({ env, main: { __test__: T } } = await setupWorld());
	});

	it.each(LEVELS)('shadowmancer (DEX 3) at L%i', async (level) => {
		const { actor } = await createCharacter(env, { classId: 'shadowmancer', abilities: { dexterity: 3 }, render: false });
		await setLevel(actor, level);
		const { mana, highestUnlockedSpellTier } = actor.system.resources;
		if (level === 1) {
			// Nimble: level-1 characters have only baseMax mana (0) → not a caster yet.
			expect(mana.max).toBe(0);
			expect(highestUnlockedSpellTier).toBeNull();
		} else {
			expect(mana.max).toBe(3); // Pilfered Power: mana = DEX
			expect(highestUnlockedSpellTier).toBe(shadowmancerTier(level));
		}
	});

	it('shadowmancer with no mana (DEX 0) is left alone (null, core semantics)', async () => {
		const { actor } = await createCharacter(env, { classId: 'shadowmancer', abilities: { dexterity: 0 }, render: false });
		for (const level of [2, 5, 10, 20]) {
			await setLevel(actor, level);
			expect(actor.system.resources.mana.max).toBe(0);
			expect(actor.system.resources.highestUnlockedSpellTier).toBeNull();
		}
	});

	it.each(LEVELS)('mage (INT 2) at L%i keeps the core Nimble ladder', async (level) => {
		const { actor } = await createCharacter(env, { classId: 'mage', abilities: { intelligence: 2 }, render: false });
		await setLevel(actor, level);
		const { mana, highestUnlockedSpellTier } = actor.system.resources;
		if (level === 1) expect(highestUnlockedSpellTier).toBeNull();
		else {
			expect(mana.max).toBeGreaterThan(0);
			expect(highestUnlockedSpellTier).toBe(nimbleHighestSpellTier(level));
		}
	});

	it.each(LEVELS.filter((l) => l > 1))('shadowmancer L%i: grant cap == casting cap (grants never outrun casting)', async (level) => {
		const { actor } = await createCharacter(env, { classId: 'shadowmancer', abilities: { dexterity: 2 }, render: false });
		await setLevel(actor, level);
		expect(actor.system.resources.highestUnlockedSpellTier).toBe(T.maxSpellTierForLevel(level, 'shadowmancer'));
	});
});
