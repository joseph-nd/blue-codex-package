/**
 * Leeching Dark (Blue spell): "You regain HP equal to the damage done."
 * Nimble's Apply Damage fires `damageApplied` per target after applying the
 * reduced damage; Blue heals the caster by the HP the target actually lost
 * (capped at the caster's max HP) and posts an Undo card.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adoptActor, REPO_ROOT, setupWorld } from '../harness/index.mjs';

const spell = JSON.parse(
	fs.readFileSync(path.join(REPO_ROOT, 'pack-sources/spells/ruin/shadow/leeching-dark.json'), 'utf-8'),
);

function makeActor(env, id, name, hp, max, temp = 0) {
	const actor = adoptActor(env, {
		_id: id,
		name,
		type: 'character',
		system: { attributes: { hp: { value: hp, max, temp } } },
	});
	// Nimble's HP methods (the harness actor has no system class).
	actor.applyDamage = async function (damage) {
		const { value, temp: t } = this.system.attributes.hp;
		const absorbed = Math.min(t, damage);
		const next = Math.max(value - (damage - absorbed), 0);
		await this.update({ 'system.attributes.hp.temp': t - absorbed, 'system.attributes.hp.value': next });
	};
	actor.setCurrentHP = async function (v) {
		await this.update({ 'system.attributes.hp.value': Math.clamp ? Math.clamp(v, 0, this.system.attributes.hp.max) : Math.min(Math.max(v, 0), this.system.attributes.hp.max) });
	};
	return actor;
}

async function world({ casterHp = 10, targetHp = 30, targetTemp = 0 } = {}) {
	const { env, main } = await setupWorld({ isGM: true });
	const caster = makeActor(env, 'leechCaster00001', 'Umbra', casterHp, 40);
	const target = makeActor(env, 'leechTarget00001', 'Goblin', targetHp, 30, targetTemp);
	return { env, h: main.__engineer__, caster, target };
}

/** What Nimble's #applyDamagePackets does for one target, then its hook. */
async function applyCard(h, caster, target, damage, { item = { type: 'spell', system: { identifier: 'leeching-dark' } }, isMiss = false } = {}) {
	await target.applyDamage(damage);
	return h.onLeechingDarkDamageApplied({ sourceItem: item, sourceActor: caster, targetActor: target, card: { system: { isMiss } } });
}

const hp = (a) => a.system.attributes.hp.value;

describe('Leeching Dark content', () => {
	it('is the identifier the automation keys on', () => {
		expect(spell.system.identifier).toBe('leeching-dark');
		expect(spell.system.description.baseEffect).toMatch(/regain HP equal to the damage done/);
	});
});

describe('Leeching Dark healing', () => {
	it('heals the caster by the damage the target actually lost, with an Undo card', async () => {
		const { env, h, caster, target } = await world();
		const before = env.ChatMessage.created.length;
		await applyCard(h, caster, target, 12);
		expect(hp(target)).toBe(18);
		expect(hp(caster)).toBe(22);
		const cards = env.ChatMessage.created.slice(before);
		expect(cards).toHaveLength(1);
		expect(cards[0].content).toMatch(/regains <strong>12 HP/);
		expect(cards[0].content).toMatch(/data-bcx-undo/);
		expect(cards[0].flags['blue-codex-package'].undo ?? Object.values(cards[0].flags['blue-codex-package'])[0]).toMatchObject({
			type: 'leechingDark',
			data: { actorUuid: caster.uuid, healed: 12 },
		});
	});

	it('uses the damage after reductions (the target lost less than rolled), not the roll', async () => {
		const { h, caster, target } = await world();
		// The system already reduced the card's damage to 5 before applying.
		await applyCard(h, caster, target, 5);
		expect(hp(caster)).toBe(15);
	});

	it('is capped at what the target had left (overkill) and at the caster\'s max HP', async () => {
		const a = await world({ targetHp: 4 });
		await applyCard(a.h, a.caster, a.target, 30);
		expect(hp(a.caster)).toBe(14);
		const b = await world({ casterHp: 38 });
		await applyCard(b.h, b.caster, b.target, 15);
		expect(hp(b.caster)).toBe(40);
		expect(b.env.ChatMessage.created.at(-1).content).toMatch(/regains <strong>2 HP/);
	});

	it('counts temp HP the damage chewed through', async () => {
		const { h, caster, target } = await world({ targetTemp: 6 });
		await applyCard(h, caster, target, 10);
		expect(hp(target)).toBe(26);
		expect(hp(caster)).toBe(20);
	});

	it('fires once per application: a second Apply Damage heals again, a stray hook call does not', async () => {
		const { h, caster, target } = await world();
		await applyCard(h, caster, target, 5);
		await applyCard(h, caster, target, 5);
		expect(hp(caster)).toBe(20);
		// Hook with no new damage (nothing was lost since the last one): no heal.
		await h.onLeechingDarkDamageApplied({ sourceItem: { system: { identifier: 'leeching-dark' } }, sourceActor: caster, targetActor: target, card: { system: {} } });
		expect(hp(caster)).toBe(20);
	});

	it('ignores other spells, and a missed card', async () => {
		const { h, caster, target } = await world();
		await applyCard(h, caster, target, 5, { item: { type: 'spell', name: 'Fireball', system: { identifier: 'fireball' } } });
		await applyCard(h, caster, target, 5, { isMiss: true });
		expect(hp(caster)).toBe(10);
	});

	it('posts a plain note (no heal, no undo) when the caster is already full', async () => {
		const { env, h, caster, target } = await world({ casterHp: 40 });
		await applyCard(h, caster, target, 7);
		const card = env.ChatMessage.created.at(-1);
		expect(card.content).toMatch(/already at full HP/);
		expect(card.content).not.toMatch(/data-bcx-undo/);
	});

	it('Undo takes the healed HP back off', async () => {
		const { h, caster, target } = await world();
		await applyCard(h, caster, target, 12);
		expect(hp(caster)).toBe(22);
		const result = await h.UNDO_HANDLERS.get('leechingDark')({ actorUuid: caster.uuid, healed: 12 });
		expect(hp(caster)).toBe(10);
		expect(result).toMatch(/back to 10 HP/);
	});
});
