/**
 * Codex Berserker subclasses — scripts/main.mjs "Berserker (Codex subclasses)":
 * Fury Dice reads/writes (Nim+ API or the pool storage), Battle Hymn verses and
 * their allies, Warrior Poet, Boltering Howl / Deafening Rebuke, the Ablaze
 * state (self burn, aura, King of Fires, end with Rage), the Fury terms on the
 * damage roll (Ablaze, Howl), Apex Lycan, Lunar Regeneration, Feral Pounce, and
 * the activation plans of Blaze Breaker / Heat of the Soul / Howl / Cleansing Fire.
 *
 * The harness has no canvas, ActiveEffect CRUD or item activation: tests build a
 * scene (summons helpers), add effect CRUD per actor (./helpers.mjs), stub
 * `activate`, and call the section through `main.__codexBerserker__`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
	BATTLEAXE,
	BITE,
	MODULE_ID,
	SYS,
	berserkerWorld,
	codex,
	makeCharacter,
	makeEnemy,
	owned,
	place,
	queueDice,
	startRaging,
} from './helpers.mjs';

const lastCard = (env) => env.ChatMessage.created.at(-1);
const undoOf = (card) => card?.flags?.[MODULE_ID]?.undo;
const hymnEffects = (actor) => actor.effects.filter((e) => e.flags?.[MODULE_ID]?.codexBerserker?.hymn);
const target = (env, ...docs) => {
	env.game.user.targets = new Set(docs.map((doc) => ({ id: doc.id, document: doc })));
};

/* ───────────────────────── Fury Dice ───────────────────────── */

describe('Fury Dice helpers', () => {
	it('write the pool storage and announce the change (no Nim+)', async () => {
		const { env, h, actor, faces } = await berserkerWorld({ fury: [2] });
		const seen = [];
		env.Hooks.on('nimble.dicePool.changed', (payload) => seen.push(payload));
		await h.cbzWriteFury(actor, h.cbzFuryEntry(actor), [2, 4]);
		expect(faces()).toEqual([2, 4]);
		expect(seen[0]).toMatchObject({ poolId: 'fury', previousFaces: [2], newFaces: [2, 4] });
	});

	it("use Nim+'s Berserker API when it is active", async () => {
		const { env, h, actor } = await berserkerWorld({ fury: [1] });
		const writeFuryFaces = vi.fn(async () => true);
		env.game.modules.set('nim-plus-package', { id: 'nim-plus-package', active: true, api: { berserker: { writeFuryFaces } } });
		await h.cbzWriteFury(actor, h.cbzFuryEntry(actor), [1, 3]);
		expect(writeFuryFaces).toHaveBeenCalledWith(actor, expect.objectContaining({ key: 'fury' }), [1, 3], { announce: true });
	});

	it('roll into the pool: dice over the max are reported, the Undo card restores the faces', async () => {
		const { env, h, actor, faces } = await berserkerWorld({ fury: [1], furyMax: 2 });
		queueDice([3, 4]);
		const out = await h.cbzRollFuryIntoPool(actor, 2, { flavor: 'Test' });
		expect(out).toMatchObject({ kept: [3], discarded: [4] });
		expect(faces()).toEqual([1, 3]);
		const undo = undoOf(lastCard(env));
		expect(undo.type).toBe('codexFuryFaces');
		await h.UNDO_HANDLERS.get(undo.type)(undo.data);
		expect(faces()).toEqual([1]);
	});
});

/* ───────────────────────── Skald ───────────────────────── */

async function skaldWorld(opts = {}) {
	const w = await berserkerWorld({
		...opts,
		features: [codex('skald', 'battle-hymn'), ...(opts.features ?? [])],
		fury: opts.fury ?? [2, 5],
	});
	const near = makeCharacter(w.env, { id: 'allyNear0000001', name: 'Near', hp: [20, 20] });
	const far = makeCharacter(w.env, { id: 'allyFar00000001', name: 'Far', hp: [20, 20] });
	const enemy = makeEnemy(w.env, 'Goblin');
	const nearToken = place(w.env, w.scene, near, [8, 5]);
	const farToken = place(w.env, w.scene, far, [15, 15]);
	const enemyToken = place(w.env, w.scene, enemy, [6, 5], -1);
	return { ...w, near, far, enemy, nearToken, farToken, enemyToken };
}

