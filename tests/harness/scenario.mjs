/**
 * One-call world setup for the common case.
 *
 *   const { env, main } = await setupWorld();                   // Codex magic on, booted to `ready`
 *   const { env } = await setupWorld({ nimPlus: true });        // + Nim+ 0.2 copies (playtest on)
 *   const { env } = await setupWorld({ emptyCodexSpells: true });  // the "rebuilt under a live server" world
 *
 * = installFoundry() + installPacks() [+ installNimPlus()] + importScripts('scripts/main.mjs') + boot().
 */
import { importScripts, installFoundry, MODULE_ID } from './foundry.mjs';
import { installPacks } from './packs.mjs';
import { installNimPlus } from './nimplus.mjs';

export const MAIN_SCRIPT = 'scripts/main.mjs';
export const CODEX_SPELLS_PACK = `${MODULE_ID}.blue-codex-spells`;

/**
 * @param {object} [opts]
 * @param {boolean} [opts.replaceSpells=true]   world setting `replaceOfficialSpells` ("Codex is the default magic system")
 * @param {boolean} [opts.nimPlus=false]        mount Nim+'s Item packs + its runtime stand-in (./nimplus.mjs)
 * @param {boolean} [opts.playtest=true]        Nim+'s playtestCoreClasses (only with nimPlus)
 * @param {boolean} [opts.nimPlusApi=true]      expose Nim+'s api.supersede.data (only with nimPlus)
 * @param {boolean} [opts.emptyCodexSpells=false]  mount the Codex spells pack with NO documents
 * @param {boolean} [opts.libWrapper=false]     install the libWrapper mock
 * @param {object} [opts.packs]                 extra options for installPacks (system, module, transform, extra)
 * @param {'init'|'setup'|'ready'|false} [opts.boot='ready']  how far to run the startup hooks
 * @param {boolean} [opts.isGM=true]
 * @param {object} [opts.settings]              extra setting presets ("ns.key" → value)
 * @param {'close'|'throw'} [opts.dialogFallback]
 * @returns {Promise<{env: object, main: object}>}
 */
export async function setupWorld({
	replaceSpells = true,
	nimPlus = false,
	playtest = true,
	nimPlusApi = true,
	emptyCodexSpells = false,
	libWrapper = false,
	packs = {},
	boot = 'ready',
	isGM = true,
	settings = {},
	dialogFallback,
} = {}) {
	const env = installFoundry({
		isGM,
		libWrapper,
		dialogFallback,
		settings: { [`${MODULE_ID}.replaceOfficialSpells`]: replaceSpells, ...settings },
	});
	const userTransform = packs.transform;
	await installPacks(env, {
		nimPlus,
		...packs,
		transform:
			emptyCodexSpells || userTransform
				? (doc, pack) => {
						if (emptyCodexSpells && pack.collection === CODEX_SPELLS_PACK) return null;
						return userTransform ? userTransform(doc, pack) : doc;
					}
				: undefined,
	});
	if (nimPlus) installNimPlus(env, { playtest, api: nimPlusApi });
	const main = await importScripts(MAIN_SCRIPT);
	if (boot) await env.boot({ until: boot });
	return { env, main };
}

/**
 * Bring an actor's persisted data into (another) world — e.g. "reload Foundry"
 * after a setting change or a pack rebuild: `adoptActor(newEnv, oldActor.toObject())`.
 * The actor keeps its id, items, flags and history.
 */
export function adoptActor(env, data) {
	const actor = new env.classes.Character(structuredClone(data));
	env.game.actors.set(actor.id, actor);
	return actor;
}
