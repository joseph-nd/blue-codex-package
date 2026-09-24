/**
 * Codex Command Shadows automation (scripts/main.mjs, "Command Shadows" section):
 * the pre-activate gate (Shadows, targets, the 1/turn charge, the per-target
 * split dialog; no distance gate) and the useItem half (pool spend, then every
 * commanded Shadow attacks through Combat#performMinionGroupAttack — one call per
 * target — or, outside combat, through each Shadow's own attack item). In combat
 * the Shadows are combatants ONLY during the group attack: added (fresh, full
 * action), rolled, removed — so they never get turns of their own.
 *
 * The harness has no canvas/combat, so this file builds a minimal scene (token
 * documents carrying the summon flag), a started combat whose
 * performMinionGroupAttack mirrors the system contract (GM only; targets read from
 * game.user.targets, filtered by the requested ids; members must be minion
 * combatants with an action left; posts ONE `minionGroupAttack` card with a row
 * per member — src/documents/combat/combatMinionAttacks.ts; new npc combatants
 * start with 1 action — combat.svelte.ts #normalizeCombatantCreateData), and the
 * user's targets. The caster is the combat's only permanent combatant; `turns`
 * lists every combatant (a Shadow combatant WOULD be a turn of its own). A "cast" is the activate wrap's two halves: the gate, then (not
 * blocked) the useItem handler.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Collection, createCharacter, REPO_ROOT, setupWorld } from '../harness/index.mjs';

const MODULE_ID = 'blue-codex-package';
const POOL = 'command-shadows';
const SHADOW_ATTACK = JSON.parse(
	fs.readFileSync(path.join(REPO_ROOT, 'pack-sources/companions/shadow-minion.json'), 'utf-8'),
).items[0];

async function world({ combat = true, shadows = [[2, 0]], targets = [[3, 0]] } = {}) {
	const { env, main } = await setupWorld();
	const h = main.__commandShadows__;
	const { actor: caster } = await createCharacter(env, { classId: 'shadowmancer', render: false });
	const item = caster.items.find((i) => i._stats?.compendiumSource === h.CODEX_COMMAND_SHADOWS_UUID);
	expect(item, 'L1 Shadowmancer owns Codex Command Shadows').toBeTruthy();
	// The native chargePool (no rules engine in the harness): what Nimble syncs onto the item.
	await item.update({
		flags: { nimble: { chargePools: { [POOL]: { current: 1, max: 1, label: 'Command Shadows (1/turn)' } } } },
	});

	const scene = { id: 'sceneArena000001', name: 'Arena', grid: { size: 100 }, tokens: new Collection() };
	env.game.scenes.set(scene.id, scene);
	globalThis.canvas.scene = scene;
	const token = (id, name, [gx, gy], actor, flags = {}) => {
		const doc = {
			id,
			name,
			x: gx * 100,
			y: gy * 100,
			width: 1,
			height: 1,
			hidden: false,
			parent: scene,
			actor,
			actorId: actor?.id ?? null,
			actorLink: actor === caster,
			flags,
			uuid: `Scene.${scene.id}.Token.${id}`,
			getFlag(scope, key) {
				return this.flags?.[scope]?.[key];
			},
		};
		scene.tokens.set(id, doc);
		return doc;
	};
	token('casterToken00001', caster.name, [0, 0], caster);

	const shadowTokens = shadows.map(([gx, gy], i) => {
		const attack = {
			...structuredClone(SHADOW_ATTACK),
			id: SHADOW_ATTACK._id,
			activate: vi.fn(async () => {
				attack.seenTargets = Array.from(env.game.user.targets ?? []).map((t) => t.id);
				return { id: `card${i}` };
			}),
		};
		const actor = { id: `shadowActor${i}`.padEnd(16, '0'), type: 'minion', isToken: true, system: { attributes: { hp: { value: 1 } } }, items: [attack] };
		return token(`shadowToken${i}`.padEnd(16, '0'), 'Shadow Minion', [gx, gy], actor, {
			[MODULE_ID]: { summon: { template: 'shadow-minion', summonerActorUuid: caster.uuid } },
		});
	});
	const targetTokens = targets.map(([gx, gy], i) =>
		token(`goblinToken${i}`.padEnd(16, '0'), `Goblin ${i + 1}`, [gx, gy], { id: `goblin${i}`.padEnd(16, '0'), type: 'npc' }),
	);

	let fight = null;
	if (combat) fight = installCombat(env, scene, caster);
	const target = (...docs) => {
		env.game.user.targets = new Set(docs.map((doc) => ({ id: doc.id, document: doc })));
		return env.game.user.targets;
	};
	target(...targetTokens);

	const cast = async () => {
		if (await h.commandShadowsActivationBlocked(item)) return { blocked: true };
		return { blocked: false, summary: await h.handleCommandShadowsUsed(item, {}) };
	};
	const pool = () => item.flags.nimble.chargePools[POOL].current;
	return { env, main, h, caster, item, scene, shadowTokens, targetTokens, fight, target, cast, pool };
}

/** A started combat with the system's performMinionGroupAttack contract. */
function installCombat(env, scene, caster) {
	const combatants = new Collection();
	const calls = [];
	let serial = 0;
	const combat = {
		id: 'combatArena00001',
		started: true,
		round: 1,
		turn: 0,
		scene,
		combatants,
		// Nimble's setupTurns: every living combatant is a turn unless grouped.
		get turns() {
			return combatants.contents;
		},
		async createEmbeddedDocuments(type, data) {
			expect(type).toBe('Combatant');
			return data.map((d) => {
				const id = `combatant${serial++}`.padEnd(16, '0');
				const c = {
					id,
					...d,
					system: { actions: { base: { current: 1, max: 1 } } },
					get token() {
						return scene.tokens.get(this.tokenId);
					},
					get actor() {
						return this.token?.actor ?? null;
					},
				};
				combatants.set(id, c);
				return c;
			});
		},
		updateEmbeddedDocuments: vi.fn(async (type, updates) => {
			expect(type).toBe('Combatant');
			for (const u of updates) {
				const c = combatants.get(u._id);
				if (c && 'system.actions.base.current' in u) c.system.actions.base.current = u['system.actions.base.current'];
			}
			return updates;
		}),
		deleteEmbeddedDocuments: vi.fn(async (type, ids) => {
			expect(type).toBe('Combatant');
			for (const id of ids) combatants.delete(id);
			return ids;
		}),
		performMinionGroupAttack: vi.fn(async (params) => {
			const result = { targetTokenId: '', rolledCombatantIds: [], skippedMembers: [], totalDamage: 0, chatMessageId: null };
			if (!env.game.user.isGM) return result;
			const selected = Array.from(env.game.user.targets ?? []).map((t) => t.id ?? t.document?.id);
			calls.push({
				params,
				selected,
				round: combat.round,
				memberTokenIds: params.memberCombatantIds.map((id) => combatants.get(id)?.tokenId),
				turnCount: combat.turns.length,
			});
			if (!selected.length) return result;
			const requested = (params.targetTokenIds ?? []).filter((id) => selected.includes(id));
			const active = requested.length ? requested : selected;
			const rows = [];
			for (const id of params.memberCombatantIds) {
				const member = combatants.get(id);
				if (member?.actor?.type !== 'minion') continue;
				const actionId = params.selections.find((s) => s.memberCombatantId === id)?.actionId;
				if (!member.actor.items.some((i) => i.id === actionId)) {
					result.skippedMembers.push({ combatantId: id, reason: 'actionNotFound' });
					continue;
				}
				if (member.system.actions.base.current < 1) {
					result.skippedMembers.push({ combatantId: id, reason: 'noActionsRemaining' });
					continue;
				}
				member.system.actions.base.current -= 1;
				result.rolledCombatantIds.push(id);
				rows.push({ memberCombatantId: id, actionId, formula: '1d12', totalDamage: 5, isMiss: false, roll: { terms: [{ faces: 12, results: [{ result: 5, active: true }] }] } });
			}
			if (!rows.length) return result;
			const card = await env.ChatMessage.create({
				type: 'minionGroupAttack',
				system: { rows, targets: active.map((tid) => scene.tokens.get(tid).uuid) },
			});
			result.targetTokenId = active[0];
			result.chatMessageId = card.id;
			return result;
		}),
	};
	env.game.combat = combat;
	env.game.combats.set(combat.id, combat);
	// The caster's own combatant (its token is the first scene token).
	const casterToken = scene.tokens.find((t) => t.actor === caster);
	combatants.set('casterCombatant0', { id: 'casterCombatant0', type: 'character', tokenId: casterToken?.id, sceneId: scene.id, system: { actions: { base: { current: 3, max: 3 } } }, get token() { return scene.tokens.get(this.tokenId); }, get actor() { return caster; } });
	const shadowCombatants = () => combatants.filter((c) => c.token?.flags?.[MODULE_ID]?.summon);
	return { combat, calls, shadowCombatants };
}