describe('Battle Hymn', () => {
	it('expends the die, records the hymn and gives the verse to allies in Burst 4 only', async () => {
		const { env, h, actor, faces, near, far, enemy } = await skaldWorld();
		const hymn = await h.cbzSingBattleHymn(actor, [{ verse: 'violence', index: 1 }]);
		expect(faces()).toEqual([2]);
		expect(hymn.verses).toEqual([{ verse: 'violence', value: 5 }]);
		expect(actor.flags[MODULE_ID].codexBerserker.hymn.id).toBe(hymn.id);
		expect(hymnEffects(near).map((e) => e.flags[MODULE_ID].codexBerserker.hymn)).toEqual([
			expect.objectContaining({ verse: 'violence', value: 5, hymnId: hymn.id }),
		]);
		expect(hymnEffects(far)).toEqual([]);
		expect(hymnEffects(enemy)).toEqual([]);
		expect(undoOf(lastCard(env)).type).toBe('codexHymnUndo');
	});

	it('Verse of Survival grants half the die as temp HP; Undo puts the dice, verses and temp HP back', async () => {
		const { env, h, actor, faces, near } = await skaldWorld();
		await h.cbzSingBattleHymn(actor, [{ verse: 'survival', index: 1 }]);
		expect(near.system.attributes.hp.temp).toBe(2);
		const undo = undoOf(lastCard(env));
		await h.UNDO_HANDLERS.get(undo.type)(undo.data);
		expect(faces()).toEqual([2, 5]);
		expect(hymnEffects(near)).toEqual([]);
		expect(near.system.attributes.hp.temp).toBe(0);
	});

	it('the dialog picks the verse and the die; Saga of Battles asks for a second one', async () => {
		const { env, h, actor, faces, near } = await skaldWorld({ features: [codex('skald', 'saga-of-battles')], fury: [2, 5, 3] });
		env.dialogs.answer({ action: 'pride', checked: ['1'] }).answer({ action: 'violence', checked: ['0'] });
		const hymn = await h.cbzBattleHymnPrompt(actor);
		expect(hymn.verses).toEqual([
			{ verse: 'pride', value: 5 },
			{ verse: 'violence', value: 2 },
		]);
		expect(faces()).toEqual([3]);
		expect(hymnEffects(near).map((e) => e.flags[MODULE_ID].codexBerserker.hymn.verse).sort()).toEqual(['pride', 'violence']);
	});

	it('"No verse" spends nothing', async () => {
		const { env, h, actor, faces } = await skaldWorld();
		env.dialogs.answer('none');
		expect(await h.cbzBattleHymnPrompt(actor)).toBeNull();
		expect(faces()).toEqual([2, 5]);
	});

	it("ends at the start of the Skald's next turn", async () => {
		const { h, actor, token, combat, near } = await skaldWorld();
		await h.cbzSingBattleHymn(actor, [{ verse: 'pride', index: 0 }]);
		expect(hymnEffects(near)).toHaveLength(1);
		await h.cbzOnTurnStart({ actor, token, parent: combat });
		expect(hymnEffects(near)).toEqual([]);
		expect(actor.flags[MODULE_ID]?.codexBerserker?.hymn).toBeUndefined();
	});

	it('an ally starting their turn in Burst 4 gets the verse then, plus +2 speed with Saga of Battles while the Skald Rages', async () => {
		const { h, actor, far, farToken } = await skaldWorld({ features: [codex('skald', 'saga-of-battles')] });
		await startRaging(actor);
		await h.cbzSingBattleHymn(actor, [{ verse: 'pride', index: 1 }]);
		expect(hymnEffects(far)).toEqual([]);
		await farToken.update({ x: 900, y: 500 }); // 4 spaces from the Skald
		await h.cbzHymnTurnStart(far, farToken);
		expect(hymnEffects(far)).toHaveLength(1);
		const saga = far.effects.find((e) => e.flags[MODULE_ID].codexBerserker.saga);
		expect(saga.system.changes).toEqual([{ key: 'system.attributes.movement.walk', type: 'add', value: '2', phase: 'initial' }]);
		// Idempotent: a second turn start adds nothing.
		await h.cbzHymnTurnStart(far, farToken);
		expect(far.effects.size).toBe(2);
		// The saga speed ends with that ally's turn.
		await h.cbzOnTurnEnd({ actor: far });
		expect(far.effects.size).toBe(1);
	});

	it("Verse of Violence adds the die to the ally's next damage roll, then is spent", async () => {
		const { env, h, actor, near, nearToken } = await skaldWorld();
		const [axe] = await near.createEmbeddedDocuments('Item', [owned(BATTLEAXE)]);
		await h.cbzSingBattleHymn(actor, [{ verse: 'violence', index: 1 }]);
		let formula = null;
		const original = async function run() {
			formula = this.system.activation.effects[0].formula;
			return { id: 'card', system: { isMiss: false } };
		};
		await h.runCodexBerserkerActivate.call(axe, original, {});
		expect(formula).toBe('1d10+@strength + 5');
		expect(axe.system.activation.effects[0].formula).toBe('1d10+@strength');
		const [spent] = hymnEffects(near);
		expect(spent).toMatchObject({ disabled: true, name: 'Verse of Violence (spent)' });
		expect(spent.flags[MODULE_ID].codexBerserker.hymn.spent).toBe(true);
		expect(env.ChatMessage.created.some((c) => /Verse of Violence/.test(c.content))).toBe(true);
		// Spent: the next roll gets nothing, and starting a turn in the area does not give it again.
		formula = null;
		await h.runCodexBerserkerActivate.call(axe, original, {});
		expect(formula).toBe('1d10+@strength');
		await h.cbzHymnTurnStart(near, nearToken);
		expect(hymnEffects(near)).toHaveLength(1);
	});

	it('Verse of Pride raises a character ally’s Armor', async () => {
		const { h, actor, near } = await skaldWorld();
		await h.cbzSingBattleHymn(actor, [{ verse: 'pride', index: 1 }]);
		near.system.attributes.armor.value = 2;
		h.cbzApplyPrideArmor(near);
		expect(near.system.attributes.armor.value).toBe(7);
	});

	it('while the Skald Rages, an ally in Burst 4 has advantage on STR saves only', async () => {
		const { h, actor, near, far } = await skaldWorld();
		expect(h.cbzHymnSaveSource(near, 'strength')).toBeNull();
		await startRaging(actor);
		expect(h.cbzHymnSaveSource(near, 'strength')).toBe(actor);
		expect(h.cbzHymnSaveSource(near, 'dexterity')).toBeNull();
		expect(h.cbzHymnSaveSource(far, 'strength')).toBeNull();
		expect(h.cbzHymnSaveSource(actor, 'strength')).toBeNull();
	});

	it('Thunderous Bellow is used against every enemy in Burst 1 when the Skald Rages', async () => {
		const { env, h, actor, item, enemyToken } = await skaldWorld({ features: [codex('skald', 'thunderous-bellow')] });
		let targets = null;
		item('Thunderous Bellow').activate = vi.fn(async () => {
			targets = [...env.game.user.targets].map((t) => t.document.id);
			return { id: 'bellow' };
		});
		env.dialogs.answer('none'); // Battle Hymn: no verse
		await h.cbzAfterRage(actor);
		expect(item('Thunderous Bellow').activate).toHaveBeenCalledWith({ fastForward: true });
		expect(targets).toEqual([enemyToken.id]);
	});

	it("a free Rage on the GM's client for a player's Skald posts a card instead of a dialog", async () => {
		const { env, h, actor } = await skaldWorld({ ownedByPlayer: true });
		await h.cbzAfterRage(actor);
		const card = lastCard(env);
		expect(card.flags[MODULE_ID].codexBerserkerCard.actions.a0).toMatchObject({ action: 'hymn', done: false });
		expect(env.dialogs.log).toEqual([]);
		// The owner's click runs the verse prompt.
		env.dialogs.answer({ action: 'survival', checked: ['1'] });
		const message = { id: 'msg1', ...card, update: vi.fn(async () => true), isAuthor: true };
		expect(await h.cbzRunCardAction(message, 'a0')).toBe(true);
		expect(message.update).toHaveBeenCalledWith(expect.objectContaining({ [`flags.${MODULE_ID}.codexBerserkerCard.actions.a0.done`]: true }));
	});
});

