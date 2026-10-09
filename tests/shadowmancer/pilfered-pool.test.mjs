/**
 * Pilfered Power on a system without a native `spellcasting.cost` (0.9.0), with
 * Nim+'s `pilfered-power` actor pool present: the pool is the single counter.
 * Blue spends it (and counts the overdraft against it) instead of mana; with no
 * pool the legacy mana model is unchanged. Shadowrime: Omenrime / Rimeblades may
 * be paid with 10 temp HP instead.
 */
import { describe, expect, it, vi } from 'vitest';
import { cards, giveFeature, MODULE_ID, shadowmancerWorld } from '../summons/helpers.mjs';

const POOL = 'pilfered-power';
const undoCards = (env, from, type) => cards(env, from).filter((c) => c.flags?.[MODULE_ID]?.undo?.type === type);

// A 0.9.0-style world: the class declares no cost, mana is the legacy budget.
async function legacyWorld({ level = 10, pool = null, mana = 2 } = {}) {
	const world = await shadowmancerWorld({ level });
	const { actor } = world;
	const cls = actor.items.find((i) => i.type === 'class');
	await cls.update({ 'system.spellcasting.cost.poolIdentifier': '' });
	await actor.update({ 'system.resources.mana.current': mana });
	if (pool) await giveFeature(actor, 'Pilfered Power', { pool: POOL, current: pool.current, max: pool.max });
	await actor.update({ 'system.attributes.hp.max': 40, 'system.attributes.hp.value': 40, 'system.attributes.hp.temp': 15 });
	return world;
}
async function spell(actor, name = 'Test Spell', extra = {}) {
	const [s] = await actor.createEmbeddedDocuments('Item', [
		{ name, type: 'spell', system: { tier: 1, school: 'shadow', activation: { effects: [] }, ...extra } },
	]);
	return s;
}
async function cast(h, actor, s, choose) {
	const plan = await h.preparePilferedPowerCast(s);
	if (choose) choose(plan);
	h.onSpellPreUse(s, { upcast: { manaSpent: 4 } });
	await h.applyShadowmancerFlatCost(s, {});
	return plan;
}
const poolNow = (actor) => actor.items.find((i) => i.name === 'Pilfered Power').flags.nimble.chargePools[POOL].current;

describe('Pilfered Power: the Nim+ pool is the single counter', () => {
	it('spends the pool, not mana, and posts an Undo card that restores the pool', async () => {
		const { env, h, actor } = await legacyWorld({ pool: { current: 2, max: 2 } });
		expect(h.nimPlusPilferedPool(actor)).toMatchObject({ current: 2, max: 2 });
		const s = await spell(actor);
		const before = env.ChatMessage.created.length;
		await cast(h, actor, s);
		expect(poolNow(actor)).toBe(1);
		expect(actor.system.resources.mana.current).toBe(2);
		const [card] = undoCards(env, before, 'poolDelta');
		await h.UNDO_HANDLERS.get('poolDelta')(card.flags[MODULE_ID].undo.data, {});
		expect(poolNow(actor)).toBe(2);
	});

	it('overdraft is counted against the pool: empty pool -> patron backlash, mana untouched, Undo gives the HP back', async () => {
		const { env, h, actor } = await legacyWorld({ pool: { current: 0, max: 1 }, mana: 3 });
		const s = await spell(actor);
		const plan = await h.preparePilferedPowerCast(s);
		expect(plan).toMatchObject({ overdraft: true, damage: 20 });
		h.onSpellPreUse(s, { upcast: { manaSpent: 2 } });
		const before = env.ChatMessage.created.length;
		await h.applyShadowmancerFlatCost(s, {});
		expect(actor.system.attributes.hp.temp + actor.system.attributes.hp.value).toBe(35);
		expect(actor.system.resources.mana.current).toBe(3);
		expect(poolNow(actor)).toBe(0);
		expect(undoCards(env, before, 'patronBacklash')).toHaveLength(1);
	});

	it('a cast with mana at 0 but pool uses left is not an overdraft', async () => {
		const { h, actor } = await legacyWorld({ pool: { current: 1, max: 1 }, mana: 0 });
		const plan = await h.preparePilferedPowerCast(await spell(actor));
		expect(plan.overdraft).toBe(false);
	});

	it('Hungering Shadows free cast spends neither the pool nor mana', async () => {
		const { h, actor } = await legacyWorld({ pool: { current: 1, max: 1 } });
		await giveFeature(actor, 'Hungering Shadows', { pool: 'hungering-shadows', current: 1, max: 1 });
		await cast(h, actor, await spell(actor));
		expect(poolNow(actor)).toBe(1);
		expect(actor.system.resources.mana.current).toBe(2);
	});

	it('every tiered spell is covered, whatever its school (Ice included); cantrips are not', async () => {
		const { h, actor } = await legacyWorld({ pool: { current: 0, max: 1 } });
		const ice = await spell(actor, 'Ice Test', { school: 'ice' });
		expect(await h.preparePilferedPowerCast(ice)).toMatchObject({ overdraft: true });
		const cantrip = await spell(actor, 'Cantrip Test', { school: 'ice', tier: 0 });
		expect(await h.preparePilferedPowerCast(cantrip)).toBeNull();
	});

	it('no pool (Nim+ inactive): the legacy mana model is unchanged', async () => {
		const { h, actor } = await legacyWorld({ pool: null, mana: 2 });
		expect(h.nimPlusPilferedPool(actor)).toBeNull();
		await cast(h, actor, await spell(actor));
		expect(actor.system.resources.mana.current).toBe(1);
	});
});

