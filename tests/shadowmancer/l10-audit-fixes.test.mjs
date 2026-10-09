/**
 * L10 audit follow-ups (2026-10-04):
 *  #9  Master of Nightfrost reads Shadow Blast whatever its `system.identifier` is
 *      (the system's and Nim+'s copies have none);
 *  #10 Swarming Shadows picks a free cell outside a Large target's footprint;
 *  #43 an owned Command Shadows copy gets its pool label refreshed to "(1/round)".
 */
import { describe, expect, it } from 'vitest';
import { adoptActor, findDoc, setupWorld } from '../harness/index.mjs';

const MODULE_ID = 'blue-codex-package';
const nightfrostFeature = { type: 'feature', name: 'Master of Nightfrost', system: { identifier: 'master-of-nightfrost' } };
const d12 = (result) => ({ primaryDie: { faces: 12, results: [{ result, active: true }] } });

describe('Master of Nightfrost on Shadow Blast copies without an identifier', () => {
	it('claims a max roll for a copy with an empty identifier (system / Nim+ copy)', async () => {
		const { main } = await setupWorld({});
		const h = main.__shadowmancerInvocations__;
		const actor = { items: [nightfrostFeature] };
		for (const system of [{ identifier: '' }, {}, { identifier: 'shadow-blast' }]) {
			const spell = { type: 'spell', name: 'Shadow Blast', system, actor };
			const context = { rolls: [d12(12)] };
			expect(h.claimNightfrostShadowBlast(spell, context)).toBeTypeOf('function');
			expect(context.nightfrostTempHp).toBe(true);
			expect(h.claimNightfrostShadowBlast(spell, { rolls: [d12(11)] })).toBeNull();
		}
		const other = { type: 'spell', name: 'Shadow Spear Dance', system: { identifier: '' }, actor };
		expect(h.claimNightfrostShadowBlast(other, { rolls: [d12(12)] })).toBeNull();
	});
});

describe('Master of Nightfrost: useItem context rolls are JSON strings', () => {
	it('reads the primary die off a serialized DamageRoll (forced 12, exploded to [12, 3])', async () => {
		const { main } = await setupWorld({});
		const h = main.__shadowmancerInvocations__;
		const json = (results) =>
			JSON.stringify({
				class: 'DamageRoll',
				formula: '1d12x + 1 + (floor(10 / 5))d12',
				terms: [
					{ class: 'PrimaryDie', faces: 12, number: 1, results },
					{ class: 'OperatorTerm', operator: '+' },
					{ class: 'Die', faces: 12, number: 2, results: [{ result: 12, active: true }] },
				],
			});
		const spell = { type: 'spell', name: 'Shadow Blast', system: { identifier: 'shadow-blast' }, actor: { items: [nightfrostFeature] } };
		const hit = { rolls: [json([{ result: 12, active: true }, { result: 3, active: true }])] };
		expect(h.claimNightfrostShadowBlast(spell, hit)).toBeTypeOf('function');
		expect(h.claimNightfrostShadowBlast(spell, { rolls: [json([{ result: 11, active: true }])] })).toBeNull();
		expect(h.claimNightfrostShadowBlast(spell, { rolls: ['not json'] })).toBeNull();
	});
});

describe('Swarming Shadows spawn cell', () => {
	const scene = (tokens) => ({ grid: { size: 100 }, tokens });
	const overlaps = (cell, t) =>
		cell.x < t.x + (t.width ?? 1) * 100 && cell.x + 100 > t.x && cell.y < t.y + (t.height ?? 1) * 100 && cell.y + 100 > t.y;

	it('Medium target: east cell first, as before', async () => {
		const { main } = await setupWorld({});
		const target = { x: 500, y: 500, width: 1, height: 1 };
		expect(main.__shadowmancerInvocations__.findFreeAdjacentPosition(scene([target]), target)).toEqual({ x: 600, y: 500 });
	});

	it('Large target: lands outside its 2x2 footprint and around other tokens', async () => {
		const { main } = await setupWorld({});
		const find = main.__shadowmancerInvocations__.findFreeAdjacentPosition;
		const troll = { x: 800, y: 700, width: 2, height: 2 };
		const first = find(scene([troll]), troll);
		expect(overlaps(first, troll)).toBe(false);
		expect(first).toEqual({ x: 1000, y: 700 });
		// A 1x1 token already on the east column and the footprint of another Large token.
		const blockers = [{ x: 1000, y: 700, width: 1, height: 1 }, { x: 1000, y: 800, width: 2, height: 2 }];
		const next = find(scene([troll, ...blockers]), troll);
		expect(overlaps(next, troll)).toBe(false);
		for (const b of blockers) expect(overlaps(next, b)).toBe(false);
		// The bug: a cell one grid step from the target's origin sits inside its footprint.
		expect(overlaps({ x: 900, y: 800 }, troll)).toBe(true);
	});
});

describe('owned Command Shadows pool label', () => {
	it('is re-labelled to (1/round) in place, keeping the pool charges', async () => {
		const { main, env } = await setupWorld();
		const hit = findDoc({ pkg: MODULE_ID, type: 'spell', name: 'Command Shadows' });
		const pool = hit.doc.system.rules.find((r) => r.type === 'chargePool');
		expect(pool.label).toBe('Command Shadows (1/round)');
		expect(hit.doc.system.description.baseEffect).toContain('(1/round)');
		const data = structuredClone(hit.doc);
		data._id = 'ownedCommand0001';
		data._stats = { ...(data._stats ?? {}), compendiumSource: hit.uuid };
		data.flags = {
			...(data.flags ?? {}),
			nimble: { chargePools: { [pool.identifier]: { current: 0, max: 1, label: 'Command Shadows (1/turn)' } } },
		};
		const actor = adoptActor(env, { _id: undefined, name: 'Id', type: 'character', system: {}, flags: {}, items: [data] });
		const plan = await main.__contentSync__.planCodexContentSync(actor);
		expect(plan.updates).toHaveLength(1);
		expect(plan.updates[0].changed).toContain(`${pool.identifier} counter label`);
		const result = await main.__contentSync__.syncCodexContent({ actors: [actor] });
		expect(result.status).toBe('applied');
		const entry = actor.items.get('ownedCommand0001')._source.flags.nimble.chargePools[pool.identifier];
		expect(entry).toEqual({ current: 0, max: 1, label: 'Command Shadows (1/round)' });
		// Idempotent.
		expect((await main.__contentSync__.planCodexContentSync(actor)).updates).toEqual([]);
	});
});