describe('Warrior Poet', () => {
	async function poetWorld() {
		const w = await skaldWorld({ features: [codex('skald', 'warrior-poet')], fury: [] });
		const feature = w.item('Warrior Poet');
		await feature.update({ 'flags.nimble.chargePools': { 'warrior-poet-uses': { current: 1, max: 1, label: 'Warrior Poet (1/turn)' } } });
		const [axe] = await w.near.createEmbeddedDocuments('Item', [owned(BATTLEAXE)]);
		w.combat.combatants.set('cmbSkald', { id: 'cmbSkald', actor: w.actor, actorId: w.actor.id });
		return { ...w, feature, axe };
	}
	const uses = (feature) => feature.flags.nimble.chargePools['warrior-poet-uses'].current;

	it("1/turn: an ally's damaging hit in Burst 4 rolls a Fury Die while the Skald Rages", async () => {
		const { env, h, actor, faces, feature, axe } = await poetWorld();
		expect(await h.cbzWarriorPoetCheck(axe, { isMiss: false })).toBe(0); // not Raging
		await startRaging(actor);
		queueDice([4]);
		expect(await h.cbzWarriorPoetCheck(axe, { isMiss: false })).toBe(1);
		expect(faces()).toEqual([4]);
		expect(uses(feature)).toBe(0);
		queueDice([2]);
		await h.cbzWarriorPoetCheck(axe, { isMiss: false });
		expect(faces()).toEqual([4]);
		// Undo gives back the die and the use.
		const undo = undoOf(env.ChatMessage.created.find((c) => undoOf(c)?.type === 'codexFuryFaces'));
		await h.UNDO_HANDLERS.get(undo.type)(undo.data);
		expect(faces()).toEqual([]);
		expect(uses(feature)).toBe(1);
	});

	it('misses do not count, and the use comes back at every turn start', async () => {
		const { h, actor, combat, feature, axe } = await poetWorld();
		await startRaging(actor);
		expect(await h.cbzWarriorPoetCheck(axe, { isMiss: true })).toBe(0);
		queueDice([3]);
		await h.cbzWarriorPoetCheck(axe, { isMiss: false });
		expect(uses(feature)).toBe(0);
		await h.cbzRefreshWarriorPoet(combat);
		expect(uses(feature)).toBe(1);
	});
});