const groupCards = (env) => env.ChatMessage.created.filter((m) => m.type === 'minionGroupAttack');
const summaryCard = (env) => env.ChatMessage.created.findLast((m) => m.flags?.[MODULE_ID]?.commandShadows);

describe('Command Shadows — nothing to do: warn and cost nothing', () => {
	it('no targets: warns, blocks the cast, spends no charge, attacks nothing', async () => {
		const w = await world();
		w.target();
		const result = await w.cast();
		expect(result.blocked).toBe(true);
		expect(w.env.notifications.messages('warn').some((m) => /Target the creature/.test(m))).toBe(true);
		expect(w.pool()).toBe(1);
		expect(w.h.pending.size).toBe(0);
		expect(w.fight.combat.performMinionGroupAttack).not.toHaveBeenCalled();
		expect(w.env.ChatMessage.created).toEqual([]);
		expect(w.env.dialogs.log).toEqual([]);
	});

	it('no Shadows: warns and blocks', async () => {
		const w = await world({ shadows: [] });
		expect((await w.cast()).blocked).toBe(true);
		expect(w.env.notifications.messages('warn').some((m) => /no Shadows to command/.test(m))).toBe(true);
		expect(w.pool()).toBe(1);
		expect(w.env.ChatMessage.created).toEqual([]);
	});

	it("another caster's Shadows are not commanded", async () => {
		const w = await world();
		w.shadowTokens[0].flags[MODULE_ID].summon.summonerActorUuid = 'Actor.someoneElse00001';
		expect((await w.cast()).blocked).toBe(true);
		expect(w.pool()).toBe(1);
	});
});

