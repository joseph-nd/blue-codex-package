/**
 * Class-content refresh + Lifebinding Spirit conversion (scripts/main.mjs,
 * "Class-content refresh" section). Since 0.9.0 both apply automatically — no
 * confirmation popup — and report through a toast, a GM-whispered chat card
 * listing every change (removals included) and console.info:
 *
 *   - blueCodex.refreshClassContent(actor) / the sheet header entry: applies at once;
 *     `dryRun` posts the card and writes nothing;
 *   - on `ready` the acting GM refreshes every stale character, once per module
 *     version, after the Codex content sync;
 *   - the debounced Lifebinding Spirit check converts on the acting GM's client,
 *     without retriggering itself.
 */
import { describe, expect, it } from 'vitest';
import { adoptActor, findDocs, setupWorld } from '../harness/index.mjs';

const MODULE_ID = 'blue-codex-package';
const GM_ID = 'gmUser000000000a';
const PLAYER_ID = 'player00000000a1';
const TINKERING = 'Compendium.blue-codex-package.blue-codex-class-features.Item.2mVWluSeiyflpvQ9';
const AED_PICK = 'Compendium.blue-codex-package.blue-codex-class-features.Item.TTPbp2QSCNPxFjce';
const AED_ITEM = 'Compendium.blue-codex-package.blue-codex-items.Item.PAqNlguDKrDFkVHe';
const SPIRIT_T1 = 'Compendium.blue-codex-package.blue-codex-spells.Item.EfjqVGarrBSsFoAF';
const SPIRIT_02 = 'Compendium.blue-codex-package.blue-codex-spells.Item.thNZGzaP60h0Q9nE';
const NIM_PLUS_CANTRIP = 'Compendium.nim-plus-package.nim-plus-spells.Item.SAEd6Nk8SfgJ2Ff7';

function packDoc(uuid) {
	const [hit] = findDocs({ where: () => true }).filter((h) => h.uuid === uuid);
	expect(hit, uuid).toBeTruthy();
	return hit;
}

/** An owned copy of pack document `uuid`. */
function ownedCopy(uuid, id) {
	const data = structuredClone(packDoc(uuid).doc);
	data._id = id;
	data._stats = { ...(data._stats ?? {}), compendiumSource: uuid };
	return data;
}

/** Tinkering as owned before the automation pass: no rules, old text, a spent counter. */
function staleTinkering() {
	const data = ownedCopy(TINKERING, 'ownedTinker00001');
	data.system.rules = [];
	data.system.description = '<p>old text</p>';
	data.flags = { nimble: { chargePools: { 'tinkering-uses': { current: 1 } } }, 'other-module': { x: 1 } };
	return data;
}

function engineerClass() {
	return { _id: 'engineerClass001', name: 'Engineer', type: 'class', system: { identifier: 'engineer', classLevel: 3 } };
}

function engineer(env, items, { name = 'Gizmo', ownership = { [PLAYER_ID]: 3 } } = {}) {
	return adoptActor(env, { name, type: 'character', system: {}, flags: {}, ownership, items: [engineerClass(), ...items] });
}

/** My Buddy! (Nimble 0.2 Shepherd), still granting Nim+'s cantrip; the Mend pool it defines is actor-scoped. */
function myBuddy() {
	return {
		_id: 'myBuddyFeature01',
		name: 'My Buddy!',
		type: 'feature',
		system: {
			identifier: 'my-buddy',
			class: 'shepherd',
			description: '<p>Your spirit.</p>',
			rules: [{ id: 'grant', type: 'grantSpells', schools: [], tiers: [0], uuids: [NIM_PLUS_CANTRIP], mode: 'auto' }],
		},
		flags: { nimble: { chargePools: { lifebindingMend: { current: 2 } } } },
	};
}

/** A Shepherd holding the tier-1 spirit — a 0.2 Shepherd (due a conversion) when it owns My Buddy!. */
function shepherd02(env, { withBuddy = true } = {}) {
	const items = [
		{ _id: 'shepherdClass001', name: 'Shepherd', type: 'class', system: { identifier: 'shepherd', classLevel: 3 } },
		ownedCopy(SPIRIT_T1, 'ownedSpiritT1001'),
	];
	if (withBuddy) items.push(myBuddy());
	return adoptActor(env, {
		name: 'Wren',
		type: 'character',
		system: {},
		flags: { nimble: { chargePools: { lifebindingMend: { current: 2 } } } },
		ownership: { [PLAYER_ID]: 3 },
		items,
	});
}