describe('Boltering Howl & Deafening Rebuke', () => {
	it('banks That all you got?! on the targeted ally; Undo removes it and returns the dice', async () => {
		const { env, h, actor, faces, item, near, nearToken } = await skaldWorld({ features: [codex('skald', 'boltering-howl')], fury: [2, 4] });
		target(env, nearToken);
		env.dialogs.answer({ action: 'confirm', checked: ['1'] });
		const plan = await h.prepareCodexBerserkerActivation(item('Boltering Howl'), {});
		expect(plan.targets).toEqual([nearToken]);
		for (const complete of plan.completes) await complete({ id: 'card' });
		expect(faces()).toEqual([4]);
		const bank = near.effects.find((e) => e.flags.nimble?.bankedDamageReduction);
		expect(bank.flags.nimble.bankedDamageReduction).toBe(4); // (STR 3 + DEX 1) × 1
		const undo = undoOf(lastCard(env));
		await h.UNDO_HANDLERS.get(undo.type)(undo.data);
		expect(near.effects.find((e) => e.flags.nimble?.bankedDamageReduction)).toBeUndefined();
		expect(faces()).toEqual([2, 4]);
	});

	it('Deafening Rebuke deals the highest die just expended (asks when it is not known)', async () => {
		const { env, h, actor, item } = await skaldWorld({ features: [codex('skald', 'deafening-rebuke')] });
		const rebuke = item('Deafening Rebuke');
		h.cbzOnFuryChanged({ actor, poolId: 'fury', previousFaces: [2, 5, 3], newFaces: [2] });
		let plan = await h.prepareCodexBerserkerActivation(rebuke, {});
		expect(rebuke.system.activation.effects[0].formula).toBe('5');
		plan.restores.forEach((restore) => restore());
		for (const complete of plan.completes) await complete({});
		env.dialogs.answer({ action: 'confirm', checked: ['3'] });
		plan = await h.prepareCodexBerserkerActivation(rebuke, {});
		expect(rebuke.system.activation.effects[0].formula).toBe('3');
		plan.restores.forEach((restore) => restore());
	});
});

