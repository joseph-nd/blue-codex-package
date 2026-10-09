/**
 * Codex Command Shadows (scripts/main.mjs, "Command Shadows" section) — a plain
 * spell: the gate asks how many Shadows attack each target (pre-filled with an
 * even split of the Shadows on the table, free to change; only Cancel blocks),
 * the useItem half spends the 1/turn charge when there is one and rolls one row
 * per Shadow onto a `minionGroupAttack` card per target. Nothing joins the
 * combat tracker and nothing checks distance.
 *
 * The harness has no canvas/combat, so this file builds a minimal scene (token
 * documents carrying the summon flag), a started combat (the caster its only
 * combatant; `turns` lists every combatant), a stand-in for the system
 * DamageRoll (every die rolls `FakeDamageRoll.face`) and the user's targets. A
 * "cast" is the activate wrap's two halves: the gate (its dialog answered), then
 * (not blocked) the useItem handler.
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

/** A stand-in for the system DamageRoll (found by its prototype methods). */
class FakeDamageRoll {
	static face = 7;
	constructor(formula, data, options) {
		Object.assign(this, { formula, data, options });
	}
	async evaluate() {
		const flat = /^\d+$/.test(this.formula);
		const [count, faces] = String(this.formula).split('d').map(Number);
		this.terms = flat ? [] : [{ faces, results: Array.from({ length: count || 1 }, () => ({ result: FakeDamageRoll.face, active: true })) }];
		this.total = flat ? Number(this.formula) : (count || 1) * FakeDamageRoll.face;
		this.isMiss = !flat && this.options?.canMiss !== false && FakeDamageRoll.face === 1;
		return this;
	}
	_evaluate() {}
	_finalizeOutcome() {}
	_recalculateTotal() {}
	toJSON() {
		return { formula: this.formula, total: this.total, terms: this.terms };
	}
}

async function world({ combat = true, shadows = [[2, 0]], targets = [[3, 0]] } = {}) {
	const { env, main } = await setupWorld();
	FakeDamageRoll.face = 7;
	CONFIG.Dice.rolls = [FakeDamageRoll];
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

	// `answer`: the Command Shadows dialog's answer ('confirm' keeps the pre-filled split).
	const cast = async (answer = 'confirm') => {
		env.dialogs.answerWhen(/Command Shadows/, answer);
		if (await h.commandShadowsActivationBlocked(item)) return { blocked: true };
		return { blocked: false, summary: await h.handleCommandShadowsUsed(item, {}) };
	};
	const pool = () => item.flags.nimble.chargePools[POOL].current;
	return { env, main, h, caster, item, scene, shadowTokens, targetTokens, fight, target, cast, pool };
}

/** A started combat: the caster is its only combatant. */
function installCombat(env, scene, caster) {
	const combatants = new Collection();
	let serial = 0;
	const combat = {
		id: 'combatArena00001',
		started: true,
		round: 1,
		turn: 0,
		scene,
		combatants,
		get turns() {
			return combatants.contents;
		},
		createEmbeddedDocuments: vi.fn(async (type, data) =>
			data.map((d) => {
				const id = `combatant${serial++}`.padEnd(16, '0');
				const c = {
					id,
					...d,
					system: { actions: { base: { current: 1, max: 1 } } },
					get token() {
						return scene.tokens.get(this.tokenId);
					},
				};
				combatants.set(id, c);
				return c;
			}),
		),
		deleteEmbeddedDocuments: vi.fn(async (type, ids) => {
			for (const id of ids) combatants.delete(id);
			return ids;
		}),
		performMinionGroupAttack: vi.fn(),
	};
	env.game.combat = combat;
	env.game.combats.set(combat.id, combat);
	const casterToken = scene.tokens.find((t) => t.actor === caster);
	combatants.set('casterCombatant0', { id: 'casterCombatant0', type: 'character', tokenId: casterToken?.id, sceneId: scene.id, get token() { return scene.tokens.get(this.tokenId); } });
	return { combat };
}

const groupCards = (env) => env.ChatMessage.created.filter((m) => m.type === 'minionGroupAttack');

