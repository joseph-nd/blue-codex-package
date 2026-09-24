/**
 * A stand-in for the sibling nim-plus-package at runtime — just the parts
 * blue-codex reads — built from Nim+'s pack JSON (never its scripts):
 *
 *   - `game.modules.get('nim-plus-package')` active, with
 *     `api.supersede.data()` → `{supersedes: Map, playtestOnly: Set}` (the shape
 *     blue-codex's ensureNimPlusEquivalence consumes);
 *   - the world setting `nim-plus-package.playtestCoreClasses`;
 *   - Nim+'s supersede layer reduced to its effect: a `getIndex` wrapper on
 *     CompendiumCollection that deletes the hidden entries (setting on: the
 *     superseded + retired system documents; off: Nim+'s own 0.2 copies) from
 *     every index it returns. Installed BEFORE main.mjs's `ready` patch, as
 *     Nim+ wraps on `init` — so blue-codex's filter runs on top of it.
 *
 * Mount the Nim+ packs themselves with `installPacks(env, { nimPlus: true })`.
 */
import { NIM_PLUS_ID } from './foundry.mjs';
import { nimPlusSupersede } from './packs.mjs';

/**
 * @param {object} env
 * @param {object} [opts]
 * @param {boolean} [opts.playtest=true]   Nim+'s playtestCoreClasses world setting
 * @param {boolean} [opts.api=true]        expose api.supersede.data (false: blue-codex
 *                                         falls back to reading the flag fields itself)
 */
export function installNimPlus(env, { playtest = true, api = true } = {}) {
	const data = nimPlusSupersede();
	env.game.modules.set(NIM_PLUS_ID, {
		id: NIM_PLUS_ID,
		active: true,
		version: '0.0.0-test',
		api: api
			? {
					supersede: {
						data: async () => ({ supersedes: new Map(data.supersedes), playtestOnly: new Set(data.playtestOnly) }),
					},
				}
			: {},
	});
	env.settings.register(NIM_PLUS_ID, 'playtestCoreClasses', { scope: 'world', type: Boolean, default: true });
	env.settings.preset(`${NIM_PLUS_ID}.playtestCoreClasses`, playtest);

	const proto = env.CompendiumCollection.prototype;
	const original = proto.getIndex;
	proto.getIndex = async function nimPlusSupersedeGetIndex(options) {
		const index = await original.call(this, options);
		const enabled = env.settings.get(NIM_PLUS_ID, 'playtestCoreClasses') !== false;
		const hidden = data.hiddenWhen(enabled);
		for (const entry of [...index.values()]) {
			const uuid = `Compendium.${this.collection}.Item.${entry._id}`.replace(/^Compendium\.[^.]+(?=\.nimble-)/, 'Compendium.nimble');
			if (hidden.has(uuid)) index.delete(entry._id);
		}
		return index;
	};
	env.nimPlus = { data, playtest };
	return env.nimPlus;
}