/* ───────────────────────── Cinderheart ───────────────────────── */

async function cinderWorld(opts = {}) {
	const w = await berserkerWorld({ ...opts, features: [codex('cinderheart', 'immolating-fury'), ...(opts.features ?? [])], fury: opts.fury ?? [] });
	const enemy = makeEnemy(w.env, 'Orc', 20);
	const enemyToken = place(w.env, w.scene, enemy, [6, 5], -1);
	const farEnemy = makeEnemy(w.env, 'Ogre', 20);
	place(w.env, w.scene, farEnemy, [9, 5], -1);
	return { ...w, enemy, enemyToken, farEnemy };
}

describe('Ablaze (Immolating Fury)', () => {
	it('setting Ablaze creates the toggle effect and burns for STR at once (Undo restores)', async () => {
		const { env, h, actor } = await cinderWorld();
		expect(await h.cbzSetAblaze(actor)).toBe(true);
		expect(h.cbzIsAblaze(actor)).toBe(true);
		const effect = actor.effects.find((e) => e.flags.nimble?.toggleEffectRuleId === 'ablazeToggle');
		expect(effect.flags[MODULE_ID].codexBerserker.ablaze).toEqual({ combatId: 'combatArena00001', round: 1 });
		expect(actor.system.attributes.hp.value).toBe(27);
		const undo = undoOf(lastCard(env));
		expect(undo.type).toBe('codexAblazeUndo');
		await h.UNDO_HANDLERS.get(undo.type)(undo.data);
		expect(h.cbzIsAblaze(actor)).toBe(false);
		expect(actor.system.attributes.hp.value).toBe(30);
	});

	it('burns at the start of each turn after the first', async () => {
		const { h, actor, combat } = await cinderWorld();
		await h.cbzSetAblaze(actor);
		expect(await h.cbzAblazeTurnStart(actor, combat)).toBeNull(); // same round: the first turn
		combat.round = 2;
		expect(await h.cbzAblazeTurnStart(actor, combat)).toMatchObject({ taken: 3 });
		expect(actor.system.attributes.hp.value).toBe(24);
	});

	it('the fiery aura burns adjacent enemies for KEY (armor ignored), with Smoldering from King of Fires', async () => {
		const { env, h, actor, enemy, farEnemy } = await cinderWorld({ features: [codex('cinderheart', 'king-of-fires')], dex: 2 });
		await h.cbzSetAblaze(actor);
		await h.cbzAblazeAura(actor);
		expect(enemy.system.attributes.hp.value).toBe(17); // KEY = max(STR 3, DEX 2)
		expect(enemy.statuses.has('smoldering')).toBe(true);
		expect(farEnemy.system.attributes.hp.value).toBe(20);
		const undo = undoOf(lastCard(env));
		await h.UNDO_HANDLERS.get(undo.type)(undo.data);
		expect(enemy.system.attributes.hp.value).toBe(20);
		expect(enemy.statuses.has('smoldering')).toBe(false);
	});

	it('King of Fires math: resistance halves (round up), then −STR while Ablaze', () => {
		return (async () => {
			const { h } = await cinderWorld();
			const actor = (reductions) => ({ system: { attributes: {}, damageReductions: reductions } });
			const resist = { mode: 'half', value: 0, damageTypes: ['fire'] };
			const ablaze = { mode: 'flat', value: 3, damageTypes: ['fire'] };
			expect(h.cbzFireTaken(actor([resist]), 5)).toBe(3);
			expect(h.cbzFireTaken(actor([resist, ablaze]), 5)).toBe(0);
			expect(h.cbzFireTaken(actor([{ mode: 'flat', value: 2, damageTypes: ['cold'] }]), 5)).toBe(5);
			expect(h.cbzFireTaken({ system: { attributes: { damageImmunities: ['fire'] } } }, 5)).toBe(0);
		})();
	});

	it('ends with the Rage', async () => {
		const { h, actor } = await cinderWorld();
		await startRaging(actor);
		await h.cbzSetAblaze(actor);
		expect(await h.cbzOnRageEnded(actor)).toBe(true);
		expect(h.cbzIsAblaze(actor)).toBe(false);
	});

	it('using Immolating Fury while Raging lights it (the system activation is replaced)', async () => {
		const { h, actor, item } = await cinderWorld();
		await startRaging(actor);
		const original = vi.fn();
		expect(await h.runCodexBerserkerActivate.call(item('Immolating Fury'), original, {})).toBeNull();
		expect(original).not.toHaveBeenCalled();
		expect(h.cbzIsAblaze(actor)).toBe(true);
	});

	it('the Rage offers Ablaze (dialog when this client decides)', async () => {
		const { env, h, actor } = await cinderWorld();
		env.dialogs.answer(true);
		await h.cbzAfterRage(actor);
		expect(h.cbzIsAblaze(actor)).toBe(true);
	});
});

