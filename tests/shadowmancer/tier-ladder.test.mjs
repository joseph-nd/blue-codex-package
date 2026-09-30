/**
 * The Shadowmancer's spell-tier ladder (tier T unlocks at [2,5,7,10,13,16,19][T-1])
 * vs every other caster, for both caps main.mjs owns:
 *   - the GRANT cap  `maxSpellTierForLevel(level, classId)` (Codex school grants);
 *   - the CASTING cap `system.resources.highestUnlockedSpellTier`, which system 0.9
 *     derives from the grant thresholds (main.mjs's override is legacy-only now).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createCharacter, findDoc, nimbleHighestSpellTier, setupWorld } from '../harness/index.mjs';

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

/**
 * Since Nimble system 0.9 the CASTING cap is the system's own: the highest tier
 * the character's grantSpells level thresholds have reached (the Shadowmancer's
 * come from Master of Darkness: 2/5/7/10/13/16/19), with no mana gate — the
 * Shadowmancer has no mana at all (Pilfered Power is a charge pool). main.mjs's
 * cap-table override stands down when the class declares Pilfered Power
 * (`nativePilferedPower`), so these characters own the feature that grants the
 * tiers, and the value must come out the same with or without the module.
 */
async function withFeature(actor, name, classId = 'shadowmancer') {
	const { doc } = findDoc({ pack: 'nimble.nimble-class-features', name, type: 'feature', class: classId });
	const source = structuredClone(doc);
	delete source._id;
	await actor.createEmbeddedDocuments('Item', [source]);
	return actor;
}

describe('casting cap — highestUnlockedSpellTier after prepareDerivedData (system 0.9)', () => {
	let env;
	let T;
	beforeAll(async () => {
		({ env, main: { __test__: T } } = await setupWorld());
	});

	it.each(LEVELS)('shadowmancer at L%i: the Shadowmancer ladder, no mana', async (level) => {
		const { actor } = await createCharacter(env, { classId: 'shadowmancer', abilities: { dexterity: 3 }, render: false });
		await withFeature(actor, 'Master of Darkness');
		await setLevel(actor, level);
		const { mana, highestUnlockedSpellTier } = actor.system.resources;
		expect(mana.max).toBe(0); // Pilfered Power is a charge pool, not mana
		expect(highestUnlockedSpellTier).toBe(shadowmancerTier(level));
	});

	it('DEX does not matter and a stored (manual) cap wins, as in the system', async () => {
		for (const dex of [0, 4]) {
			const { actor } = await createCharacter(env, { classId: 'shadowmancer', abilities: { dexterity: dex }, render: false });
			await withFeature(actor, 'Master of Darkness');
			await setLevel(actor, 10);
			expect(actor.system.resources.highestUnlockedSpellTier).toBe(4);
		}
		const { actor } = await createCharacter(env, { classId: 'shadowmancer', render: false });
		await withFeature(actor, 'Master of Darkness');
		await actor.update({ 'system.resources.highestUnlockedSpellTier': 2 });
		await setLevel(actor, 20);
		expect(actor.system.resources.highestUnlockedSpellTier).toBe(2);
	});

	it.each(LEVELS.filter((l) => l > 1))('mage (INT 2) at L%i keeps the core Nimble ladder', async (level) => {
		const { actor } = await createCharacter(env, { classId: 'mage', abilities: { intelligence: 2 }, render: false });
		await withFeature(actor, 'Mana and Unlock Tier 1 Spells', 'mage');
		await setLevel(actor, level);
		expect(actor.system.resources.mana.max).toBeGreaterThan(0);
		expect(actor.system.resources.highestUnlockedSpellTier).toBe(nimbleHighestSpellTier(level));
	});

	it.each(LEVELS.filter((l) => l > 1))('shadowmancer L%i: grant cap == casting cap (grants never outrun casting)', async (level) => {
		const { actor } = await createCharacter(env, { classId: 'shadowmancer', abilities: { dexterity: 2 }, render: false });
		await withFeature(actor, 'Master of Darkness');
		await setLevel(actor, level);
		expect(actor.system.resources.highestUnlockedSpellTier).toBe(T.maxSpellTierForLevel(level, 'shadowmancer'));
	});
});
