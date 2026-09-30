/**
 * New characters (scripts/main.mjs "New characters: what the character creator
 * leaves behind"): Nimble's creator toggles every granted object's equip state,
 * which switches OFF a Codex grant that arrives equipped (the Engineer's Pistol,
 * whose Ammo counter only exists while equipped) — it is equipped again once the
 * creator is done; and the creator writes the ability scores last, so a
 * stat-based pool (Toolbelt: (INT+STR)×2) starts 0/4 — without Nim+, the new
 * character's Codex pools that start full are filled after the late syncs.
 */
import { describe, expect, it } from 'vitest';
import { adoptActor, setupWorld } from '../harness/index.mjs';
import { DOCS, owned, poolCurrent } from './helpers.mjs';

// Nimble's NimbleObjectItem#toggleEquipment: rules on/off with the equip state.
function installToggleEquipment(env) {
	env.classes.Item.prototype.toggleEquipment = async function toggleEquipment() {
		const next = !this.system.equipped;
		const rules = (this._source.system?.rules ?? []).map((rule) => ({ ...rule, disabled: !next }));
		await this.update({ 'system.rules': rules });
		await this.update({ 'system.equipped': next });
	};
}

/**
 * A stand-in for CharacterCreationDialog#submitCharacterCreation: the character
 * (createActor), the origin items with their grants (the Pistol arrives
 * equipped), the auto-equip loop that toggles every object, the pools the
 * system creates before any ability score is set (0/0), then the ability write.
 */
function creatorApp(env, { extraItems = [] } = {}) {
	const app = {
		actor: null,
		async submitCharacterCreation() {
			const actor = adoptActor(env, {
				_id: 'newEngineer00001',
				name: 'Fresh Engineer',
				type: 'character',
				system: { abilities: { intelligence: { mod: 0 }, strength: { mod: 0 } }, classData: { levels: ['engineer'] } },
				items: [],
			});
			app.actor = actor;
			env.Hooks.callAll('createActor', actor, {}, env.game.user.id);
			await actor.createEmbeddedDocuments('Item', [owned(DOCS.toolbelt), owned(DOCS.pistol), ...extraItems]);
			for (const item of actor.items.filter((i) => i.type === 'object')) await item.toggleEquipment();
			const toolbelt = actor.items.find((i) => i.name === 'Toolbelt');
			await actor.update({
				'flags.nimble.chargePools': { 'actor:toolbelt': { current: 0, max: 0, label: 'Toolbelt Scraps', sourceItemId: toolbelt.id } },
			});
			// The ability write lands last; the system's sync raises the max, not current.
			await actor.update({ 'system.abilities.intelligence.mod': 1, 'flags.nimble.chargePools.actor:toolbelt.max': 4 });
			return 'closed';
		},
	};
	return app;
}

const pistolOf = (actor) => actor.items.find((i) => i.name === 'Pistol');

describe('character creator: starting firearm equipped again', () => {
	it('the Pistol the auto-equip loop toggled off ends up equipped (rules back on); a second render does not re-wrap', async () => {
		const { env } = await setupWorld({ nimPlus: true });
		installToggleEquipment(env);
		const app = creatorApp(env);
		env.Hooks.callAll('renderCharacterCreationDialog', app);
		env.Hooks.callAll('renderCharacterCreationDialog', app);
		await expect(app.submitCharacterCreation({})).resolves.toBe('closed');
		await env.flush();
		const pistol = pistolOf(app.actor);
		expect(pistol.system.equipped).toBe(true);
		expect(pistol._source.system.rules.every((rule) => rule.disabled === false)).toBe(true);
		expect(env.Hooks.errors).toEqual([]);
	});

	it("another package's object that arrived equipped is left as the creator made it", async () => {
		const { env } = await setupWorld({ nimPlus: true });
		installToggleEquipment(env);
		const buckler = { _id: 'bucklerItem00001', name: 'Buckler', type: 'object', system: { objectType: 'armor', equipped: true, rules: [] } };
		const app = creatorApp(env, { extraItems: [buckler] });
		env.Hooks.callAll('renderCharacterCreationDialog', app);
		await app.submitCharacterCreation({});
		await env.flush();
		expect(app.actor.items.find((i) => i.name === 'Buckler').system.equipped).toBe(false);
		expect(pistolOf(app.actor).system.equipped).toBe(true);
	});
});

describe('character creator: Codex pools start full (without Nim+)', () => {
	async function created({ nimPlus = false } = {}) {
		const world = await setupWorld({ nimPlus });
		installToggleEquipment(world.env);
		const zeroPool = owned(DOCS.turretDeployed, {
			pools: { 'turret-deployed-turn': [0, 1] },
			patch: (data) => {
				data.system.rules[0].initial = 'zero';
			},
		});
		const foreign = {
			_id: 'foreignFeature01',
			name: 'Foreign Feature',
			type: 'feature',
			system: { rules: [{ type: 'chargePool', identifier: 'uses', initial: 'max', max: '2' }] },
			flags: { nimble: { chargePools: { uses: { current: 0, max: 2, label: 'uses' } } } },
		};
		const app = creatorApp(world.env, { extraItems: [zeroPool, foreign] });
		await app.submitCharacterCreation({});
		return { ...world, actor: app.actor, h: world.main.__engineer__ };
	}

	it('the Toolbelt (0/4 after the ability write) is filled; initial:"zero" and non-Codex pools are not', async () => {
		const { actor, h } = await created();
		expect(poolCurrent(actor, 'actor:toolbelt')).toBe(0);
		const { filled } = await h.finishCreatedCharacter(actor, { settleMs: 0 });
		expect(filled).toEqual(['Toolbelt Scraps 0 → 4']);
		expect(poolCurrent(actor, 'actor:toolbelt')).toBe(4);
		expect(poolCurrent(actor.items.find((i) => i.name === 'Turret Deployed!'), 'turret-deployed-turn')).toBe(0);
		expect(poolCurrent(actor.items.find((i) => i.name === 'Foreign Feature'), 'uses')).toBe(0);
	});

	it('with Nim+ active the module leaves the pools to it', async () => {
		const { actor, h } = await created({ nimPlus: true });
		const { filled } = await h.finishCreatedCharacter(actor, { settleMs: 0 });
		expect(filled).toEqual([]);
		expect(poolCurrent(actor, 'actor:toolbelt')).toBe(0);
	});
});