describe('Fury terms on the damage roll', () => {
	class NumericTerm {
		constructor({ number, options = {} }) {
			this.number = number;
			this.options = options;
		}
	}
	class OperatorTerm {
		constructor({ operator }) {
			this.operator = operator;
		}
	}
	const terms = { NumericTerm, OperatorTerm };
	const plus = () => new OperatorTerm({ operator: '+' });
	const fury = (n) => new NumericTerm({ number: n, options: { flavor: 'Fury Dice' } });
	const makeRoll = (...extra) => ({ terms: [{ faces: 10 }, plus(), fury(1), plus(), fury(3), plus(), fury(2), ...extra], _total: 12, resetFormula: vi.fn() });

	it('Ablaze adds +1 per Fury Die as its own term', async () => {
		const { h } = await berserkerWorld();
		const roll = makeRoll();
		expect(h.cbzAdjustFuryRoll(roll, { ablaze: true }, terms)).toBe(3);
		expect(roll.terms.at(-1)).toMatchObject({ number: 3, options: { flavor: 'Ablaze' } });
		expect(roll._total).toBe(15);
	});

	it('Howl in the Night: two Fury Dice count at their max against a Frightened target', async () => {
		const { h } = await berserkerWorld();
		const roll = makeRoll();
		expect(h.cbzAdjustFuryRoll(roll, { howl: true, dieFaces: 6 }, terms)).toBe(9);
		expect(roll.terms.filter((t) => t.options?.flavor === 'Fury Dice').map((t) => t.number)).toEqual([6, 3, 6]);
	});

	it("a Death Blow term (already doubled) is kept in step", async () => {
		const { h } = await berserkerWorld();
		const roll = makeRoll(plus(), new NumericTerm({ number: 6, options: { flavor: 'Death Blow' } }));
		expect(h.cbzAdjustFuryRoll(roll, { ablaze: true }, terms)).toBe(6);
		expect(roll.terms.find((t) => t.options?.flavor === 'Death Blow').number).toBe(9);
	});

	it('an attack while Ablaze, or with Howl against a Frightened target, carries the roll context', async () => {
		const { env, h, actor, item } = await berserkerWorld({ features: [codex('lycan', 'howl-in-the-night'), codex('lycan', 'lycan-fury')], weapons: [BITE], fury: [2], dieSize: 'd8' });
		const enemy = makeEnemy(env, 'Wolf');
		const token = place(env, env.scene, enemy, [6, 5], -1);
		target(env, token);
		expect(await h.prepareCodexBerserkerActivation(item('Bite'), {})).toBeNull();
		enemy.statuses.add('frightened');
		await startRaging(actor);
		const plan = await h.prepareCodexBerserkerActivation(item('Bite'), {});
		expect(plan.context).toMatchObject({ actor, howl: true, ablaze: false, dieFaces: 8 });
	});
});