const sources = (actor) => actor.items.map((item) => item._stats?.compendiumSource ?? null);
const lastCard = (env) => env.ChatMessage.created.at(-1);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Refresh Codex class content (macro / sheet header)', () => {
	it('applies at once — no dialog — keeping ids and counters, and reports by toast + card', async () => {
		const { env } = await setupWorld();
		const actor = engineer(env, [staleTinkering(), ownedCopy(AED_PICK, 'ownedAedPick0001')]);
		const result = await globalThis.blueCodex.refreshClassContent(actor);

		expect(env.dialogs.log).toEqual([]);
		expect(result.errors).toEqual([]);
		const tinkering = actor.items.get('ownedTinker00001');
		expect(tinkering._source.system.rules.map((rule) => rule.type)).toEqual(['chargePool', 'chargeConsumer']);
		expect(tinkering._source.flags.nimble.chargePools).toEqual({ 'tinkering-uses': { current: 1 } });
		expect(tinkering._source.flags['other-module']).toEqual({ x: 1 });
		expect(sources(actor)).toContain(AED_ITEM);
		expect(result.updated).toBe(1);
		expect(result.added).toContain('AED');

		const [toast] = env.notifications.messages('info').filter((m) => /refreshed class content/.test(m));
		expect(toast).toMatch(/^Blue's Codex refreshed class content on 1 character: 1 updated, \d+ added\.$/);
		const card = lastCard(env);
		expect(card.content).toMatch(/Updated <strong>Tinkering<\/strong>/);
		expect(card.content).toMatch(/Added <strong>AED<\/strong>/);
		expect(card.whisper).toEqual(expect.arrayContaining([GM_ID, PLAYER_ID]));

		// Idempotent: a second run finds nothing.
		const again = await globalThis.blueCodex.refreshClassContent(actor);
		expect(again.updated).toBe(0);
		expect(env.notifications.messages('info').at(-1)).toBe("Blue's Codex | Gizmo's class content is up to date.");
	});

	it('a dry run posts the card and writes nothing', async () => {
		const { env } = await setupWorld();
		const actor = engineer(env, [staleTinkering()]);
		const plan = await globalThis.blueCodex.refreshClassContent(actor, { dryRun: true });
		expect(plan.updates).toHaveLength(1);
		expect(actor.items.get('ownedTinker00001')._source.system.rules).toEqual([]);
		expect(env.dialogs.log).toEqual([]);
		expect(lastCard(env).content).toMatch(/dry run/);
		expect(lastCard(env).content).toMatch(/Would update <strong>Tinkering<\/strong>/);
		expect(env.notifications.messages('info').at(-1)).toMatch(/dry run, nothing written/);
	});

	it('the sheet header entry applies without a dialog', async () => {
		const { env } = await setupWorld();
		const actor = engineer(env, [staleTinkering()]);
		const controls = [];
		env.Hooks.callAll('getHeaderControlsPlayerCharacterSheet', { actor }, controls);
		const entry = controls.find((control) => control.action === 'bcxRefreshClassContent');
		expect(entry).toBeTruthy();
		entry.onClick();
		await env.flush();
		expect(env.dialogs.log).toEqual([]);
		expect(actor.items.get('ownedTinker00001')._source.system.rules).toHaveLength(2);
	});

	it('a player refreshes their own character, but not someone else’s', async () => {
		const { env } = await setupWorld({ isGM: false });
		const mine = engineer(env, [staleTinkering()]);
		await globalThis.blueCodex.refreshClassContent(mine);
		expect(mine.items.get('ownedTinker00001')._source.system.rules).toHaveLength(2);
		expect(lastCard(env).whisper).toEqual(expect.arrayContaining([GM_ID, PLAYER_ID]));

		const theirs = engineer(env, [staleTinkering()], { name: 'Other', ownership: {} });
		expect(await globalThis.blueCodex.refreshClassContent(theirs)).toBeNull();
		expect(theirs.items.get('ownedTinker00001')._source.system.rules).toEqual([]);
		expect(env.notifications.messages('warn').at(-1)).toMatch(/You don't own Other/);
	});

	it('an error is caught and reported in the toast and the card', async () => {
		const { env } = await setupWorld();
		const actor = engineer(env, [staleTinkering()]);
		actor.updateEmbeddedDocuments = async () => {
			throw new Error('boom');
		};
		const result = await globalThis.blueCodex.refreshClassContent(actor);
		expect(result.errors).toHaveLength(1);
		expect(env.notifications.messages('warn').at(-1)).toMatch(/1 problem — see the chat card/);
		expect(lastCard(env).content).toMatch(/<strong>Failed:<\/strong> Updating 1 item \(Tinkering\): boom/);
	});

	it('lists a Shepherd’s spirit removal in the card (no confirm)', async () => {
		const { env } = await setupWorld();
		const actor = shepherd02(env);
		await globalThis.blueCodex.refreshClassContent(actor);
		expect(env.dialogs.log).toEqual([]);
		expect(sources(actor)).not.toContain(SPIRIT_T1);
		expect(sources(actor)).toContain(SPIRIT_02);
		expect(lastCard(env).content).toMatch(/Replaced <s>Summon Lifebinding Spirit<\/s> \(removed\)/);
		expect(lastCard(env).content).toMatch(/Mend counter/);
		expect(actor.flags.nimble.chargePools).toEqual({ lifebindingMend: { current: 2 } });
		expect(actor.items.get('myBuddyFeature01')._source.flags.nimble.chargePools).toEqual({
			lifebindingMend: { current: 2 },
		});
	});
});

