/**
 * Codex content sync (scripts/main.mjs, "Codex content sync" section): owned
 * copies of Codex spells are brought in line with the packs — in place, no
 * dialog — automatically once per module version on `ready`, and on demand from
 * blueCodex.syncCodexContent / refreshClassContent.
 *
 * The fixture is the user's report: a Summon Shadow copy owned before the Nimble
 * 0.2 rewrite (old text with "+1 Reach every 5 levels", old summon automation
 * maxCount minIntOrLevel + reachPerLevels 5, no spawnCount).
 */
import { describe, expect, it } from 'vitest';
import { adoptActor, findDoc, setupWorld } from '../harness/index.mjs';

const MODULE_ID = 'blue-codex-package';
const SUMMON_SHADOW = 'Compendium.blue-codex-package.blue-codex-spells.Item.nrDkGygSyNE6JR7n';
const OLD_BASE_EFFECT =
	'<p><strong>Cantrip · 1 Action.</strong></p><p>Summon a Shadow minion (max INT or LVL).</p>' +
	'<p><strong>High Levels:</strong> +1 Reach every 5 levels.</p>';
const OLD_SUMMON = {
	template: 'shadow-minion',
	combatOnly: true,
	expireOnCombatEnd: true,
	maxCount: 'minIntOrLevel',
	reachPerLevels: 5,
	featureBoosts: [{ name: 'Shadow Magus', reachBonus: 4, formulaOverride: '1d10' }],
};

function packSummonShadow() {
	const hit = findDoc({ pkg: MODULE_ID, type: 'spell', name: 'Summon Shadow' });
	expect(hit.uuid).toBe(SUMMON_SHADOW);
	return hit.doc;
}

/** An owned Summon Shadow copy from before the 0.2 rewrite, with actor state on it. */
function legacySummonShadow() {
	const data = structuredClone(packSummonShadow());
	data._id = 'ownedShadow00001';
	data.system.description.baseEffect = OLD_BASE_EFFECT;
	data.system.grantedById = 'grantingFeat0001';
	data.flags = {
		[MODULE_ID]: { automation: { summon: structuredClone(OLD_SUMMON) }, playerNote: 'keep me' },
		nimble: { chargePools: { shadows: { current: 2 } } },
		'other-module': { tag: 'x' },
	};
	data._stats = { ...(data._stats ?? {}), compendiumSource: SUMMON_SHADOW };
	return data;
}

/** A fresh, current copy of `name` from the Codex spells pack. */
function currentCopy(name, id) {
	const hit = findDoc({ pkg: MODULE_ID, type: 'spell', name });
	const data = structuredClone(hit.doc);
	data._id = id;
	data._stats = { ...(data._stats ?? {}), compendiumSource: hit.uuid };
	return data;
}

function shadowmancer(env, items, name = 'Nyx') {
	return adoptActor(env, { _id: undefined, name, type: 'character', system: {}, flags: {}, items });
}

describe('planning', () => {
	it('lists what differs on a stale copy and nothing on a current one', async () => {
		const { main, env } = await setupWorld();
		const actor = shadowmancer(env, [legacySummonShadow(), currentCopy('Shadow Blast', 'ownedBlast000001')]);
		const plan = await main.__contentSync__.planCodexContentSync(actor);
		expect(plan.missing).toEqual([]);
		expect(plan.updates).toHaveLength(1);
		const [entry] = plan.updates;
		expect(entry.itemId).toBe('ownedShadow00001');
		expect(entry.changed).toEqual(['description', 'summon automation']);
		expect(entry.changed).not.toContain('name');
		expect(entry.changed).not.toContain('grantedById');
	});

	it('reports (and leaves alone) a copy whose pack entry is gone', async () => {
		const { main, env } = await setupWorld();
		const gone = currentCopy('Shadow Blast', 'ownedGone0000001');
		gone._stats.compendiumSource = 'Compendium.blue-codex-package.blue-codex-spells.Item.AAAAAAAAAAAAAAAA';
		gone.system.description.baseEffect = '<p>homebrew</p>';
		const actor = shadowmancer(env, [gone]);
		const result = await main.__contentSync__.syncCodexContent({ actors: [actor] });
		expect(result.status).toBe('nothing');
		expect(result.missing).toEqual(['Shadow Blast (Nyx)']);
		expect(actor.items.get('ownedGone0000001').system.description.baseEffect).toBe('<p>homebrew</p>');
	});

	it('ignores spells from other packs and non-spell items', async () => {
		const { main, env } = await setupWorld();
		const foreign = currentCopy('Shadow Blast', 'ownedForeign0001');
		foreign._stats.compendiumSource = 'Compendium.nimble.nimble-spells.Item.9TNPdOXlCcGgxw6r';
		foreign.system.description.baseEffect = '<p>different</p>';
		const actor = shadowmancer(env, [foreign]);
		const plan = await main.__contentSync__.planCodexContentSync(actor);
		expect(plan.updates).toEqual([]);
		expect(plan.missing).toEqual([]);
	});
});