describe('Cinderheart activations', () => {
	it('Blaze Breaker: the expended dice (highest first) + KEY, Smoldering with King of Fires; spent once the card is out', async () => {
		const { env, h, item, faces } = await cinderWorld({ features: [codex('cinderheart', 'blaze-breaker'), codex('cinderheart', 'king-of-fires')], fury: [2, 5, 3] });
		const breaker = item('Blaze Breaker');
		env.dialogs.answer({ action: 'confirm', checked: ['2'] });
		const plan = await h.prepareCodexBerserkerActivation(breaker, {});
		const [save] = breaker.system.activation.effects;
		expect(save.sharedRolls[0].formula).toBe('8 + @key');
		expect(save.on.failedSave.concat(save.on.passedSave).filter((n) => n.condition === 'smoldering')).toHaveLength(2);
		for (const complete of plan.completes) await complete({ id: 'card' });
		expect(faces()).toEqual([2]);
		plan.restores.forEach((restore) => restore());
		expect(breaker.system.activation.effects[0].sharedRolls[0].formula).toBe('@key');
	});

	it('Blaze Breaker without Fury Dice is refused (nothing spent)', async () => {
		const { env, h, item } = await cinderWorld({ features: [codex('cinderheart', 'blaze-breaker')] });
		const plan = await h.prepareCodexBerserkerActivation(item('Blaze Breaker'), {});
		expect(plan.blocked).toBe(true);
		expect(env.notifications.messages('warn').some((m) => /at least 1 Fury Die/.test(m))).toBe(true);
	});

	it('Heat of the Soul: STR+DEX per die to every enemy in Burst 1, the lowest dice spent', async () => {
		const { env, h, item, faces, enemyToken } = await cinderWorld({ features: [codex('cinderheart', 'heat-of-the-soul')], fury: [4, 2, 3] });
		env.dialogs.answer({ action: 'confirm', checked: ['2'] });
		const plan = await h.prepareCodexBerserkerActivation(item('Heat of the Soul'), {});
		expect(item('Heat of the Soul').system.activation.effects[0].formula).toBe('(@strength + @dexterity) * 2');
		expect(plan.targets).toEqual([enemyToken]);
		for (const complete of plan.completes) await complete({ id: 'card' });
		expect(faces()).toEqual([4]);
	});

	it('Cleansing Fire removes the only negative condition (Undo restores it)', async () => {
		const { env, h, actor, item } = await cinderWorld({ features: [codex('cinderheart', 'cleansing-fire')] });
		expect((await h.prepareCodexBerserkerActivation(item('Cleansing Fire'), {})).blocked).toBe(true);
		actor.statuses.add('dazed');
		const plan = await h.prepareCodexBerserkerActivation(item('Cleansing Fire'), {});
		for (const complete of plan.completes) await complete({ id: 'card' });
		expect(actor.statuses.has('dazed')).toBe(false);
		const undo = undoOf(lastCard(env));
		await h.UNDO_HANDLERS.get(undo.type)(undo.data);
		expect(actor.statuses.has('dazed')).toBe(true);
	});

	it('Burn Together is used against adjacent enemies when a Wound is gained', async () => {
		const { env, actor, item, enemyToken } = await cinderWorld({ features: [codex('cinderheart', 'burn-together')] });
		let targets = null;
		item('Burn Together').activate = vi.fn(async () => {
			targets = [...env.game.user.targets].map((t) => t.document.id);
			return { id: 'burn' };
		});
		await actor.update({ 'system.attributes.wounds.value': 1 });
		await env.flush();
		expect(targets).toEqual([enemyToken.id]);
	});
});

/* ───────────────────────── Lycan ───────────────────────── */