describe('Command Shadows — a plain spell: nothing joins the tracker', () => {
	it('one target: one minion attack card, a row per Shadow, the charge spent', async () => {
		const w = await world({ shadows: [[2, 0], [3, 1]] });
		const { blocked, summary } = await w.cast();
		expect(blocked).toBe(false);
		expect(w.env.dialogs.log).toHaveLength(1);
		expect(w.env.dialogs.log[0].content).toMatch(/<strong>2<\/strong> Shadows on the table/);

		const cards = groupCards(w.env);
		expect(cards).toHaveLength(1);
		const [card] = cards;
		expect(card.system.targets).toEqual([w.targetTokens[0].uuid]);
		expect(card.system.rows).toHaveLength(2);
		expect(card.system.rows.map((r) => r.formula)).toEqual(['1d12', '1d12']);
		expect(card.system.totalDamage).toBe(14);
		expect(card.system.rows.map((r) => r.memberTokenUuid)).toEqual(w.shadowTokens.map((t) => t.uuid));
		expect(new Set(card.system.rows.map((r) => r.memberCombatantId)).size).toBe(2);
		expect(card.flags[MODULE_ID].commandShadows.casterUuid).toBe(w.caster.uuid);
		expect(summary.cards).toEqual([expect.objectContaining({ targetId: w.targetTokens[0].id, rows: 2 })]);

		// No combatant was ever added; the system's group attack is not used.
		expect(w.fight.combat.createEmbeddedDocuments).not.toHaveBeenCalled();
		expect(w.fight.combat.performMinionGroupAttack).not.toHaveBeenCalled();
		expect(w.fight.combat.turns.map((c) => c.id)).toEqual(['casterCombatant0']);

		// 1/turn charge spent, with an Undo card.
		expect(w.pool()).toBe(0);
		expect(w.env.ChatMessage.created.some((m) => m.flags?.[MODULE_ID]?.undo?.type === 'poolDelta')).toBe(true);
		expect(w.env.Hooks.errors).toEqual([]);
	});

	it('a 1 misses its row (0 damage)', async () => {
		const w = await world();
		FakeDamageRoll.face = 1;
		await w.cast();
		expect(groupCards(w.env)[0].system.rows[0]).toMatchObject({ isMiss: true, totalDamage: 0 });
	});

	it('the count can be raised above the Shadows on the table: extra rows roll a base Shadow', async () => {
		const w = await world();
		await w.cast(() => [{ count: 3, rush: 0 }]);
		const rows = groupCards(w.env)[0].system.rows;
		expect(rows).toHaveLength(3);
		expect(rows.map((r) => r.formula)).toEqual(['1d12', '1d12', '1d12']);
		expect(rows.map((r) => Boolean(r.memberTokenUuid))).toEqual([true, false, false]);
		expect(new Set(rows.map((r) => r.memberCombatantId)).size).toBe(3);
	});

	it('no Shadows and no target: not blocked — the dialog asks and the card has no target', async () => {
		const w = await world({ shadows: [] });
		w.target();
		const { blocked } = await w.cast(() => [{ count: 2, rush: 0 }]);
		expect(blocked).toBe(false);
		expect(w.env.dialogs.log[0].content).toMatch(/No target/);
		const [card] = groupCards(w.env);
		expect(card.system.targets).toEqual([]);
		expect(card.system.rows).toHaveLength(2);
	});

	it("another caster's Shadows are not counted", async () => {
		const w = await world();
		w.shadowTokens[0].flags[MODULE_ID].summon.summonerActorUuid = 'Actor.someoneElse00001';
		await w.cast();
		expect(w.env.dialogs.log[0].content).toMatch(/<strong>0<\/strong> Shadows on the table/);
		expect(groupCards(w.env)).toEqual([]);
	});

	it('a Shadow far from its target still attacks (no distance gate)', async () => {
		const w = await world({ shadows: [[2, 0], [20, 0]], targets: [[3, 0]] });
		await w.cast();
		expect(groupCards(w.env)[0].system.rows).toHaveLength(2);
		expect(w.env.notifications.messages('warn')).toEqual([]);
	});
});

describe('Command Shadows — several targets', () => {
	it('3 Shadows / 2 targets: an even split pre-filled → one card per target', async () => {
		const w = await world({ shadows: [[2, 0], [2, 1], [2, 2]], targets: [[3, 0], [3, 2]] });
		expect(w.h.defaultShadowSplit(3, 2)).toEqual([2, 1]);
		await w.cast();
		expect(w.env.dialogs.log[0].content).toMatch(/name="bcx-count-0"[^>]*value="2"/);
		expect(w.env.dialogs.log[0].content).toMatch(/name="bcx-count-1"[^>]*value="1"/);
		const [first, second] = groupCards(w.env);
		expect(first.system.targets).toEqual([w.targetTokens[0].uuid]);
		expect(second.system.targets).toEqual([w.targetTokens[1].uuid]);
		const [s0, s1, s2] = w.shadowTokens.map((t) => t.uuid);
		expect(first.system.rows.map((r) => r.memberTokenUuid)).toEqual([s0, s1]);
		expect(second.system.rows.map((r) => r.memberTokenUuid)).toEqual([s2]);
		expect(w.pool()).toBe(0);
	});

	it('Cancel: nothing happens, no charge spent', async () => {
		const w = await world({ shadows: [[2, 0], [2, 1]], targets: [[3, 0], [3, 2]] });
		expect((await w.cast('cancel')).blocked).toBe(true);
		expect(w.pool()).toBe(1);
		expect(w.h.pending.size).toBe(0);
		expect(w.env.ChatMessage.created).toEqual([]);
	});
});