describe('Shadowrime: Rimeblades / Omenrime for 10 temp HP', () => {
	const rimeblades = (actor) => spell(actor, 'Rimeblades', { identifier: 'rimeblades', school: 'ice', tier: 4 });

	it('chosen: 10 temp HP instead of the pool; Undo gives the temp HP back', async () => {
		const { env, h, actor } = await legacyWorld({ pool: { current: 1, max: 1 } });
		await giveFeature(actor, 'Shadowrime');
		const before = env.ChatMessage.created.length;
		await cast(h, actor, await rimeblades(actor), (plan) => {
			plan.shadowrime = true;
		});
		expect(actor.system.attributes.hp.temp).toBe(5);
		expect(poolNow(actor)).toBe(1);
		expect(actor.system.resources.mana.current).toBe(2);
		const [card] = undoCards(env, before, 'patronBacklash');
		await h.UNDO_HANDLERS.get('patronBacklash')(card.flags[MODULE_ID].undo.data, {});
		expect(actor.system.attributes.hp.temp).toBe(15);
	});

	it('chosen at an empty pool: no backlash either', async () => {
		const { h, actor } = await legacyWorld({ pool: { current: 0, max: 1 } });
		await giveFeature(actor, 'Shadowrime');
		await cast(h, actor, await rimeblades(actor), (plan) => {
			plan.shadowrime = true;
		});
		expect(actor.system.attributes.hp.value).toBe(40);
		expect(actor.system.attributes.hp.temp).toBe(5);
	});

	it('not chosen: Pilfered Power is spent as usual, temp HP untouched', async () => {
		const { h, actor } = await legacyWorld({ pool: { current: 1, max: 1 } });
		await giveFeature(actor, 'Shadowrime');
		await cast(h, actor, await rimeblades(actor));
		expect(poolNow(actor)).toBe(0);
		expect(actor.system.attributes.hp.temp).toBe(15);
	});

	it('legacy mana model (no pool): the option spares the mana', async () => {
		const { h, actor } = await legacyWorld({ pool: null, mana: 1 });
		await giveFeature(actor, 'Shadowrime');
		await cast(h, actor, await rimeblades(actor), (plan) => {
			plan.shadowrime = true;
		});
		expect(actor.system.resources.mana.current).toBe(1);
		expect(actor.system.attributes.hp.temp).toBe(5);
	});

	it('the checkbox is offered only for Omenrime/Rimeblades with the feature (and not on a free cast); disabled under 10 temp HP', async () => {
		const { h, actor } = await legacyWorld({ pool: { current: 1, max: 1 } });
		const rime = await rimeblades(actor);
		expect(h.shadowrimeOffer(actor, rime)).toBeNull(); // no feature yet
		await giveFeature(actor, 'Shadowrime');
		expect(h.shadowrimeOffer(actor, await spell(actor))).toBeNull(); // not Omenrime/Rimeblades
		expect(h.shadowrimeOffer(actor, rime)).toEqual({ temp: 15, enough: true });
		h.shadowmancerCastPlans.set(actor.uuid, { free: true });
		expect(h.shadowrimeOffer(actor, rime)).toBeNull();
		h.shadowmancerCastPlans.set(actor.uuid, { free: false });
		await actor.update({ 'system.attributes.hp.temp': 4 });
		expect(h.shadowrimeOffer(actor, rime)).toEqual({ temp: 4, enough: false });
	});
});
