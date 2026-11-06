/**
 * The rest window's option swap (`getOptionSwapOffer`) reads the class-feature index,
 * which hides `subclass: true` features, so scripts/main.mjs names the character's
 * subclass while the offer is built: its pool options join the base pool, and only
 * its own.
 */
import { describe, expect, it } from 'vitest';
import { createCharacter, renderSheet, setupWorld } from '../harness/index.mjs';
import { buildClassFeatureIndex } from '../harness/nimble.mjs';

const POOL = 'underhanded-abilities';

async function cheat(env, subclassId) {
	const { actor } = await createCharacter(env, { classId: 'the-cheat', abilities: { dexterity: 3 } });
	if (subclassId) {
		await actor.createEmbeddedDocuments('Item', [
			{ name: subclassId, type: 'subclass', system: { identifier: subclassId, parentClass: 'the-cheat' } },
		]);
	}
	await renderSheet(env, actor);
	return actor;
}

const memberNames = async (offer) =>
	Promise.all([...(offer.pools.get(POOL) ?? [])].map(async (uuid) => (await fromUuid(uuid)).name));

describe('option swap offer', () => {
	it('adds the subclass pool options to the base pool', async () => {
		const { env } = await setupWorld();
		const names = await memberNames(await (await cheat(env, 'tools-of-the-deadeye')).getOptionSwapOffer('safeRest'));
		expect(names).toEqual(expect.arrayContaining(['Hamstringer', 'Grappling Hook!']));
		// The base pool stays on offer next to them.
		expect(names.length).toBeGreaterThan(4);
		expect(env.Hooks.errors).toEqual([]);
	});

	it("does not offer another subclass's options", async () => {
		const { env } = await setupWorld();
		const names = await memberNames(await (await cheat(env, 'tools-of-the-shifter')).getOptionSwapOffer('safeRest'));
		expect(names).toContain('Pocket Critter');
		expect(names).not.toContain('Hamstringer');
	});

	it('offers only the base pool without a Codex subclass', async () => {
		const { env } = await setupWorld();
		const names = await memberNames(await (await cheat(env, null)).getOptionSwapOffer('safeRest'));
		expect(names.length).toBeGreaterThan(0);
		expect(names).not.toContain('Hamstringer');
	});

	it('names the subclass only while the offer is built', async () => {
		const { env } = await setupWorld();
		const actor = await cheat(env, 'tools-of-the-deadeye');
		await actor.getOptionSwapOffer('safeRest');
		const index = await buildClassFeatureIndex();
		const uuids = [...(index.get('the-cheat')?.values() ?? [])].flat().map((entry) => entry.uuid);
		const names = (await Promise.all(uuids.map((uuid) => fromUuid(uuid)))).map((doc) => doc?.name);
		expect(names).not.toContain('Hamstringer');
	});
});