describe('Command Shadows — Shadow combatants from earlier builds', () => {
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
	it('a second cast in the same turn warns but still rolls; no charge to spend', async () => {
		const w = await world();
		expect((await w.cast()).blocked).toBe(false);
		expect(w.pool()).toBe(0);
		expect((await w.cast()).blocked).toBe(false);
		expect(w.env.notifications.messages('warn').some((m) => /already used Command Shadows this turn/.test(m))).toBe(true);
		expect(groupCards(w.env)).toHaveLength(2);
		expect(w.pool()).toBe(0);
	});

	it('outside combat: no charge spent, the same cards', async () => {
		const w = await world({ combat: false, shadows: [[2, 0], [2, 1]] });
		await w.cast();
		expect(w.pool()).toBe(1);
		expect(groupCards(w.env)[0].system.rows).toHaveLength(2);
		expect(w.env.ChatMessage.created.some((m) => m.flags?.[MODULE_ID]?.undo)).toBe(false);
	});
});

describe('Command Shadows — Swarming Shadows reads the rows', () => {
	it('a maxed row resolves its Shadow token by memberTokenUuid', async () => {
		const w = await world();
		FakeDamageRoll.face = 12;
		await w.cast();
		const [card] = groupCards(w.env);
		expect(card.system.rows[0].memberTokenUuid).toBe(w.shadowTokens[0].uuid);
		await expect(w.h.handleSwarmingShadowsGroupAttack(card)).resolves.toBeUndefined();
	});
});

describe('Command Shadows — spell data', () => {
	it('is a Shadowmancer-only shadow cantrip with a visible 1/round charge pool refilled on turn start', async () => {
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

describe('Command Shadows — one dialog per cast', () => {
	it('once the count dialog is answered, the system roll dialog is fast-forwarded', async () => {
		const w = await world();
		expect(w.h.commandShadowsActivateOptions(w.item, { rollMode: 1 })).toEqual({ rollMode: 1 });
		await w.env.dialogs.answerWhen(/Command Shadows/, 'confirm');
		expect(await w.h.commandShadowsActivationBlocked(w.item)).toBe(false);
		expect(w.h.commandShadowsActivateOptions(w.item, { rollMode: 1 })).toEqual({ rollMode: 1, fastForward: true });
		expect(w.h.commandShadowsActivateOptions(w.item, undefined)).toEqual({ fastForward: true });
	});

	it('a cancelled count dialog leaves the options alone (no plan pending)', async () => {
		const w = await world();
		expect((await w.cast('cancel')).blocked).toBe(true);
		expect(w.h.commandShadowsActivateOptions(w.item, {})).toEqual({});
	});
});

describe('Command Shadows — card decoration', () => {
	const fakeHtml = (rows) => {
		const lis = Array.from({ length: rows }, () => ({ classes: new Set(), classList: { add(c) { this.owner.add(c); } } }));
		lis.forEach((li) => (li.classList.owner = li.classes));
		const title = { textContent: 'Group of Minions' };
		const root = new Set();
		return {
			lis,
			title,
			root,
			classList: { add: (c) => root.add(c) },
			querySelector: (sel) => (sel === '.nimble-chat-card__title' ? title : null),
			querySelectorAll: () => lis,
		};
	};

	it('a Rush row is named "Rush" and flagged; the card is retitled "Shadows → target"', async () => {
		const w = await world({ shadows: [[2, 0], [3, 1]] });
		w.env.dialogs.answerWhen(/Command Shadows/, () => [{ count: 2, rush: 1 }]);
		// The rush field only shows for Shadow Rush owners; a plan with a rush count suffices here.
		w.h.pending.clear();
		w.env.game.user.targets = new Set([{ id: w.targetTokens[0].id, document: w.targetTokens[0] }]);
		await w.h.executeCommandShadows({
			casterUuid: w.caster.uuid,
			itemName: 'Command Shadows',
			sceneId: w.scene.id,
			shadowIds: w.shadowTokens.map((t) => t.id),
			groups: [{ targetId: w.targetTokens[0].id, count: 2, rush: 1 }],
		});
		const [card] = groupCards(w.env);
		expect(card.system.rows.map((r) => r.actionName)).toEqual(['Rush', card.system.rows[1].actionName]);
		expect(card.system.rows[1].actionName).not.toBe('Rush');
		expect(card.flags[MODULE_ID].commandShadows.rushRows).toEqual([0]);

		const styles = [];
		vi.stubGlobal('document', {
			getElementById: (id) => styles.find((el) => el.id === id) ?? null,
			createElement: () => ({}),
			head: { append: (el) => styles.push(el) },
		});
		const html = fakeHtml(2);
		expect(w.h.decorateCommandShadowsCard(card, html)).toBe(true);
		expect(styles).toHaveLength(1);
		vi.unstubAllGlobals();
		expect(html.root.has('bcx-shadow-card')).toBe(true);
		expect(html.title.textContent).toBe('Shadows → Goblin 1');
		expect(html.lis[0].classes.has('bcx-shadow-rush')).toBe(true);
		expect(html.lis[1].classes.has('bcx-shadow-rush')).toBe(false);
	});

	it('other minion cards are left alone', async () => {
		const w = await world();
		const html = fakeHtml(1);
		expect(w.h.decorateCommandShadowsCard({ type: 'minionGroupAttack', flags: {}, system: {} }, html)).toBe(false);
		expect(html.title.textContent).toBe('Group of Minions');
	});
});
