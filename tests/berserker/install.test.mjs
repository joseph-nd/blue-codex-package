/**
 * Codex Berserker subclasses — the patches the section installs (activation wrap,
 * DamageRoll post-evaluation, STR-save advantage, data-prep wraps) and the
 * triggered features (Flaming Heart, Brothers in Blood, Last Blaze).
 */
import { describe, expect, it, vi } from 'vitest';
import { MODULE_ID, SYS, BITE, berserkerWorld, codex, makeCharacter, makeEnemy, place, startRaging } from './helpers.mjs';

const lastCard = (env) => env.ChatMessage.created.at(-1);
const undoOf = (card) => card?.flags?.[MODULE_ID]?.undo;

describe('installed patches', () => {
	it('wraps every item class that defines its own activate, once', async () => {
		const { env, h } = await berserkerWorld();
		const calls = [];
		class FakeItem {
			async activate(options) {
				calls.push(options);
				return { id: 'card' };
			}
		}
		class FakeFeature extends FakeItem {}
		env.CONFIG.NIMBLE.Item.documentClasses = { base: FakeItem, feature: FakeFeature };
		h.installCodexBerserkerActivate();
		h.installCodexBerserkerActivate();
		expect(Object.prototype.hasOwnProperty.call(FakeItem.prototype, '__blueCodexBerserkerWrapped')).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(FakeFeature.prototype, '__blueCodexBerserkerWrapped')).toBe(false);
		const item = new FakeFeature();
		expect(await item.activate({ rollMode: 1 })).toEqual({ id: 'card' });
		expect(calls).toEqual([{ rollMode: 1 }]);
	});

	it('the DamageRoll patch adjusts the Fury terms of the activation in flight', async () => {
		const { env, h } = await berserkerWorld();
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
		env.foundry.dice.terms = { NumericTerm, OperatorTerm };
		class FakeDamageRoll {
			constructor() {
				this.terms = [];
				this._total = 0;
			}
			async _evaluate() {
				this.terms = [new NumericTerm({ number: 4 }), new OperatorTerm({ operator: '+' }), new NumericTerm({ number: 2, options: { flavor: 'Fury Dice' } })];
				this._total = 6;
				return this;
			}
			_finalizeOutcome() {}
			_recalculateTotal() {}
		}
		env.CONFIG.Dice.rolls = [FakeDamageRoll];
		expect(h.installCodexBerserkerDamageRoll()).toBe(true);
		const plain = await new FakeDamageRoll()._evaluate();
		expect(plain._total).toBe(6);
		h.cbzRollContexts.push({ ablaze: true });
		const roll = await new FakeDamageRoll()._evaluate();
		h.cbzRollContexts.pop();
		expect(roll._total).toBe(7);
		expect(roll.terms.at(-1).options.flavor).toBe('Ablaze');
	});

	it('STR saves of an ally near a Raging Skald get +1 roll mode', async () => {
		const { env, h, actor, scene } = await berserkerWorld({ features: [codex('skald', 'battle-hymn')] });
		const received = [];
		class FakeBaseActor {
			async rollSavingThrow(saveKey, options) {
				received.push([saveKey, options]);
				return { roll: null };
			}
		}
		class FakeCharacter extends FakeBaseActor {}
		env.CONFIG.NIMBLE.Actor.documentClasses = { base: FakeBaseActor, character: FakeCharacter };
		h.installCodexBerserkerSaves();
		const ally = makeCharacter(env, { id: 'allySave0000001', name: 'Saver' });
		place(env, scene, ally, [6, 5]);
		await startRaging(actor);
		const call = (key, options) => FakeCharacter.prototype.rollSavingThrow.call(ally, key, options);
		await call('strength', {});
		await call('will', { rollModeModifier: 0 });
		expect(received).toEqual([
			['strength', { rollModeModifier: 1 }],
			['will', { rollModeModifier: 0 }],
		]);
		expect(env.notifications.messages('info').at(-1)).toMatch(/Battle Hymn/);
	});

	it("data prep: Verse of Pride armor on characters, Apex Lycan's extra die on the natural weapons", async () => {
		const { env, h } = await berserkerWorld();
		const prepared = [];
		class FakeCharacter {
			_onAfterPrepareData() {
				prepared.push('character');
			}
		}
		class FakeObject {
			prepareDerivedData() {
				prepared.push('object');
			}
		}
		env.CONFIG.NIMBLE.Actor.documentClasses = { character: FakeCharacter };
		env.CONFIG.NIMBLE.Item.documentClasses = { object: FakeObject };
		h.installCodexBerserkerPrep();
		const character = new FakeCharacter();
		Object.assign(character, {
			type: 'character',
			system: { attributes: { armor: { value: 2, hint: 'Unarmored' } } },
			effects: [{ disabled: false, flags: { [MODULE_ID]: { codexBerserker: { hymn: { verse: 'pride', value: 3 } } } } }],
		});
		character._onAfterPrepareData();
		expect(character.system.attributes.armor.value).toBe(5);
		new FakeObject().prepareDerivedData();
		expect(prepared).toEqual(['character', 'object']);
	});
});