describe('startup pass (version gate, acting GM)', () => {
	it('runs after the content sync, applies, toasts, cards and stamps the version', async () => {
		const { main, env } = await setupWorld({ boot: false });
		const actor = engineer(env, [staleTinkering()]);
		const order = [];
		const create = env.ChatMessage.create;
		env.ChatMessage.create = async (data) => {
			order.push(data.content);
			return create(data);
		};
		await env.boot();
		await main.__contentSync__.startup();
		expect(await main.__classRefresh__.startup()).toBe('applied');

		expect(env.dialogs.log).toEqual([]);
		expect(actor.items.get('ownedTinker00001')._source.system.rules).toHaveLength(2);
		expect(env.game.settings.get(MODULE_ID, 'classContentRefreshVersion')).toBe(
			env.game.modules.get(MODULE_ID).version,
		);
		expect(env.notifications.messages('info')).toContain(
			"Blue's Codex refreshed class content on 1 character: 1 updated, 0 added.",
		);
		expect(order.at(-1)).toMatch(/class content refreshed/);
		expect(order.at(-1)).not.toMatch(/<button/);

		// Same version: skipped, even if something went stale again.
		await actor.updateEmbeddedDocuments('Item', [{ _id: 'ownedTinker00001', 'system.rules': [] }]);
		expect(await main.__classRefresh__.runClassContentRefreshStartup()).toBe('skipped');
		expect(actor.items.get('ownedTinker00001')._source.system.rules).toEqual([]);

		// A new version runs it again.
		await env.game.settings.set(MODULE_ID, 'classContentRefreshVersion', '0.0.1');
		expect(await main.__classRefresh__.runClassContentRefreshStartup()).toBe('applied');
		expect(actor.items.get('ownedTinker00001')._source.system.rules).toHaveLength(2);
	});

	it('stamps the version when nothing is stale', async () => {
		const { main, env } = await setupWorld({ boot: false });
		engineer(env, [ownedCopy(TINKERING, 'ownedTinker00001')]);
		await env.boot();
		expect(await main.__classRefresh__.startup()).toBe('nothing');
		expect(env.game.settings.get(MODULE_ID, 'classContentRefreshVersion')).toBe(
			env.game.modules.get(MODULE_ID).version,
		);
	});

	it('converts a Shepherd’s spirit and lists the removal', async () => {
		const { main, env } = await setupWorld({ boot: false });
		const actor = shepherd02(env);
		await env.boot();
		expect(await main.__classRefresh__.startup()).toBe('applied');
		expect(sources(actor)).toEqual(expect.arrayContaining([SPIRIT_02]));
		expect(sources(actor)).not.toContain(SPIRIT_T1);
		expect(lastCard(env).content).toMatch(/Lifebinding Spirit: Replaced <s>Summon Lifebinding Spirit<\/s>/);
		expect(actor.flags.nimble.chargePools).toEqual({ lifebindingMend: { current: 2 } });
	});

	it('a failure leaves the version unstamped and is reported', async () => {
		const { main, env } = await setupWorld({ boot: false });
		const actor = engineer(env, [staleTinkering()]);
		actor.updateEmbeddedDocuments = async () => {
			throw new Error('db down');
		};
		await env.boot();
		expect(await main.__classRefresh__.startup()).toBe('failed');
		expect(env.game.settings.get(MODULE_ID, 'classContentRefreshVersion')).toBe('');
		expect(env.notifications.messages('warn').at(-1)).toMatch(/1 problem/);
		expect(lastCard(env).content).toMatch(/db down/);
	});

	it('does not run for a player', async () => {
		const { main, env } = await setupWorld({ boot: false, isGM: false });
		const actor = engineer(env, [staleTinkering()]);
		await env.boot();
		expect(main.__classRefresh__.startup()).toBeNull();
		expect(await main.__classRefresh__.runClassContentRefreshStartup()).toBe('skipped');
		expect(actor.items.get('ownedTinker00001')._source.system.rules).toEqual([]);
	});
});