describe('Command Shadows — one target', () => {
	it('every Shadow attacks it through ONE system minion group attack', async () => {
		const w = await world({ shadows: [[2, 0], [3, 1]] });
		const ownTargets = w.env.game.user.targets;
		const { blocked, summary } = await w.cast();
		expect(blocked).toBe(false);
		expect(w.env.dialogs.log).toEqual([]); // no split dialog for a single target

		const perform = w.fight.combat.performMinionGroupAttack;
		expect(perform).toHaveBeenCalledTimes(1);
		const [params] = perform.mock.calls[0];
		expect(params.targetTokenIds).toEqual([w.targetTokens[0].id]);
		expect(params.endTurn).toBe(false);
		expect(params.memberCombatantIds).toHaveLength(2);
		expect(params.selections.every((s) => s.actionId === SHADOW_ATTACK._id)).toBe(true);
		// The Shadows joined the tracker only for the attack (npc combatants of their
		// tokens, flagged transient) and were removed right after.
		expect(w.fight.calls[0].memberTokenIds.sort()).toEqual(w.shadowTokens.map((t) => t.id).sort());
		expect(w.fight.calls[0].turnCount).toBe(3);
		expect(w.fight.shadowCombatants()).toEqual([]);
		expect(w.fight.combat.turns.map((c) => c.id)).toEqual(['casterCombatant0']);
		// The system saw exactly this target; the user's own targets are restored.
		expect(w.fight.calls[0].selected).toEqual([w.targetTokens[0].id]);
		expect(w.env.game.user.targets).toBe(ownTargets);

		// The system's card: type minionGroupAttack, a row per Shadow, the target's uuid.
		const cards = groupCards(w.env);
		expect(cards).toHaveLength(1);
		expect(cards[0].system.rows).toHaveLength(2);
		expect(cards[0].system.targets).toEqual([w.targetTokens[0].uuid]);

		// 1/turn charge spent, with an Undo card.
		expect(w.pool()).toBe(0);
		expect(w.env.ChatMessage.created.some((m) => m.flags?.[MODULE_ID]?.undo?.type === 'poolDelta')).toBe(true);

		// Summary card.
		expect(summary.mode).toBe('groupAttack');
		expect(summary.groups).toEqual([
			expect.objectContaining({ targetId: w.targetTokens[0].id, shadowIds: w.shadowTokens.map((t) => t.id), attacked: 2 }),
		]);
		const card = summaryCard(w.env);
		expect(card.content).toMatch(/Each Shadow may move 6 before attacking/);
		expect(card.content).toMatch(/Goblin 1/);
		expect(w.env.Hooks.errors).toEqual([]);
	});

	it('a leftover Shadow combatant with no action left is reused, topped up, attacks, then removed', async () => {
		const w = await world({ shadows: [[2, 0], [3, 1]] });
		const [leftover] = await w.fight.combat.createEmbeddedDocuments('Combatant', [
			{ type: 'npc', tokenId: w.shadowTokens[0].id, sceneId: w.scene.id, actorId: w.shadowTokens[0].actorId },
		]);
		leftover.system.actions.base.current = 0; // it "already acted"
		const { summary } = await w.cast();
		const [params] = w.fight.combat.performMinionGroupAttack.mock.calls[0];
		expect(params.memberCombatantIds).toHaveLength(2);
		expect(params.memberCombatantIds).toContain(leftover.id); // not added twice
		expect(summary.skipped).toEqual([]);
		expect(groupCards(w.env)[0].system.rows).toHaveLength(2);
		expect(w.fight.shadowCombatants()).toEqual([]);
	});

	it('Shadows the system cannot roll for are listed on the card', async () => {
		const w = await world({ shadows: [[2, 0], [3, 1]] });
		w.shadowTokens[1].actor.items = []; // no attack item
		const { summary } = await w.cast();
		expect(summary.skipped).toEqual([{ name: 'Shadow Minion', reason: 'noActionSelected' }]);
		expect(groupCards(w.env)[0].system.rows).toHaveLength(1);
		expect(summaryCard(w.env).content).toMatch(/Could not attack:.*no attack found/);
		expect(w.fight.shadowCombatants()).toEqual([]);
	});
});