describe('triggered features', () => {
	it('Flaming Heart: once per Rage / gain burst, against enemies in Reach 1', async () => {
		const { env, h, actor, scene, item } = await berserkerWorld({ features: [codex('cinderheart', 'flaming-heart')] });
		const orc = place(env, scene, makeEnemy(env, 'Orc'), [6, 6], -1);
		place(env, scene, makeEnemy(env, 'Far'), [8, 8], -1);
		const hits = [];
		item('Flaming Heart').activate = vi.fn(async (options) => {
			hits.push({ options, targets: [...env.game.user.targets].map((t) => t.document.id) });
			return { id: 'fh' };
		});
		await h.cbzFlamingHeart(actor);
		expect(await h.cbzFlamingHeart(actor)).toBeNull(); // debounced
		expect(hits).toEqual([{ options: { fastForward: true }, targets: [orc.id] }]);
		h.cbzFlamingHeartAt.clear();
		h.cbzOnFuryChanged({ actor, poolId: 'fury', previousFaces: [], newFaces: [3] });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(hits).toHaveLength(2);
	});

	it('Brothers in Blood: a Wound posts the rallying cry; the ally in Range 4 gets the temp HP card', async () => {
		const { env, h, actor, scene, item } = await berserkerWorld({ features: [codex('skald', 'brothers-in-blood')] });
		const ally = makeCharacter(env, { id: 'allyBrother0001', name: 'Brother' });
		const allyToken = place(env, scene, ally, [7, 7]);
		let targeted = null;
		item('Brothers in Blood').activate = vi.fn(async () => {
			targeted = [...env.game.user.targets].map((t) => t.document.id);
			return { id: 'bib' };
		});
		await h.cbzOnWound(actor);
		const card = lastCard(env);
		expect(card.flags[MODULE_ID].codexBerserkerCard.actions.a0.action).toBe('brothers');
		const message = { id: 'm', ...card, isAuthor: true, update: vi.fn(async () => true) };
		expect(await h.cbzRunCardAction(message, 'a0')).toBe(true);
		expect(targeted).toEqual([allyToken.id]);
	});

	it('Last Blaze: the Rage ends, the HP is sacrificed, adjacent enemies are targeted; Undo restores all', async () => {
		const { env, h, actor, scene, item, faces } = await berserkerWorld({ features: [codex('cinderheart', 'last-blaze')], fury: [2, 3] });
		const orc = place(env, scene, makeEnemy(env, 'Orc'), [4, 5], -1);
		await startRaging(actor);
		env.dialogs.answer({ action: 'confirm', checked: ['10'] });
		const blaze = item('Last Blaze');
		const plan = await h.prepareCodexBerserkerActivation(blaze, {});
		expect(blaze.system.activation.effects[0].formula).toBe('10');
		expect(plan.options).toEqual({ fastForward: true });
		expect(plan.targets).toEqual([orc]);
		for (const complete of plan.completes) await complete({ id: 'card' });
		expect(actor.system.attributes.hp.value).toBe(20);
		expect(faces()).toEqual([]);
		expect(h.cbzIsRaging(actor)).toBe(false);
		const undo = undoOf(lastCard(env));
		await h.UNDO_HANDLERS.get(undo.type)(undo.data);
		expect(actor.system.attributes.hp.value).toBe(30);
		expect(faces()).toEqual([2, 3]);
		expect(h.cbzIsRaging(actor)).toBe(true);
	});

	it('Lycan Fury reminder only for Lycans (a Skald swinging an axe is left alone)', async () => {
		const { env, h, actor, item } = await berserkerWorld({ weapons: [BITE] });
		await startRaging(actor);
		await h.prepareCodexBerserkerActivation(item('Bite'), {});
		expect(env.notifications.messages('info')).toEqual([]);
	});

	it('Warrior Poet used by hand rolls the Fury Die after the system spent the use', async () => {
		const { h, item, faces } = await berserkerWorld({ features: [codex('skald', 'warrior-poet')] });
		const { queueDice } = await import('./helpers.mjs');
		queueDice([3]);
		const plan = await h.prepareCodexBerserkerActivation(item('Warrior Poet'), {});
		for (const complete of plan.completes) await complete({ id: 'card' });
		expect(faces()).toEqual([3]);
		expect(item('Rage').flags[SYS].dicePools.fury.faces).toEqual([3]);
	});
});