describe('Lifebinding Spirit live conversion', () => {
	it('converts automatically on the acting GM (debounced), toasts, cards, and does not retrigger', async () => {
		const { main, env } = await setupWorld();
		// A 2.0.3 Shepherd whose class migration (Nim+) swaps My Buddy! in: the check is scheduled.
		const actor = shepherd02(env, { withBuddy: false });
		await actor.createEmbeddedDocuments('Item', [myBuddy()]);
		expect(main.__classRefresh__.pendingSpiritChecks()).toBe(1);
		const cardsBefore = env.ChatMessage.created.length;
		await wait(main.__classRefresh__.SPIRIT_CHECK_DELAY_MS + 100);
		await env.flush();

		expect(env.dialogs.log).toEqual([]);
		expect(sources(actor)).toContain(SPIRIT_02);
		expect(sources(actor)).not.toContain(SPIRIT_T1);
		expect(env.notifications.messages('info').at(-1)).toMatch(/converted Wren's Lifebinding Spirit/);
		expect(env.ChatMessage.created).toHaveLength(cardsBefore + 1);
		const card = lastCard(env);
		expect(card.content).toMatch(/Removed <s>Summon Lifebinding Spirit<\/s>|Replaced <s>Summon Lifebinding Spirit<\/s>/);
		expect(card.content).not.toMatch(/<button/);
		expect(card.whisper).toEqual([GM_ID]);
		// The Mend counter is untouched.
		expect(actor.flags.nimble.chargePools).toEqual({ lifebindingMend: { current: 2 } });

		// Its own create/update/delete did not schedule another check.
		expect(main.__classRefresh__.pendingSpiritChecks()).toBe(0);
		await wait(main.__classRefresh__.SPIRIT_CHECK_DELAY_MS + 100);
		await env.flush();
		expect(env.ChatMessage.created).toHaveLength(cardsBefore + 1);
		// Idempotent.
		expect(await main.__classRefresh__.runSpiritConversionCheck(actor)).toBe('nothing');
	});

	it('never re-applies the same failed plan (loop guard)', async () => {
		const { main, env } = await setupWorld();
		const actor = shepherd02(env);
		const create = actor.createEmbeddedDocuments.bind(actor);
		actor.createEmbeddedDocuments = async (name, data, options) =>
			data.some((d) => d._stats?.compendiumSource === SPIRIT_02) ? [] : create(name, data, options);

		expect(await main.__classRefresh__.runSpiritConversionCheck(actor)).toBe('failed');
		expect(sources(actor)).toContain(SPIRIT_T1); // create failed → old spell kept
		expect(env.notifications.messages('warn').at(-1)).toMatch(/Lifebinding Spirit conversion had 1 problem/);
		expect(lastCard(env).content).toMatch(/could not be created — Summon Lifebinding Spirit kept/);
		const cards = env.ChatMessage.created.length;

		expect(await main.__classRefresh__.runSpiritConversionCheck(actor)).toBe('repeat');
		expect(env.ChatMessage.created).toHaveLength(cards);
	});

	it('does nothing on a player client', async () => {
		const { main, env } = await setupWorld({ isGM: false });
		const actor = shepherd02(env);
		main.__classRefresh__.scheduleSpiritConversionCheck(actor);
		expect(main.__classRefresh__.pendingSpiritChecks()).toBe(0);
		expect(await main.__classRefresh__.runSpiritConversionCheck(actor)).toBe('skipped');
		expect(sources(actor)).toContain(SPIRIT_T1);
		expect(env.ChatMessage.created).toHaveLength(0);
	});
});

describe('legacy cards', () => {
	it('strips the inert Refresh / Review & convert buttons from pre-0.9.0 cards', async () => {
		const { env } = await setupWorld();
		const removed = [];
		const button = { remove: () => removed.push(true) };
		const html = { querySelectorAll: (selector) => (selector === '[data-bcx-refresh-actor]' ? [button] : []) };
		env.Hooks.callAll('renderChatMessageHTML', { flags: { [MODULE_ID]: { classRefreshNotice: true } } }, html);
		expect(removed).toHaveLength(1);
	});
});