describe('Command Shadows — several targets', () => {
	it('3 Shadows / 2 targets: the dialog pre-fills an even split → one group attack per target', async () => {
		const w = await world({ shadows: [[2, 0], [2, 1], [2, 2]], targets: [[3, 0], [3, 2]] });
		expect(w.h.defaultShadowAssignment(3, 2)).toEqual([0, 1, 0]);
		w.env.dialogs.answerWhen(/Command Shadows/, 'confirm');
		const { blocked, summary } = await w.cast();
		expect(blocked).toBe(false);
		expect(w.env.dialogs.log).toHaveLength(1);
		expect(w.env.dialogs.log[0].title).toMatch(/Command Shadows/);
		// Every Shadow is offered both targets, the round-robin pick pre-selected.
		expect(w.env.dialogs.log[0].content.match(/<select /g)).toHaveLength(3);
		expect(w.env.dialogs.log[0].content.match(/<option value="1" selected>/g)).toHaveLength(1);

		const perform = w.fight.combat.performMinionGroupAttack;
		expect(perform).toHaveBeenCalledTimes(2);
		const byTarget = Object.fromEntries(
			w.fight.calls.map((c) => [c.params.targetTokenIds[0], [...c.memberTokenIds].sort()]),
		);
		// One create for all the Shadows, one delete after both attacks.
		expect(w.fight.combat.deleteEmbeddedDocuments).toHaveBeenCalledTimes(1);
		expect(w.fight.shadowCombatants()).toEqual([]);
		const [s0, s1, s2] = w.shadowTokens.map((t) => t.id);
		expect(byTarget).toEqual({ [w.targetTokens[0].id]: [s0, s2].sort(), [w.targetTokens[1].id]: [s1] });
		// Each call saw only its own target.
		expect(w.fight.calls.map((c) => c.selected)).toEqual([[w.targetTokens[0].id], [w.targetTokens[1].id]]);
		expect(groupCards(w.env)).toHaveLength(2);
		expect(summary.groups.map((g) => g.shadowIds.length)).toEqual([2, 1]);
		expect(w.pool()).toBe(0);
	});

	it('Cancel in the split dialog: nothing happens, no charge spent', async () => {
		const w = await world({ shadows: [[2, 0], [2, 1]], targets: [[3, 0], [3, 2]] });
		w.env.dialogs.answerWhen(/Command Shadows/, 'cancel');
		expect((await w.cast()).blocked).toBe(true);
		expect(w.pool()).toBe(1);
		expect(w.fight.combat.performMinionGroupAttack).not.toHaveBeenCalled();
		expect(w.env.ChatMessage.created).toEqual([]);
	});
});