describe('Lycan', () => {
	it('Apex Lycan gives the natural weapons one more damage die (derived, idempotent)', async () => {
		const { h, item } = await berserkerWorld({ features: [codex('lycan', 'apex-lycan')], weapons: [BITE] });
		const bite = item('Bite');
		h.cbzApplyApexLycan(bite);
		h.cbzApplyApexLycan(bite);
		expect(bite.system.activation.effects[0].formula).toBe('2d10 + @strength');
		const plain = await berserkerWorld({ weapons: [BITE] });
		plain.h.cbzApplyApexLycan(plain.item('Bite'));
		expect(plain.item('Bite').system.activation.effects[0].formula).toBe('1d10 + @strength');
	});

	it('Lunar Regeneration heals STR at the start of the turn while Bloodied', async () => {
		const { env, h, actor } = await berserkerWorld({ features: [codex('lycan', 'lunar-regeneration')], hp: [12, 30] });
		expect(await h.cbzLunarRegeneration(actor)).toBe(3);
		expect(actor.system.attributes.hp.value).toBe(15);
		expect(undoOf(lastCard(env)).type).toBe('codexHpRestore');
		await actor.update({ 'system.attributes.hp.value': 20 });
		expect(await h.cbzLunarRegeneration(actor)).toBeNull();
	});

	it('Howl in the Night targets Burst 3 when nothing is targeted and expends the lowest die', async () => {
		const { env, h, item, faces } = await berserkerWorld({ features: [codex('lycan', 'howl-in-the-night')], fury: [3, 1] });
		const near = place(env, env.scene, makeEnemy(env, 'Near'), [7, 5], -1);
		place(env, env.scene, makeEnemy(env, 'Far'), [10, 5], -1);
		const plan = await h.prepareCodexBerserkerActivation(item('Howl in the Night'), {});
		expect(plan.targets).toEqual([near]);
		for (const complete of plan.completes) await complete({ id: 'card' });
		expect(faces()).toEqual([3]);
	});

	it('Howl in the Night with no Fury Die asks first', async () => {
		const { env, h, item } = await berserkerWorld({ features: [codex('lycan', 'howl-in-the-night')] });
		env.dialogs.answer(false);
		expect((await h.prepareCodexBerserkerActivation(item('Howl in the Night'), {})).blocked).toBe(true);
	});

	it('reminders (never blocks): a weapon while Raging, a natural weapon out of form', async () => {
		const { env, h, actor, item } = await berserkerWorld({ features: [codex('lycan', 'lycan-fury')], weapons: [BITE, BATTLEAXE] });
		await h.prepareCodexBerserkerActivation(item('Bite'), {});
		expect(env.notifications.messages('info').at(-1)).toMatch(/hybrid form/);
		await startRaging(actor);
		await h.prepareCodexBerserkerActivation(item('Battleaxe'), {});
		expect(env.notifications.messages('info').at(-1)).toMatch(/cannot wield weapons/);
	});

	it('Feral Pounce: 3 spaces moved while Raging → next attack +LVL, then a Prone offer on the hit', async () => {
		const { env, h, actor, token, combat, item } = await berserkerWorld({ features: [codex('lycan', 'feral-pounce')], weapons: [BITE], fury: [2] });
		const wolf = makeEnemy(env, 'Wolf');
		const wolfToken = place(env, env.scene, wolf, [6, 5], -1);
		combat.combatant = { actorId: actor.id, actor };
		expect(await h.cbzTrackPounce(token, { x: token.x - 300, y: token.y })).toBeNull(); // not Raging
		await startRaging(actor);
		await h.cbzTrackPounce(token, { x: token.x - 200, y: token.y });
		expect(actor.effects.some((e) => e.flags[MODULE_ID]?.codexBerserker?.pounce)).toBe(false);
		await h.cbzTrackPounce(token, { x: token.x - 100, y: token.y });
		expect(actor.effects.some((e) => e.flags[MODULE_ID]?.codexBerserker?.pounce)).toBe(true);
		target(env, wolfToken);
		const plan = await h.prepareCodexBerserkerActivation(item('Bite'), {});
		expect(item('Bite').system.activation.effects[0].formula).toBe('1d10 + @strength + 11');
		for (const complete of plan.completes) await complete({ system: { isMiss: false } });
		expect(actor.effects.some((e) => e.flags[MODULE_ID]?.codexBerserker?.pounce)).toBe(false);
		expect(lastCard(env).flags[MODULE_ID].codexBerserkerCard.actions.a0.action).toBe('pounceProne');
		const message = { id: 'msg2', ...lastCard(env), update: vi.fn(async () => true), isAuthor: true };
		await h.cbzRunCardAction(message, 'a0');
		expect(wolf.statuses.has('prone')).toBe(true);
		expect(actor.items.find((i) => i.name === 'Rage').flags[SYS].dicePools.fury.faces).toEqual([]);
	});
});
