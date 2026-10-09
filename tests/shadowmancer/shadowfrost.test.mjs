/**
 * Shadowfrost (Pact of the Abyssal Depths, a system feature): "Your Shadow Blast
 * also Slows." A Slowed condition node rides Shadow Blast's hit branch for the
 * cast only, never twice (Nim+ injects the same node id), and only for a caster
 * who has the feature.
 */
import { describe, expect, it } from 'vitest';
import { setupWorld } from '../harness/index.mjs';

async function load() {
	const { main } = await setupWorld({});
	return main.__shadowmancerInvocations__;
}

const shadowfrost = { type: 'feature', name: 'Shadowfrost', system: { identifier: 'shadowfrost' } };

function shadowBlast(features, { identifier = 'shadow-blast' } = {}) {
	return {
		type: 'spell',
		name: 'Shadow Blast',
		system: {
			identifier,
			activation: {
				effects: [
					{
						id: 'shadowBlastDamage1',
						type: 'damage',
						on: { hit: [{ id: 'shadowBlastHit1', type: 'damageOutcome' }], miss: [] },
					},
				],
			},
		},
		actor: { items: features },
	};
}

const hitIds = (spell) => spell.system.activation.effects[0].on.hit.map((n) => n.id);

describe('Shadowfrost', () => {
	it('adds Slowed to Shadow Blast on hit for the cast, then restores the spell', async () => {
		const h = await load();
		const spell = shadowBlast([shadowfrost]);
		const restore = h.applyShadowfrost(spell);
		expect(spell.system.activation.effects[0].on.hit.at(-1)).toEqual({
			id: h.SHADOWFROST_NODE_ID,
			type: 'condition',
			condition: 'slowed',
			parentContext: 'hit',
			parentNode: 'shadowBlastDamage1',
		});
		expect(h.applyShadowfrost(spell)).toBeNull();
		restore();
		expect(hitIds(spell)).toEqual(['shadowBlastHit1']);
	});

	it('needs the feature (by name or compendium source), and only touches Shadow Blast', async () => {
		const h = await load();
		expect(h.applyShadowfrost(shadowBlast([]))).toBeNull();
		expect(h.applyShadowfrost(shadowBlast([shadowfrost], { identifier: 'shadow-trap' }))).toBeNull();
		const translated = {
			type: 'feature',
			name: 'Escarcha sombría',
			system: { identifier: 'escarcha-sombria' },
			_stats: { compendiumSource: 'Compendium.nimble.nimble-class-features.Item.qihi3i4aGFMlvg00' },
		};
		expect(h.applyShadowfrost(shadowBlast([translated]))).toBeTypeOf('function');
	});
});

const nightfrost = { type: 'feature', name: 'Master of Nightfrost', system: { identifier: 'master-of-nightfrost' } };

function caster({ int = 3, level = 7, temp = 0, features = [nightfrost] } = {}) {
	return {
		name: 'Vex',
		items: features,
		system: {
			abilities: { intelligence: { mod: int } },
			classData: { levels: Array.from({ length: level }, () => 'shadowmancer') },
			attributes: { hp: { temp } },
		},
		updates: [],
		async update(changes) {
			this.updates.push(changes);
			this.system.attributes.hp.temp = changes['system.attributes.hp.temp'];
		},
	};
}

const d12 = (result) => ({ terms: [{ faces: 12, results: [{ result, active: true }] }] });

describe('Master of Nightfrost', () => {
	it('grants INT+LVL temp HP, never lowering what the caster already has', async () => {
		const h = await load();
		const actor = caster({ int: 3, level: 7 });
		expect(await h.grantNightfrost(actor, 'Shadow Blast')).toBe(true);
		expect(actor.system.attributes.hp.temp).toBe(10);
		expect(await h.grantNightfrost(actor, 'Shadow Blast')).toBe(false);
		expect(await h.grantNightfrost(caster({ temp: 12 }), 'Shadow Blast')).toBe(false);
		expect(await h.grantNightfrost(caster({ features: [] }), 'Shadow Blast')).toBe(false);
	});

	it('Shadow Blast: claims a max roll once per cast (shared with Nim+), skips anything else', async () => {
		const h = await load();
		const spell = { ...shadowBlast([]), actor: caster() };
		expect(h.claimNightfrostShadowBlast(spell, { rolls: [d12(11)] })).toBeNull();
		const context = { rolls: [d12(12)] };
		const grant = h.claimNightfrostShadowBlast(spell, context);
		expect(grant).toBeTypeOf('function');
		expect(context.nightfrostTempHp).toBe(true);
		expect(h.claimNightfrostShadowBlast(spell, context)).toBeNull();
		await grant();
		expect(spell.actor.system.attributes.hp.temp).toBe(10);
		// Nim+ claimed it first.
		expect(h.claimNightfrostShadowBlast(spell, { rolls: [d12(12)], nightfrostTempHp: true })).toBeNull();
		expect(h.claimNightfrostShadowBlast({ ...spell, actor: caster({ features: [] }) }, { rolls: [d12(12)] })).toBeNull();
	});
});
