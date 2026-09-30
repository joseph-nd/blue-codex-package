/**
 * Summon framework — fallen summons (audit D3): a summoned MINION at 0 HP no
 * longer counts toward any limit, and the acting GM removes its token (one Undo
 * card per summoner, restoring the tokens at full HP). Turrets keep their own
 * destruction flow; non-minion companions are left alone. A Greater Shadow bursts
 * into 5 Shadows when it falls.
 *
 * Scene/token/combat stand-ins: ./helpers.mjs.
 */
import { describe, expect, it } from 'vitest';
import {
	cards,
	MODULE_ID,
	placeShadow,
	shadowmancerWorld,
	startCombat,
	summonsOf,
} from './helpers.mjs';

const undoOf = (card) => card?.flags?.[MODULE_ID]?.undo;

describe('fallen summons: counting', () => {
	it('a dead (0 HP) Shadow does not count toward the Shadow Limit (the cast is not refused)', async () => {
		const { env, h, actor, scene, summonShadow } = await shadowmancerWorld({ abilities: { intelligence: 3 } });
		startCombat(env);
		placeShadow(env, scene, actor, [1, 0]);
		placeShadow(env, scene, actor, [1, 1]);
		placeShadow(env, scene, actor, [1, -1], { hp: 0 });
		expect(h.findActiveSummons(actor, 'shadow-minion')).toHaveLength(2);
		await expect(h.summonActivationBlocked(summonShadow)).resolves.toBe(false);
		// Three living Shadows: the limit (INT 3) refuses the cast.
		placeShadow(env, scene, actor, [2, 0]);
		await expect(h.summonActivationBlocked(summonShadow)).resolves.toBe(true);
		expect(env.notifications.messages('warn').at(-1)).toMatch(/already has the maximum 3 Shadows/);
	});
});

describe('fallen summons: removal (acting GM)', () => {
	it('a Shadow dropping to 0 HP is deleted, with an Undo card that brings it back at full HP', async () => {
		const { env, h, actor, scene } = await shadowmancerWorld();
		startCombat(env);
		const shadow = placeShadow(env, scene, actor, [1, 0], { combatId: 'combatArena00001' });
		const before = env.ChatMessage.created.length;
		await shadow.actor.update({ 'system.attributes.hp.value': 0 });
		expect(h.pendingFallenSummons.size).toBe(1);
		await h.flushFallenSummons();
		expect(summonsOf(scene, actor)).toHaveLength(0);
		const [card] = cards(env, before);
		expect(card.content).toMatch(/Shadow Minion.*drops to 0 HP and is gone/);
		const undo = undoOf(card);
		expect(undo.type).toBe('restoreFallenSummons');
		const note = await h.UNDO_HANDLERS.get('restoreFallenSummons')(undo.data, {});
		expect(note).toMatch(/1 summon restored/);
		const [restored] = summonsOf(scene, actor);
		expect(restored.id).toBe(shadow.id);
		expect(restored.actor.system.attributes.hp.value).toBe(1);
		expect(restored.flags[MODULE_ID].summon.combatId).toBe('combatArena00001');
	});

	it('deaths landing together share one card', async () => {
		const { env, h, actor, scene } = await shadowmancerWorld();
		const a = placeShadow(env, scene, actor, [1, 0]);
		const b = placeShadow(env, scene, actor, [1, 1]);
		const before = env.ChatMessage.created.length;
		await a.actor.update({ 'system.attributes.hp.value': 0 });
		await b.actor.update({ 'system.attributes.hp.value': 0 });
		await h.flushFallenSummons();
		const posted = cards(env, before);
		expect(posted).toHaveLength(1);
		expect(posted[0].content).toMatch(/drop to 0 HP and are gone/);
		expect(undoOf(posted[0]).data.tokens).toHaveLength(2);
	});

	it('healing / damage above 0 does nothing; turrets and non-minion companions are skipped', async () => {
		const { env, h, actor, scene } = await shadowmancerWorld();
		const shadow = placeShadow(env, scene, actor, [1, 0], { hp: 1 });
		await shadow.actor.update({ 'system.attributes.hp.temp': 3 });
		const spirit = placeShadow(env, scene, actor, [2, 0], { template: 'lifebinding-spirit-02' });
		await spirit.actor.update({ 'system.attributes.hp.value': 0 });
		expect(spirit.actor.type).toBe('npc');
		const turret = placeShadow(env, scene, actor, [3, 0], { template: 'turret-rifle' });
		await turret.actor.update({ 'system.attributes.hp.value': 0 });
		expect(h.pendingFallenSummons.size).toBe(0);
		await h.flushFallenSummons();
		expect(scene.tokens.size).toBe(4); // caster + the three
	});

	it('only the acting GM removes (a player client does nothing)', async () => {
		const { env, h, actor, scene } = await shadowmancerWorld();
		const shadow = placeShadow(env, scene, actor, [1, 0]);
		env.setUser({ isGM: false });
		await shadow.actor.update({ 'system.attributes.hp.value': 0 });
		expect(h.pendingFallenSummons.size).toBe(0);
	});

	it('a fallen Greater Shadow explodes into 5 Shadows (ignoring the limit); Undo reverses both', async () => {
		const { env, h, actor, scene } = await shadowmancerWorld({ abilities: { intelligence: 1 } });
		startCombat(env);
		placeShadow(env, scene, actor, [0, 1]); // already at the INT 1 limit
		const greater = placeShadow(env, scene, actor, [3, 3], { template: 'greater-shadow' });
		const before = env.ChatMessage.created.length;
		await greater.actor.update({ 'system.attributes.hp.value': 0 });
		await h.flushFallenSummons();
		expect(summonsOf(scene, actor, 'greater-shadow')).toHaveLength(0);
		const burst = summonsOf(scene, actor).filter((t) => t.id !== summonsOf(scene, actor)[0].id);
		expect(summonsOf(scene, actor)).toHaveLength(6);
		for (const token of burst) {
			expect(Math.abs(token.x - 300)).toBeLessThanOrEqual(100);
			expect(Math.abs(token.y - 300)).toBeLessThanOrEqual(100);
		}
		const card = cards(env, before).find((c) => undoOf(c)?.type === 'restoreFallenSummons');
		expect(card.content).toMatch(/explodes into <strong>5<\/strong> Shadows/);
		await h.UNDO_HANDLERS.get('restoreFallenSummons')(undoOf(card).data, {});
		expect(summonsOf(scene, actor, 'greater-shadow')).toHaveLength(1);
		expect(summonsOf(scene, actor)).toHaveLength(1);
	});
});