describe('Command Shadows — no distance gate (tokens are not moved)', () => {
	it('a Shadow far from its target still attacks; nothing is listed as out of reach', async () => {
		const w = await world({ shadows: [[2, 0], [12, 0]], targets: [[3, 0]] });
		const { blocked, summary } = await w.cast();
		expect(blocked).toBe(false);
		const [params] = w.fight.combat.performMinionGroupAttack.mock.calls[0];
		expect(params.memberCombatantIds).toHaveLength(2);
		expect(w.fight.calls[0].memberTokenIds.sort()).toEqual(w.shadowTokens.map((t) => t.id).sort());
		expect(summary).not.toHaveProperty('outOfReach');
		expect(summary.groups[0].attacked).toBe(2);
		const card = summaryCard(w.env);
		expect(card.content).not.toMatch(/reach/i);
		expect(card.content).toMatch(/Each Shadow may move 6 before attacking/);
	});

	it('every Shadow far away: the cast is NOT blocked, the charge is spent and they attack', async () => {
		const w = await world({ shadows: [[20, 0]], targets: [[3, 0]] });
		expect((await w.cast()).blocked).toBe(false);
		expect(w.env.notifications.messages('warn')).toEqual([]);
		expect(w.pool()).toBe(0);
		expect(w.fight.combat.performMinionGroupAttack).toHaveBeenCalledTimes(1);
		expect(groupCards(w.env)[0].system.rows).toHaveLength(1);
	});

	it('the split dialog still shows each target\'s distance as a hint', async () => {
		const w = await world({ shadows: [[2, 0], [20, 0]], targets: [[3, 0], [3, 2]] });
		w.env.dialogs.answerWhen(/Command Shadows/, 'confirm');
		expect((await w.cast()).blocked).toBe(false);
		expect(w.env.dialogs.log[0].content).toMatch(/Goblin 1 \(\d+ spaces\)/);
		expect(w.fight.combat.performMinionGroupAttack).toHaveBeenCalledTimes(2);
	});
});

describe('Command Shadows — Shadows never take turns of their own', () => {
	it('the turn list never gains Shadow turns; commanding works on 2 consecutive rounds', async () => {
		const w = await world({ shadows: [[2, 0], [3, 1]] });
		const turnIds = () => w.fight.combat.turns.map((c) => c.id);
		expect(turnIds()).toEqual(['casterCombatant0']);

		// Round 1.
		const r1 = await w.cast();
		expect(r1.blocked).toBe(false);
		expect(turnIds()).toEqual(['casterCombatant0']);
		// Round 2: the pool refills at the caster's turn start (onTurnStart recovery).
		// Nothing refreshes the Shadows' own actions — they need none.
		w.fight.combat.round = 2;
		await w.item.update({ flags: { nimble: { chargePools: { [POOL]: { current: 1 } } } } });
		const r2 = await w.cast();
		expect(r2.blocked).toBe(false);
		expect(turnIds()).toEqual(['casterCombatant0']);

		expect(w.fight.calls.map((c) => c.round)).toEqual([1, 2]);
		for (const call of w.fight.calls) expect(call.memberTokenIds).toHaveLength(2);
		const cards = groupCards(w.env);
		expect(cards).toHaveLength(2);
		expect(cards.map((c) => c.system.rows.length)).toEqual([2, 2]);
		expect([r1.summary.skipped, r2.summary.skipped]).toEqual([[], []]);
		expect(w.fight.shadowCombatants()).toEqual([]);
	});

	it('the removed combatant ids still resolve to their Shadow tokens (Swarming Shadows)', async () => {
		const w = await world({ shadows: [[2, 0], [3, 1]] });
		await w.cast();
		const [card] = groupCards(w.env);
		const resolved = card.system.rows.map((row) => w.h.retiredShadowCombatantTokens.get(row.memberCombatantId)?.id);
		expect(resolved.sort()).toEqual(w.shadowTokens.map((t) => t.id).sort());
	});

	it('a failed group attack still removes the Shadow combatants', async () => {
		const w = await world();
		w.fight.combat.performMinionGroupAttack.mockImplementationOnce(async () => {
			throw new Error('boom');
		});
		await expect(w.h.executeCommandShadows({
			casterUuid: w.caster.uuid,
			itemName: 'Command Shadows',
			sceneId: w.scene.id,
			move: 6,
			inCombat: true,
			assignments: [{ shadowId: w.shadowTokens[0].id, targetId: w.targetTokens[0].id }],
		})).rejects.toThrow('boom');
		expect(w.fight.shadowCombatants()).toEqual([]);
	});

	it('the ready sweep removes Shadow combatants an earlier build left in the combat', async () => {
		const w = await world({ shadows: [[2, 0], [3, 1]] });
		await w.fight.combat.createEmbeddedDocuments(
			'Combatant',
			w.shadowTokens.map((t) => ({ type: 'npc', tokenId: t.id, sceneId: w.scene.id, actorId: t.actorId })),
		);
		expect(w.fight.combat.turns).toHaveLength(3);
		expect(await w.h.sweepShadowCombatants()).toBe(2);
		expect(w.fight.combat.turns.map((c) => c.id)).toEqual(['casterCombatant0']);
	});

	it('removeShadowCombatants leaves non-Shadow combatants alone', async () => {
		const w = await world();
		await w.fight.combat.createEmbeddedDocuments('Combatant', [
			{ type: 'npc', tokenId: w.targetTokens[0].id, sceneId: w.scene.id, actorId: w.targetTokens[0].actorId },
		]);
		expect(await w.h.removeShadowCombatants(w.fight.combat)).toBe(0);
		expect(w.fight.combat.turns).toHaveLength(2);
	});
});