describe('applying', () => {
	it('rewrites the copy in place: same id, 0.2 text and flags, actor state kept', async () => {
		const { main, env } = await setupWorld();
		const actor = shadowmancer(env, [legacySummonShadow()]);
		const result = await main.__contentSync__.syncCodexContent({ actors: [actor] });
		expect(result.status).toBe('applied');
		expect(result.updated).toBe(1);

		const pack = packSummonShadow();
		const item = actor.items.get('ownedShadow00001');
		expect(actor.items.size).toBe(1);
		expect(item._source.system.description).toEqual(pack.system.description);
		expect(item._source.system.description.baseEffect).not.toMatch(/Reach every 5 levels/);
		// Replaced wholesale — no leftover legacy key merged in.
		expect(item._source.flags[MODULE_ID].automation).toEqual(pack.flags[MODULE_ID].automation);
		expect(item._source.flags[MODULE_ID].automation.summon).not.toHaveProperty('reachPerLevels');
		// Actor state untouched.
		expect(item._source.system.grantedById).toBe('grantingFeat0001');
		expect(item._source.flags[MODULE_ID].playerNote).toBe('keep me');
		expect(item._source.flags.nimble.chargePools).toEqual({ shadows: { current: 2 } });
		expect(item._source.flags['other-module']).toEqual({ tag: 'x' });
		expect(item._source._stats.compendiumSource).toBe(SUMMON_SHADOW);

		// No dialog; a toast + a GM whisper card.
		expect(env.dialogs.log).toEqual([]);
		expect(env.notifications.messages('info')).toContain(
			"Blue's Codex updated 1 item on 1 character (Summon Shadow).",
		);
		expect(env.ChatMessage.created.at(-1).content).toMatch(/Summon Shadow/);

		// Idempotent.
		const again = await main.__contentSync__.syncCodexContent({ actors: [actor], silent: true });
		expect(again.status).toBe('nothing');
	});

	it('a dry run writes nothing', async () => {
		const { main, env } = await setupWorld();
		const actor = shadowmancer(env, [legacySummonShadow()]);
		const result = await main.__contentSync__.syncCodexContent({ actors: [actor], apply: false });
		expect(result.status).toBe('dry-run');
		expect(result.report[0].updates).toHaveLength(1);
		expect(actor.items.get('ownedShadow00001').system.description.baseEffect).toBe(OLD_BASE_EFFECT);
	});

	it('the world-wide macro is GM-only', async () => {
		const { main, env } = await setupWorld({ isGM: false });
		const actor = shadowmancer(env, [legacySummonShadow()]);
		const result = await main.__contentSync__.syncCodexContent({ actors: [actor] });
		expect(result.status).toBe('nothing');
		expect(actor.items.get('ownedShadow00001').system.description.baseEffect).toBe(OLD_BASE_EFFECT);
		expect(env.notifications.messages('warn').some((m) => /Only a GM/.test(m))).toBe(true);
	});

	it('is on the module api as blueCodex.syncCodexContent', async () => {
		const { main } = await setupWorld();
		expect(globalThis.blueCodex.syncCodexContent).toBe(main.__contentSync__.syncCodexContent);
	});
});

describe('startup (version gate)', () => {
	it('applies automatically on ready once per module version', async () => {
		const { main, env } = await setupWorld({ boot: false });
		const actor = shadowmancer(env, [legacySummonShadow()]);
		await env.boot();
		const status = await main.__contentSync__.startup();
		expect(status).toBe('applied');
		expect(env.dialogs.log).toEqual([]);
		const version = env.game.modules.get(MODULE_ID).version;
		expect(env.game.settings.get(MODULE_ID, 'codexContentSyncVersion')).toBe(version);
		expect(actor.items.get('ownedShadow00001')._source.flags[MODULE_ID].automation.summon.maxCount).toBe('intMod');

		// Same version: skipped even if something went stale again.
		await actor.updateEmbeddedDocuments('Item', [
			{ _id: 'ownedShadow00001', 'system.description.baseEffect': OLD_BASE_EFFECT },
		]);
		expect(await main.__contentSync__.runCodexContentSyncStartup()).toBe('skipped');
		expect(actor.items.get('ownedShadow00001').system.description.baseEffect).toBe(OLD_BASE_EFFECT);

		// A new version runs it again.
		await env.game.settings.set(MODULE_ID, 'codexContentSyncVersion', '0.0.1');
		expect(await main.__contentSync__.runCodexContentSyncStartup()).toBe('applied');
		expect(actor.items.get('ownedShadow00001').system.description.baseEffect).not.toMatch(/Reach every 5 levels/);
	});

	it('stamps the version when there is nothing to do', async () => {
		const { main, env } = await setupWorld({ boot: false });
		shadowmancer(env, [currentCopy('Summon Shadow', 'ownedShadow00001')]);
		await env.boot();
		expect(await main.__contentSync__.startup()).toBe('nothing');
		expect(env.game.settings.get(MODULE_ID, 'codexContentSyncVersion')).toBe(env.game.modules.get(MODULE_ID).version);
	});

	it('does not run for a player', async () => {
		const { main, env } = await setupWorld({ boot: false, isGM: false });
		const actor = shadowmancer(env, [legacySummonShadow()]);
		await env.boot();
		expect(main.__contentSync__.startup()).toBeNull();
		expect(await main.__contentSync__.runCodexContentSyncStartup()).toBe('skipped');
		expect(actor.items.get('ownedShadow00001').system.description.baseEffect).toBe(OLD_BASE_EFFECT);
	});
});

describe('Refresh Codex class content (sheet header)', () => {
	it("syncs the actor's spells immediately, without a dialog", async () => {
		const { env } = await setupWorld();
		const actor = shadowmancer(env, [legacySummonShadow()]);
		await globalThis.blueCodex.refreshClassContent(actor);
		expect(env.dialogs.log).toEqual([]);
		expect(actor.items.get('ownedShadow00001')._source.flags[MODULE_ID].automation.summon).not.toHaveProperty(
			'reachPerLevels',
		);
		expect(env.notifications.messages('info')).toContain(
			"Blue's Codex updated 1 item on 1 character (Summon Shadow).",
		);
	});
});