describe('Command Shadows — 1/turn', () => {
	it('a second cast in the same turn is refused until the charge refills', async () => {
		const w = await world();
		expect((await w.cast()).blocked).toBe(false);
		expect(w.pool()).toBe(0);
		expect((await w.cast()).blocked).toBe(true);
		expect(w.env.notifications.messages('warn').some((m) => /already used Command Shadows this turn/.test(m))).toBe(true);
		expect(w.fight.combat.performMinionGroupAttack).toHaveBeenCalledTimes(1);
		// Refilled at the start of the caster's turn (Nimble's onTurnStart recovery) — or by hand.
		await w.item.update({ flags: { nimble: { chargePools: { [POOL]: { current: 1 } } } } });
		expect((await w.cast()).blocked).toBe(false);
		expect(w.fight.combat.performMinionGroupAttack).toHaveBeenCalledTimes(2);
	});

	it('outside combat there is no limit: each Shadow attacks with its own item, no charge spent', async () => {
		const w = await world({ combat: false, shadows: [[2, 0], [2, 1]] });
		expect((await w.cast()).blocked).toBe(false);
		const { summary } = await w.cast();
		expect(summary.mode).toBe('individual');
		expect(w.pool()).toBe(1);
		for (const shadow of w.shadowTokens) {
			const attack = shadow.actor.items[0];
			expect(attack.activate).toHaveBeenCalledTimes(2);
			expect(attack.activate).toHaveBeenCalledWith({ fastForward: true });
			expect(attack.seenTargets).toEqual([w.targetTokens[0].id]);
		}
		expect(groupCards(w.env)).toEqual([]);
		expect(w.env.ChatMessage.created.some((m) => m.flags?.[MODULE_ID]?.undo)).toBe(false);
	});

	it('a combat that has not started counts as outside combat', async () => {
		const w = await world();
		w.fight.combat.started = false;
		const { summary } = await w.cast();
		expect(summary.mode).toBe('individual');
		expect(w.pool()).toBe(1);
		expect(w.fight.combat.performMinionGroupAttack).not.toHaveBeenCalled();
	});
});

describe('Command Shadows — spell data', () => {
	it('is a Shadowmancer-only shadow cantrip with a visible 1/turn charge pool refilled on turn start', async () => {
		const w = await world({ combat: false });
		const src = w.item._source;
		expect(src.system).toMatchObject({ school: 'shadow', tier: 0, classes: ['shadowmancer'] });
		const pool = src.system.rules.find((r) => r.type === 'chargePool');
		expect(pool).toMatchObject({ identifier: POOL, scope: 'item', max: '1', hidden: false });
		expect(pool.recoveries.map((r) => r.trigger)).toContain('onTurnStart');
		expect(src.flags[MODULE_ID].automation.commandShadows).toEqual({ template: 'shadow-minion', move: 6, perTurnPool: POOL });
		expect(src.img).toBe(`modules/${MODULE_ID}/assets/spells/ruin/shadow/command-shadows.webp`);
	});
});
