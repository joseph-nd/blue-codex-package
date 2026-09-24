/**
 * Blue Codex Package — runtime entry point.
 *
 * Exposes a module API that feature macros (the `system.macro` field on
 * Nimble items) can call, mirroring the pattern established by
 * nim-plus-package:
 *
 *   game.modules.get('blue-codex-package').api.someHelper(actor, item, opts)
 *   blueCodex.someHelper(actor, item, opts)   // shortcut alias
 *
 * Content automation (class features, turret/companion handling, etc.) is
 * added here as the compendium content is authored.
 */

const MODULE_ID = 'blue-codex-package';

// ── Resource undo cards ──────────────────────────────────────────────────────
// Players misclick. Every resource the MODULE spends or grants (Toolbelt scrap,
// once-per-rest uses, free deploys, …) lives in a native Nimble charge pool — so
// the sheet's charge indicator shows it and its dialog corrects it by hand — and
// every module-side spend/grant posts a chat card carrying an Undo button.
//
// Usage (any section of this file, or a feature macro via the module api):
//
//   // Deduct 1 from the actor-scoped Toolbelt pool. Returns false (and warns)
//   // when the pool is missing or short; nothing is spent then.
//   await spendPoolWithUndo(actor, 'toolbelt', 1, { label: 'Toolbelt scrap', reason: 'Turret Deployed!' });
//   // Item-scoped pool (e.g. identifier `uses` on one specific feature):
//   await spendPoolWithUndo(actor, 'uses', 1, { item, label: 'Optimized Activation' });
//   await grantPoolWithUndo(actor, 'toolbelt', 1, { reason: 'Tool Wrench recall' });
//
//   // Any other reversible action: register a handler ONCE (top level), then post.
//   registerUndoHandler('restoreMark', async (data, { message, user }) => {
//     …; return 'Mark restored.'; // string = note shown on the card; false = failed
//   });
//   await postUndoCard({ actor, text: '<p>…</p>', undoAction: { type: 'restoreMark', data: { … } } });
//
// Undo handlers receive only the serialisable `data` stored on the card and run
// on a client that can write: the GM runs them directly; a player's click is
// relayed to the active GM (runAsGM — a hidden whispered relay message, since the
// manifest declares no socket). A card undoes at most once (flag `undo.done`) and
// only the GM or an owner of the card's `actor` sees the button.
const UNDO_FLAG = 'undo';
const GM_RELAY_FLAG = 'gmRelay';
const UNDO_HANDLERS = new Map();
const GM_RELAY_OPS = new Map();
const UNDO_IN_FLIGHT = new Set();

function chargePoolScope() {
	return game.system?.id ?? 'nimble';
}

// Register the function that reverts an undo card of `type`. It receives
// (data, { message, user }) and returns a note string, true, or false (= failed,
// card stays undoable).
function registerUndoHandler(type, handler) {
	if (typeof type === 'string' && typeof handler === 'function') UNDO_HANDLERS.set(type, handler);
}

// Register an operation a player may ask the active GM to run on their behalf.
function registerGMRelayOp(op, handler) {
	if (typeof op === 'string' && typeof handler === 'function') GM_RELAY_OPS.set(op, handler);
}

// Run a registered relay op with GM authority: directly when this client is a GM
// (or no GM is online — best effort), otherwise via a hidden whispered message the
// active GM's client executes and deletes. Fire-and-forget on the relay path
// (resolves undefined); resolves the op's own result on the direct path.
async function runAsGM(op, payload = {}) {
	const handler = GM_RELAY_OPS.get(op);
	if (!handler) throw new Error(`[${MODULE_ID}] unknown GM relay op "${op}"`);
	const activeGM = game.users?.activeGM ?? null;
	if (game.user?.isGM || !activeGM) return handler(payload, { user: game.user });
	const whisper = (game.users?.filter?.((u) => u.isGM) ?? []).map((u) => u.id);
	await ChatMessage.create({
		content: '<p><em>Blue Codex: relaying an action to the GM…</em></p>',
		whisper,
		flags: { [MODULE_ID]: { [GM_RELAY_FLAG]: { op, payload } } },
	});
	return undefined;
}

// Relay permission checks: a relayed op runs with GM authority, so each op
// verifies the requesting `user` may act for the document it touches — the GM,
// an owner of the actor, or an owner of a summon (turret / minion token) that
// this actor deployed (the summon's player drives its actions).
function userOwnsSummonOf(user, actor) {
	if (!user || !actor?.uuid) return false;
	for (const scene of game.scenes ?? []) {
		for (const tokenDoc of scene.tokens ?? []) {
			if (getTokenSummonFlag(tokenDoc)?.summonerActorUuid !== actor.uuid) continue;
			if (tokenDoc.actor?.testUserPermission?.(user, 'OWNER')) return true;
		}
	}
	return false;
}

function userMayActFor(user, actor) {
	if (!user || !actor) return false;
	if (user.isGM) return true;
	if (actor.testUserPermission?.(user, 'OWNER')) return true;
	return userOwnsSummonOf(user, actor);
}

// A summoned token may be driven by an owner of its own actor or of its summoner.
function userMayActForSummon(user, tokenDoc) {
	if (!user || !tokenDoc) return false;
	if (user.isGM) return true;
	if (tokenDoc.actor?.testUserPermission?.(user, 'OWNER')) return true;
	const summoner = resolveSummonerFromToken(tokenDoc);
	return !!summoner && summoner.testUserPermission?.(user, 'OWNER');
}

function relayDenied(op, user, what) {
	console.warn(`[${MODULE_ID}] GM relay "${op}" refused: ${user?.name ?? 'unknown user'} may not act for ${what}.`);
	return false;
}

// The active GM executes relay messages, then deletes them.
Hooks.on('createChatMessage', (message) => {
	const relay = message?.flags?.[MODULE_ID]?.[GM_RELAY_FLAG];
	if (!relay || !isActingGM()) return;
	void (async () => {
		try {
			const handler = GM_RELAY_OPS.get(relay.op);
			if (handler) await handler(relay.payload ?? {}, { user: message.author ?? null });
			else console.warn(`[${MODULE_ID}] unknown GM relay op "${relay.op}"`);
		} catch (error) {
			console.error(`[${MODULE_ID}] GM relay op "${relay.op}" failed`, error);
		} finally {
			try {
				await message.delete();
			} catch {
				/* already gone */
			}
		}
	})();
});

// Resolve a charge pool to { document, key, identifier, label, current, max }.
// `poolKey` is the pool identifier ('toolbelt') or its actor-scoped storage key
// ('actor:toolbelt'). With `item` (Item or id) the item-scoped pool of that item
// is read; otherwise the actor-scoped pool wins, then the first owned item that
// stores a pool under that identifier. Storage mirrors Nimble's
// src/utils/chargePool/helpers.ts: actor pools at
// actor.flags.<sys>.chargePools["actor:<id>"], item pools at
// item.flags.<sys>.chargePools["<id>"].
function getChargePoolEntry(actor, poolKey, { item } = {}) {
	if (!actor || typeof poolKey !== 'string' || !poolKey) return null;
	const scope = chargePoolScope();
	const identifier = poolKey.startsWith('actor:') ? poolKey.slice(6) : poolKey;
	const build = (document, key, raw, fallbackLabel) => {
		if (!raw || typeof raw !== 'object') return null;
		const max = Math.max(0, Math.floor(Number(raw.max) || 0));
		const current = Math.max(0, Math.min(Math.floor(Number(raw.current) || 0), max));
		return { document, key, identifier, label: raw.label || fallbackLabel || identifier, current, max };
	};
	const itemPool = (it) => build(it, identifier, it?.flags?.[scope]?.chargePools?.[identifier], it?.name);
	if (item) {
		const owned = typeof item === 'string' ? actor.items?.get?.(item) : item;
		return owned ? itemPool(owned) : null;
	}
	const actorKey = `actor:${identifier}`;
	const actorEntry = build(actor, actorKey, actor.flags?.[scope]?.chargePools?.[actorKey], identifier);
	if (actorEntry || poolKey.startsWith('actor:')) return actorEntry;
	for (const it of actor.items ?? []) {
		const entry = itemPool(it);
		if (entry) return entry;
	}
	return null;
}

// Write a pool's `current` (clamped to [0, max]) into the same flag storage the
// sheet's ChargeIndicator reads. Returns the value actually written.
async function setChargePoolCurrent(entry, next) {
	const clamped = Math.max(0, Math.min(Math.round(Number(next) || 0), entry.max));
	if (clamped !== entry.current) {
		await entry.document.update({
			flags: { [chargePoolScope()]: { chargePools: { [entry.key]: { current: clamped } } } },
		});
	}
	return clamped;
}

function resolveActorByUuid(uuid) {
	try {
		const doc = uuid ? fromUuidSync(uuid) : null;
		if (doc instanceof Actor) return doc;
		return doc?.actor instanceof Actor ? doc.actor : null;
	} catch {
		return null;
	}
}

// Post a chat card whose Undo button runs `undoAction.type`'s registered handler
// with `undoAction.data`. `text` is trusted HTML (escape interpolated names).
async function postUndoCard({ actor, text, undoAction, flavor } = {}) {
	try {
		const data = {
			content: `<div class="bcx-undo-card">${text ?? ''}<button type="button" class="bcx-undo-button" data-bcx-undo><i class="fa-solid fa-rotate-left"></i> Undo</button></div>`,
			flags: {
				[MODULE_ID]: {
					[UNDO_FLAG]: {
						type: undoAction?.type ?? '',
						data: undoAction?.data ?? {},
						actorUuid: actor?.uuid ?? null,
						done: false,
					},
				},
			},
		};
		if (actor) data.speaker = ChatMessage.getSpeaker({ actor });
		if (flavor) data.flavor = `<strong>${escapeHtml(flavor)}</strong>`;
		return await ChatMessage.create(data);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Could not post undo card`, error);
		return null;
	}
}

// Run a card's undo once. Called on a writer client (GM, or best effort when no
// GM is online). `user` is the clicker, for the permission check and the note.
async function performUndo(messageId, user) {
	const message = game.messages?.get(messageId);
	const undo = message?.flags?.[MODULE_ID]?.[UNDO_FLAG];
	if (!undo || undo.done || UNDO_IN_FLIGHT.has(messageId)) return false;
	const actor = resolveActorByUuid(undo.actorUuid);
	if (user && !user.isGM && actor && !actor.testUserPermission(user, 'OWNER')) {
		console.warn(`[${MODULE_ID}] ${user.name} may not undo "${undo.type}" for ${actor.name}.`);
		return false;
	}
	const handler = UNDO_HANDLERS.get(undo.type);
	if (!handler) {
		ui.notifications?.warn(`Blue Codex: no undo handler for "${undo.type}".`);
		return false;
	}
	UNDO_IN_FLIGHT.add(messageId);
	try {
		const result = await handler(undo.data ?? {}, { message, user });
		if (result === false) {
			ui.notifications?.warn('Blue Codex: the undo could not be applied — fix it by hand on the sheet.');
			return false;
		}
		await message.update({
			[`flags.${MODULE_ID}.${UNDO_FLAG}.done`]: true,
			[`flags.${MODULE_ID}.${UNDO_FLAG}.undoneBy`]: user?.name ?? game.user?.name ?? '',
			[`flags.${MODULE_ID}.${UNDO_FLAG}.note`]: typeof result === 'string' ? result : '',
		});
		return true;
	} catch (error) {
		console.error(`[${MODULE_ID}] undo "${undo.type}" failed`, error);
		return false;
	} finally {
		UNDO_IN_FLIGHT.delete(messageId);
	}
}

registerGMRelayOp('undo', ({ messageId }, { user }) => performUndo(messageId, user));

// Deduct `amount` from a pool and post an undo card. False (+ warning) when the
// pool is missing or holds less than `amount`; nothing is spent then. When this
// client cannot write the pool's document, the whole spend (and its card) is
// relayed to the GM after the local sufficiency check. Opts: { label, reason,
// item, flavor }.
async function spendPoolWithUndo(actor, poolKey, amount = 1, { label, reason, item, flavor } = {}) {
	const entry = getChargePoolEntry(actor, poolKey, { item });
	const name = label ?? entry?.label ?? poolKey;
	if (!entry) {
		ui.notifications?.warn(`${actor?.name ?? 'Actor'} has no "${name}" counter on the sheet — adjust it by hand.`);
		return false;
	}
	const cost = Math.max(0, Math.floor(Number(amount) || 0));
	if (entry.current < cost) {
		ui.notifications?.warn(
			`${actor.name} has only ${entry.current} ${name} left (needs ${cost}). If that is wrong, click the counter on the sheet to fix it.`,
		);
		return false;
	}
	if (!entry.document.isOwner && !game.user?.isGM) {
		await runAsGM('spendPoolWithUndo', {
			actorUuid: actor.uuid,
			poolKey,
			itemId: entry.document === actor ? null : entry.document.id,
			amount: cost,
			label,
			reason,
			flavor,
		});
		return true;
	}
	const after = await setChargePoolCurrent(entry, entry.current - cost);
	await postUndoCard({
		actor,
		flavor,
		text: `<p>${escapeHtml(actor.name)} spent <strong>${cost} ${escapeHtml(name)}</strong>${reason ? ` (${escapeHtml(reason)})` : ''}. Remaining: <strong>${after}/${entry.max}</strong>.</p>`,
		undoAction: {
			type: 'poolDelta',
			data: {
				actorUuid: actor.uuid,
				poolKey,
				itemId: entry.document === actor ? null : entry.document.id,
				delta: entry.current - after,
				label: name,
			},
		},
	});
	return true;
}

// Add `amount` to a pool (clamped to max) and post an undo card. False (+ note)
// when the pool is missing or already full. Same opts/relay as spendPoolWithUndo.
async function grantPoolWithUndo(actor, poolKey, amount = 1, { label, reason, item, flavor } = {}) {
	const entry = getChargePoolEntry(actor, poolKey, { item });
	const name = label ?? entry?.label ?? poolKey;
	if (!entry) {
		ui.notifications?.warn(`${actor?.name ?? 'Actor'} has no "${name}" counter on the sheet — adjust it by hand.`);
		return false;
	}
	if (entry.current >= entry.max) {
		ui.notifications?.info(`${actor.name}'s ${name} is already full (${entry.current}/${entry.max}).`);
		return false;
	}
	if (!entry.document.isOwner && !game.user?.isGM) {
		await runAsGM('grantPoolWithUndo', {
			actorUuid: actor.uuid,
			poolKey,
			itemId: entry.document === actor ? null : entry.document.id,
			amount,
			label,
			reason,
			flavor,
		});
		return true;
	}
	const after = await setChargePoolCurrent(entry, entry.current + Math.max(0, Math.floor(Number(amount) || 0)));
	await postUndoCard({
		actor,
		flavor,
		text: `<p>${escapeHtml(actor.name)} regained <strong>${after - entry.current} ${escapeHtml(name)}</strong>${reason ? ` (${escapeHtml(reason)})` : ''}. Now: <strong>${after}/${entry.max}</strong>.</p>`,
		undoAction: {
			type: 'poolDelta',
			data: {
				actorUuid: actor.uuid,
				poolKey,
				itemId: entry.document === actor ? null : entry.document.id,
				delta: entry.current - after,
				label: name,
			},
		},
	});
	return true;
}

registerGMRelayOp('spendPoolWithUndo', ({ actorUuid, poolKey, itemId, amount, label, reason, flavor }, { user } = {}) => {
	const actor = resolveActorByUuid(actorUuid);
	if (!userMayActFor(user, actor)) return relayDenied('spendPoolWithUndo', user, actor?.name ?? actorUuid);
	return spendPoolWithUndo(actor, poolKey, amount, { item: itemId ?? undefined, label, reason, flavor });
});
registerGMRelayOp('grantPoolWithUndo', ({ actorUuid, poolKey, itemId, amount, label, reason, flavor }, { user } = {}) => {
	const actor = resolveActorByUuid(actorUuid);
	if (!userMayActFor(user, actor)) return relayDenied('grantPoolWithUndo', user, actor?.name ?? actorUuid);
	return grantPoolWithUndo(actor, poolKey, amount, { item: itemId ?? undefined, label, reason, flavor });
});

// Undo of a pool spend/grant: apply `delta` back (clamped to the pool bounds).
registerUndoHandler('poolDelta', async ({ actorUuid, poolKey, itemId, delta, label }) => {
	const actor = resolveActorByUuid(actorUuid);
	const entry = getChargePoolEntry(actor, poolKey, { item: itemId ?? undefined });
	if (!entry) return false;
	const after = await setChargePoolCurrent(entry, entry.current + (Number(delta) || 0));
	return `${label ?? entry.label}: ${entry.current} → ${after}.`;
});

// Wire the Undo buttons; hide relay messages; show "Undone by …" once used.
Hooks.on('renderChatMessageHTML', (message, html) => {
	try {
		const flags = message?.flags?.[MODULE_ID];
		if (flags?.[GM_RELAY_FLAG]) {
			html.style.display = 'none';
			return;
		}
		const undo = flags?.[UNDO_FLAG];
		const button = undo ? html.querySelector?.('[data-bcx-undo]') : null;
		if (!button) return;
		if (undo.done) {
			const note = document.createElement('p');
			note.className = 'bcx-undo-done';
			note.innerHTML = `<em>Undone by ${escapeHtml(undo.undoneBy || 'someone')}.${undo.note ? ` ${escapeHtml(undo.note)}` : ''}</em>`;
			button.replaceWith(note);
			return;
		}
		const actor = resolveActorByUuid(undo.actorUuid);
		if (!game.user?.isGM && !actor?.isOwner) {
			button.remove();
			return;
		}
		button.addEventListener('click', (event) => {
			event.preventDefault();
			button.disabled = true;
			void runAsGM('undo', { messageId: message.id }).catch((error) =>
				console.error(`[${MODULE_ID}] undo request failed`, error),
			);
		});
	} catch (error) {
		console.warn(`[${MODULE_ID}] Could not wire undo card`, error);
	}
});

Hooks.once('ready', () => {
	Object.assign(api, {
		spendPoolWithUndo,
		grantPoolWithUndo,
		postUndoCard,
		registerUndoHandler,
		registerGMRelayOp,
		runAsGM,
		getChargePoolEntry,
	});
});

// ── Default magic system ─────────────────────────────────────────────────────
// Blue's Codex re-authors (and rebalances) the whole spell list. When a
// spellcasting class levels up, Nimble's `grantSpells` rules grant *every*
// spell of the granted school/tier found in the spell index — and that index
// (`buildSpellIndex`, an un-patchable bundle-local) scans EVERY Item compendium.
// With this module installed, that means the character receives both the
// official `nimble.nimble-spells` version and our Codex version of each spell.
//
// To make the Codex the default magic system we suppress the official spells at
// the point they would enter a character — but ONLY where the Codex actually
// provides a replacement for that (school, tier). Official schools the Codex
// does not re-author (notably `necrotic`, which the Codex splits into
// shadow/death/blood/curse) are left untouched so casters of those schools are
// never left with zero spells until the Codex classes are authored.
//
// Two coordinated layers, both gated by the `replaceOfficialSpells` setting:
//   1. `CompendiumCollection#getIndex` — filter the official spell packs out of
//      the *grant* index (character creation + level-up) so official spells
//      never appear in the level-up preview or selection lists. The grant path
//      is told apart from the compendium browser by its index-field signature
//      (grant requests `system.classes` and omits `name`; the browser is the
//      reverse), so the official spell *browser* is left fully intact.
//   2. `preCreateItem` — a safety net: block any official-pack spell from being
//      created on a character when the Codex covers its school/tier, in case a
//      future system update changes the grant path's field signature.
const SETTING_REPLACE_SPELLS = 'replaceOfficialSpells';
const OFFICIAL_SPELL_PACKS = new Set(['nimble.nimble-spells', 'nimble.nimble-secret-spells']);
const CODEX_SPELLS_PACK = `${MODULE_ID}.blue-codex-spells`;

// Set (to `{ actorId, subclassId }`) only while a character's native level-up
// dialog is open — see wrapTriggerLevelUp. Lets the class-feature index patch
// scope its subclass-pool injection to the character actually leveling up.
let levelUpContext = null;

/** Set of `${school}:${tier}` the Codex spell pack can grant (non-secret). */
let codexCoverageSet = null;
let codexCoveragePromise = null;

function isReplaceSpellsEnabled() {
	try {
		return game.settings?.get?.(MODULE_ID, SETTING_REPLACE_SPELLS) === true;
	} catch {
		return false;
	}
}

/**
 * Build (once, cached) the set of `${school}:${tier}` keys the Codex spell pack
 * covers, excluding secret spells (which are never granted at level-up). Also
 * caches the resolved Set synchronously on `codexCoverageSet` for the
 * synchronous `preCreateItem` hook.
 */
function ensureCodexCoverage() {
	if (!codexCoveragePromise) {
		codexCoveragePromise = (async () => {
			const set = new Set();
			try {
				const pack = game.packs?.get?.(CODEX_SPELLS_PACK);
				if (pack) {
					const index = await pack.getIndex({
						fields: ['system.school', 'system.tier', 'system.properties.selected'],
					});
					for (const entry of index) {
						const school = entry?.system?.school;
						if (!school) continue;
						const selected = entry?.system?.properties?.selected ?? [];
						if (selected.includes('secretSpell')) continue;
						set.add(`${school}:${entry?.system?.tier ?? 0}`);
					}
				}
			} catch (error) {
				console.error(`[${MODULE_ID}] Failed to build Codex spell coverage`, error);
			}
			codexCoverageSet = set;
			return set;
		})();
	}
	return codexCoveragePromise;
}

// The level-up / character-creator feature pipeline (buildClassFeatureIndex)
// requests `system.selectionCountByLevel` and omits `name`; the subclass-feature
// index and the pool-option loader do not request selectionCountByLevel, and the
// compendium browser requests `name`. So this signature uniquely identifies the
// class-feature-selection index build.
function isClassFeatureIndexRequest(options) {
	const fields = options?.fields;
	return (
		Array.isArray(fields) &&
		fields.includes('system.selectionCountByLevel') &&
		fields.includes('system.group') &&
		!fields.includes('name')
	);
}

/**
 * During a native level-up for a character with a Blue's Codex subclass, add THIS
 * subclass's pool options (Chimeric Boons, Savage Arsenal, Sacred Decrees, …) to
 * the base class's native selection pool, so the level-up GUI's "Choose N" lists
 * the subclass options ALONGSIDE the base class's — one combined pick, not two.
 *
 * Nimble's `buildClassFeatureIndex` skips `subclass:true` features and cannot
 * scope a selection group to a subclass, so these options were hidden from the
 * native dialog and offered only through this module's own popup — on top of the
 * base pool the dialog already showed, making the player choose twice (e.g. 4
 * Chimeric Boons instead of 2). Here we un-hide the leveling subclass's options
 * in the module pack (carrying the pool's choose-count) so they merge into the
 * base group. The popup then degrades to a back-fill: `maybePromptPools` counts
 * every owned feature in the pool's group — base or subclass — so once the player
 * picks in the GUI it sees the pool satisfied and does not re-offer.
 *
 * Only the module pack is transformed; the core pack (the base options) passes
 * through untouched. Returns a transformed index Collection, or null to leave the
 * result unchanged. Gated on `levelUpContext` so nothing changes outside a
 * level-up.
 */
async function maybeInjectSubclassPoolOptions(pack, options, result) {
	const subclassId = levelUpContext?.subclassId;
	if (!subclassId) return null;
	if (pack.collection !== CLASS_FEATURES_PACK) return null;
	if (!isClassFeatureIndexRequest(options)) return null;

	const bySubclass = await loadPoolOptions();
	const poolOptions = bySubclass.get(subclassId);
	if (!poolOptions || poolOptions.length === 0) return null;

	const countByUuid = new Map(poolOptions.map((option) => [option.uuid, option.count]));

	const transformed = new foundry.utils.Collection();
	for (const [key, entry] of result.entries()) {
		if (entry?.type === 'feature' && countByUuid.has(entry.uuid)) {
			// Un-hide THIS subclass's pool options and give them the pool's choose-count
			// so they merge into the base group with the right native "Choose N" (the
			// options themselves store {}).
			transformed.set(key, {
				...entry,
				system: {
					...entry.system,
					subclass: false,
					selectionCountByLevel: countByUuid.get(entry.uuid),
				},
			});
		} else {
			transformed.set(key, entry);
		}
	}
	return transformed;
}

/**
 * Patch CompendiumCollection#getIndex so the official Nimble spell packs
 * contribute no Codex-covered spells to the character-grant index (while the
 * compendium browser, a different field signature, is left untouched), and so a
 * leveling character's subclass pool options replace the base class's generic
 * pool in the native level-up dialog (see maybeInjectSubclassPoolOptions).
 */
function patchSpellGrantIndex() {
	const CompendiumCollectionClass =
		foundry?.documents?.collections?.CompendiumCollection ?? globalThis.CompendiumCollection;
	const proto = CompendiumCollectionClass?.prototype;
	if (!proto?.getIndex || proto.__blueCodexSpellFilterPatched) return;

	const originalGetIndex = proto.getIndex;
	proto.getIndex = async function blueCodexPatchedGetIndex(options = {}) {
		const result = await originalGetIndex.call(this, options);
		// Subclass-scoped pool-option injection into the native level-up dialog
		// (independent of the official-spell setting handled below).
		try {
			const injected = await maybeInjectSubclassPoolOptions(this, options, result);
			if (injected) return injected;
		} catch (error) {
			console.error(`[${MODULE_ID}] Class-feature selection injection failed`, error);
		}
		try {
			if (!isReplaceSpellsEnabled()) return result;

			// Only the character-grant path (buildSpellIndex) requests `system.classes`
			// and omits `name`; the spell-compendium browser does the reverse.
			const fields = options?.fields;
			const isGrantPath =
				Array.isArray(fields) && fields.includes('system.classes') && !fields.includes('name');

			// During a school-swapping subclass's level-up, drop the base-school Codex
			// spells the character will not keep from the grant index, so the native
			// level-up preview stops listing spells the runtime swap immediately
			// replaces (e.g. an Invoker of Ether no longer sees Fire/Ice/Lightning in
			// "GRANTED SPELLS"). The base class's grantSpells rules hardcode the base
			// schools, so removing those spells here makes the rules resolve to nothing.
			// The chosen swapped schools are added back into the preview by the
			// transient carrier feature (createSwapGrantCarrier), which the native
			// grant then applies. Only affects the leveling character (gated on
			// levelUpContext) and only the Codex pack.
			if (this.collection === CODEX_SPELLS_PACK) {
				if (!isGrantPath) return result;
				const dropped = getLevelUpSwapDroppedSchools();
				if (!dropped || dropped.size === 0) return result;
				const filtered = new foundry.utils.Collection();
				for (const [key, entry] of result.entries()) {
					if (entry?.type === 'spell' && dropped.has(entry?.system?.school)) continue;
					filtered.set(key, entry);
				}
				return filtered;
			}

			if (!OFFICIAL_SPELL_PACKS.has(this.collection)) return result;
			if (!isGrantPath) return result;

			const coverage = (await ensureCodexCoverage()) ?? new Set();

			// During a necrotic-remapped class's own level-up, also hide official
			// necrotic from the grant preview / selection lists — Shadowmancer and
			// Shepherd learn a Codex school (shadow / death) in its place. Scoped to
			// that class via levelUpContext so Mage (Invoker of Control) and Songweaver,
			// which offer necrotic as a *choice*, are left untouched. The authoritative,
			// all-paths suppression is the preCreateItem block below.
			const dropNecrotic = !!CLASS_SPELL_REMAP[levelUpContext?.classId];

			const filtered = new foundry.utils.Collection();
			for (const [key, entry] of result.entries()) {
				if (entry?.type === 'spell') {
					const school = entry?.system?.school;
					const tier = entry?.system?.tier ?? 0;
					if (dropNecrotic && school === 'necrotic') continue;
					// Drop the official spell only where the Codex replaces it.
					if (school && coverage.has(`${school}:${tier}`)) continue;
				}
				filtered.set(key, entry);
			}
			return filtered;
		} catch (error) {
			console.error(`[${MODULE_ID}] Spell-grant index filter failed`, error);
			return result;
		}
	};
	proto.__blueCodexSpellFilterPatched = true;
}

/**
 * Safety net: block an official-pack spell from being created on a character
 * when the Codex covers its school/tier. The `getIndex` filter normally keeps
 * official spells out of grants entirely; this catches any path that slips
 * through (e.g. a future change to the grant index-field signature).
 */
Hooks.on('preCreateItem', (item, data) => {
	try {
		if (!isReplaceSpellsEnabled()) return true;
		if (item?.type !== 'spell') return true;

		const actor = item?.parent;
		if (!(actor instanceof Actor) || actor.type !== 'character') return true;

		const source = item?._stats?.compendiumSource ?? data?._stats?.compendiumSource ?? '';
		if (typeof source !== 'string') return true;
		const isOfficial =
			source.startsWith('Compendium.nimble.nimble-spells.') ||
			source.startsWith('Compendium.nimble.nimble-secret-spells.');
		if (!isOfficial) return true;

		const school = item?.system?.school;
		const tier = item?.system?.tier ?? 0;

		// Authoritative, all-paths suppression of official necrotic on the two base
		// necrotic casters that Blue's Codex re-homes (Shadowmancer → shadow,
		// Shepherd → death). Catches the school-, uuid- and selectSpell-mode grants
		// alike (they all funnel through here). Scoped to those classes so Mage /
		// Songweaver necrotic choices are untouched. classSpellRemapSync grants the
		// Codex replacement school.
		if (school === 'necrotic' && CLASS_SPELL_REMAP[getPrimaryClass(actor)?.classId]) {
			console.log(
				`[${MODULE_ID}] Blocked official necrotic spell "${item.name}" — re-homed to a Blue's Codex school for this class.`,
			);
			return false;
		}

		if (codexCoverageSet && school && codexCoverageSet.has(`${school}:${tier}`)) {
			console.log(
				`[${MODULE_ID}] Blocked official spell "${item.name}" (${school} T${tier}) — Blue's Codex is the default magic system.`,
			);
			return false;
		}
	} catch (error) {
		console.error(`[${MODULE_ID}] preCreateItem spell filter failed`, error);
	}
	return true;
});

// ── Compendium tier badges ───────────────────────────────────────────────────
// The core Nimble spell compendium shows each spell's tier as a small badge in
// the list, so you can see at a glance which tier (and thus level) a spell is
// without opening it. That behaviour is hard-coded to the system's own spell
// packs, so we reproduce it for the Blue Codex spells pack — mirroring the
// sibling nim-plus-package. We reuse the system's own compendium level-badge
// CSS classes so the badge looks identical to the core one (a cantrip shows
// "C"; tiered spells show their tier number).
const SPELL_ENTRY_WITH_LEVEL_CLASS = 'nimble-compendium-entry-with-level';
const SPELL_LEVEL_BADGE_CLASS = 'nimble-compendium-entry-level';
const SPELL_LEVEL_NAME_FLEX_CLASS = 'nimble-class-feature-name-flex';

/**
 * Sort the compendium's spell entries by tier (cantrips first), tie-broken by
 * name, within each folder. Foundry's default sorting is alphabetical and its
 * `sort`/folder-sorting fields don't express tier order, so — like the sibling
 * nim-plus-package does for class-feature levels — we reorder the rendered DOM
 * on each render. Entries are grouped by their parent list element, so each
 * Book/school folder is sorted independently and the folder structure is kept.
 */
function sortSpellEntriesByTier(pack, container) {
	const entries = [];
	for (const entryElement of container.querySelectorAll('[data-entry-id]')) {
		const entryId = entryElement.dataset.entryId;
		if (!entryId || !entryElement.parentElement) continue;
		const indexEntry = pack.index.get(entryId);
		const tier = Number(foundry.utils.getProperty(indexEntry ?? {}, 'system.tier'));
		entries.push({
			entryElement,
			parentElement: entryElement.parentElement,
			tier: Number.isFinite(tier) ? tier : Number.MAX_SAFE_INTEGER,
			name: (indexEntry?.name ?? entryElement.textContent ?? '').trim(),
		});
	}

	const grouped = new Map();
	for (const entry of entries) {
		const list = grouped.get(entry.parentElement) ?? [];
		list.push(entry);
		grouped.set(entry.parentElement, list);
	}

	for (const [parent, list] of grouped) {
		list.sort((a, b) =>
			a.tier !== b.tier
				? a.tier - b.tier
				: a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
		);
		for (const entry of list) parent.append(entry.entryElement);
	}
}

function applySpellTierBadges(pack, container) {
	for (const entryElement of container.querySelectorAll('[data-entry-id]')) {
		const entryId = entryElement.dataset.entryId;
		if (!entryId) continue;
		const indexEntry = pack.index.get(entryId);
		const tier = Number(foundry.utils.getProperty(indexEntry ?? {}, 'system.tier'));
		if (!Number.isFinite(tier)) continue;

		const nameElement =
			entryElement.querySelector('.entry-name') ?? entryElement.querySelector('a') ?? entryElement;
		nameElement.classList.add(SPELL_LEVEL_NAME_FLEX_CLASS);
		nameElement.style.setProperty('display', 'flex', 'important');
		nameElement.style.setProperty('align-items', 'center', 'important');
		nameElement.style.setProperty('width', '100%', 'important');
		nameElement.style.setProperty('min-width', '0', 'important');

		let badge = nameElement.querySelector(`.${SPELL_LEVEL_BADGE_CLASS}`);
		if (!badge) {
			badge = document.createElement('span');
			badge.classList.add(SPELL_LEVEL_BADGE_CLASS);
			nameElement.append(badge);
		}
		badge.style.setProperty('margin-left', 'auto', 'important');
		badge.style.setProperty('margin-right', '6px', 'important');
		badge.style.setProperty('display', 'inline-block', 'important');
		badge.style.setProperty('white-space', 'nowrap', 'important');
		badge.textContent = tier === 0 ? 'C' : String(tier);
		entryElement.classList.add(SPELL_ENTRY_WITH_LEVEL_CLASS);
	}
}

Hooks.on('renderCompendium', (application, element) => {
	const pack = application?.collection;
	if (!pack || pack.collection !== CODEX_SPELLS_PACK) return;

	const container = element instanceof HTMLElement ? element : element?.[0];
	if (!(container instanceof HTMLElement)) return;

	pack
		.getIndex({ fields: ['system.tier'] })
		.then(() => {
			sortSpellEntriesByTier(pack, container);
			applySpellTierBadges(pack, container);
		})
		.catch((error) => {
			console.error(`[${MODULE_ID}] Failed to sort/badge spell entries`, error);
		});
});

const api = {};

// ── Spell-school filter icons ────────────────────────────────────────────────
// The character sheet's Spells tab renders a per-school filter row (and a
// per-card school marker) driven entirely by two plain objects on
// `CONFIG.NIMBLE`: `spellSchools` (label) and `spellSchoolIcons` (a Font Awesome
// class string rendered as `<i class="…">`). Core only defines six schools
// (fire, ice, lightning, necrotic, radiant, wind), so Blue's Codex's extra
// schools get no filter tab and a blank marker. We inject the missing schools
// here. Values are plain display strings (the system's `localize(label ?? key)`
// passes unknown strings through unchanged) and stock Font Awesome 6 Free solid
// glyphs, matching the system's monochrome, single-theme-color icon style — no
// per-school tint, exactly like the six built-in schools.
const CODEX_SPELL_SCHOOLS = {
	earth: { label: 'Earth', icon: 'fa-solid fa-mountain' },
	water: { label: 'Water', icon: 'fa-solid fa-water' },
	illusion: { label: 'Illusion', icon: 'fa-solid fa-mask' },
	domination: { label: 'Domination', icon: 'fa-solid fa-brain' },
	inspiration: { label: 'Inspiration', icon: 'fa-solid fa-lightbulb' },
	protection: { label: 'Protection', icon: 'fa-solid fa-shield-halved' },
	divination: { label: 'Divination', icon: 'fa-solid fa-eye' },
	nature: { label: 'Nature', icon: 'fa-solid fa-leaf' },
	shadow: { label: 'Shadow', icon: 'fa-solid fa-moon' },
	death: { label: 'Death', icon: 'fa-solid fa-skull-crossbones' },
	blood: { label: 'Blood', icon: 'fa-solid fa-droplet' },
	curse: { label: 'Curse', icon: 'fa-solid fa-spider' },
	// Blue's Codex utility spells carry `system.school: "utility"` (school-agnostic
	// spells). Registering it makes native `grantSpells` rules with
	// `schools: ["utility"]` (Specter's Pierce the Veil) validate — the rule's
	// `schools` field only accepts keys of CONFIG.NIMBLE.spellSchools. It is NOT a
	// managed school (MANAGED_SPELL_SCHOOLS excludes it), so no swap/grant path
	// auto-grants it; only rules that name it (with `utilityOnly`) pick from it.
	utility: { label: 'Utility', icon: 'fa-solid fa-wand-magic-sparkles' },
};

function registerSpellSchoolIcons() {
	const config = CONFIG?.NIMBLE;
	if (!config?.spellSchools || !config?.spellSchoolIcons) {
		console.warn(`[${MODULE_ID}] CONFIG.NIMBLE spell-school config missing; cannot register school filter icons.`);
		return;
	}
	for (const [key, { label, icon }] of Object.entries(CODEX_SPELL_SCHOOLS)) {
		// Don't clobber a school the core system (or another module) already defines.
		config.spellSchools[key] ??= label;
		config.spellSchoolIcons[key] ??= icon;
	}
}

Hooks.once('init', () => {
	console.log(`[${MODULE_ID}] Initializing.`);

	registerSpellSchoolIcons();

	game.settings.register(MODULE_ID, SETTING_REPLACE_SPELLS, {
		name: "Blue's Codex is the default magic system",
		hint: "When enabled, leveling a spellcaster grants Blue's Codex spells instead of the official Nimble ones. Official spells for schools the Codex does not re-author (e.g. necrotic) are still granted. Disable to use the official Nimble spells.",
		scope: 'world',
		config: true,
		type: Boolean,
		default: true,
	});
});

// Safety net: if the system's `CONFIG.NIMBLE` wasn't ready at our `init` (hook
// order), `setup` runs after every module's `init`. `??=` keeps it idempotent.
Hooks.once('setup', () => {
	registerSpellSchoolIcons();
});

// Nimble rebuilds CONFIG.NIMBLE.spellSchools from its init-time snapshot (built-in
// schools only) whenever the GM edits the system's custom-spell-schools setting,
// which would silently drop the Codex schools (and `utility`, breaking Pierce the
// Veil's grantSpells validation). Re-inject after that rebuild.
// A world that never saved the setting creates it on the first edit
// (createSetting, not updateSetting), so listen to both.
function onSpellSchoolSettingChanged(setting) {
	if (!String(setting?.key ?? '').endsWith('.customSpellSchools')) return;
	setTimeout(() => registerSpellSchoolIcons(), 0);
}
Hooks.on('updateSetting', onSpellSchoolSettingChanged);
Hooks.on('createSetting', onSpellSchoolSettingChanged);

Hooks.once('ready', () => {
	const module = game.modules.get(MODULE_ID);
	if (module) module.api = api;
	globalThis.blueCodex = api;

	patchSpellGrantIndex();
	// Rewrite the necrotic-caster / Songweaver class-feature spell rules so the
	// creation & level-up dialogs preview and grant the Codex schools.
	installFromUuidRewrite();
	// Reusable on-hit automation: wrap item activation so a marked actor's next
	// attack rolls at disadvantage, and listen for hits that apply the mark.
	installOnHitAutomation();
	// Summon automation: combat-end + Safe Rest cleanup for spawned companions
	// (the spawn/gate/charge hooks piggyback on the on-hit install above).
	installSummonAutomation();
	// Specter: Soul Touched effects/saves, Rite mark removal, Free Soul Twist.
	installSpecterAutomation();
	// Shadowmancer casting rules: custom spell-tier cap table + Pilfered Power
	// flat 1-mana cost.
	installShadowmancerCasting();
	// Warm the Codex coverage cache so the synchronous preCreateItem net has it.
	ensureCodexCoverage();
	// Warm the subclass-pool option + auto-grant indexes.
	loadPoolOptions();
	loadAutoGrantFeatures();
	// Warm the Codex spell-by-school index for subclass spell-school swaps.
	loadCodexSpellsBySchool();

	// Install the level-up wrap eagerly if a character actor already exists (else
	// it installs on the first character sheet render).
	for (const actor of game.actors ?? []) {
		if (actor?.type === 'character') {
			wrapTriggerLevelUp(actor);
			break;
		}
	}
});

// ── Subclass-scoped ability pools (choose one) ───────────────────────────────
// Blue's Codex subclasses expand their class's choose-pools (Savage Arsenal,
// Sacred Decrees, Underhanded Abilities, Thrill of the Hunt, Spellshaper,
// Invocations, Sacred Graces, Lyrical Weaponry / A "People" Person, Direbeast
// Forms / Chimeric Boons, Commander's Orders / Tactics / Weapon Mastery). Nimble
// has NO native subclass-scoped selection — a class selection group leaks to
// every subclass of the class. So these options are authored as decoupled
// subclass features (invisible to both native grant paths: subclass:true keeps
// them out of the class-feature index, and gainedAtLevels:[] keeps them out of
// the subclass index) carrying `flags.<module>.pool = { subclass, name, group,
// levels, count }`. This runtime presents the subclass-scoped choice at the
// pool's milestone levels and grants the picks. It is an idempotent back-fill:
// it offers only (picks owed by the character's level) − (picks already made).
const CLASS_FEATURES_PACK = `${MODULE_ID}.blue-codex-class-features`;

function escapeHtml(value) {
	return String(value ?? '').replace(
		/[&<>"']/g,
		(ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
	);
}

// Escape a literal string for safe embedding in a RegExp source.
function escapeRegExp(value) {
	return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let poolOptionsPromise = null;
/** Index every subclass-pool option out of the class-features pack, by subclass slug. */
function loadPoolOptions() {
	if (!poolOptionsPromise) {
		poolOptionsPromise = (async () => {
			const pack = game.packs.get(CLASS_FEATURES_PACK);
			if (!pack) return new Map();
			const index = await pack.getIndex({
				fields: ['type', 'name', 'img', 'system.identifier', `flags.${MODULE_ID}.pool`],
			});
			const bySubclass = new Map();
			for (const entry of index) {
				if (entry.type !== 'feature') continue;
				const pool = foundry.utils.getProperty(entry, `flags.${MODULE_ID}.pool`);
				if (!pool || !pool.subclass) continue;
				if (!bySubclass.has(pool.subclass)) bySubclass.set(pool.subclass, []);
				bySubclass.get(pool.subclass).push({
					uuid: entry.uuid,
					name: entry.name,
					img: entry.img,
					identifier: entry.system?.identifier,
					poolGroup: pool.group,
					poolName: pool.name,
					levels: Array.isArray(pool.levels) ? pool.levels : [],
					count: pool.count && typeof pool.count === 'object' ? pool.count : {},
				});
			}
			return bySubclass;
		})().catch((error) => {
			console.error(`[${MODULE_ID}] Failed to index subclass-pool options`, error);
			return new Map();
		});
	}
	return poolOptionsPromise;
}

function getPrimaryClass(actor) {
	for (const item of actor.items ?? []) {
		if (item.type !== 'class') continue;
		return {
			classId: item.system?.identifier || item.name?.slugify?.({ strict: true }) || '',
			classLevel: Number(item.system?.classLevel ?? 0) || 0,
		};
	}
	return null;
}

function getActorSubclassId(actor, classId) {
	for (const item of actor.items ?? []) {
		if (item.type !== 'subclass') continue;
		if (classId && item.system?.parentClass && item.system.parentClass !== classId) continue;
		return item.system?.identifier || item.name?.slugify?.({ strict: true }) || '';
	}
	return '';
}

/** Total picks a pool owes by `level` = Σ countAt(milestone) for milestones ≤ level. */
function picksOwed(levels, count, level) {
	let owed = 0;
	for (const milestone of levels) {
		if (milestone <= level) owed += Number(count?.[String(milestone)] ?? 1) || 0;
	}
	return owed;
}

/**
 * For a subclass's options at a level, list the pools that still owe picks.
 *
 * A pool's picks can now be satisfied natively (the level-up GUI merges the
 * subclass options into the base class's pool group), so "owned" is counted by
 * GROUP membership — every owned feature whose `system.group` is the pool group,
 * base OR subclass — not just this module's subclass options. That way a base
 * pick made in the GUI counts, and this popup only fires as a back-fill (when the
 * group has fewer picks than the level owes). `available` stays the subclass
 * options not yet owned, so a back-fill offers the themed choices.
 */
function owedPools(options, ownedIdentifiers, ownedGroupCounts, level) {
	const pools = new Map();
	for (const option of options) {
		if (!pools.has(option.poolGroup)) {
			pools.set(option.poolGroup, {
				group: option.poolGroup,
				name: option.poolName,
				levels: option.levels,
				count: option.count,
				options: [],
			});
		}
		pools.get(option.poolGroup).options.push(option);
	}
	const result = [];
	for (const pool of pools.values()) {
		const ownedInGroup = ownedGroupCounts.get(pool.group) ?? 0;
		const available = pool.options.filter((o) => !ownedIdentifiers.has(o.identifier));
		const need = Math.min(picksOwed(pool.levels, pool.count, level) - ownedInGroup, available.length);
		if (need > 0) result.push({ ...pool, need, available });
	}
	return result;
}

async function grantPoolOption(actor, option) {
	const doc = await fromUuid(option.uuid);
	if (!doc) return null;
	const obj = doc.toObject();
	delete obj._id;
	obj._stats = obj._stats ?? {};
	obj._stats.compendiumSource = doc.uuid;
	const [created] = await actor.createEmbeddedDocuments('Item', [obj]);
	return created ?? null;
}

/** Present one pool's "choose N" as a checkbox dialog; returns the chosen options. */
async function promptPoolChoice(actor, pool) {
	const rows = pool.available
		.map(
			(option) => `
			<label class="blue-codex-pool-pick">
				<input type="checkbox" name="blue-codex-pool-pick" value="${escapeHtml(option.identifier)}">
				<img src="${escapeHtml(option.img)}" width="32" height="32">
				<span>${escapeHtml(option.name)}</span>
			</label>`,
		)
		.join('');

	while (true) {
		// eslint-disable-next-line no-await-in-loop
		const picked = await foundry.applications.api.DialogV2.wait({
			window: { title: `${actor.name} — ${pool.name}` },
			content: `<form class="blue-codex-pool-form">
					<p>Choose <strong>${pool.need}</strong> ${escapeHtml(pool.name)} option${
						pool.need > 1 ? 's' : ''
					} for your subclass:</p>
					<div class="blue-codex-pool-list">${rows}</div>
				</form>
				<style>
					.blue-codex-pool-pick{display:flex;gap:8px;align-items:center;padding:3px 0;cursor:pointer}
					.blue-codex-pool-pick img{border:none;border-radius:4px;flex:0 0 auto}
					.blue-codex-pool-list{max-height:340px;overflow:auto}
				</style>`,
			buttons: [
				{
					action: 'confirm',
					label: 'Confirm',
					default: true,
					callback: (_event, button, dialog) => {
						const root =
							dialog?.element ?? button?.closest?.('.application') ?? button?.form ?? document;
						return [...root.querySelectorAll('input[name="blue-codex-pool-pick"]:checked')].map(
							(input) => input.value,
						);
					},
				},
			],
			rejectClose: false,
			modal: true,
		}).catch(() => null);

		if (!Array.isArray(picked)) return []; // dismissed / cancelled
		if (picked.length !== pool.need) {
			ui.notifications?.warn(`Choose exactly ${pool.need} ${pool.name} option(s).`);
			continue;
		}
		const chosenSet = new Set(picked);
		return pool.available.filter((option) => chosenSet.has(option.identifier));
	}
}

// Guard against the render-storm: track in-flight prompts and per-actor
// declines so a cancelled prompt doesn't immediately reopen every re-render.
const poolPromptActive = new Set();
const poolDeclinedAtLevel = new Map();

async function maybePromptPools(actor) {
	if (!(actor instanceof Actor) || actor.type !== 'character' || !actor.isOwner) return;
	if (poolPromptActive.has(actor.id)) return;

	const classInfo = getPrimaryClass(actor);
	if (!classInfo?.classId || classInfo.classLevel < 1) return;
	const subclassId = getActorSubclassId(actor, classInfo.classId);
	if (!subclassId) return;

	const bySubclass = await loadPoolOptions();
	const options = bySubclass.get(subclassId);
	if (!options || options.length === 0) return;

	const ownedIdentifiers = new Set(
		(actor.items ?? [])
			.filter(
				(item) =>
					item.type === 'feature' &&
					foundry.utils.getProperty(item, `flags.${MODULE_ID}.pool`),
			)
			.map((item) => item.system?.identifier),
	);

	// Picks already made in the native level-up GUI count toward a pool even when
	// they are base-class options (no pool flag), so tally by group membership.
	const ownedGroupCounts = new Map();
	for (const item of actor.items ?? []) {
		if (item.type !== 'feature') continue;
		const group = item.system?.group;
		if (group) ownedGroupCounts.set(group, (ownedGroupCounts.get(group) ?? 0) + 1);
	}

	const owed = owedPools(options, ownedIdentifiers, ownedGroupCounts, classInfo.classLevel);
	if (owed.length === 0) {
		poolDeclinedAtLevel.delete(actor.id);
		return;
	}
	if (poolDeclinedAtLevel.get(actor.id) === classInfo.classLevel) return;

	poolPromptActive.add(actor.id);
	try {
		for (const pool of owed) {
			// eslint-disable-next-line no-await-in-loop
			const chosen = await promptPoolChoice(actor, pool);
			if (chosen.length === 0) {
				// User cancelled — remember the level so we don't nag until they level again.
				poolDeclinedAtLevel.set(actor.id, classInfo.classLevel);
				break;
			}
			for (const option of chosen) {
				// eslint-disable-next-line no-await-in-loop
				await grantPoolOption(actor, option);
			}
			ui.notifications?.info(
				`${actor.name} gained ${chosen.map((o) => o.name).join(', ')}.`,
			);
		}
	} finally {
		poolPromptActive.delete(actor.id);
	}
}

// ── Auto-granted subclass features (back-fill) ───────────────────────────────
// Auto-grant subclass features (the Zephyr Air/Water forms, and the fixed
// level-3/7/11/15 features) are granted natively only DURING the level-up that
// reaches their level. A character that reached a level before this content
// existed — or before a rank's forms were authored — never receives them, since
// Nimble does not back-fill. This grants any missing auto-grant feature for the
// character's subclass up to its current level. Auto-grant subclass features are
// distinguished from choose-pool options by their `group` (== the subclass slug)
// and a NON-empty `gainedAtLevels` (pool options carry `group` == native pool
// and `gainedAtLevels: []`).
let autoGrantPromise = null;
function loadAutoGrantFeatures() {
	if (!autoGrantPromise) {
		autoGrantPromise = (async () => {
			const pack = game.packs.get(CLASS_FEATURES_PACK);
			if (!pack) return new Map();
			const index = await pack.getIndex({
				fields: [
					'type',
					'name',
					'system.subclass',
					'system.group',
					'system.gainedAtLevels',
					'system.identifier',
				],
			});
			const bySubclass = new Map();
			for (const entry of index) {
				if (entry.type !== 'feature') continue;
				const system = entry.system ?? {};
				if (!system.subclass || !system.group) continue;
				const levels = Array.isArray(system.gainedAtLevels) ? system.gainedAtLevels : [];
				if (levels.length === 0) continue; // pool options carry []
				if (!bySubclass.has(system.group)) bySubclass.set(system.group, []);
				bySubclass.get(system.group).push({
					uuid: entry.uuid,
					name: entry.name,
					identifier: system.identifier,
					levels,
				});
			}
			return bySubclass;
		})().catch((error) => {
			console.error(`[${MODULE_ID}] Failed to index auto-grant features`, error);
			return new Map();
		});
	}
	return autoGrantPromise;
}

const autoGrantActive = new Set();

async function backfillAutoGrants(actor) {
	if (!(actor instanceof Actor) || actor.type !== 'character' || !actor.isOwner) return;
	if (autoGrantActive.has(actor.id)) return;

	const classInfo = getPrimaryClass(actor);
	if (!classInfo?.classId || classInfo.classLevel < 1) return;
	const subclassId = getActorSubclassId(actor, classInfo.classId);
	if (!subclassId) return;

	const bySubclass = await loadAutoGrantFeatures();
	const features = bySubclass.get(subclassId);
	if (!features || features.length === 0) return;

	const ownedSources = new Set(
		(actor.items ?? []).map((item) => item._stats?.compendiumSource).filter(Boolean),
	);
	const ownedIdentifiers = new Set(
		(actor.items ?? [])
			.filter((item) => item.type === 'feature')
			.map((item) => item.system?.identifier),
	);

	const missing = features.filter(
		(feature) =>
			feature.levels.some((level) => level <= classInfo.classLevel) &&
			!ownedSources.has(feature.uuid) &&
			!ownedIdentifiers.has(feature.identifier),
	);
	if (missing.length === 0) return;

	autoGrantActive.add(actor.id);
	try {
		const docs = await Promise.all(missing.map((feature) => fromUuid(feature.uuid)));
		const toCreate = [];
		for (const doc of docs) {
			if (!doc) continue;
			const obj = doc.toObject();
			delete obj._id;
			obj._stats = obj._stats ?? {};
			obj._stats.compendiumSource = doc.uuid;
			toCreate.push(obj);
		}
		if (toCreate.length > 0) {
			await actor.createEmbeddedDocuments('Item', toCreate);
			ui.notifications?.info(
				`${actor.name} gained ${toCreate.length} subclass feature${
					toCreate.length > 1 ? 's' : ''
				}.`,
			);
		}
	} finally {
		autoGrantActive.delete(actor.id);
	}
}

// ── Subclass spell-school swaps ──────────────────────────────────────────────
// Four core spellcasting classes (Mage, Shepherd, Stormshifter, Songweaver) have
// Blue's Codex subclasses that change which spell schools the caster learns.
// Per the book the mechanic is NOT uniform: Invoker of Ether "No More Elements"
// FULLY replaces the mage's Book of Elements with the Book of Ether; most others
// ADD a school and cap the caster at 3 known schools (so an over-cap subclass, or
// one whose flavor replaces a base school, makes the player drop one). The book
// also frames this as the player's choice ("either replace at level 3 or select
// the new school from level 1"), so the module OFFERS the choice in a dialog at
// level-up rather than forcing it.
//
// A caster's granted schools normally come from `grantSpells auto` rules baked
// into the *system's* class features, which keep granting the base schools at
// every tier regardless of subclass — so we can't express this in our data. This
// runtime instead: (1) prompts the player for their final school set when they
// take one of these subclasses, (2) removes owned spells of dropped schools and
// grants every Codex spell of the chosen schools up to the caster's unlocked
// tiers (idempotent back-fill, so higher tiers fill in on later level-ups), and
// (3) blocks the base class from granting any non-chosen managed school.
//
// Invoker of Knowledge (Grimoire — scribe any spells manually) and Herald of
// Swords (martial, no schools) are intentionally NOT listed: they get no school
// automation.

// Every spell school the four classes / their subclasses can grant. Spells whose
// school is in this set are "managed": droppable on a swap and blockable when not
// chosen. `necrotic` is the official-pack school the Codex doesn't re-author yet
// (Shepherd), included so it participates in the 3-school cap but never granted
// from the Codex pack (it isn't in it). `utility` is deliberately excluded —
// utility spells are school-agnostic and never swapped.
const MANAGED_SPELL_SCHOOLS = new Set([
	'fire', 'ice', 'earth', 'lightning', 'water', 'wind', // Book of Elements
	'illusion', 'domination', 'inspiration', // Book of Ether
	'radiant', 'protection', 'divination', 'nature', // Book of Radiance
	'shadow', 'death', 'blood', 'curse', // Book of Ruin
	'necrotic', // official (Shepherd) — counts toward the cap, never Codex-granted
]);

// Per-subclass school policy. `mandatory` = schools the subclass forces you to
// know; `choose` = either/or pairs the player picks one school from; `cap` = max
// known schools; `replaceAll` = the mandatory/chosen schools become your ENTIRE
// set (drop every base school) rather than being added to it.
const SUBCLASS_SPELL_POLICY = {
	// ── Mage (base auto: fire/ice/lightning) ──
	'invoker-of-ether': {
		mandatory: ['illusion', 'domination', 'inspiration'],
		cap: 3,
		replaceAll: true,
		newLabel: 'Book of Ether (Illusion, Domination, Inspiration)',
		summary:
			'“No More Elements.” Replace your Book of Elements spell schools with the Book of Ether. You will only learn Illusion, Domination and Inspiration spells from now on.',
	},
	'invoker-of-elements': {
		mandatory: ['fire', 'earth'],
		choose: [
			{ label: 'Ice or Water', options: ['ice', 'water'] },
			{ label: 'Wind or Lightning', options: ['wind', 'lightning'] },
		],
		cap: 4,
		replaceAll: true,
		newLabel: 'four Book of Elements schools',
		summary:
			'Elementalist: you know Fire and Earth, plus either Ice or Water, and either Wind or Lightning.',
	},
	// ── Shepherd (base auto: radiant + necrotic) ──
	'luminary-of-fate': { mandatory: ['divination'], cap: 3, summary: 'Learn Divination spells. You can know only 3 spell schools.' },
	'luminary-of-storms': { mandatory: ['lightning'], cap: 3, summary: 'Learn Lightning spells. You can know only 3 spell schools.' },
	'luminary-of-trickery': { mandatory: ['illusion'], cap: 3, summary: 'Learn Illusion spells. You can know only 3 spell schools.' },
	// ── Stormshifter (base auto: lightning + wind) ──
	'circle-of-earth': { mandatory: ['earth'], cap: 3, summary: 'Learn Earth spells.' },
	'circle-of-hunger': { mandatory: ['shadow', 'illusion'], cap: 3, summary: 'Learn Shadow and Illusion spells. You can know only 3 spell schools.' },
	'circle-of-spores': { mandatory: ['nature'], cap: 3, summary: 'Learn Nature spells.' },
	// ── Songweaver (base auto: wind + 1 chosen) ──
	'herald-of-disruption': { mandatory: ['domination'], cap: 3, summary: 'Learn Domination spells.' },
	'herald-of-inspiration': { mandatory: ['inspiration'], cap: 3, summary: 'Learn Inspiration spells.' },
	// ── Specter / Eidolon of Rage (base schools come from Dark Knowledge — 2 of
	// shadow/death/blood/curse — granted by CLASS_SPELL_CHOICE below; Soul of Rage
	// ADDS one element school on top, so cap = 2 Book-of-Ruin + 1 chosen element = 3.
	// No replaceAll: the two Dark Knowledge schools are kept. Runs after the Dark
	// Knowledge grant (see handleActorFeatures ordering) so `getActorSpellSchools`
	// already reports the two Book-of-Ruin schools to keep). ──
	'eidolon-of-rage': {
		mandatory: [],
		choose: [{ label: 'Fire or Lightning', options: ['fire', 'lightning'] }],
		cap: 3,
		summary:
			'Soul of Rage: learn spells from either the Fire or Lightning School (in addition to your two Book of Ruin schools chosen with Dark Knowledge).',
	},
};

// ── Class-level necrotic re-home ─────────────────────────────────────────────
// necrotic is the one base spell school Blue's Codex doesn't re-author — it splits
// it into shadow / death / blood / curse — so the coverage filter can't auto-swap
// it the way it does fire / radiant / etc. The two base necrotic casters are
// remapped here (keyed by class identifier → the Codex school they learn instead):
// their official necrotic grants are suppressed (grant-index drop + preCreateItem
// block, which together catch the school-, uuid- and selectSpell-mode grants) and
// the Codex replacement school is granted at runtime by classSpellRemapSync, one
// tier at a time. Only these two classes grant necrotic as a fixed part of their
// progression; Mage (Invoker of Control) and Songweaver merely *offer* it as a
// choice and are deliberately excluded so those picks keep working.
const CLASS_SPELL_REMAP = {
	shadowmancer: 'shadow',
	shepherd: 'death',
};

// ── Class-level spell-school choice (new module classes) ─────────────────────
// A NEW class defined entirely in this module (the Specter) has no system
// `grantSpells` rules to rewrite/remap, so its Codex spell access is granted by
// this class-keyed path instead. The Specter's Dark Knowledge (L1) lets it learn
// 2 of the 4 Book of Ruin schools; the player picks them once in a dialog and the
// module grants those schools' Codex spells one tier at a time as the caster's
// Spellcasting levels unlock higher tiers (`maxSpellTierForLevel`). The chosen
// schools are the Specter's BASE schools; the Eidolon of Rage subclass ADDS a
// Fire/Lightning school on top via SUBCLASS_SPELL_POLICY (see above).
//   pick   — how many schools the player chooses.
//   choose — the school pool to pick from.
// The pick is stored on the caster under `flags.<module>.classSpellChoice`
// ({ classId, schools, grantedTier }), mirroring the `classSchools` high-water
// mark used by classSpellRemapSync.
const CLASS_SPELL_CHOICE = {
	specter: {
		pick: 2,
		choose: ['shadow', 'death', 'blood', 'curse'],
		title: 'Dark Knowledge',
		summary:
			'Choose 2 of the Book of Ruin schools (Shadow, Death, Blood, Curse). You learn those schools’ cantrips now and their higher-tier spells as you gain Spellcasting levels.',
	},
};

// ── System class-feature spell-rule rewrites ─────────────────────────────────
// The character-creation and level-up dialogs read each class feature's own
// `grantSpells` rules (via the global `fromUuid`) both to PREVIEW and to GRANT
// spells. To make those dialogs reflect Blue's Codex schools we rewrite the rules
// of the relevant SYSTEM features as they're resolved (see installFromUuidRewrite).
// Keyed by `system.class`:
//   swap        — replace these school names wherever they appear in a grantSpells
//                 rule's `schools` (Shadowmancer/Shepherd necrotic → shadow/death;
//                 Songweaver's necrotic *choice* → death).
//   uuidMap     — remap the specific spell UUIDs of a uuid-only grant 1:1
//                 (Shadowmancer's conduit-of-shadow patron cantrips: official necrotic
//                 Shadow Blast/Summon Shadow → their Codex-shadow equivalents), so the
//                 level-1 caster previews/learns exactly those two Codex spells rather
//                 than the whole school.
//   addSchools  — extend a `selectSchool` rule's option list (Songweaver gains the
//                 Book of Ether + Divination + Curse as choosable additional schools).
const CLASS_FEATURE_SPELL_REWRITES = {
	shadowmancer: {
		swap: { necrotic: 'shadow' },
		uuidMap: {
			'Compendium.nimble.nimble-spells.Item.9TNPdOXlCcGgxw6r':
				'Compendium.blue-codex-package.blue-codex-spells.Item.enkqIepuxNVpUsCh',
			'Compendium.nimble.nimble-spells.Item.ho2KADcmQWWTeYR0':
				'Compendium.blue-codex-package.blue-codex-spells.Item.nrDkGygSyNE6JR7n',
		},
	},
	shepherd: { swap: { necrotic: 'death' } },
	songweaver: {
		swap: { necrotic: 'death' },
		addSchools: ['illusion', 'domination', 'inspiration', 'divination', 'curse'],
	},
};

/** Order-preserving de-dupe of a string list. */
function uniqueList(list) {
	const seen = new Set();
	return list.filter((value) => (seen.has(value) ? false : seen.add(value)));
}

/**
 * Return a rewritten copy of a feature's `rules` per `cfg`, or null when nothing
 * changed. Only `grantSpells` rules are touched.
 */
function rewriteFeatureSpellRules(rules, cfg) {
	let changed = false;
	const out = rules.map((rule) => {
		if (rule?.type !== 'grantSpells') return rule;

		// A uuid-only grant (no schools) → remap those specific spell UUIDs 1:1 to
		// their Codex equivalents, preserving the precise (2-spell) grant.
		if (cfg.uuidMap && Array.isArray(rule.uuids) && rule.uuids.length && !rule.schools?.length) {
			const mapped = rule.uuids.map((u) => cfg.uuidMap[u] ?? u);
			if (mapped.join(',') !== rule.uuids.join(',')) {
				changed = true;
				return { ...rule, uuids: mapped };
			}
			return rule;
		}

		if (Array.isArray(rule.schools) && rule.schools.length) {
			let schools = rule.schools.map((school) => cfg.swap?.[school] ?? school);
			if (cfg.addSchools && rule.mode === 'selectSchool') schools = [...schools, ...cfg.addSchools];
			schools = uniqueList(schools);
			if (schools.join(',') !== rule.schools.join(',')) {
				changed = true;
				return { ...rule, schools };
			}
		}
		return rule;
	});
	return changed ? out : null;
}

// fromUuid returns cached compendium docs; rewriting one in place (idempotently)
// updates every reader. The WeakSet skips docs already handled; the rewrite itself
// is idempotent anyway (re-running finds no necrotic / already-added schools).
const rewrittenFeatureDocs = new WeakSet();

/**
 * Wrap the global `fromUuid` so a SYSTEM class feature belonging to a rewritten
 * class comes back with Codex-adjusted grantSpells rules. This is the single point
 * that makes the creation/level-up dialogs both preview and grant the Codex schools
 * (Shadowmancer→shadow, Shepherd→death, Songweaver's extra-school choice). Gated on
 * the `replaceOfficialSpells` setting; fully guarded so a failure leaves fromUuid
 * behaving normally.
 */
function installFromUuidRewrite() {
	const original = globalThis.fromUuid;
	if (typeof original !== 'function' || original.__blueCodexRewrapped) return;
	const wrapped = async function blueCodexFromUuid(...args) {
		const doc = await original.apply(this, args);
		try {
			if (!isReplaceSpellsEnabled()) return doc;
			if (!doc || doc.type !== 'feature' || rewrittenFeatureDocs.has(doc)) return doc;
			const cfg = doc.system?.class ? CLASS_FEATURE_SPELL_REWRITES[doc.system.class] : null;
			if (!cfg) return doc;
			const rules = doc.system?.rules;
			if (Array.isArray(rules)) {
				const rewritten = rewriteFeatureSpellRules(rules, cfg);
				if (rewritten) doc.updateSource({ 'system.rules': rewritten });
			}
			rewrittenFeatureDocs.add(doc);
		} catch (error) {
			console.error(`[${MODULE_ID}] fromUuid spell-rule rewrite failed`, error);
		}
		return doc;
	};
	wrapped.__blueCodexRewrapped = true;
	globalThis.fromUuid = wrapped;
}

/**
 * The managed spell schools to hide from the grant index during the current
 * level-up, so the native "GRANTED SPELLS" preview doesn't list base-class
 * spells that a school-swapping subclass will immediately replace. Returns a
 * Set of school keys, or null when the leveling character isn't a swap subclass.
 *
 * Prefers the character's stored final school set (recorded once they answer the
 * swap prompt); before that (e.g. the level-3 level-up that first grants the
 * subclass) it falls back to the subclass policy — for a full-replacement
 * subclass, every managed school except the ones it is guaranteed to keep (its
 * mandatory schools plus every option a choose-pair might resolve to, since we
 * can't yet know which the player picks). For an add-and-cap subclass with no
 * stored choice yet the dropped base schools aren't knowable, so nothing is
 * hidden (never hide a school the character might keep).
 */
function getLevelUpSwapDroppedSchools() {
	const ctx = levelUpContext;
	if (!ctx?.subclassId) return null;
	const policy = SUBCLASS_SPELL_POLICY[ctx.subclassId];
	if (!policy) return null;

	const actor = game.actors?.get?.(ctx.actorId);
	const stored = actor?.getFlag?.(MODULE_ID, 'spellSchools');
	let keep;
	if (stored && stored.subclass === ctx.subclassId && Array.isArray(stored.schools)) {
		keep = new Set(stored.schools);
	} else if (policy.replaceAll) {
		keep = new Set(policy.mandatory ?? []);
		for (const pair of policy.choose ?? []) for (const opt of pair.options) keep.add(opt);
	} else {
		return null;
	}

	const dropped = new Set();
	for (const school of MANAGED_SPELL_SCHOOLS) {
		if (!keep.has(school)) dropped.add(school);
	}
	return dropped;
}

// Flag marking the transient "carrier" feature created during a swap subclass's
// level-up (see createSwapGrantCarrier). It exists only for the lifetime of the
// level-up dialog so the native preview/grant can see the swapped schools, then
// is removed — it never persists on the sheet.
const SWAP_GRANT_CARRIER_FLAG = 'swapGrantCarrier';

/**
 * Build `grantSpells auto` rules that grant every Codex spell of `schools` up to
 * the tier unlocked at each level, mirroring a caster's tier progression (tier 0
 * at level 1, tier T at level 2·T). Fed to the native level-up dialog via a
 * carrier feature so its "Granted Spells" preview lists the schools a swap
 * subclass actually gains (Book of Ether, etc.) with correct school headers.
 */
function buildSwapGrantRules(schools) {
	const schoolList = [...schools];
	const rules = [];
	for (let tier = 0; tier <= 9; tier += 1) {
		const rule = {
			id: `blue-codex-swap-grant-t${tier}`,
			type: 'grantSpells',
			mode: 'auto',
			schools: schoolList,
			tiers: [tier],
		};
		if (tier > 0) rule.predicate = { level: { min: tier * 2 } };
		rules.push(rule);
	}
	return rules;
}

/**
 * Create the transient carrier feature for a school-swapping subclass's level-up
 * (returns its id, or null). The base class's own grantSpells rules are hidden by
 * getLevelUpSwapDroppedSchools; this adds the character's chosen schools back so
 * the native preview shows what they'll actually gain — and the native submit
 * grants those spells (idempotent with the runtime swap, which dedupes on
 * compendiumSource). grantSpells rules have no create-time side effects, so the
 * carrier is inert except inside the level-up dialog. Returns null before the
 * player has chosen their schools (the level-3 level-up), since the swap prompt
 * runs after that submit.
 */
async function createSwapGrantCarrier(actor, subclassId) {
	try {
		if (!isReplaceSpellsEnabled()) return null;
		if (!subclassId) return null;
		const policy = SUBCLASS_SPELL_POLICY[subclassId];
		if (!policy) return null;
		const stored = actor.getFlag(MODULE_ID, 'spellSchools');
		if (
			!stored ||
			stored.subclass !== subclassId ||
			!Array.isArray(stored.schools) ||
			stored.schools.length === 0
		) {
			return null;
		}
		const [created] = await actor.createEmbeddedDocuments('Item', [
			{
				name: "Blue's Codex Spellcasting",
				type: 'feature',
				system: { rules: buildSwapGrantRules(stored.schools) },
				flags: { [MODULE_ID]: { [SWAP_GRANT_CARRIER_FLAG]: true } },
			},
		]);
		return created?.id ?? null;
	} catch (error) {
		console.error(`[${MODULE_ID}] Failed to create transient spell-grant carrier`, error);
		return null;
	}
}

/**
 * Remove any leftover carrier features (e.g. from a crash or forced reload mid
 * level-up). Skips the actor currently leveling — that carrier is live and owned
 * by the triggerLevelUp wrapper's own cleanup.
 */
const carrierSweepInFlight = new Set();

async function sweepStaleGrantCarriers(actor) {
	if (levelUpContext?.actorId === actor.id) return;
	if (carrierSweepInFlight.has(actor.id)) return;
	carrierSweepInFlight.add(actor.id);
	try {
		const stale = (actor.items ?? [])
			.filter((item) =>
				foundry.utils.getProperty(item, `flags.${MODULE_ID}.${SWAP_GRANT_CARRIER_FLAG}`),
			)
			.map((item) => item.id)
			.filter((id) => actor.items.get(id));
		if (stale.length === 0) return;
		await actor.deleteEmbeddedDocuments('Item', stale);
	} catch (error) {
		// A carrier can vanish mid-flight (the level-up wrapper's own cleanup owns
		// the live one); losing that race is harmless — stay quiet about it.
		if (!/does not exist/i.test(error?.message ?? '')) {
			console.error(`[${MODULE_ID}] Failed to sweep stale spell-grant carrier`, error);
		}
	} finally {
		carrierSweepInFlight.delete(actor.id);
	}
}

const SCHOOL_LABEL = (school) => school.charAt(0).toUpperCase() + school.slice(1);

/** Spell tier T unlocks at character level 2·T (cantrips at 1); this caps the tiers to grant. */
function maxSpellTierForLevel(level) {
	return Math.max(0, Math.min(9, Math.floor(Number(level ?? 0) / 2)));
}

/** The managed spell schools the actor currently knows (distinct across owned spell items). */
function getActorSpellSchools(actor) {
	const schools = new Set();
	for (const item of actor.items ?? []) {
		if (item.type !== 'spell') continue;
		const school = item.system?.school;
		if (school && MANAGED_SPELL_SCHOOLS.has(school)) schools.add(school);
	}
	return schools;
}

let codexSpellsBySchoolPromise = null;
/** Index the Codex spell pack as school → [{uuid, tier}], excluding secret spells. */
function loadCodexSpellsBySchool() {
	if (!codexSpellsBySchoolPromise) {
		codexSpellsBySchoolPromise = (async () => {
			const bySchool = new Map();
			const pack = game.packs?.get?.(CODEX_SPELLS_PACK);
			if (!pack) return bySchool;
			const index = await pack.getIndex({
				fields: ['type', 'system.school', 'system.tier', 'system.properties.selected'],
			});
			for (const entry of index) {
				if (entry.type !== 'spell') continue;
				const school = entry.system?.school;
				if (!school) continue;
				const selected = entry.system?.properties?.selected ?? [];
				if (selected.includes('secretSpell')) continue; // never auto-granted
				const tier = Number(entry.system?.tier ?? 0) || 0;
				if (!bySchool.has(school)) bySchool.set(school, []);
				bySchool.get(school).push({ uuid: entry.uuid, tier });
			}
			return bySchool;
		})().catch((error) => {
			console.error(`[${MODULE_ID}] Failed to index Codex spells by school`, error);
			return new Map();
		});
	}
	return codexSpellsBySchoolPromise;
}

/**
 * Offer the subclass's spell-school choice. Returns the final Set of chosen
 * schools, or null if the player dismissed the dialog (defer — re-offer later).
 */
async function promptSchoolChoice(actor, policy) {
	const mandatory = [...policy.mandatory];
	const choosePairs = policy.choose ?? [];
	const current = getActorSpellSchools(actor);
	// A class-level school pick (Specter's Dark Knowledge) is a mandatory KEEP for
	// any additive subclass policy (Eidolon of Rage): it is never offered as a
	// droppable "keep N" candidate and always survives into the final set.
	if (!policy.replaceAll) {
		for (const school of getClassChoiceSchools(actor)) {
			if (!mandatory.includes(school)) mandatory.push(school);
		}
	}
	// Slots left for keeping base schools once mandatory + one-per-choose are set.
	const slots = Math.max(0, policy.cap - mandatory.length - choosePairs.length);
	const keepCandidates = policy.replaceAll
		? []
		: [...current].filter((school) => !mandatory.includes(school));
	const mustPickKeep = slots > 0 && keepCandidates.length > slots;

	const mandatoryLine = mandatory.length
		? `<p>You ${policy.mandatory.length ? 'gain' : 'keep'}: <strong>${mandatory.map(SCHOOL_LABEL).join(', ')}</strong>.</p>`
		: '';
	const chooseRows = choosePairs
		.map(
			(pair, index) => `
			<fieldset class="blue-codex-school-choose">
				<legend>${escapeHtml(pair.label)}</legend>
				${pair.options
					.map(
						(opt, oi) => `<label><input type="radio" name="blue-codex-choose-${index}" value="${escapeHtml(
							opt,
						)}" ${oi === 0 ? 'checked' : ''}> ${escapeHtml(SCHOOL_LABEL(opt))}</label>`,
					)
					.join('')}
			</fieldset>`,
		)
		.join('');
	const keepRows = mustPickKeep
		? `<fieldset class="blue-codex-school-keep">
				<legend>Keep ${slots} of your current school${slots > 1 ? 's' : ''}</legend>
				${keepCandidates
					.map(
						(school) => `<label><input type="checkbox" name="blue-codex-keep" value="${escapeHtml(
							school,
						)}"> ${escapeHtml(SCHOOL_LABEL(school))}</label>`,
					)
					.join('')}
			</fieldset>`
		: '';

	while (true) {
		// eslint-disable-next-line no-await-in-loop
		const result = await foundry.applications.api.DialogV2.wait({
			window: { title: `${actor.name} — Spell Schools` },
			content: `<form class="blue-codex-school-form">
					<p>${escapeHtml(policy.summary)}</p>
					${mandatoryLine}
					${chooseRows}
					${keepRows}
				</form>
				<style>
					.blue-codex-school-form fieldset{border:1px solid var(--color-border-light-tertiary,#666);border-radius:4px;margin:6px 0;padding:4px 8px}
					.blue-codex-school-form legend{padding:0 4px;font-weight:600}
					.blue-codex-school-form label{display:inline-flex;gap:4px;align-items:center;margin-right:12px;cursor:pointer}
				</style>`,
			buttons: [
				{
					action: 'confirm',
					label: 'Confirm',
					default: true,
					callback: (_event, button, dialog) => {
						const root = dialog?.element ?? button?.form ?? document;
						const chosen = choosePairs.map(
							(_pair, index) =>
								root.querySelector(`input[name="blue-codex-choose-${index}"]:checked`)?.value,
						);
						const keep = [...root.querySelectorAll('input[name="blue-codex-keep"]:checked')].map(
							(input) => input.value,
						);
						return { chosen, keep };
					},
				},
			],
			rejectClose: false,
			modal: true,
		}).catch(() => null);

		if (!result) return null; // dismissed — defer

		const { chosen, keep } = result;
		if (chosen.some((value) => !value)) continue; // a radio somehow unset
		const final = new Set([...mandatory, ...chosen]);
		if (mustPickKeep) {
			if (keep.length !== slots) {
				ui.notifications?.warn(`Keep exactly ${slots} of your current spell schools.`);
				continue;
			}
			for (const school of keep) final.add(school);
		} else if (slots > 0) {
			for (const school of keepCandidates) final.add(school); // room for all
		}
		return final;
	}
}

/**
 * Sync the actor's spell items toward `finalSchools`: (optionally) drop spells of
 * the schools this subclass no longer keeps, then grant every Codex spell of the
 * chosen schools in the tier band `(fromTier, unlocked tier]` they don't own.
 *
 * Both halves are ONE-TIME transitions, never per-render enforcement, so the
 * player keeps full manual control of their spellbook:
 *   - `fromTier` is the exclusive lower bound — the highest tier already granted
 *     for this school set. The initial school choice grants `(-1, maxTier]`, a
 *     later level-up grants only the newly-unlocked tiers, and a plain re-render
 *     grants nothing. Without it, a manually removed spell was re-added next render.
 *   - `pruneDropped` is true ONLY when the schools are actually (re)chosen. On a
 *     routine re-render it is false, so a spell the player deliberately added — from
 *     ANY school, including one this subclass "dropped" — is left untouched. The
 *     swap's school drop still happens once, at the moment of the choice.
 */
async function applySpellSchools(actor, finalSchools, level, fromTier = -1, pruneDropped = false) {
	const maxTier = maxSpellTierForLevel(level);
	const spellItems = (actor.items ?? []).filter((item) => item.type === 'spell');

	let removed = 0;
	if (pruneDropped) {
		const toDelete = spellItems
			.filter(
				(item) =>
					MANAGED_SPELL_SCHOOLS.has(item.system?.school) &&
					!finalSchools.has(item.system?.school),
			)
			.map((item) => item.id);
		if (toDelete.length) await actor.deleteEmbeddedDocuments('Item', toDelete);
		removed = toDelete.length;
	}

	const bySchool = await loadCodexSpellsBySchool();
	const ownedSources = new Set(
		(actor.items ?? []).map((item) => item._stats?.compendiumSource).filter(Boolean),
	);
	const ownedNameSchool = new Set(
		spellItems.map((item) => `${item.name}|${item.system?.school}`),
	);
	// A spell already learned via another path (e.g. the creation dialog's rewritten
	// grantSpells rules) can carry a different compendiumSource/name casing; its stable
	// `system.identifier` is the cross-path key that stops us re-creating a duplicate.
	const ownedIdentifiers = new Set(
		spellItems
			.filter((item) => item.system?.identifier)
			.map((item) => `${item.system.identifier}|${item.system?.school}`),
	);

	const toCreate = [];
	const seen = new Set();
	for (const school of finalSchools) {
		const list = bySchool.get(school); // necrotic/official schools aren't in the Codex pack
		if (!list) continue;
		for (const { uuid, tier } of list) {
			if (tier > maxTier || tier <= fromTier || seen.has(uuid) || ownedSources.has(uuid)) continue;
			seen.add(uuid);
			// eslint-disable-next-line no-await-in-loop
			const doc = await fromUuid(uuid);
			if (!doc) continue;
			if (ownedNameSchool.has(`${doc.name}|${doc.system?.school}`)) continue;
			if (doc.system?.identifier && ownedIdentifiers.has(`${doc.system.identifier}|${doc.system?.school}`)) continue;
			const obj = doc.toObject();
			delete obj._id;
			obj._stats = obj._stats ?? {};
			obj._stats.compendiumSource = doc.uuid;
			toCreate.push(obj);
		}
	}
	if (toCreate.length) await actor.createEmbeddedDocuments('Item', toCreate);
	return { removed, granted: toCreate.length };
}

// Guard against the render-storm (our own create/delete re-triggers the hooks).
const spellSyncActive = new Set();

async function spellSchoolSync(actor) {
	if (!(actor instanceof Actor) || actor.type !== 'character' || !actor.isOwner) return;
	if (spellSyncActive.has(actor.id)) return;

	const classInfo = getPrimaryClass(actor);
	if (!classInfo?.classId || classInfo.classLevel < 1) return;
	const subclassId = getActorSubclassId(actor, classInfo.classId);
	const policy = subclassId ? SUBCLASS_SPELL_POLICY[subclassId] : null;

	const stored = actor.getFlag(MODULE_ID, 'spellSchools');
	if (!policy) {
		// Respec away from a school-swapping subclass — drop the stale flag so it
		// stops blocking spell grants. (Existing spell items are left as-is.)
		if (stored) await actor.unsetFlag(MODULE_ID, 'spellSchools');
		return;
	}
	// A class whose BASE schools come from a class-level pick (Specter / Dark
	// Knowledge) must make that pick first: recording the subclass set (Eidolon of
	// Rage) without it would lock in an element-only school list, prune nothing
	// useful, and make the level-up filter below block the Book-of-Ruin grants.
	// Defer until classSpellChoiceSync has stored the pick (re-offered next render).
	if (CLASS_SPELL_CHOICE[classInfo.classId] && getClassChoiceSchools(actor).length === 0) return;
	// Hold the guard continuously across prompt + setFlag + apply so our own
	// document writes (which re-fire the sheet-render hook) can't re-enter.
	spellSyncActive.add(actor.id);
	try {
		const maxTier = maxSpellTierForLevel(classInfo.classLevel);
		let finalSchools;
		// Exclusive lower bound of tiers to grant now: the highest tier already
		// granted for this school set. This makes the grant one-time-per-tier so a
		// manually removed spell is NOT re-added on the next render.
		let fromTier;
		// True only when the schools are actually (re)chosen — the one moment we
		// apply the swap's school drop. False on routine renders / level-ups so the
		// player's manual additions from any school survive.
		let pruneDropped = false;
		if (stored && stored.subclass === subclassId && Array.isArray(stored.schools)) {
			finalSchools = new Set(stored.schools);
			// Self-heal a set recorded before the class-level pick existed (or after a
			// Dark Knowledge respec): the class schools always belong in an additive set.
			if (!policy.replaceAll) for (const school of getClassChoiceSchools(actor)) finalSchools.add(school);
			// Existing pick. `grantedTier` is the high-water mark. When it is absent
			// the flag pre-dates this field: the previous back-fill-every-render
			// behavior already granted every unlocked tier, so adopt the current tier
			// as the mark WITHOUT re-granting (nothing new to grant this render, and
			// deletions stick). When present, grant only the tiers a level-up has
			// since unlocked, `(grantedTier, maxTier]`.
			fromTier = typeof stored.grantedTier === 'number' ? stored.grantedTier : maxTier;
		} else {
			// New/changed subclass — offer the choice, grant every unlocked tier, and
			// apply the school drop this once.
			finalSchools = await promptSchoolChoice(actor, policy);
			if (!finalSchools) return; // deferred
			fromTier = -1;
			pruneDropped = true;
		}

		// Persist the school set + advanced high-water mark BEFORE granting so a
		// re-entrant render (fired by our own writes) already sees the final state.
		await actor.setFlag(MODULE_ID, 'spellSchools', {
			subclass: subclassId,
			schools: [...finalSchools],
			grantedTier: Math.max(fromTier, maxTier),
		});

		const { removed, granted } = await applySpellSchools(
			actor,
			finalSchools,
			classInfo.classLevel,
			fromTier,
			pruneDropped,
		);
		if (removed || granted) {
			ui.notifications?.info(
				`${actor.name}: spell schools updated (${granted} learned${
					removed ? `, ${removed} replaced` : ''
				}).`,
			);
		}
	} finally {
		spellSyncActive.delete(actor.id);
	}
}

// Grant every Codex spell of a single `school` in the tier band `(fromTier, maxTier]`
// the actor doesn't already own. Same one-time-per-tier discipline as
// applySpellSchools, so a manually removed spell isn't re-added and manual adds of
// any school survive. Returns the count created.
async function grantCodexSchoolSpells(actor, school, maxTier, fromTier, stats = null) {
	const bySchool = await loadCodexSpellsBySchool();
	const list = bySchool.get(school);
	if (!list || list.length === 0) return 0;

	const spellItems = (actor.items ?? []).filter((item) => item.type === 'spell');
	const ownedSources = new Set(
		(actor.items ?? []).map((item) => item._stats?.compendiumSource).filter(Boolean),
	);
	const ownedNameSchool = new Set(spellItems.map((item) => `${item.name}|${item.system?.school}`));
	// Cross-path duplicate guard: the creation/level-up dialog can grant this school's
	// spells directly (its necrotic rules are rewritten to death/shadow), so match on
	// the stable `system.identifier` too — a spell already present that way, even with a
	// different compendiumSource, must never be re-created here.
	const ownedIdentifiers = new Set(
		spellItems
			.filter((item) => item.system?.identifier)
			.map((item) => `${item.system.identifier}|${item.system?.school}`),
	);

	const toCreate = [];
	const seen = new Set();
	for (const { uuid, tier } of list) {
		if (tier > maxTier || tier <= fromTier || seen.has(uuid) || ownedSources.has(uuid)) continue;
		seen.add(uuid);
		// eslint-disable-next-line no-await-in-loop
		const doc = await fromUuid(uuid);
		if (!doc) continue;
		if (ownedNameSchool.has(`${doc.name}|${doc.system?.school}`)) continue;
		if (doc.system?.identifier && ownedIdentifiers.has(`${doc.system.identifier}|${doc.system?.school}`)) continue;
		const obj = doc.toObject();
		delete obj._id;
		obj._stats = obj._stats ?? {};
		obj._stats.compendiumSource = doc.uuid;
		toCreate.push(obj);
	}
	// Count what was ACTUALLY created: a preCreateItem hook can veto some of the
	// batch, and callers (classSpellChoiceSync) must not advance their high-water
	// mark past spells that never landed. `stats` (optional) accumulates both.
	let created = 0;
	if (toCreate.length) created = (await actor.createEmbeddedDocuments('Item', toCreate))?.length ?? 0;
	if (stats) {
		stats.expected = (stats.expected ?? 0) + toCreate.length;
		stats.created = (stats.created ?? 0) + created;
	}
	return created;
}

// Self-heal: collapse accidental duplicate Codex spells down to one copy. A spell is
// a duplicate when another spell item on the actor shares its (non-empty)
// `system.identifier` AND `system.school`. Conservative on purpose — it only ever
// touches spell items, requires an exact identifier+school match, and always keeps
// the first occurrence — so a legitimately distinct spell is never removed. Fully
// guarded; returns the number deleted. Cleans characters already affected by the
// earlier double-grant bug.
async function pruneDuplicateCodexSpells(actor) {
	try {
		const spellItems = (actor.items ?? []).filter((item) => item.type === 'spell');
		const kept = new Set();
		const duplicateIds = [];
		for (const item of spellItems) {
			const identifier = item.system?.identifier;
			const school = item.system?.school;
			if (!identifier || !school) continue; // only exact identifier+school matches
			const key = `${identifier}|${school}`;
			if (kept.has(key)) duplicateIds.push(item.id);
			else kept.add(key);
		}
		if (duplicateIds.length) await actor.deleteEmbeddedDocuments('Item', duplicateIds);
		return duplicateIds.length;
	} catch (error) {
		console.error(`[${MODULE_ID}] duplicate Codex-spell sweep failed`, error);
		return 0;
	}
}

// Guard against the render-storm (our own create/delete re-fires the hooks).
const classRemapActive = new Set();

// Re-home a base necrotic caster (Shadowmancer → shadow, Shepherd → death) onto its
// Codex school. Idempotent and one-time-per-tier via a `classSchools` high-water
// mark, exactly like the subclass swap, so a manually removed spell is not re-added
// and a spell added from any school survives. The official necrotic spells the class
// replaces are pruned ONCE (when the remap is first applied or the class changes);
// future necrotic grants are already suppressed by the grant-index drop + the
// preCreateItem block, so no continuous deletion is needed.
async function classSpellRemapSync(actor) {
	if (!(actor instanceof Actor) || actor.type !== 'character' || !actor.isOwner) return;
	if (!isReplaceSpellsEnabled()) return;
	if (classRemapActive.has(actor.id)) return;

	const classInfo = getPrimaryClass(actor);
	if (!classInfo?.classId || classInfo.classLevel < 1) return;
	const target = CLASS_SPELL_REMAP[classInfo.classId];
	if (!target) return;

	const maxTier = maxSpellTierForLevel(classInfo.classLevel);
	const stored = actor.getFlag(MODULE_ID, 'classSchools');
	const isNew = !stored || stored.classId !== classInfo.classId;

	classRemapActive.add(actor.id);
	try {
		// Self-heal characters already hit by the earlier double-grant: collapse any
		// duplicate Codex spells (same identifier+school) to a single copy. Cheap,
		// idempotent, guarded — safe to run on every sync.
		await pruneDuplicateCodexSpells(actor);

		// Adoption discipline (mirrors applySpellSchools' "absent high-water flag ⇒
		// adopt current tier, don't re-grant"). At character creation the dialog grants
		// this class's Codex school directly — its necrotic grantSpells rules are
		// rewritten to death/shadow (see installFromUuidRewrite) — so the actor can own
		// the target-school spells before this back-fill ever runs. When there is no
		// high-water flag yet but the actor already owns spells of the target school,
		// those grants happened elsewhere: adopt the current tier as the mark WITHOUT
		// re-granting, or we would create a second copy of each. (An untouched existing
		// character owns only official necrotic here — not the Codex school — so it
		// still falls through to the one-time prune + grant below.)
		const ownsTargetSchool = (actor.items ?? []).some(
			(item) => item.type === 'spell' && item.system?.school === target,
		);
		// maxTier === 0: at level 1 the class feature (via the fromUuid rewrite) is the
		// sole authority on cantrips. During creation the sheet renders after the class
		// item lands but BEFORE the granted spells do, so ownsTargetSchool is briefly
		// false — blanket-granting here would hand out the whole tier-0 school.
		if (isNew && (ownsTargetSchool || maxTier === 0)) {
			// Still prune any official necrotic this class replaces that leaked through.
			const necroticIds = (actor.items ?? [])
				.filter((item) => item.type === 'spell' && item.system?.school === 'necrotic')
				.map((item) => item.id);
			if (necroticIds.length) await actor.deleteEmbeddedDocuments('Item', necroticIds);
			await actor.setFlag(MODULE_ID, 'classSchools', {
				classId: classInfo.classId,
				grantedTier: maxTier,
			});
			return;
		}

		const fromTier = isNew
			? -1
			: typeof stored.grantedTier === 'number'
				? stored.grantedTier
				: maxTier;

		// Already granted through the current tier and no class change → nothing to do
		// (persist a missing grantedTier so an upgraded flag stops re-checking).
		if (!isNew && fromTier >= maxTier) {
			if (typeof stored.grantedTier !== 'number') {
				await actor.setFlag(MODULE_ID, 'classSchools', {
					classId: classInfo.classId,
					grantedTier: maxTier,
				});
			}
			return;
		}

		if (isNew) {
			// One-time prune of the official necrotic spells this class replaces (e.g.
			// a character that already leveled before this remap existed).
			const necroticIds = (actor.items ?? [])
				.filter((item) => item.type === 'spell' && item.system?.school === 'necrotic')
				.map((item) => item.id);
			if (necroticIds.length) await actor.deleteEmbeddedDocuments('Item', necroticIds);
		}

		// Persist the advanced high-water mark BEFORE granting so a re-entrant render
		// (fired by our own writes) already sees the final state.
		await actor.setFlag(MODULE_ID, 'classSchools', {
			classId: classInfo.classId,
			grantedTier: Math.max(fromTier, maxTier),
		});

		const granted = await grantCodexSchoolSpells(actor, target, maxTier, fromTier);
		if (granted) {
			ui.notifications?.info(
				`${actor.name}: learned ${granted} ${SCHOOL_LABEL(target)} spell${granted > 1 ? 's' : ''}.`,
			);
		}
	} finally {
		classRemapActive.delete(actor.id);
	}
}

// ── Class-level spell-school choice grant (Specter / Dark Knowledge) ──────────
// Guard against the render-storm (our own create re-fires the hooks).
const classChoiceActive = new Set();

/** The actor's stored class-level school pick (Dark Knowledge) for its CURRENT
 *  primary class, or [] when none is recorded (or it belongs to another class). */
function getClassChoiceSchools(actor) {
	const stored = actor?.getFlag?.(MODULE_ID, 'classSpellChoice');
	if (!stored || !Array.isArray(stored.schools)) return [];
	const classId = getPrimaryClass(actor)?.classId;
	if (!classId || stored.classId !== classId) return [];
	return [...stored.schools];
}

/** Present a "pick exactly N schools" checkbox dialog; returns the chosen school
 *  list, or null if the player dismissed the dialog (defer — re-offer later). */
async function promptClassSchoolChoice(actor, config) {
	const rows = config.choose
		.map(
			(school) => `
			<label class="blue-codex-school-pick">
				<input type="checkbox" name="blue-codex-school-pick" value="${escapeHtml(school)}">
				<i class="${escapeHtml(CODEX_SPELL_SCHOOLS[school]?.icon ?? 'fa-solid fa-book')}"></i>
				<span>${escapeHtml(SCHOOL_LABEL(school))}</span>
			</label>`,
		)
		.join('');

	while (true) {
		// eslint-disable-next-line no-await-in-loop
		const picked = await foundry.applications.api.DialogV2.wait({
			window: { title: `${actor.name} — ${config.title}` },
			content: `<form class="blue-codex-school-form">
					<p>${escapeHtml(config.summary)}</p>
					<div class="blue-codex-school-list">${rows}</div>
				</form>
				<style>
					.blue-codex-school-pick{display:flex;gap:8px;align-items:center;padding:3px 0;cursor:pointer}
					.blue-codex-school-pick i{width:18px;text-align:center}
				</style>`,
			buttons: [
				{
					action: 'confirm',
					label: 'Confirm',
					default: true,
					callback: (_event, button, dialog) => {
						const root =
							dialog?.element ?? button?.closest?.('.application') ?? button?.form ?? document;
						return [...root.querySelectorAll('input[name="blue-codex-school-pick"]:checked')].map(
							(input) => input.value,
						);
					},
				},
			],
			rejectClose: false,
			modal: true,
		}).catch(() => null);

		if (!Array.isArray(picked)) return null; // dismissed / cancelled — defer
		if (picked.length !== config.pick) {
			ui.notifications?.warn(`Choose exactly ${config.pick} spell school${config.pick > 1 ? 's' : ''}.`);
			continue;
		}
		return picked;
	}
}

// Grant a new module class's chosen Codex spell schools (Specter's Dark Knowledge).
// Structured exactly like classSpellRemapSync: one-time-per-tier via a stored
// high-water mark so a manually removed spell is not re-added and manual adds
// survive. On first run (no flag / class change) it prompts the school choice and
// grants every unlocked tier; later level-ups grant only the newly unlocked tiers.
// The Eidolon of Rage element school is layered on separately by spellSchoolSync,
// which runs after this (see handleActorFeatures), so its prompt already sees the
// Book-of-Ruin schools granted here.
// Failed-grant retries per actor/class/tier this session: a grant vetoed every
// time (e.g. by another module) would otherwise retry on every sheet render.
const CLASS_SPELL_CHOICE_MAX_RETRIES = 3;
const classSpellChoiceRetries = new Map(); // `${actorId}:${classId}:${tier}` → failed attempts

async function classSpellChoiceSync(actor) {
	if (!(actor instanceof Actor) || actor.type !== 'character' || !actor.isOwner) return;
	if (classChoiceActive.has(actor.id)) return;

	const classInfo = getPrimaryClass(actor);
	if (!classInfo?.classId || classInfo.classLevel < 1) return;
	const config = CLASS_SPELL_CHOICE[classInfo.classId];
	if (!config) return;

	const maxTier = maxSpellTierForLevel(classInfo.classLevel);
	const retryKey = `${actor.id}:${classInfo.classId}:${maxTier}`;
	if ((classSpellChoiceRetries.get(retryKey) ?? 0) >= CLASS_SPELL_CHOICE_MAX_RETRIES) return;
	const stored = actor.getFlag(MODULE_ID, 'classSpellChoice');
	const isNew =
		!stored || stored.classId !== classInfo.classId || !Array.isArray(stored.schools);

	classChoiceActive.add(actor.id);
	try {
		let schools;
		let fromTier;
		if (isNew) {
			const picked = await promptClassSchoolChoice(actor, config);
			if (!picked) return; // deferred — re-offer on a later render
			schools = picked;
			fromTier = -1;
		} else {
			schools = stored.schools;
			// Absent high-water flag ⇒ adopt current tier without re-granting (an
			// upgraded flag). Present ⇒ grant only the tiers unlocked since.
			fromTier = typeof stored.grantedTier === 'number' ? stored.grantedTier : maxTier;
			if (fromTier >= maxTier) {
				if (typeof stored.grantedTier !== 'number') {
					await actor.setFlag(MODULE_ID, 'classSpellChoice', {
						classId: classInfo.classId,
						schools,
						grantedTier: maxTier,
					});
				}
				return; // already granted through the current tier
			}
		}

		// Persist the chosen schools BEFORE granting (so spellSchoolSync / the
		// level-up school filter already see them), but keep the high-water mark at
		// its previous value: it only advances once the grants have actually landed.
		// If any create is vetoed (e.g. a level-up filter) the tier band is retried on
		// the next render instead of being skipped forever. Re-entry from our own
		// writes is blocked by classChoiceActive.
		await actor.setFlag(MODULE_ID, 'classSpellChoice', {
			classId: classInfo.classId,
			schools,
			grantedTier: fromTier,
		});

		const stats = { expected: 0, created: 0 };
		let granted = 0;
		for (const school of schools) {
			// eslint-disable-next-line no-await-in-loop
			granted += await grantCodexSchoolSpells(actor, school, maxTier, fromTier, stats);
		}
		if (stats.created >= stats.expected) {
			await actor.setFlag(MODULE_ID, 'classSpellChoice', {
				classId: classInfo.classId,
				schools,
				grantedTier: Math.max(fromTier, maxTier),
			});
		} else {
			const attempts = (classSpellChoiceRetries.get(retryKey) ?? 0) + 1;
			classSpellChoiceRetries.set(retryKey, attempts);
			console.warn(
				attempts >= CLASS_SPELL_CHOICE_MAX_RETRIES
					? `[${MODULE_ID}] ${config.title}: ${stats.expected - stats.created} spell grant(s) for ${actor.name} still did not land after ${attempts} attempts; giving up for this session (add the missing spells by hand, or reload to retry).`
					: `[${MODULE_ID}] ${config.title}: ${stats.expected - stats.created} spell grant(s) did not land; will retry on the next sheet render.`,
			);
		}
		if (granted) {
			ui.notifications?.info(
				`${actor.name}: learned ${granted} ${config.title} spell${granted > 1 ? 's' : ''}.`,
			);
		}
	} finally {
		classChoiceActive.delete(actor.id);
	}
}

// Suppress ONLY the automated base-class grant that fires during a swapped
// caster's level-up — this is what stops an Invoker of Ether from re-gaining Book
// of Elements spells every level-up. It is deliberately scoped to the leveling
// character's own level-up (levelUpContext): outside a level-up this returns early,
// so the player can freely add a spell of ANY school and ANY tier from the sheet
// (drag-in, spell browser, etc.). Runs as its own hook because the official-spell
// filter above returns early for non-official (i.e. Codex) spells.
Hooks.on('preCreateItem', (item, data) => {
	try {
		if (!isReplaceSpellsEnabled()) return true;
		if (item?.type !== 'spell') return true;
		const actor = item?.parent;
		if (!(actor instanceof Actor) || actor.type !== 'character') return true;

		// Manual adds happen outside any level-up dialog — let them all through.
		if (levelUpContext?.actorId !== actor.id) return true;

		const stored = actor.getFlag(MODULE_ID, 'spellSchools');
		if (!stored || !Array.isArray(stored.schools)) return true;

		const school = item?.system?.school ?? data?.system?.school;
		// The class-level pick (Dark Knowledge) is always allowed, even if the stored
		// subclass set pre-dates it — blocking it here would permanently lose the
		// grant once classSpellChoiceSync advanced its high-water mark.
		if (getClassChoiceSchools(actor).includes(school)) return true;
		if (school && MANAGED_SPELL_SCHOOLS.has(school) && !stored.schools.includes(school)) {
			console.log(
				`[${MODULE_ID}] Blocked ${school} spell "${item.name}" during level-up — not among this subclass's chosen schools (${stored.schools.join(', ')}).`,
			);
			return false;
		}
	} catch (error) {
		console.error(`[${MODULE_ID}] preCreateItem school filter failed`, error);
	}
	return true;
});

// Wrap the character document's `triggerLevelUp` so that, for the whole time its
// native level-up dialog is open, `levelUpContext` names the leveling character
// and its subclass. The class-feature index patch reads that to swap the base
// class's generic pool options for the subclass's themed ones (see
// maybeInjectSubclassPoolOptions). Installed lazily from the first character
// sheet render (and eagerly at ready when an actor already exists) because the
// document subclass isn't on a stable global.
let levelUpWrapInstalled = false;
function wrapTriggerLevelUp(actor) {
	if (levelUpWrapInstalled) return;
	let proto = actor ? Object.getPrototypeOf(actor) : null;
	while (proto && !Object.prototype.hasOwnProperty.call(proto, 'triggerLevelUp')) {
		proto = Object.getPrototypeOf(proto);
	}
	if (!proto || typeof proto.triggerLevelUp !== 'function' || proto.__blueCodexLevelUpWrapped) return;

	const originalTriggerLevelUp = proto.triggerLevelUp;
	proto.triggerLevelUp = async function blueCodexTriggerLevelUp(...args) {
		const previous = levelUpContext;
		let carrierId = null;
		try {
			const classInfo = getPrimaryClass(this);
			const classId = classInfo?.classId ?? '';
			const subclassId = classId ? getActorSubclassId(this, classId) : '';
			// Track the leveling character's subclass AND class. `classId` scopes the
			// grant-index necrotic drop to a remapped class's own level-up; `subclassId`
			// drives the swap machinery. Set whenever either applies.
			levelUpContext =
				subclassId || CLASS_SPELL_REMAP[classId]
					? { actorId: this.id, subclassId, classId }
					: null;
			// Seed the native preview/grant with the chosen swapped schools (transient;
			// removed in the finally so it never sticks on the sheet). Necrotic base
			// casters (Shadowmancer/Shepherd) need no carrier: installFromUuidRewrite
			// already rewrites their base feature rules to grant the Codex school.
			carrierId = await createSwapGrantCarrier(this, subclassId);
			return await originalTriggerLevelUp.apply(this, args);
		} finally {
			// Delete the carrier BEFORE clearing levelUpContext: the grant-triggered
			// sheet re-renders run sweepStaleGrantCarriers, which only skips this
			// actor while the context still names it — clearing first lets the sweep
			// race this delete for the same id ("Item does not exist").
			if (carrierId) {
				try {
					await this.deleteEmbeddedDocuments('Item', [carrierId]);
				} catch (error) {
					console.error(`[${MODULE_ID}] Failed to remove transient spell-grant carrier`, error);
				}
			}
			levelUpContext = previous;
		}
	};
	proto.__blueCodexLevelUpWrapped = true;
	levelUpWrapInstalled = true;
}

// ── Reusable on-hit automation ───────────────────────────────────────────────
// A small, data-driven "when this item hits a target, do X" framework. Any item
// (spell, weapon, feature) opts in with a flag:
//
//   flags.blue-codex-package.automation.onHit = [ { type: '<effect>' }, … ]
//
// Currently the only effect is `disadvantageNextAttack` (used by Vicious
// Mockery): on a hit, the target's *next* attack rolls at disadvantage, then the
// mark clears itself. Nimble has no rule/condition for this — attack advantage/
// disadvantage is the `rollMode` passed into `item.activate` (negative =
// disadvantage), which flows through the activation dialog into the DamageRoll's
// primary die. So the mechanism is two halves:
//   1. On a hit (the system's `useItem` hook), drop a tracking ActiveEffect on
//      each hit target.
//   2. Wrap `item.activate`: if the acting actor carries a mark and the item is
//      an attack, decrement `rollMode` (pre-selecting disadvantage in the roll
//      dialog) and, once the attack resolves, delete the mark.
//
// New on-hit effects can be added by extending ON_HIT_APPLIERS and the marker
// bookkeeping — the flag schema and the useItem plumbing are already generic.
const DISADVANTAGE_MARK_FLAG = 'disadvantageNextAttack';

// Read an item's declared on-hit automations (always an array).
function getItemOnHitAutomations(item) {
	const automation =
		item?.getFlag?.(MODULE_ID, 'automation') ?? item?.flags?.[MODULE_ID]?.automation;
	const onHit = automation?.onHit;
	return Array.isArray(onHit) ? onHit : [];
}

// True when the item makes a to-hit attack roll — a `damage` activation effect
// that can miss. Auto-hit effects (canMiss:false) roll no d20, so disadvantage
// is meaningless and such items neither trigger nor consume a mark.
function isAttackItem(item) {
	const effects = item?.system?.activation?.effects;
	if (!Array.isArray(effects)) return false;
	return effects.some((effect) => effect?.type === 'damage' && effect?.canMiss !== false);
}

// The disadvantage-on-next-attack marks currently on an actor.
function getDisadvantageMarks(actor) {
	const effects = actor?.effects ? [...actor.effects] : [];
	return effects.filter((effect) => effect?.getFlag?.(MODULE_ID, DISADVANTAGE_MARK_FLAG) === true);
}

// Drop a tracking ActiveEffect that flags the target's next attack as
// disadvantaged. Idempotent (one mark at a time — you can't be "more" than
// disadvantaged on a single next attack). Requires permission to edit the
// target actor; in single-GM play the acting client is the GM so this always
// succeeds. In multiplayer, a player targeting an actor they don't own can't
// create the effect — it degrades to the reminder note on the spell's chat card.
async function applyDisadvantageNextAttack(targetActor, sourceItem) {
	if (!targetActor) return;
	if (getDisadvantageMarks(targetActor).length) return;
	const effectData = {
		name: sourceItem?.name ?? 'Disadvantage (Next Attack)',
		img: sourceItem?.img ?? 'icons/svg/downgrade.svg',
		description: '<p>Disadvantage on your next attack.</p>',
		disabled: false,
		transfer: false,
		flags: {
			[MODULE_ID]: {
				[DISADVANTAGE_MARK_FLAG]: true,
				sourceName: sourceItem?.name ?? '',
			},
		},
	};
	try {
		await targetActor.createEmbeddedDocuments('ActiveEffect', [effectData]);
	} catch (error) {
		console.warn(
			`[${MODULE_ID}] Could not apply "disadvantage on next attack" to ${targetActor?.name}` +
				' (insufficient permission?); relying on the chat-card reminder instead.',
			error,
		);
	}
}

// Maps an on-hit automation type to the function that applies it to a target.
const ON_HIT_APPLIERS = {
	disadvantageNextAttack: applyDisadvantageNextAttack,
};

// `useItem` fires (on the acting client only) after an item's chat card is
// created, with the aggregate hit/miss of its primary attack. For any item that
// declares on-hit automations, apply each to every target the attack hit.
async function onItemUsed(item, _chatCard, context) {
	try {
		await applyOnHitAutomations(item, context);
	} catch (error) {
		console.error(`[${MODULE_ID}] on-hit automation failed`, error);
	}
	// Summon spells spawn their companion after the cast resolves; summoned
	// healers spend a heal charge when their Cure resolves. Both are independent
	// of the on-hit path and each degrade to a console.warn (single-GM play).
	try {
		await handleSummonSpawn(item, context);
	} catch (error) {
		console.warn(`[${MODULE_ID}] summon spawn failed`, error);
	}
	try {
		await consumeSummonCharge(item, context);
	} catch (error) {
		console.warn(`[${MODULE_ID}] summon charge consumption failed`, error);
	}
	// Swarming Shadows: a shadow minion's single attack that would crit spawns
	// another minion beside the target.
	try {
		await handleSwarmingShadowsUseItem(item, context);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Swarming Shadows (single attack) failed`, error);
	}
	// Shadowmancer Pilfered Power: enforce the flat 1-mana cost after the system's
	// own tier-based deduction has run.
	try {
		await applyShadowmancerFlatCost(item, context);
	} catch (error) {
		console.warn(`[${MODULE_ID}] shadowmancer flat-cost correction failed`, error);
	}
	// Specter: Rites remove Soul Touched (Undo card, Reclaim Essence, Lingering);
	// Soul of Suffering asks for the save stat.
	try {
		await handleSpecterItemUsed(item, context);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Specter item automation failed`, error);
	}
	// Engineer turrets: Targeting Matrix marks + Tool Wrench recall.
	await handleTurretUseItem(item, context);
}

// Apply every declared on-hit automation to each target the primary attack hit.
async function applyOnHitAutomations(item, context) {
	const automations = getItemOnHitAutomations(item);
	if (!automations.length) return;
	// Only fire on a hit. `isMiss` is the primary attack's aggregate outcome
	// (undefined for auto-hit items, which count as hits here).
	if (context?.isMiss === true) return;
	const targets = context?.targets ?? [];
	for (const automation of automations) {
		const apply = ON_HIT_APPLIERS[automation?.type];
		if (!apply) continue;
		for (const token of targets) {
			const targetActor = token?.actor ?? token?.document?.actor;
			if (targetActor) await apply(targetActor, item, automation);
		}
	}
}

// The wrapped body shared by every item document class's `activate`: if the
// acting actor carries a disadvantage mark and this item is an attack, pre-apply
// disadvantage (rollMode −1) and, once the attack resolves, clear the mark(s).
async function runWrappedActivate(originalActivate, options = {}) {
	// The macro path is not an attack roll; pass straight through.
	if (options?.executeMacro) return originalActivate.call(this, options);
	// Summon gating: for spells carrying a summon automation flag, decide whether
	// the cast may proceed BEFORE the dialog/mana/chat-card. Blocking here means
	// `originalActivate` never runs, so a recast-dismiss costs no mana (see the
	// Summon automation section below).
	try {
		if (await summonActivationBlocked(this)) return null;
	} catch (error) {
		console.error(`[${MODULE_ID}] summon pre-activate gate failed`, error);
	}
	// Specter Rites: warn (proceed / cancel) when a target isn't Soul Touched by
	// this Specter. Cancelling here costs nothing (originalActivate never runs).
	try {
		if (await riteActivationBlocked(this)) return null;
	} catch (error) {
		console.error(`[${MODULE_ID}] Rite pre-activate check failed`, error);
	}
	// Turret Toolbelt special: confirm (scrap + turret destruction) before the
	// roll; cancel = no activation. Paid/destroyed after it resolves (see
	// prepareTurretToolbelt in the Engineer turret section).
	let turretToolbelt = null;
	try {
		turretToolbelt = await prepareTurretToolbelt(this);
		if (turretToolbelt?.blocked) return null;
	} catch (error) {
		console.error(`[${MODULE_ID}] turret toolbelt pre-activate failed`, error);
	}
	let marks = [];
	try {
		if (this?.actor && isAttackItem(this)) {
			marks = getDisadvantageMarks(this.actor);
			if (marks.length) options = { ...options, rollMode: (options.rollMode ?? 0) - 1 };
		}
	} catch (error) {
		console.error(`[${MODULE_ID}] disadvantage pre-activate failed`, error);
	}
	// Targeting Matrix: an attack at a marked target starts at advantage.
	let matrixMarks = [];
	try {
		matrixMarks = collectTargetingMatrixMarks(this);
		if (matrixMarks.length) options = { ...options, rollMode: (options.rollMode ?? 0) + 1 };
	} catch (error) {
		console.error(`[${MODULE_ID}] Targeting Matrix pre-activate failed`, error);
	}
	// Tier-cap lift: a summon boost with `uncapsTierLimit` (Empowered Companion —
	// "ignoring the typical spell tier restrictions") lets the upcast slider run
	// to full mana. The system's SpellUpcastDialog reads the DERIVED in-memory
	// value `actor.system.resources.highestUnlockedSpellTier` both at render and
	// at submit validation, and `originalActivate` awaits the dialog's whole
	// lifetime — so raising the value here and restoring it in `finally` brackets
	// both reads. Real mana still bounds the slider's maxMana, so the player can
	// never overspend actual mana; and if the system re-derives the value
	// mid-dialog, submit validation just falls back to the real cap (fail-safe:
	// dialog warns, the user retries).
	let tierResources = null;
	let priorTier = 0;
	let hadOverride = false;
	try {
		const summon = getItemSummonAutomation(this);
		if (summon && getSummonFeatureBoosts(summon, this?.actor).uncapTier) {
			const resources = this?.actor?.system?.resources;
			const current = resources?.highestUnlockedSpellTier;
			// Only lift a real numeric cap that sits below Nimble's max tier (9).
			if (resources && typeof current === 'number' && current < 9) {
				tierResources = resources;
				priorTier = current;
				resources.highestUnlockedSpellTier = 9;
				hadOverride = true;
			}
		}
	} catch (error) {
		console.warn(`[${MODULE_ID}] summon tier-uncap pre-activate failed`, error);
	}
	// Shadowmancer Pilfered Power forced max-tier: the SpellUpcastDialog is auto-
	// answered at the cap (see onRenderUpcastDialog), but getData's applyUpcastDeltas
	// also enforces Rule 4 (manaToSpend <= mana.current, reading the derived in-memory
	// value). Under Pilfered Power mana.current is a use-count, not a per-tier budget,
	// so raise it to the cap for the duration of getData; onSpellPreUse restores the
	// real value BEFORE the system's own deduction (so the true flat cost persists),
	// and the `finally` restores it if the cast is cancelled before preUse ever fires.
	// Also strip fastForward so the dialog (hence the auto-answer) always runs.
	try {
		if (this?.type === 'spell' && (Number(this.system?.tier) || 0) >= 1 && isShadowmancerActor(this?.actor)) {
			if (options?.fastForward) options = { ...options, fastForward: false };
			const resources = this.actor.system?.resources;
			const realMana = Number(resources?.mana?.current) || 0;
			const cap = Number(resources?.highestUnlockedSpellTier) || 0;
			if (resources?.mana && realMana < cap) {
				resources.mana.current = cap;
				// Store only the plain value; the live `resources` object can be
				// replaced if prepareData() re-runs during the dialog window, so the
				// restore re-resolves the actor's mana object freshly.
				shadowmancerManaFudge.set(this.actor.uuid, realMana);
			}
		}
	} catch (error) {
		console.warn(`[${MODULE_ID}] shadowmancer mana pre-activate fudge failed`, error);
	}
	let result;
	try {
		result = await originalActivate.call(this, options);
		// Consume the mark only if an attack actually resolved (dialog not cancelled).
		if (marks.length && result) {
			try {
				await this.actor.deleteEmbeddedDocuments(
					'ActiveEffect',
					marks.map((mark) => mark.id).filter(Boolean),
				);
			} catch (error) {
				console.warn(`[${MODULE_ID}] Could not clear disadvantage mark`, error);
			}
		}
		if (result && matrixMarks.length) {
			try {
				await consumeTargetingMatrixMarks(matrixMarks);
			} catch (error) {
				console.warn(`[${MODULE_ID}] Could not clear Targeting Matrix mark`, error);
			}
		}
		// Rapid Fire (automation.repeatsTimes "int"): each extra shot is its own full
		// Nimble attack (own roll, hit/miss/crit, target choice) — Nimble only gives
		// crit/miss to an activation's first damage node, so cloned nodes would roll
		// flat. Runs the unwrapped activate so no extra confirm/scrap is taken; the
		// turret is only paid for / destroyed after the last shot. Cancelling a
		// shot's dialog stops the volley. NPC turrets spend no combatant actions.
		if (result && turretToolbelt?.shots > 1) {
			for (let shot = 2; shot <= turretToolbelt.shots; shot += 1) {
				let again = null;
				try {
					// eslint-disable-next-line no-await-in-loop
					again = await originalActivate.call(this, options);
				} catch (error) {
					console.warn(`[${MODULE_ID}] Rapid Fire shot ${shot} failed`, error);
				}
				if (!again) break;
			}
		}
		if (result && turretToolbelt?.complete) {
			try {
				await turretToolbelt.complete();
			} catch (error) {
				console.warn(`[${MODULE_ID}] turret toolbelt completion failed`, error);
			}
		}
		return result;
	} finally {
		// ALWAYS restore the exact prior tier cap, even when activate throws.
		if (hadOverride) {
			try {
				tierResources.highestUnlockedSpellTier = priorTier;
			} catch (error) {
				console.warn(`[${MODULE_ID}] Could not restore spell tier cap`, error);
			}
		}
		try {
			const uuid = this?.actor?.uuid;
			// Restore the mana fudge if onSpellPreUse never ran (the cast was
			// cancelled/aborted before the deduction); a completed cast already
			// restored it in preUse. Re-resolve the live mana object — the reference
			// captured at fudge time may be stale after a mid-dialog prepareData().
			if (uuid && shadowmancerManaFudge.has(uuid)) {
				const realMana = shadowmancerManaFudge.get(uuid);
				shadowmancerManaFudge.delete(uuid);
				const mana = this?.actor?.system?.resources?.mana;
				if (mana) mana.current = realMana;
			}
			// Clear a leftover cost snapshot ONLY when the cast did not complete (e.g.
			// a later preUseItem handler blocked it after ours ran). A completed cast
			// leaves the snapshot for the async useItem handler to consume — clearing
			// it here would race that handler and skip the flat-cost/overdraft step.
			if (uuid && !result) shadowmancerPreCastMana.delete(uuid);
		} catch (error) {
			console.warn(`[${MODULE_ID}] Could not restore shadowmancer mana fudge`, error);
		}
	}
}

// Wrap `activate` on every distinct item document class prototype that defines
// its own. `NimbleSpellItem` reimplements activate (it only calls super in the
// macro path), so wrapping `NimbleBaseItem` alone would miss attack spells —
// hence iterating the per-type classes. Idempotent per prototype.
let onHitAutomationInstalled = false;
function installOnHitAutomation() {
	if (onHitAutomationInstalled) return;

	Hooks.on(`${game.system?.id ?? 'nimble'}.useItem`, onItemUsed);

	const classes = CONFIG?.NIMBLE?.Item?.documentClasses;
	if (classes) {
		const seen = new Set();
		for (const cls of Object.values(classes)) {
			const proto = cls?.prototype;
			if (!proto || seen.has(proto)) continue;
			seen.add(proto);
			if (!Object.prototype.hasOwnProperty.call(proto, 'activate')) continue;
			// Own-property check: a subclass (e.g. NimbleSpellItem, which reimplements
			// activate) inherits the base prototype's `__blueCodexActivateWrapped`
			// flag, so an inherited-value guard would wrongly skip wrapping its own
			// activate. Only skip a prototype we have already wrapped directly.
			if (typeof proto.activate !== 'function') continue;
			if (Object.prototype.hasOwnProperty.call(proto, '__blueCodexActivateWrapped')) continue;
			const originalActivate = proto.activate;
			proto.activate = async function blueCodexActivate(options = {}) {
				return runWrappedActivate.call(this, originalActivate, options);
			};
			proto.__blueCodexActivateWrapped = true;
		}
	} else {
		console.warn(`[${MODULE_ID}] CONFIG.NIMBLE.Item.documentClasses missing; on-hit attack-roll automation not installed.`);
	}

	onHitAutomationInstalled = true;
}

// ── Summon automation ────────────────────────────────────────────────────────
// A data-driven "casting this spell spawns/dismisses a companion token" layer,
// riding the same `useItem` hook and `activate` wrap as the on-hit section. A
// spell opts in with a flag:
//
//   flags.blue-codex-package.automation.summon = {
//     template, combatOnly?, expireOnCombatEnd?, maxCount?, unique?,
//     recastDismisses?, chargesFromMana?, upcastDieStep?: { baseFaces, maxFaces }
//   }
//
// Two spells use it today:
//   • summon-shadow → many shadow-minion tokens, capped at min(INT, level), only
//     during combat, cleaned up when combat ends.
//   • summon-lifebinding-spirit → one unique spirit; recasting dismisses it (no
//     mana); its heal die scales with upcast; its Cure carries a pool of heal
//     charges (= mana spent) that dismiss the spirit when exhausted.
//
// The companions themselves are world actors imported once from the
// `blue-codex-package.blue-codex-companions` pack, tagged with an actor flag
// `flags.blue-codex-package.companionTemplate === '<template>'`. Each spawned
// token records its provenance on `flags.blue-codex-package.summon`; unique
// templates are also tracked on the caster under
// `flags.blue-codex-package.summons.<template>`. All spawning/patching degrades
// to console.warn — single-GM play, same assumption as the on-hit section.
const COMPANION_PACK = `${MODULE_ID}.blue-codex-companions`;
const COMPANION_TEMPLATE_FLAG = 'companionTemplate';
const SUMMON_FLAG = 'summon'; // token flag: provenance of a spawned companion
const SUMMONS_TRACK_FLAG = 'summons'; // caster-actor flag namespace for unique summons

// Named `maxCount` modes → the ability whose modifier caps the number of live
// summons (cap = min(<ability> mod, character level), floored at 0). Shared by the
// pre-activation gate (summonActivationBlocked) and the trigger-spawn cap check
// (spawnSwarmingShadow) so a new mode only has to be declared once.
//   minIntOrLevel → Summon Shadow (shadow minions);
//   minStrOrLevel → Reanimated Soul (undead minions, count = Soul Power dice used,
//                   itself capped at min(STR, LVL)).
const SUMMON_COUNT_MODES = {
	minIntOrLevel: { ability: 'intelligence', noun: 'shadow minion' },
	minStrOrLevel: { ability: 'strength', noun: 'undead minion' },
};

// Live summon cap for `summon` on `caster` (Infinity when the flag names no mode).
function summonCountCap(caster, summon) {
	const mode = SUMMON_COUNT_MODES[summon?.maxCount];
	if (!mode) return Infinity;
	return Math.max(0, Math.min(getAbilityMod(caster, mode.ability), getCharacterLevel(caster)));
}

// Read a spell's declared summon automation (or null).
function getItemSummonAutomation(item) {
	const automation =
		item?.getFlag?.(MODULE_ID, 'automation') ?? item?.flags?.[MODULE_ID]?.automation;
	const summon = automation?.summon;
	return summon && typeof summon === 'object' ? summon : null;
}

// Read the raw summon provenance flag off a token document.
function getTokenSummonFlag(tokenDoc) {
	return tokenDoc?.getFlag?.(MODULE_ID, SUMMON_FLAG) ?? tokenDoc?.flags?.[MODULE_ID]?.[SUMMON_FLAG] ?? null;
}

// Total character level = one entry per level in classData.levels (matches the
// system's own `_prepareLevelData`).
function getCharacterLevel(actor) {
	const levels = actor?.system?.classData?.levels;
	return Array.isArray(levels) ? levels.length : 0;
}

function getAbilityMod(actor, ability) {
	return Number(actor?.system?.abilities?.[ability]?.mod ?? 0);
}

// Die-size steps walk the standard ladder (upcast "+1 die step" semantics), so
// a d12 steps straight to a d20 — never a nonstandard d14/16/18.
const SUMMON_DIE_LADDER = [4, 6, 8, 10, 12, 20];

// Step `baseFaces` up the standard die ladder by `steps`, then clamp DOWN to the
// largest ladder value <= `maxFaces` (a d12 cap yields d6/d8/d10/d12; a d20 cap
// yields d6→d8→d10→d12→d20). If baseFaces isn't a standard die, fall back to the
// old +2-faces arithmetic as a safety net.
function stepSummonDie(baseFaces, steps, maxFaces) {
	const start = SUMMON_DIE_LADDER.indexOf(baseFaces);
	if (start === -1) return Math.min(maxFaces, baseFaces + 2 * steps);
	const stepped = SUMMON_DIE_LADDER[Math.min(start + steps, SUMMON_DIE_LADDER.length - 1)];
	// Largest standard die that fits under the cap (fall back to baseFaces should
	// the cap somehow sit below every ladder entry).
	let cap = baseFaces;
	for (const faces of SUMMON_DIE_LADDER) {
		if (faces <= maxFaces) cap = faces;
	}
	return Math.min(stepped, cap);
}

// A summon flag may declare featureBoosts: bonuses granted when the caster owns
// a specific feature (e.g. the Shepherd Sacred Grace "Empowered Companion":
// +1 effective mana ignoring tier restrictions, die cap raised to d20). Each
// entry applies AT MOST ONCE — the grace cannot be owned more than once, and a
// duplicated item still counts a single time. Returns an aggregate
// { bonusMana, maxFacesOverride, uncapTier } (0 / null / false when the caster
// owns none).
function getSummonFeatureBoosts(summon, actor) {
	const result = {
		bonusMana: 0,
		maxFacesOverride: null,
		uncapTier: false,
		reachBonus: 0,
		formulaOverride: null,
	};
	const boosts = summon?.featureBoosts;
	if (!Array.isArray(boosts) || !(actor instanceof Actor)) return result;

	// Snapshot the caster's feature items once for cheap identifier/name matching.
	const features = [];
	for (const it of actor.items ?? []) {
		if (it?.type === 'feature') features.push(it);
	}

	for (const entry of boosts) {
		if (!entry || typeof entry !== 'object') continue;
		// The owned item's identifier is often EMPTY in the core pack, so match on
		// identifier OR exact (case-sensitive) name — either counts the entry once.
		const owned = features.some(
			(it) =>
				(entry.feature && it.system?.identifier === entry.feature) ||
				(entry.name && it.name === entry.name),
		);
		if (!owned) continue;
		result.bonusMana += Number(entry.bonusMana) || 0;
		const faces = Number(entry.maxFaces) || 0;
		if (faces > (result.maxFacesOverride ?? 0)) result.maxFacesOverride = faces;
		if (entry.uncapsTierLimit === true) result.uncapTier = true;
		result.reachBonus += Number(entry.reachBonus) || 0;
		if (typeof entry.formulaOverride === 'string' && entry.formulaOverride) {
			result.formulaOverride = entry.formulaOverride; // last owned entry wins
		}
	}
	return result;
}

// Every live token, across all scenes, that this caster summoned of `template`.
// Iterating scene.tokens (never getDocuments) keeps this cheap and never stalls.
// Uses the caster's UUID rather than the (possibly stale) caster tracking flag,
// so a tracking flag pointing at a deleted token never produces a phantom.
function findLiveSummons(casterActor, template) {
	const out = [];
	const casterUuid = casterActor?.uuid;
	if (!casterUuid) return out;
	for (const scene of game.scenes ?? []) {
		for (const token of scene.tokens ?? []) {
			const flag = getTokenSummonFlag(token);
			if (!flag || flag.template !== template) continue;
			if (flag.summonerActorUuid !== casterUuid) continue;
			out.push(token);
		}
	}
	return out;
}

// Resolve the caster Actor recorded on a summoned token's flag.
function resolveSummonerFromToken(tokenDoc) {
	const uuid = getTokenSummonFlag(tokenDoc)?.summonerActorUuid;
	if (!uuid) return null;
	try {
		const doc = fromUuidSync?.(uuid);
		if (doc instanceof Actor) return doc;
		return doc?.actor instanceof Actor ? doc.actor : null;
	} catch {
		return null;
	}
}

// Post a brief summon chat card. `content` is trusted HTML (callers escape any
// interpolated names); `flavor` is a plain string.
function postSummonChat(actor, content, flavor) {
	try {
		const data = { content };
		if (actor) data.speaker = ChatMessage.getSpeaker({ actor });
		if (flavor) data.flavor = `<strong>${escapeHtml(flavor)}</strong>`;
		ChatMessage.create(data);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Could not post summon chat card`, error);
	}
}

// Import (once) or find the world actor backing a companion template.
async function resolveCompanionBaseActor(template) {
	const existing = game.actors?.find?.(
		(a) =>
			(a.getFlag?.(MODULE_ID, COMPANION_TEMPLATE_FLAG) ??
				a.flags?.[MODULE_ID]?.[COMPANION_TEMPLATE_FLAG]) === template,
	);
	if (existing) return existing;

	const pack = game.packs?.get?.(COMPANION_PACK);
	if (!pack) return null;

	// Index-only lookup, then a single getDocument — never getDocuments (stalls).
	const index = await pack.getIndex({ fields: [`flags.${MODULE_ID}.${COMPANION_TEMPLATE_FLAG}`] });
	const entry = index.find(
		(e) => foundry.utils.getProperty(e, `flags.${MODULE_ID}.${COMPANION_TEMPLATE_FLAG}`) === template,
	);
	if (!entry) return null;

	const source = await pack.getDocument(entry._id);
	if (!source) return null;

	return Actor.implementation.create(source.toObject(), { keepId: false });
}

// The actor's token document on `scene` (any scene when omitted: the viewed
// one first, then the active one, then any). getActiveTokens only sees the
// viewed canvas, which may not be the scene the actor is on.
function findActorTokenDoc(actor, scene) {
	if (!actor) return null;
	if (actor.token && (!scene || actor.token.parent?.id === scene.id)) return actor.token;
	const onScene = (sc) => sc?.tokens?.find?.((t) => t.actorId === actor.id && (t.actorLink || t.actor === actor)) ?? null;
	if (scene) return onScene(scene);
	const scenes = [canvas?.scene, game.scenes?.active, ...(game.scenes ?? [])].filter(Boolean);
	for (const sc of scenes) {
		const found = onScene(sc);
		if (found) return found;
	}
	return null;
}

// Adjacent to the caster's token, else the scene centre.
function computeSummonSpawnPosition(actor, scene) {
	const ownToken = findActorTokenDoc(actor, scene);
	const grid = scene?.grid?.size ?? 100;
	if (ownToken) return { x: ownToken.x + grid, y: ownToken.y };
	return {
		x: Math.round((scene?.dimensions?.sceneWidth ?? scene?.width ?? 4000) / 2),
		y: Math.round((scene?.dimensions?.sceneHeight ?? scene?.height ?? 4000) / 2),
	};
}

// Shared teardown for a single summoned token: delete it, clear the caster's
// matching unique-tracking flag, and (optionally) narrate why. Fully null-safe.
async function dismissSummon(tokenDoc, { reason, summonerActor, template } = {}) {
	try {
		const flag = getTokenSummonFlag(tokenDoc);
		const tmpl = template ?? flag?.template;
		const caster = summonerActor ?? resolveSummonerFromToken(tokenDoc);
		const tokenId = tokenDoc?.id;

		if (tokenDoc) {
			try {
				await tokenDoc.delete();
			} catch (error) {
				console.warn(`[${MODULE_ID}] Could not delete summoned token`, error);
			}
		}
		if (caster && tmpl) {
			try {
				const tracked = caster.getFlag?.(MODULE_ID, `${SUMMONS_TRACK_FLAG}.${tmpl}`);
				// Only clear the tracking flag if it points at the token we removed
				// (or we have no id to compare) — never clobber a newer summon.
				if (!tracked || !tokenId || tracked.tokenId === tokenId) {
					await caster.unsetFlag(MODULE_ID, `${SUMMONS_TRACK_FLAG}.${tmpl}`);
				}
			} catch (error) {
				console.warn(`[${MODULE_ID}] Could not clear summon tracking flag`, error);
			}
		}
		if (reason) postSummonChat(caster ?? null, reason);
	} catch (error) {
		console.warn(`[${MODULE_ID}] dismissSummon failed`, error);
	}
}

// Pre-activate gate (A): returns true when the cast must be BLOCKED. Runs inside
// the activate wrap, before any dialog/mana/chat card.
async function summonActivationBlocked(item) {
	const summon = getItemSummonAutomation(item);
	if (!summon) return false;
	const actor = item?.actor;
	if (!(actor instanceof Actor)) return false;

	// Turret Deployed!: a self-contained deploy flow (picker + cap/recast + HP
	// scaling) that runs entirely here and ALWAYS blocks the normal activation —
	// the feature's whole job is the deploy, so no generic chat card is needed and
	// a cancelled picker costs nothing (originalActivate never runs).
	if (summon.turretDeploy) {
		try {
			await handleTurretDeploy(item, actor, summon);
		} catch (error) {
			console.error(`[${MODULE_ID}] turret deploy failed`, error);
		}
		return true;
	}

	// 1. combat-only spells cannot be cast outside combat.
	if (summon.combatOnly && !game.combat?.started) {
		ui.notifications?.warn(`${item.name} can only be cast during combat.`);
		return true;
	}

	// 1b. Auto Deploy!'s free turret (countsTowardCap: false + expireOnCombatEnd)
	// is deployed automatically on combat start; a manual activation is only the
	// fallback for when it hasn't gone out yet, so block a second one in the same
	// combat rather than letting the Engineer stack free turrets.
	if (summon.countsTowardCap === false && summon.expireOnCombatEnd) {
		const free = findFreeAutoDeployTurret(actor, summon.template, game.combat?.id ?? null);
		if (free) {
			ui.notifications?.warn(
				`${actor.name} already deployed ${free.name ?? 'the free turret'} this combat.`,
			);
			return true;
		}
	}

	// 3. recast dismisses: if a live summon of this template exists, remove it
	// (no mana, since originalActivate never runs) and block. With no live
	// summon, fall through and let the cast proceed normally.
	if (summon.recastDismisses) {
		const live = findLiveSummons(actor, summon.template);
		if (live.length) {
			await dismissSummon(live[0], {
				summonerActor: actor,
				template: summon.template,
				reason: `<p><strong>${escapeHtml(live[0].name ?? 'Lifebinding Spirit')}</strong> dismissed.</p>`,
			});
			// Sweep any strays (shouldn't happen for a unique summon, but stay safe).
			for (let i = 1; i < live.length; i += 1) {
				await dismissSummon(live[i], { summonerActor: actor, template: summon.template });
			}
			return true;
		}
	}

	// 2. maxCount cap = min(<ability> mod, character level), floored at 0 — see
	//    SUMMON_COUNT_MODES for the per-mode ability.
	const countMode = SUMMON_COUNT_MODES[summon.maxCount];
	if (countMode) {
		const { noun } = countMode;
		const cap = summonCountCap(actor, summon);
		if (cap <= 0) {
			ui.notifications?.warn(`${actor.name} cannot summon any ${noun}s right now.`);
			return true;
		}
		const count = findLiveSummons(actor, summon.template).length;
		if (count >= cap) {
			ui.notifications?.warn(`${actor.name} already has the maximum ${cap} ${noun}${cap === 1 ? '' : 's'}.`);
			return true;
		}
	}

	return false;
}

// Create one summoned companion token: stamps the shared provenance/expiration
// flags every summon path relies on, then applies owned-feature reach/damage
// boosts to the spawned token's synthetic (unlinked) actor. Shared by the
// post-cast spawn (handleSummonSpawn) and the Swarming Shadows trigger, so a
// swarm-spawned minion inherits the same Shadow Magus reach/die as a cast one.
// `extraFlag` merges into the token summon flag (e.g. { charges } for healers).
async function spawnSummonedToken({ caster, summon, baseActor, scene, x, y, extraFlag } = {}) {
	if (!(caster instanceof Actor) || !baseActor || !scene) return null;

	const casterToken = caster.getActiveTokens?.(true, true)?.[0] ?? null;
	const tokenFlag = {
		template: summon.template,
		summonerActorUuid: caster.uuid,
		summonerTokenId: casterToken?.id ?? null,
	};
	if (summon.expireOnCombatEnd) tokenFlag.combatId = game.combat?.id ?? null;
	if (extraFlag && typeof extraFlag === 'object') Object.assign(tokenFlag, extraFlag);

	const tokenSrc = baseActor.prototypeToken.toObject();
	const tokenData = foundry.utils.mergeObject(
		tokenSrc,
		{
			name: baseActor.name,
			x,
			y,
			actorId: baseActor.id,
			actorLink: false,
			disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY,
			flags: { [MODULE_ID]: { [SUMMON_FLAG]: tokenFlag } },
		},
		{ inplace: false },
	);
	delete tokenData._id;

	const [created] = await scene.createEmbeddedDocuments('Token', [tokenData]);
	if (!created) return null;

	await patchSummonFeatureBoosts(created, summon, caster);
	return created;
}

// Apply owned-feature reach/damage boosts (e.g. Shadow Magus: +4 Reach, d10) and
// the spell's "Reach +1 every N levels" scaling to a spawned token's synthetic
// actor. Reach scaling always applies (a base spell feature); reachBonus and the
// damage formula override only apply when the caster owns the boost feature. The
// same technique as patchLifebindingSpiritFormulas — patch after creation on the
// unlinked token actor, rewriting both the mechanical fields and the visible
// attack-sequence / description text so the sheet reads correctly.
async function patchSummonFeatureBoosts(tokenDoc, summon, caster) {
	try {
		const synth = tokenDoc?.actor;
		if (!synth) return;

		const boosts = getSummonFeatureBoosts(summon, caster);
		const perLevels = Number(summon?.reachPerLevels) || 0;
		const levelReach = perLevels > 0 ? Math.floor(getCharacterLevel(caster) / perLevels) : 0;
		const reachBonus = (boosts.reachBonus || 0) + levelReach;
		const formulaOverride = boosts.formulaOverride;
		if (reachBonus <= 0 && !formulaOverride) return;

		const itemUpdates = [];
		const textReplacements = []; // { pattern: RegExp, to } applied to visible text

		for (const item of listEmbeddedItems(synth)) {
			const activation = item.system?.activation;
			if (!activation) continue;
			const update = { _id: item.id ?? item._id };
			let changed = false;
			let description = typeof item.system?.description === 'string' ? item.system.description : null;

			if (reachBonus > 0 && activation.targets?.attackType === 'reach') {
				const oldDistance = Number(activation.targets.distance) || 0;
				const newDistance = oldDistance + reachBonus;
				foundry.utils.setProperty(update, 'system.activation.targets.distance', newDistance);
				changed = true;
				const pattern = new RegExp(`(Reach:\\s*)${oldDistance}\\b`, 'g');
				textReplacements.push({ pattern, to: `$1${newDistance}` });
				if (description) description = description.replace(pattern, `$1${newDistance}`);
			}

			if (formulaOverride) {
				const effects = foundry.utils.deepClone(activation.effects ?? []);
				let effectsChanged = false;
				for (const node of effects) {
					if (node?.type !== 'damage' || typeof node.formula !== 'string' || !node.formula) continue;
					const oldFormula = node.formula;
					if (oldFormula !== formulaOverride) {
						const pattern = new RegExp(escapeRegExp(oldFormula), 'g');
						textReplacements.push({ pattern, to: formulaOverride });
						if (description) description = description.replace(pattern, formulaOverride);
					}
					node.formula = formulaOverride;
					effectsChanged = true;
				}
				if (effectsChanged) {
					foundry.utils.setProperty(update, 'system.activation.effects', effects);
					changed = true;
				}
			}

			if (changed) {
				if (description && description !== item.system?.description) {
					foundry.utils.setProperty(update, 'system.description', description);
				}
				itemUpdates.push(update);
			}
		}

		if (itemUpdates.length) await synth.updateEmbeddedDocuments('Item', itemUpdates);

		// Rewrite the actor-level free-text mirror of the attack (Reach / Damage).
		const seq = synth.system?.attackSequence;
		if (typeof seq === 'string' && seq && textReplacements.length) {
			let newSeq = seq;
			for (const { pattern, to } of textReplacements) newSeq = newSeq.replace(pattern, to);
			if (newSeq !== seq) {
				try {
					await synth.update({ 'system.attackSequence': newSeq });
				} catch (error) {
					console.warn(`[${MODULE_ID}] Could not rewrite summon attack-sequence text`, error);
				}
			}
		}
	} catch (error) {
		console.warn(`[${MODULE_ID}] Could not apply summon feature boosts`, error);
	}
}

// Post-cast spawn (B): fires from `useItem` after the summon spell resolves.
async function handleSummonSpawn(item, context) {
	const summon = getItemSummonAutomation(item);
	if (!summon) return;
	const caster = item?.actor;
	if (!(caster instanceof Actor)) return;

	const scene = canvas?.scene;
	if (!scene) {
		console.warn(`[${MODULE_ID}] No active scene to summon "${summon.template}" onto.`);
		return;
	}

	const baseActor = await resolveCompanionBaseActor(summon.template);
	if (!baseActor) {
		console.warn(`[${MODULE_ID}] Could not resolve companion template "${summon.template}".`);
		return;
	}

	// Reanimated Soul: several minions at once (one per Soul Power die).
	if (summon.spawnCount === 'soulPowerDice') {
		await spawnSoulPowerMinions(item, caster, summon, baseActor, scene);
		return;
	}

	const { x, y } = computeSummonSpawnPosition(caster, scene);

	// Mana actually spent = upcast amount, else the base tier cost.
	const manaSpent = Number(context?.upcast?.manaSpent ?? item?.system?.tier ?? 0) || 0;
	// Owned-feature bonuses (e.g. "Empowered Companion"). The REAL mana deduction
	// stays whatever the system already took; effectiveMana is a virtual total the
	// summon's charges and die scaling treat as if that much mana were spent.
	const boosts = getSummonFeatureBoosts(summon, caster);
	const effectiveMana = manaSpent + boosts.bonusMana;

	const extraFlag = {};
	if (summon.chargesFromMana) extraFlag.charges = effectiveMana;
	// Auto Deploy!'s rifle "does not count against your turret limit": tag it so
	// the Turret Deployed! cap counting (findLiveTurrets) skips it. It still expires
	// on combat end and remains individually dismissable.
	if (summon.countsTowardCap === false) extraFlag.excludeFromCap = true;
	const created = await spawnSummonedToken({ caster, summon, baseActor, scene, x, y, extraFlag });
	if (!created) {
		console.warn(`[${MODULE_ID}] Failed to spawn "${summon.template}" token.`);
		return;
	}

	// Turret threshold/HP + Engineer scaling. Used by Auto Deploy!'s manual
	// fallback; the Turret Deployed! picker path runs it in spawnTurret.
	if (summon.hpFromLevel || TURRET_TEMPLATE_SET.has(summon.template)) await applyTurretHp(created, caster);

	// Track unique summons on the caster so future casts can find/dismiss them.
	if (summon.unique) {
		try {
			await caster.setFlag(MODULE_ID, `${SUMMONS_TRACK_FLAG}.${summon.template}`, {
				tokenId: created.id,
				sceneId: scene.id,
			});
		} catch (error) {
			console.warn(`[${MODULE_ID}] Could not record unique summon tracking`, error);
		}
	}

	// Lifebinding Spirit: scale its die by upcast and bake in the caster's WIL.
	if (summon.upcastDieStep && typeof summon.upcastDieStep === 'object') {
		const baseFaces = Number(summon.upcastDieStep.baseFaces) || 6;
		const flagMax = Number(summon.upcastDieStep.maxFaces) || baseFaces;
		// A feature boost can raise the die cap (e.g. "Empowered Companion" → d20)
		// and add virtual mana steps. The higher of the flag cap / boost cap wins.
		const maxFaces = Math.max(flagMax, boosts.maxFacesOverride ?? 0);
		const steps = Math.max(0, Number(context?.upcast?.upcastSteps) || 0) + boosts.bonusMana;
		const faces = stepSummonDie(baseFaces, steps, maxFaces);
		await patchLifebindingSpiritFormulas(created, faces, getAbilityMod(caster, 'will'));
	}

	// School-gated bonus commands: keep only the spirit's commands whose required
	// spell school the caster knows (deletes the rest from the spawned token).
	let schoolGrant = { gated: false, granted: [] };
	try {
		schoolGrant = await applySchoolGatedAbilities(created, caster);
	} catch (error) {
		console.warn(`[${MODULE_ID}] school-gated ability filtering failed`, error);
	}

	// Summon chat card (with charge count for the spirit).
	let content = `<p>${escapeHtml(caster.name)} summons <strong>${escapeHtml(created.name ?? summon.template)}</strong>.</p>`;
	if (summon.chargesFromMana) {
		content += `<p>Heal charges remaining: <strong>${effectiveMana}</strong>.</p>`;
	}
	if (schoolGrant.gated) {
		const names = schoolGrant.granted.length
			? schoolGrant.granted.map(escapeHtml).join(', ')
			: 'none';
		content += `<p>School abilities: <strong>${names}</strong>.</p>`;
	}
	postSummonChat(caster, content, item?.name);
}

// ── Engineer turret deployment ───────────────────────────────────────────────
// Turrets reuse the summon primitives (companion pack, spawn position, dismiss,
// combat-end cleanup via the SUMMON_FLAG.combatId) but need a picker (the Engineer
// chooses which known turret to deploy), a cost, a 1/turn limit, level-scaled
// stats and a damage threshold, so Turret Deployed! runs this dedicated flow
// instead of the generic single-template spawn. The six turret companions live in
// the companion pack tagged companionTemplate "turret-<slug>".
//
// Resources (all native charge pools, corrected by hand from the sheet):
//   • Toolbelt scrap — actor pool `toolbelt` (toolbelt.json). Every module spend /
//     refund goes through spendPoolWithUndo / grantPoolWithUndo (undo card).
//   • Testing In Progress! — actor pool `testing-in-progress` (1/encounter free
//     deploy), offered in the picker when it has a charge.
//   • Optimized Activation — item pool `uses` on the Mechanist feature.
// The 1/turn limit is a per-combat-turn marker on the Engineer (not a resource);
// shift-click Turret Deployed! to override it. Master Technician lifts it.
//
// Turret token flag (SUMMON_FLAG) extras: threshold (destruction threshold),
// deployedAt (creation time → "oldest turret" when making room).
const TURRET_TEMPLATES = [
	{ template: 'turret-rifle', label: 'Rifle Turret' },
	{ template: 'turret-flame', label: 'Flame Turret' },
	{ template: 'turret-rocket', label: 'Rocket Turret' },
	{ template: 'turret-healing', label: 'Healing Turret' },
	{ template: 'turret-electro-net', label: 'Electro-Net Turret' },
	{ template: 'turret-thumper', label: 'Thumper Turret' },
];
const TURRET_TEMPLATE_SET = new Set(TURRET_TEMPLATES.map((t) => t.template));
const TURRET_TEMPLATE_FLAG = 'turretTemplate'; // turret pick features: flags.<module>.turretTemplate
const TOOLBELT_POOL = 'toolbelt';
const TESTING_IN_PROGRESS_POOL = 'testing-in-progress';
const TURRET_DEPLOY_TURN_FLAG = 'turretDeployTurn';
const TARGETING_MATRIX_FLAG = 'targetingMatrix';

function turretLabel(template) {
	return TURRET_TEMPLATES.find((t) => t.template === template)?.label ?? 'Turret';
}

// True when the caster owns a feature with the given identifier (or exact name —
// the identifier can be empty on some docs). Mirrors getSummonFeatureBoosts' match.
// Iterates via listEmbeddedItems so it also works on a spawned token's synthetic
// actor (same discipline as every other item scan in this file).
function actorOwnsFeature(actor, identifier, name) {
	return findOwnedFeature(actor, identifier, name) !== null;
}

// Same match as actorOwnsFeature, but hands back the owned Item so callers can
// read its automation flags — the feature JSON stays the single source of truth
// (e.g. Auto Deploy! declares which turret template it deploys).
function findOwnedFeature(actor, identifier, name) {
	for (const item of listEmbeddedItems(actor)) {
		if (item?.type !== 'feature') continue;
		if (identifier && item.system?.identifier === identifier) return item;
		if (name && item.name === name) return item;
	}
	return null;
}

// A turret's destruction threshold = the summoner's level, doubled by Mechanist's
// Extra Plating (L3). Also used as the token's HP so the sheet reads sensibly:
// the damage guard below keeps HP full on smaller hits and drops it to 0 (and
// destroys the turret) on a single hit >= threshold.
function turretHpForCaster(caster) {
	const level = Math.max(1, getCharacterLevel(caster));
	return actorOwnsFeature(caster, 'extra-plating', 'Extra Plating') ? level * 2 : level;
}

// The TokenDocument of a spawned turret, given its (synthetic) actor — null for
// anything else (world base actors, other summons, characters).
function getTurretTokenDoc(actor) {
	const tokenDoc = actor?.token ?? null;
	const flag = getTokenSummonFlag(tokenDoc);
	return flag && TURRET_TEMPLATE_SET.has(flag.template) ? tokenDoc : null;
}

// The Engineer's save DC (10 + KEY, KEY = highest class key stat — Nimble's own
// `@key` roll-data value). Falls back to INT when roll data is unavailable.
function engineerSaveDC(caster) {
	const key = Number(caster?.getRollData?.()?.key);
	return 10 + (Number.isFinite(key) ? key : getAbilityMod(caster, 'intelligence'));
}

// Overclocked tier: 1 from level 10 (+INT), 2 from level 16 (+1 die as well).
function overclockedTier(caster) {
	if (!actorOwnsFeature(caster, 'overclocked', 'Overclocked')) return 0;
	const level = getCharacterLevel(caster);
	if (level >= 16) return 2;
	return level >= 10 ? 1 : 0;
}

// Turret automation flags name the stat as "int" (contract) or "intelligence".
function isIntScaling(value) {
	return value === 'int' || value === 'intelligence';
}

// Rewrite a leading "NdF…" formula: replace the die count (diceCount), add dice
// (extraDice) and append a flat bonus. Non-dice formulas only get the bonus.
function scaleTurretFormula(formula, { diceCount = null, extraDice = 0, flatBonus = 0 } = {}) {
	const bonus = flatBonus ? ` ${flatBonus < 0 ? '-' : '+'} ${Math.abs(flatBonus)}` : '';
	const match = /^\s*(\d*)d(\d+)(.*)$/i.exec(formula);
	if (!match) return `${formula}${bonus}`;
	const count = Math.max(1, (diceCount ?? (Number(match[1]) || 1)) + extraDice);
	return `${count}d${match[2]}${match[3]}${bonus}`;
}

// Bake the summoning Engineer's numbers into a spawned turret's actions (the
// turret's own roll data is the NPC's, so @int etc. would read the turret):
//   automation.diceCount "int" → INT dice; automation.addInt → +INT;
//   Overclocked (1) → +INT, Overclocked (2) → +1 die, on every damage/healing node;
//   savingThrow nodes → saveDC = Engineer's DC;
//   automation.repeatsTimes "int" → name "(×INT)" + text; the shots themselves
//   are repeated activations in runWrappedActivate (see prepareTurretToolbelt).
// Same patch-after-creation technique as patchSummonFeatureBoosts. Each patched
// action gets a one-line "[A] Scaled to …" summary prepended to its description.
async function patchTurretScaling(tokenDoc, caster) {
	try {
		const synth = tokenDoc?.actor;
		if (!synth || !(caster instanceof Actor)) return;
		const int = getAbilityMod(caster, 'intelligence');
		const intCount = Math.max(1, int);
		const tier = overclockedTier(caster);
		const dc = engineerSaveDC(caster);
		const updates = [];
		for (const item of listEmbeddedItems(synth)) {
			const activation = item.system?.activation;
			if (!activation) continue;
			const auto = {
				diceCount: getItemAutomationFlag(item, 'diceCount'),
				addInt: getItemAutomationFlag(item, 'addInt'),
				repeatsTimes: getItemAutomationFlag(item, 'repeatsTimes'),
			};
			const effects = foundry.utils.deepClone(activation.effects ?? []);
			let changed = false;
			let shownFormula = null;
			let hasSave = false;
			const visit = (nodes) => {
				for (const node of Array.isArray(nodes) ? nodes : []) {
					if (!node || typeof node !== 'object') continue;
					if ((node.type === 'damage' || node.type === 'healing') && typeof node.formula === 'string' && node.formula) {
						const next = scaleTurretFormula(node.formula, {
							diceCount: isIntScaling(auto.diceCount) ? intCount : null,
							extraDice: tier >= 2 ? 1 : 0,
							flatBonus: (auto.addInt === true ? int : 0) + (tier >= 1 ? int : 0),
						});
						if (next !== node.formula) {
							node.formula = next;
							changed = true;
						}
						shownFormula ??= node.formula;
					}
					if (node.type === 'savingThrow') {
						node.saveDC = dc;
						hasSave = true;
						changed = true;
					}
					for (const children of Object.values(node.on ?? {})) visit(children);
					visit(node.sharedRolls);
				}
			};
			visit(effects);
			const repeats = isIntScaling(auto.repeatsTimes) ? intCount : 0;
			if (!changed && !repeats) continue;
			const bits = [];
			if (shownFormula) bits.push(escapeHtml(shownFormula));
			if (hasSave) bits.push(`save DC ${dc}`);
			if (repeats) bits.push(`fires ${repeats} times (one attack roll each)`);
			const update = { _id: item.id ?? item._id, 'system.activation.effects': effects };
			update['system.description'] =
				`<p><em>[A] Scaled to ${escapeHtml(caster.name)} (INT ${int}${tier ? `, Overclocked ${tier}` : ''}): ${bits.join(' · ')}.</em></p>` +
				(item.system?.description ?? '');
			if (repeats) update.name = `${item.name} (×${repeats})`;
			updates.push(update);
		}
		if (updates.length) await synth.updateEmbeddedDocuments('Item', updates);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Could not scale turret actions`, error);
	}
}

// Finalise a freshly spawned turret token: record its destruction threshold and
// deploy time on the token flag, set HP = threshold (sheet cue for the damage
// guard) and bake in the Engineer's scaling. Called by every turret spawn path
// (picker deploy, Auto Deploy! trigger, manual Auto Deploy! via handleSummonSpawn).
async function applyTurretHp(tokenDoc, caster) {
	try {
		const hp = turretHpForCaster(caster);
		const prior = getTokenSummonFlag(tokenDoc) ?? {};
		await tokenDoc.update({
			[`flags.${MODULE_ID}.${SUMMON_FLAG}.threshold`]: hp,
			[`flags.${MODULE_ID}.${SUMMON_FLAG}.deployedAt`]: prior.deployedAt ?? Date.now(),
		});
		const synth = tokenDoc?.actor;
		if (synth) {
			await synth.update(
				{ 'system.attributes.hp.max': hp, 'system.attributes.hp.value': hp },
				{ [MODULE_ID]: { turretSetup: true } },
			);
		}
	} catch (error) {
		console.warn(`[${MODULE_ID}] Could not set turret HP`, error);
	}
	await patchTurretScaling(tokenDoc, caster);
}

// The turret templates a caster can deploy: Rifle (Mechanical Mayhem 1) plus one
// per owned turret-pick feature (flags.<module>.turretTemplate, picked at
// L7/L11/L15). Characters from before the pick group existed own no picks: from
// level 7 they are offered every turret, with a one-time notice.
const turretFallbackNoticed = new Set();
function getKnownTurretTemplates(caster) {
	const known = new Set(['turret-rifle']);
	for (const item of listEmbeddedItems(caster)) {
		const template = item?.flags?.[MODULE_ID]?.[TURRET_TEMPLATE_FLAG];
		if (typeof template === 'string' && TURRET_TEMPLATE_SET.has(template)) known.add(template);
	}
	if (known.size === 1 && getCharacterLevel(caster) >= 7) {
		if (!turretFallbackNoticed.has(caster.uuid)) {
			turretFallbackNoticed.add(caster.uuid);
			const text = `${caster.name} has no turret picks on the sheet (Mechanical Mayhem 2–4) — offering every turret. Add the chosen turret features from the class-features compendium to narrow the list.`;
			console.info(`[${MODULE_ID}] ${text}`);
			ui.notifications?.info(text);
		}
		return TURRET_TEMPLATES;
	}
	return TURRET_TEMPLATES.filter((t) => known.has(t.template));
}

// Every live turret this caster has out, across all six templates, that counts
// toward the Turret Deployed! cap, OLDEST FIRST (deployedAt). Excludes Auto
// Deploy!'s free rifle (tagged `excludeFromCap` at spawn) so a picker deploy never
// dismisses it.
function findLiveTurrets(caster) {
	const out = [];
	for (const { template } of TURRET_TEMPLATES) {
		for (const token of findLiveSummons(caster, template)) {
			if (getTokenSummonFlag(token)?.excludeFromCap === true) continue;
			out.push(token);
		}
	}
	const deployedAt = (token) => Number(getTokenSummonFlag(token)?.deployedAt) || 0;
	return out.sort((a, b) => deployedAt(a) - deployedAt(b));
}

// "combatId:round:turn" of a started combat, else null (no 1/turn limit outside
// combat).
function combatTurnKey(combat) {
	return combat?.started ? `${combat.id}:${combat.round}:${combat.turn}` : null;
}

function isShiftHeld() {
	try {
		return Boolean(game.keyboard?.isModifierActive?.('Shift'));
	} catch {
		return false;
	}
}

// Present the "which turret / how to pay" picker; returns { template, useFree }
// or null if cancelled. Skipped (auto-answer) when only Rifle is known and no
// free deploy is available.
async function promptTurretChoice(caster, known, { scrap = null, freeAvailable = false } = {}) {
	if (known.length === 1 && !freeAvailable) return { template: known[0].template, useFree: false };
	const rows = known
		.map(
			(t, i) => `
			<label class="blue-codex-turret-pick">
				<input type="radio" name="blue-codex-turret" value="${escapeHtml(t.template)}" ${i === 0 ? 'checked' : ''}>
				<span>${escapeHtml(t.label)}</span>
			</label>`,
		)
		.join('');
	const scrapText = scrap ? `1 Toolbelt scrap (${scrap.current}/${scrap.max} left)` : '1 Toolbelt scrap (no counter found — deduct by hand)';
	const costRows = freeAvailable
		? `<p><strong>Cost:</strong></p>
			<label class="blue-codex-turret-pick">
				<input type="radio" name="blue-codex-turret-cost" value="free" checked>
				<span>Testing In Progress! — free (1/encounter)</span>
			</label>
			<label class="blue-codex-turret-pick">
				<input type="radio" name="blue-codex-turret-cost" value="scrap" ${scrap && scrap.current > 0 ? '' : 'disabled'}>
				<span>${escapeHtml(scrapText)}</span>
			</label>`
		: `<p><strong>Cost:</strong> ${escapeHtml(scrapText)}</p>`;
	return foundry.applications.api.DialogV2.wait({
		window: { title: `${caster.name} — Deploy Turret` },
		content: `<form class="blue-codex-turret-form">
				<p>Choose which turret to deploy in an adjacent space:</p>
				<div class="blue-codex-turret-list">${rows}</div>
				${costRows}
			</form>
			<style>
				.blue-codex-turret-pick{display:flex;gap:8px;align-items:center;padding:3px 0;cursor:pointer}
			</style>`,
		buttons: [
			{
				action: 'confirm',
				label: 'Deploy',
				default: true,
				callback: (_event, button, dialog) => {
					const root = dialog?.element ?? button?.closest?.('.application') ?? button?.form ?? document;
					const template = root.querySelector('input[name="blue-codex-turret"]:checked')?.value ?? null;
					const cost = root.querySelector('input[name="blue-codex-turret-cost"]:checked')?.value ?? 'scrap';
					return template ? { template, useFree: cost === 'free' } : null;
				},
			},
		],
		rejectClose: false,
		modal: true,
	}).catch(() => null);
}

// Spawn a single turret token of `template` with level-scaled HP/stats and
// provenance. Mirrors handleSummonSpawn's token construction but for a
// caller-chosen template.
async function spawnTurret(caster, template, summon) {
	// The Engineer's own scene (the viewing client may be looking elsewhere).
	const scene = findActorTokenDoc(caster)?.parent ?? canvas?.scene;
	if (!scene) {
		console.warn(`[${MODULE_ID}] No active scene to deploy "${template}" onto.`);
		return null;
	}
	const baseActor = await resolveCompanionBaseActor(template);
	if (!baseActor) {
		console.warn(`[${MODULE_ID}] Could not resolve turret template "${template}".`);
		return null;
	}
	const { x, y } = computeSummonSpawnPosition(caster, scene);
	const created = await spawnSummonedToken({
		caster,
		summon: { ...summon, template },
		baseActor,
		scene,
		x,
		y,
		extraFlag: { deployedAt: Date.now() },
	});
	if (!created) {
		console.warn(`[${MODULE_ID}] Failed to deploy "${template}" token.`);
		return null;
	}
	await applyTurretHp(created, caster);
	return created;
}

// Turret Deployed! flow: combat check → 1/turn check (shift-click overrides;
// Master Technician lifts it) → picker (+ free-deploy choice) → pay (undo card) →
// make room under the cap (oldest first; "deploying another destroys the previous
// one") → spawn. Mechanist's Master Technician raises the cap from 1 to 2. A
// cancelled picker deploys nothing and costs nothing.
async function handleTurretDeploy(item, caster, summon) {
	if (summon.combatOnly && !game.combat?.started) {
		ui.notifications?.warn(`${item.name} can only be used during combat.`);
		return;
	}
	const masterTechnician = actorOwnsFeature(caster, 'master-technician', 'Master Technician');
	const turnKey = combatTurnKey(game.combat);
	if (!masterTechnician && turnKey && !isShiftHeld() && caster.getFlag?.(MODULE_ID, TURRET_DEPLOY_TURN_FLAG) === turnKey) {
		ui.notifications?.warn(
			`${caster.name} already deployed a turret this turn (Turret Deployed! is 1/turn). Shift-click the action to deploy anyway.`,
		);
		return;
	}

	const scrap = getChargePoolEntry(caster, TOOLBELT_POOL);
	const freeAvailable = (getChargePoolEntry(caster, TESTING_IN_PROGRESS_POOL)?.current ?? 0) > 0;
	if (scrap && scrap.current < 1 && !freeAvailable) {
		ui.notifications?.warn(
			`${caster.name} has no Toolbelt scrap left. If that is wrong, click the Toolbelt counter on the sheet to fix it.`,
		);
		return;
	}

	const known = getKnownTurretTemplates(caster);
	const choice = await promptTurretChoice(caster, known, { scrap, freeAvailable });
	const template = choice?.template;
	if (!template || !TURRET_TEMPLATE_SET.has(template)) return; // cancelled — free
	const label = turretLabel(template);

	// Pay first (each spend posts its own undo card); a refused spend deploys nothing.
	if (choice.useFree) {
		const paid = await spendPoolWithUndo(caster, TESTING_IN_PROGRESS_POOL, 1, {
			label: 'Testing In Progress! free deploy',
			reason: `deploying a ${label}`,
		});
		if (!paid) return;
	} else if (scrap) {
		const paid = await spendPoolWithUndo(caster, TOOLBELT_POOL, 1, {
			label: 'Toolbelt scrap',
			reason: `Turret Deployed!: ${label}`,
		});
		if (!paid) return;
	} else {
		ui.notifications?.warn(`${caster.name} has no Toolbelt counter on the sheet — deduct the scrap by hand.`);
	}

	// Cap: base maxCount (1), raised to 2 by Master Technician. Make room by
	// dismissing the OLDEST live turret(s) so the new one fits under the cap.
	let cap = Number(summon.maxCount) || 1;
	if (masterTechnician) cap = Math.max(cap, 2);
	const live = findLiveTurrets(caster);
	const overflow = live.length - (cap - 1);
	for (let i = 0; i < overflow && i < live.length; i += 1) {
		// eslint-disable-next-line no-await-in-loop
		await removeTurretToken(live[i], caster);
	}

	const created = await spawnTurret(caster, template, summon);
	if (!created) {
		ui.notifications?.warn(`Deploying the ${label} failed — use Undo on the cost card to get the resource back.`);
		return;
	}
	if (turnKey) {
		try {
			await caster.setFlag(MODULE_ID, TURRET_DEPLOY_TURN_FLAG, turnKey);
		} catch (error) {
			console.warn(`[${MODULE_ID}] Could not record the turret 1/turn marker`, error);
		}
	}
	postSummonChat(
		caster,
		`<p>${escapeHtml(caster.name)} deploys a <strong>${escapeHtml(label)}</strong>. It is destroyed by a single hit of <strong>${turretHpForCaster(caster)}+</strong> damage.</p>`,
		item?.name,
	);
}

// Delete a turret token with GM authority (players normally lack TOKEN_DELETE).
async function removeTurretToken(tokenDoc, caster, reason) {
	if (!tokenDoc) return;
	if (game.user?.isGM) {
		await dismissSummon(tokenDoc, { summonerActor: caster, template: getTokenSummonFlag(tokenDoc)?.template, reason });
		return;
	}
	await runAsGM('dismissTurret', { tokenUuid: tokenDoc.uuid, reason: reason ?? '' });
}

// Also used for Reanimated Soul minions: any summoned token (turret or not)
// whose owner or summoner's owner asked for its removal.
registerGMRelayOp('dismissTurret', async ({ tokenUuid, reason }, { user } = {}) => {
	const tokenDoc = tokenUuid ? fromUuidSync(tokenUuid) : null;
	if (!tokenDoc) return;
	if (!getTokenSummonFlag(tokenDoc)) return relayDenied('dismissTurret', user, `${tokenDoc.name} (not a summon)`);
	if (!userMayActForSummon(user, tokenDoc)) return relayDenied('dismissTurret', user, tokenDoc.name);
	await dismissSummon(tokenDoc, { reason: reason || undefined });
});

// Undo of a destroyed turret: recreate the token exactly as it was.
registerUndoHandler('restoreTurretToken', async ({ sceneId, tokenData }) => {
	const scene = game.scenes?.get(sceneId);
	if (!scene || !tokenData) return false;
	if (tokenData._id && scene.tokens?.get(tokenData._id)) return 'The turret is still on the scene.';
	await scene.createEmbeddedDocuments('Token', [tokenData], { keepId: true });
	return 'Turret restored.';
});

// ── Turret Toolbelt specials (turret NPC items with automation.turretToolbelt) ─
// "2 Actions and 1 Toolbelt scrap … The turret is destroyed afterwards." Runs in
// the activate wrap: a confirm dialog BEFORE the roll (cancel = no activation),
// then, once the activation resolved, the scrap spend (undo card on the
// Engineer) and the turret's removal. Mechanist's Optimized Activation (item pool
// `uses`) keeps the turret; further turrets activated in the same combat turn
// ride along for free ("activate all active turrets' abilities").
const optimizedActivationTurns = new Map(); // summoner uuid → turn key of the last Optimized Activation

async function prepareTurretToolbelt(item) {
	if (getItemAutomationFlag(item, 'turretToolbelt') !== true) return null;
	const tokenDoc = getTurretTokenDoc(item?.actor);
	if (!tokenDoc) return null; // world base actor / not a spawned turret — no automation
	const summoner = resolveSummonerFromToken(tokenDoc);
	if (!summoner) {
		ui.notifications?.warn(
			`Could not find the Engineer who deployed ${tokenDoc.name} — spend the scrap and remove the turret by hand.`,
		);
		return null;
	}
	const scrap = getChargePoolEntry(summoner, TOOLBELT_POOL);
	// Ride-along is scoped to one combat turn; outside combat there is no turn to
	// share, so every activation pays (and Optimized Activation arms nothing).
	const turnKey = combatTurnKey(game.combat);
	const rideAlong = !!turnKey && optimizedActivationTurns.get(summoner.uuid) === turnKey;
	const oaFeature = findOwnedFeature(summoner, 'optimized-activation', 'Optimized Activation');
	const oaUses = oaFeature ? getChargePoolEntry(summoner, 'uses', { item: oaFeature }) : null;
	const hasScrap = !scrap || scrap.current >= 1;

	const buttons = [];
	if (hasScrap) buttons.push({ action: 'destroy', label: 'Spend 1 scrap, destroy turret', default: true });
	if (hasScrap && oaUses && oaUses.current > 0) {
		buttons.push({ action: 'optimized', label: 'Optimized Activation (1 scrap + 1/Safe Rest use, turret stays)' });
	}
	if (rideAlong) buttons.push({ action: 'rideAlong', label: "Part of this turn's Optimized Activation (free, turret stays)" });
	if (!buttons.length) {
		ui.notifications?.warn(
			`${summoner.name} has no Toolbelt scrap left. If that is wrong, click the Toolbelt counter on the sheet to fix it.`,
		);
		return { blocked: true };
	}
	buttons.push({ action: 'cancel', label: 'Cancel' });
	const scrapText = scrap ? `${scrap.current}/${scrap.max} left` : 'no counter found — deduct it by hand';
	const mode = await foundry.applications.api.DialogV2.wait({
		window: { title: `${tokenDoc.name} — ${item.name}` },
		content: `<p>Using <strong>${escapeHtml(item.name)}</strong> spends <strong>1 Toolbelt scrap</strong> from <strong>${escapeHtml(summoner.name)}</strong> (${escapeHtml(scrapText)}) and destroys <strong>${escapeHtml(tokenDoc.name)}</strong> afterwards.</p>`,
		buttons,
		rejectClose: false,
		modal: true,
	}).catch(() => null);
	if (!mode || mode === 'cancel') return { blocked: true };

	const shots = isIntScaling(getItemAutomationFlag(item, 'repeatsTimes'))
		? Math.max(1, getAbilityMod(summoner, 'intelligence'))
		: 1;
	return {
		blocked: false,
		shots,
		complete: async () => {
			const reason = `${item.name} (${tokenDoc.name})`;
			if (mode === 'rideAlong') return;
			if (mode === 'optimized') {
				await spendPoolWithUndo(summoner, 'uses', 1, { item: oaFeature, label: 'Optimized Activation use', reason });
				if (turnKey) optimizedActivationTurns.set(summoner.uuid, turnKey);
			}
			if (scrap) await spendPoolWithUndo(summoner, TOOLBELT_POOL, 1, { label: 'Toolbelt scrap', reason });
			if (mode === 'destroy') {
				await removeTurretToken(
					tokenDoc,
					summoner,
					`<p><strong>${escapeHtml(tokenDoc.name)}</strong> is destroyed after its Toolbelt special.</p>`,
				);
			}
		},
	};
}

// ── Turret damage threshold ──────────────────────────────────────────────────
// "Destroyed when it takes one instance of damage equal to LVL" (2×LVL with Extra
// Plating). HP is kept at the threshold: a smaller hit is ignored (HP stays
// full), a big enough hit drops HP to 0 and removes the token afterwards, with an
// Undo card that recreates it. preUpdateActor only fires on the client that
// applies the damage, so this runs there (removal is GM-relayed).
const pendingTurretDestroy = new Map(); // token uuid → { damage, threshold, tokenData }

Hooks.on('preUpdateActor', (actor, changes, options) => {
	try {
		if (options?.[MODULE_ID]?.turretSetup) return;
		const tokenDoc = getTurretTokenDoc(actor);
		if (!tokenDoc) return;
		const threshold = Number(getTokenSummonFlag(tokenDoc)?.threshold) || 0;
		if (threshold <= 0) return;
		// One hit = the HP drop plus whatever temp HP absorbed of it.
		const next = foundry.utils.getProperty(changes, 'system.attributes.hp.value');
		const nextTemp = foundry.utils.getProperty(changes, 'system.attributes.hp.temp');
		if (typeof next !== 'number' && typeof nextTemp !== 'number') return;
		const current = Number(actor.system?.attributes?.hp?.value) || 0;
		const currentTemp = Number(actor.system?.attributes?.hp?.temp) || 0;
		const hpDrop = typeof next === 'number' ? Math.max(0, current - next) : 0;
		const tempDrop = typeof nextTemp === 'number' ? Math.max(0, currentTemp - nextTemp) : 0;
		const damage = hpDrop + tempDrop;
		if (damage <= 0) return; // healing / manual raise
		if (damage >= threshold) {
			foundry.utils.setProperty(changes, 'system.attributes.hp.value', 0);
			pendingTurretDestroy.set(tokenDoc.uuid, { damage, threshold, tokenData: tokenDoc.toObject() });
			return;
		}
		// Too small: the hit is ignored entirely (HP and temp HP stay).
		if (typeof next === 'number') foundry.utils.setProperty(changes, 'system.attributes.hp.value', current);
		if (typeof nextTemp === 'number') foundry.utils.setProperty(changes, 'system.attributes.hp.temp', currentTemp);
		postSummonChat(
			resolveSummonerFromToken(tokenDoc),
			`<p><strong>${escapeHtml(tokenDoc.name)}</strong> shrugs off ${damage} damage — only a single hit of <strong>${threshold}+</strong> destroys it.</p>`,
		);
	} catch (error) {
		console.warn(`[${MODULE_ID}] turret damage guard failed`, error);
	}
});

Hooks.on('updateActor', (actor, _changes, _options, userId) => {
	if (userId !== game.user?.id) return;
	const tokenDoc = getTurretTokenDoc(actor);
	const pending = tokenDoc ? pendingTurretDestroy.get(tokenDoc.uuid) : null;
	if (!pending) return;
	pendingTurretDestroy.delete(tokenDoc.uuid);
	void (async () => {
		const summoner = resolveSummonerFromToken(tokenDoc);
		const sceneId = tokenDoc.parent?.id ?? null;
		await removeTurretToken(tokenDoc, summoner);
		await postUndoCard({
			actor: summoner,
			text: `<p><strong>${escapeHtml(tokenDoc.name)}</strong> takes ${pending.damage} damage (threshold ${pending.threshold}) and is destroyed.</p>`,
			undoAction: { type: 'restoreTurretToken', data: { sceneId, tokenData: pending.tokenData } },
		});
	})().catch((error) => console.warn(`[${MODULE_ID}] turret destruction failed`, error));
});

// ── Targeting Matrix (Mechanist L7) & Tool Wrench recall ─────────────────────
// Targeting Matrix: "When a turret deals damage to an enemy, the next attack
// against it has advantage." A turret's damaging action that doesn't miss drops
// a visible, deletable "Targeting Matrix" ActiveEffect on each non-friendly
// target; the next attack roll (by anyone) targeting a marked creature is
// pre-set to advantage in the roll dialog and consumes the mark(s).
// Tool Wrench: using it while targeting your own turret offers to undeploy the
// turret and regain its Toolbelt scrap (undo card).
function itemDealsDamage(item) {
	const hasDamage = (nodes) =>
		(Array.isArray(nodes) ? nodes : []).some(
			(node) =>
				node?.type === 'damage' ||
				Object.values(node?.on ?? {}).some(hasDamage) ||
				hasDamage(node?.sharedRolls),
		);
	return hasDamage(item?.system?.activation?.effects);
}

function getTargetingMatrixMarks(actor) {
	return [...(actor?.effects ?? [])].filter((effect) => effect?.getFlag?.(MODULE_ID, TARGETING_MATRIX_FLAG) === true);
}

async function createTargetingMatrixMark(actor, sourceName) {
	if (!actor || getTargetingMatrixMarks(actor).length) return;
	await actor.createEmbeddedDocuments('ActiveEffect', [
		{
			name: 'Targeting Matrix',
			img: 'icons/svg/target.svg',
			description: `<p>The next attack against this creature has advantage (Targeting Matrix${sourceName ? `, from ${escapeHtml(sourceName)}` : ''}). Consumed by the next attack roll that targets it; delete it by hand if it was not used.</p>`,
			disabled: false,
			transfer: false,
			flags: { [MODULE_ID]: { [TARGETING_MATRIX_FLAG]: true } },
		},
	]);
}

// Only an owner of the turret (or of its Engineer) may mark on its behalf.
registerGMRelayOp('targetingMatrixMark', async ({ actorUuid, sourceName, turretTokenUuid }, { user } = {}) => {
	const turretToken = turretTokenUuid ? fromUuidSync(turretTokenUuid) : null;
	if (!getTurretTokenDoc(turretToken?.actor) || !userMayActForSummon(user, turretToken)) {
		return relayDenied('targetingMatrixMark', user, turretToken?.name ?? 'an unknown turret');
	}
	return createTargetingMatrixMark(resolveActorByUuid(actorUuid), sourceName);
});
// Anyone's attack consumes a Targeting Matrix mark, so the relay deletes only
// effects that ARE such marks (or that the requester owns anyway).
registerGMRelayOp('deleteEffects', async ({ effectUuids }, { user } = {}) => {
	for (const uuid of effectUuids ?? []) {
		try {
			const effect = fromUuidSync(uuid);
			if (!effect) continue;
			const allowed =
				user?.isGM ||
				effect.getFlag?.(MODULE_ID, TARGETING_MATRIX_FLAG) === true ||
				effect.testUserPermission?.(user, 'OWNER');
			if (!allowed) {
				relayDenied('deleteEffects', user, effect.name);
				continue;
			}
			// eslint-disable-next-line no-await-in-loop
			await effect.delete();
		} catch {
			/* already gone */
		}
	}
});

async function applyTargetingMatrix(item, context) {
	const tokenDoc = getTurretTokenDoc(item?.actor);
	if (!tokenDoc || context?.isMiss === true || !itemDealsDamage(item)) return;
	const summoner = resolveSummonerFromToken(tokenDoc);
	if (!summoner || !actorOwnsFeature(summoner, 'targeting-matrix', 'Targeting Matrix')) return;
	for (const token of context?.targets ?? []) {
		const target = token?.actor ?? token?.document?.actor;
		const disposition = token?.document?.disposition ?? token?.disposition;
		if (!target || target === summoner || disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY) continue;
		if (getTargetingMatrixMarks(target).length) continue;
		// eslint-disable-next-line no-await-in-loop
		if (target.isOwner) await createTargetingMatrixMark(target, tokenDoc.name);
		else {
			// eslint-disable-next-line no-await-in-loop
			await runAsGM('targetingMatrixMark', {
				actorUuid: target.uuid,
				sourceName: tokenDoc.name,
				turretTokenUuid: tokenDoc.uuid,
			});
		}
	}
}

// activate-wrap helper: the Targeting Matrix marks on this user's current
// targets when `item` is a to-hit attack (empty otherwise).
function collectTargetingMatrixMarks(item) {
	if (!item?.actor || !isAttackItem(item)) return [];
	const marks = [];
	for (const token of game.user?.targets ?? []) marks.push(...getTargetingMatrixMarks(token?.actor));
	return marks;
}

async function consumeTargetingMatrixMarks(marks) {
	const own = marks.filter((mark) => mark.isOwner);
	const relayed = marks.filter((mark) => !mark.isOwner).map((mark) => mark.uuid);
	for (const mark of own) {
		try {
			// eslint-disable-next-line no-await-in-loop
			await mark.delete();
		} catch {
			/* already gone */
		}
	}
	if (relayed.length) await runAsGM('deleteEffects', { effectUuids: relayed });
}

// The wrench weapon itself (the damaging `tool-wrench` object), not the gadget
// feature that grants it; any item can opt in with automation.turretRecall.
function isToolWrench(item) {
	if (getItemAutomationFlag(item, 'turretRecall') === true) return true;
	return item?.system?.identifier === 'tool-wrench' && item?.type !== 'feature' && itemDealsDamage(item);
}

// The recall refunds the scrap the wrench's own chargeConsumer took (net 0), so
// it must know whether Nimble actually charged it: an unequipped object's rules
// are off, and the system's resource-spending automation can be disabled. Nimble
// emits `<sys>.chargePool.consumed` after persisting a consumption (async, from
// its own useItem listener) — record when the wrench was charged.
const toolWrenchChargedAt = new Map(); // item uuid → Date.now() of the last charge

function onChargePoolConsumed(payload) {
	const item = payload?.item;
	if (!item?.uuid || !isToolWrench(item)) return;
	const charged = (payload?.consumption ?? []).some((entry) => (Number(entry?.cost) || 0) > 0);
	if (charged) toolWrenchChargedAt.set(item.uuid, Date.now());
}
Hooks.once('init', () => Hooks.on(`${game.system?.id ?? 'nimble'}.chargePool.consumed`, onChargePoolConsumed));

function isResourceSpendingAutomationOn() {
	try {
		const value = game.settings?.get(game.system?.id ?? 'nimble', 'automation.resourceSpending');
		return value === undefined ? true : Boolean(value);
	} catch {
		return true;
	}
}

// Wait (briefly) for the wrench's consumption record from this use.
async function toolWrenchWasCharged(item, since) {
	if (!isResourceSpendingAutomationOn()) return false;
	for (let waited = 0; waited <= 2000; waited += 100) {
		if ((toolWrenchChargedAt.get(item.uuid) ?? 0) >= since) return true;
		// eslint-disable-next-line no-await-in-loop
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
}

async function handleToolWrenchRecall(item, context) {
	if (!isToolWrench(item)) return;
	const actor = item?.actor;
	if (!(actor instanceof Actor)) return;
	const usedAt = Date.now() - 1000;
	for (const token of context?.targets ?? []) {
		const tokenDoc = token?.document ?? token;
		const flag = getTokenSummonFlag(tokenDoc);
		if (!flag || !TURRET_TEMPLATE_SET.has(flag.template) || flag.summonerActorUuid !== actor.uuid) continue;
		// eslint-disable-next-line no-await-in-loop
		const confirmed = await foundry.applications.api.DialogV2.confirm({
			window: { title: `${item.name} — Recall Turret` },
			content: `<p>Undeploy <strong>${escapeHtml(tokenDoc.name)}</strong> and regain its Toolbelt scrap?</p>`,
			rejectClose: false,
			modal: true,
		}).catch(() => false);
		if (!confirmed) continue;
		// eslint-disable-next-line no-await-in-loop
		await removeTurretToken(tokenDoc, actor, `<p><strong>${escapeHtml(tokenDoc.name)}</strong> is recalled.</p>`);
		// Refund only what this use actually cost (and only once per use).
		// eslint-disable-next-line no-await-in-loop
		if (await toolWrenchWasCharged(item, usedAt)) {
			toolWrenchChargedAt.delete(item.uuid);
			// eslint-disable-next-line no-await-in-loop
			await grantPoolWithUndo(actor, TOOLBELT_POOL, 1, { label: 'Toolbelt scrap', reason: `recalled ${tokenDoc.name}` });
		} else {
			postSummonChat(
				actor,
				`<p>${escapeHtml(actor.name)} recalls <strong>${escapeHtml(tokenDoc.name)}</strong>. No Toolbelt scrap was charged for this ${escapeHtml(item.name)} use (item unequipped or Nimble's resource spending off), so none is refunded — adjust the Toolbelt counter on the sheet if needed.</p>`,
				item.name,
			);
		}
	}
}

// useItem entry point for the turret section (called from onItemUsed).
async function handleTurretUseItem(item, context) {
	try {
		await applyTargetingMatrix(item, context);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Targeting Matrix failed`, error);
	}
	try {
		await handleToolWrenchRecall(item, context);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Tool Wrench recall failed`, error);
	}
}

// ── Auto Deploy! (Engineer L7) ───────────────────────────────────────────────
// "When you roll initiative, you automatically deploy a Rifle Turret. This does
// not count against your turret limit and does not cost a Toolbelt scrap."
// The turret is spawned by the module on combat start (and when an Engineer is
// added to an already-running combat) instead of on the individual initiative
// roll: Nimble rolls initiative for the whole party at once, so combat start is
// the single moment every Engineer's rifle should appear.
//
// Everything about WHAT gets deployed (template, HP scaling, combat expiry) is
// read from the owned feature item's automation flag, so auto-deploy.json stays
// the single source of truth — this code only supplies the trigger.
const AUTO_DEPLOY_IDENTIFIER = 'auto-deploy';
const AUTO_DEPLOY_NAME = 'Auto Deploy!';

// The free rifle is tagged { excludeFromCap, combatId } at spawn. Both the
// trigger and a manual activation look for that exact tag before deploying, so
// the turret can never be put out twice in the same combat (double `combatStart`
// hooks, a re-added combatant, or the player clicking the feature afterwards).
function findFreeAutoDeployTurret(caster, template, combatId) {
	if (!combatId || !template) return null;
	for (const token of findLiveSummons(caster, template)) {
		const flag = getTokenSummonFlag(token);
		if (flag?.excludeFromCap === true && flag.combatId === combatId) return token;
	}
	return null;
}

// Only one client may create tokens. Prefer the designated active GM; fall back
// to any GM when that API is unavailable (mirrors onDeleteCombat's gate).
function isActingGM() {
	return game.users?.activeGM ? game.users.activeGM.isSelf : Boolean(game.user?.isGM);
}

// Deploy one combatant's free rifle turret, if it owns Auto Deploy! and hasn't
// already got this combat's turret out. Silent no-op for everyone else.
async function autoDeployForCombatant(combatant, combat) {
	const combatId = combat?.id;
	const actor = combatant?.actor;
	if (!combatId || !(actor instanceof Actor)) return;
	if (!actorOwnsFeature(actor, AUTO_DEPLOY_IDENTIFIER, AUTO_DEPLOY_NAME)) return;

	const feature = findOwnedFeature(actor, AUTO_DEPLOY_IDENTIFIER, AUTO_DEPLOY_NAME);
	const summon = getItemSummonAutomation(feature);
	if (!summon?.template) return;

	// Spawn on the COMBAT's scene, next to the combatant's token — not on whatever
	// scene the acting GM happens to be viewing.
	const tokenDoc = combatant.token ?? null;
	const scene = tokenDoc?.parent ?? combat.scene ?? null;
	if (!tokenDoc || !scene) return;

	// Already out for this combat (trigger ran twice, or the player activated the
	// feature manually first) → nothing to do.
	if (findFreeAutoDeployTurret(actor, summon.template, combatId)) return;

	const baseActor = await resolveCompanionBaseActor(summon.template);
	if (!baseActor) {
		console.warn(`[${MODULE_ID}] Auto Deploy!: could not resolve turret template "${summon.template}".`);
		return;
	}

	// Position from the combatant's own token (getActiveTokens only sees the
	// viewed canvas, which may be another scene).
	const grid = scene.grid?.size ?? 100;
	const x = tokenDoc.x + grid;
	const y = tokenDoc.y;
	// combatId is pinned explicitly rather than left to spawnSummonedToken's
	// `game.combat` read: the combat that just started is not necessarily the
	// viewing client's active combat.
	const created = await spawnSummonedToken({
		caster: actor,
		summon,
		baseActor,
		scene,
		x,
		y,
		extraFlag: { excludeFromCap: true, combatId, deployedAt: Date.now() },
	});
	if (!created) {
		console.warn(`[${MODULE_ID}] Auto Deploy!: failed to spawn "${summon.template}" token.`);
		return;
	}

	// Threshold/HP + Engineer scaling apply to every turret, flag or not.
	const isTurret = summon.hpFromLevel || TURRET_TEMPLATE_SET.has(summon.template);
	if (isTurret) await applyTurretHp(created, actor);

	const hpNote = isTurret
		? ` (destroyed by a single hit of ${turretHpForCaster(actor)}+ damage)`
		: '';
	postSummonChat(
		actor,
		`<p>${escapeHtml(actor.name)} automatically deploys a <strong>${escapeHtml(created.name ?? 'Rifle Turret')}</strong>${hpNote}. It does not count against the turret limit and costs no scrap.</p>`,
		AUTO_DEPLOY_NAME,
	);
}

// Sequential on purpose: several Engineers in one combat each create a token, and
// serialising keeps the spawn positions/flags deterministic.
async function autoDeployForCombat(combat) {
	for (const combatant of combat?.combatants ?? []) {
		// eslint-disable-next-line no-await-in-loop
		await autoDeployForCombatant(combatant, combat);
	}
}

// combatStart: the normal path — every Engineer already in the tracker deploys.
function onCombatStart(combat) {
	try {
		if (!isActingGM()) return;
		void autoDeployForCombat(combat).catch((error) =>
			console.warn(`[${MODULE_ID}] Auto Deploy! on combat start failed`, error),
		);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Auto Deploy! on combat start failed`, error);
	}
}

// createCombatant: an Engineer dropped into an ALREADY-started combat deploys on
// joining. Combatants added before the encounter begins are covered by
// combatStart, so this only acts once `combat.started` is true.
function onCreateCombatant(combatant) {
	try {
		const combat = combatant?.parent;
		if (!combat?.started) return;
		if (!isActingGM()) return;
		void autoDeployForCombatant(combatant, combat).catch((error) =>
			console.warn(`[${MODULE_ID}] Auto Deploy! on combatant creation failed`, error),
		);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Auto Deploy! on combatant creation failed`, error);
	}
}

// Every embedded item on `actorLike` as a plain array, spanning both the live
// client (Foundry Collection → `.contents`) and the test harness (a plain array
// with a `getName` helper). Never triggers a getDocuments load.
function listEmbeddedItems(actorLike) {
	const items = actorLike?.items;
	if (!items) return [];
	if (Array.isArray(items.contents)) return items.contents;
	if (Array.isArray(items)) return items;
	try {
		return Array.from(items);
	} catch {
		return [];
	}
}

// Read a companion-item automation config (works for real Item docs via getFlag
// and for the plain-object items the harness/synthetic actors expose).
function getItemAutomationFlag(item, key) {
	const automation =
		item?.getFlag?.(MODULE_ID, 'automation') ??
		foundry.utils.getProperty(item, `flags.${MODULE_ID}.automation`);
	return automation ? automation[key] : undefined;
}

// Rewrite the summoned companion's roll formulas on the unlinked token's
// synthetic actor. Data-driven: every embedded item carrying a
// `automation.summonFormula` flag has its damage/healing node rewritten. Patched
// after creation (not via the create payload) to avoid fragile array-merge
// semantics — matches the nim-plus spirit.
//
//   summonFormula = { count?: 1, baseFaces, addWil?: bool, scalesWithUpcast?: bool }
//
// `scalesWithUpcast` items (Attack/Cure) use `steppedFaces` (the upcast die
// step); the rest (school-command abilities like Reap 3d4+WIL) use their own
// `baseFaces` unchanged. `addWil` bakes in the caster's WIL modifier with the
// exact "+ <wil>" rendering (WIL 0 → "+ 0", negatives → "+ -1").
async function patchLifebindingSpiritFormulas(tokenDoc, steppedFaces, wilMod) {
	try {
		const synth = tokenDoc?.actor;
		if (!synth) return;
		const updates = [];
		for (const item of listEmbeddedItems(synth)) {
			const cfg = getItemAutomationFlag(item, 'summonFormula');
			if (!cfg || typeof cfg !== 'object') continue;
			const count = Number(cfg.count) || 1;
			const faces = cfg.scalesWithUpcast ? steppedFaces : (Number(cfg.baseFaces) || 6);
			let formula = `${count}d${faces}`;
			if (cfg.addWil) formula += ` + ${wilMod}`;

			const effects = foundry.utils.deepClone(item.system?.activation?.effects ?? []);
			const node = effects.find((e) => e?.type === 'damage' || e?.type === 'healing');
			if (!node) continue;
			node.formula = formula;
			updates.push({ _id: item.id ?? item._id, system: { activation: { effects } } });
		}
		if (updates.length) await synth.updateEmbeddedDocuments('Item', updates);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Could not patch Lifebinding Spirit formulas`, error);
	}
}

// The set of spell schools a caster knows: distinct `system.school` over the
// caster's owned spell-type items. Iterates the actor's item list (never
// getDocuments) so it is cheap in the live client.
function getKnownSpellSchools(actor) {
	const schools = new Set();
	if (!(actor instanceof Actor)) return schools;
	for (const item of listEmbeddedItems(actor)) {
		if (item?.type !== 'spell') continue;
		const school = item.system?.school;
		if (typeof school === 'string' && school) schools.add(school);
	}
	return schools;
}

// School-gated bonus commands (Lifebinding Spirit): the full companion template
// carries one command per spell school; at summon time we DELETE every embedded
// item whose `automation.requiresSchool` the caster does NOT know, leaving only
// the granted commands. The compendium/world actor keeps the full set for
// browsing. Returns { gated, granted: [names] } for the chat card.
async function applySchoolGatedAbilities(tokenDoc, caster) {
	const synth = tokenDoc?.actor;
	if (!synth) return { gated: false, granted: [] };

	const gatedItems = [];
	for (const item of listEmbeddedItems(synth)) {
		const req = getItemAutomationFlag(item, 'requiresSchool');
		if (typeof req === 'string' && req) gatedItems.push({ item, req });
	}
	if (!gatedItems.length) return { gated: false, granted: [] };

	const known = getKnownSpellSchools(caster);
	const granted = [];
	const toDelete = [];
	for (const { item, req } of gatedItems) {
		if (known.has(req)) granted.push(item.name);
		else toDelete.push(item.id ?? item._id);
	}
	if (toDelete.length) {
		try {
			await synth.deleteEmbeddedDocuments('Item', toDelete.filter(Boolean));
		} catch (error) {
			console.warn(`[${MODULE_ID}] Could not remove unknown-school spirit abilities`, error);
		}
	}
	return { gated: true, granted };
}

// Heal-charge consumption (D): a summoned healer's Cure item carries
// `automation.consumesSummonCharge`. Each use decrements the token's charge
// pool; at zero the spirit fades.
async function consumeSummonCharge(item, _context) {
	const automation =
		item?.getFlag?.(MODULE_ID, 'automation') ?? item?.flags?.[MODULE_ID]?.automation;
	if (automation?.consumesSummonCharge !== true) return;

	// An unlinked token actor exposes its TokenDocument via actor.token
	// (actor.isToken is true). Linked/world actors have no charge pool.
	const actor = item?.actor;
	if (!actor?.isToken) return;
	const tokenDoc = actor.token;
	if (!tokenDoc) return;

	const flag = getTokenSummonFlag(tokenDoc);
	if (!flag || typeof flag.charges !== 'number') return;

	const remaining = flag.charges - 1;
	if (remaining > 0) {
		try {
			await tokenDoc.setFlag(MODULE_ID, `${SUMMON_FLAG}.charges`, remaining);
		} catch (error) {
			console.warn(`[${MODULE_ID}] Could not decrement summon heal charges`, error);
		}
		postSummonChat(
			actor,
			`<p>Lifebinding Spirit: <strong>${remaining}</strong> heal charge${remaining === 1 ? '' : 's'} remaining.</p>`,
		);
	} else {
		await dismissSummon(tokenDoc, {
			summonerActor: resolveSummonerFromToken(tokenDoc),
			template: flag.template,
			reason: '<p><em>Its power expended, the Lifebinding Spirit fades.</em></p>',
		});
	}
}

// ── Swarming Shadows (Feature B) ─────────────────────────────────────────────
// A shadow minion whose attack "would crit" (its primary die rolls its max face)
// summons another shadow minion adjacent to the target — provided its summoner
// owns the "Swarming Shadows" boon. Minions never actually crit (the system
// hard-suppresses isCritical on the minion attack paths), so crit is re-derived
// from the roll's dice. Two attack paths: single-item use (nimble.useItem) and
// group attacks (a `minionGroupAttack` chat card). The spawned minion costs
// nothing and inherits the same provenance/expiration/feature-boost patching as
// a cast one via spawnSummonedToken.
const SWARMING_SHADOWS_FEATURE = 'Swarming Shadows';
const SHADOW_MINION_TEMPLATE = 'shadow-minion';

// "Would crit": an active, non-discarded result on the primary (first) die term
// equals its faces. Works on a live DamageRoll (primaryDie accessor / .terms) and
// on a serialized rollData JSON (damageRoll.toJSON() → .terms).
function rollHasPrimaryMaxFace(rollLike) {
	if (!rollLike || typeof rollLike !== 'object') return false;
	const dieHasMaxFace = (die) => {
		const faces = Number(die?.faces);
		if (!(faces > 0) || !Array.isArray(die?.results)) return false;
		return die.results.some((r) => r && r.active !== false && !r.discarded && Number(r.result) === faces);
	};
	// Live DamageRoll exposes its extracted primary die directly.
	if (rollLike.primaryDie && dieHasMaxFace(rollLike.primaryDie)) return true;
	const terms = rollLike.terms;
	if (!Array.isArray(terms)) return false;
	const die = terms.find((t) => Number(t?.faces) > 0 && Array.isArray(t?.results));
	return die ? dieHasMaxFace(die) : false;
}

// True when the actor owns a `feature`-type item with this exact name. Name-only
// alias of actorOwnsFeature (the two were written independently on either side of
// the Engineer/Specter merge — one implementation is enough).
function actorHasFeatureNamed(actor, name) {
	return actorOwnsFeature(actor, null, name);
}

// The summon config that spawns `template`, read off the caster's own spell that
// declares it (the summoner necessarily owns Summon Shadow). Carries maxCount,
// featureBoosts and reachPerLevels so a swarm spawn matches a cast one.
function findSummonConfigForTemplate(actor, template) {
	if (!(actor instanceof Actor)) return null;
	for (const it of listEmbeddedItems(actor)) {
		const summon = getItemSummonAutomation(it);
		if (summon?.template === template) return summon;
	}
	return null;
}

// First free grid square among a target token's 8 neighbours (orthogonals first),
// else overlap to the east as a last resort.
function findFreeAdjacentPosition(scene, targetToken) {
	const grid = scene?.grid?.size ?? 100;
	const tx = Number(targetToken?.x) || 0;
	const ty = Number(targetToken?.y) || 0;
	const occupied = new Set();
	for (const t of scene?.tokens ?? []) occupied.add(`${Math.round(t.x)},${Math.round(t.y)}`);
	const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
	for (const [dx, dy] of offsets) {
		const x = tx + dx * grid;
		const y = ty + dy * grid;
		if (!occupied.has(`${Math.round(x)},${Math.round(y)}`)) return { x, y };
	}
	return { x: tx + grid, y: ty };
}

// Whisper the summoner's owner(s) that the swarm is at its limit.
function postSwarmAtCapWhisper(caster) {
	try {
		const recipients = [];
		for (const user of game.users ?? []) {
			if (user?.isGM) continue;
			if (caster?.testUserPermission?.(user, 'OWNER')) recipients.push(user.id);
		}
		const gm = game.users?.activeGM;
		if (gm?.id && !recipients.includes(gm.id)) recipients.push(gm.id);
		const data = {
			content: '<p><em>Swarming Shadows:</em> the shadow swarm is already at its limit — no new minion rises.</p>',
			whisper: recipients,
		};
		if (caster) data.speaker = ChatMessage.getSpeaker({ actor: caster });
		ChatMessage.create(data);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Could not post swarm-at-cap whisper`, error);
	}
}

// Spawn one Swarming-Shadows minion adjacent to `targetToken` (respecting the
// spell's cap). Returns the created token, or null when blocked/at cap.
async function spawnSwarmingShadow(caster, summon, targetToken, scene) {
	if (!(caster instanceof Actor) || !summon || !scene) return null;

	const cap = summonCountCap(caster, summon);
	const count = findLiveSummons(caster, summon.template).length;
	if (count >= cap) {
		postSwarmAtCapWhisper(caster);
		return null;
	}

	const baseActor = await resolveCompanionBaseActor(summon.template);
	if (!baseActor) {
		console.warn(`[${MODULE_ID}] Swarming Shadows could not resolve template "${summon.template}".`);
		return null;
	}

	const { x, y } = findFreeAdjacentPosition(scene, targetToken);
	const created = await spawnSummonedToken({ caster, summon, baseActor, scene, x, y });
	if (!created) return null;

	const targetName = targetToken?.name ?? 'the target';
	postSummonChat(
		caster,
		`<p><em>Swarming Shadows:</em> a new shadow minion rises beside <strong>${escapeHtml(targetName)}</strong>.</p>`,
		SWARMING_SHADOWS_FEATURE,
	);
	return created;
}

// Given a shadow-minion token and its damage rolls, spawn a swarm minion iff any
// roll "would crit" and the summoner owns Swarming Shadows. Shared by both paths.
async function maybeSwarmFromMinionAttack(minionTokenDoc, rollLikes, targetToken, scene) {
	const flag = getTokenSummonFlag(minionTokenDoc);
	if (flag?.template !== SHADOW_MINION_TEMPLATE) return;
	if (!Array.isArray(rollLikes) || !rollLikes.some(rollHasPrimaryMaxFace)) return;

	const caster = resolveSummonerFromToken(minionTokenDoc);
	if (!caster || !actorHasFeatureNamed(caster, SWARMING_SHADOWS_FEATURE)) return;

	const summon = findSummonConfigForTemplate(caster, SHADOW_MINION_TEMPLATE);
	if (!summon) return;

	const spawnScene = scene ?? minionTokenDoc?.parent ?? canvas?.scene;
	if (!spawnScene) return;
	await spawnSwarmingShadow(caster, summon, targetToken, spawnScene);
}

// Path 1: single-item minion attack (nimble.useItem). Fires on the acting client
// only, so no double-execution guard is needed.
async function handleSwarmingShadowsUseItem(item, context) {
	const actor = item?.actor;
	if (!actor?.isToken) return;
	const tokenDoc = actor.token;
	if (!tokenDoc) return;

	const targetPlaceable = context?.targets?.[0] ?? null;
	const targetDoc = targetPlaceable?.document ?? targetPlaceable ?? null;
	const scene = targetDoc?.parent ?? tokenDoc.parent ?? canvas?.scene;
	await maybeSwarmFromMinionAttack(tokenDoc, context?.rolls ?? [], targetDoc, scene);
}

// Resolve a combatant by id across every active combat.
function resolveCombatantById(id) {
	if (!id) return null;
	for (const combat of game.combats ?? []) {
		const combatant = combat.combatants?.get?.(id);
		if (combatant) return combatant;
	}
	return null;
}

// Resolve the primary target TokenDocument from a group-attack card's target
// UUID list (system.targets; targets[0] is the primary).
function resolveGroupAttackTargetToken(targetUuids) {
	for (const uuid of targetUuids ?? []) {
		try {
			const doc = fromUuidSync?.(uuid);
			const tokenDoc = doc?.document ?? doc;
			if (tokenDoc) return tokenDoc;
		} catch {
			/* ignore and try the next */
		}
	}
	return null;
}

// Path 2: group attacks post ONE `minionGroupAttack` card with a per-member row
// (row.roll = damageRoll.toJSON()). Each would-crit shadow-minion member whose
// summoner owns Swarming Shadows spawns one minion beside the shared target.
async function handleSwarmingShadowsGroupAttack(message) {
	const rows = message?.system?.rows;
	if (!Array.isArray(rows) || !rows.length) return;

	const targetDoc = resolveGroupAttackTargetToken(message.system?.targets);
	const scene = targetDoc?.parent ?? canvas?.scene;

	for (const row of rows) {
		if (row?.isMiss) continue;
		if (!rollHasPrimaryMaxFace(row?.roll)) continue;
		const combatant = resolveCombatantById(row?.memberCombatantId);
		const tokenDoc = combatant?.token;
		if (!tokenDoc) continue;
		// Each qualifying member spawns its own minion (cap re-checked per spawn).
		await maybeSwarmFromMinionAttack(tokenDoc, [row.roll], targetDoc, scene);
	}
}

// createChatMessage hook: only the client whose user authored the card executes,
// so a group attack spawns each swarm minion exactly once regardless of GM count.
async function onCreateChatMessage(message) {
	try {
		if (message?.type !== 'minionGroupAttack') return;
		const authorId = message.author?.id ?? message.author;
		if (authorId && game.user?.id !== authorId) return;
		await handleSwarmingShadowsGroupAttack(message);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Swarming Shadows group-attack handler failed`, error);
	}
}

// Combat-end cleanup (C): remove every token whose summon flag names the combat
// that just ended. Only one client acts (prefer the active GM).
async function cleanupCombatSummons(combat) {
	const combatId = combat?.id;
	if (!combatId) return;

	const hits = [];
	for (const scene of game.scenes ?? []) {
		for (const token of scene.tokens ?? []) {
			if (getTokenSummonFlag(token)?.combatId === combatId) hits.push({ scene, token });
		}
	}
	if (!hits.length) return;

	// Clear any unique-tracking flags pointing at the doomed tokens.
	for (const { token } of hits) {
		const caster = resolveSummonerFromToken(token);
		const tmpl = getTokenSummonFlag(token)?.template;
		if (!caster || !tmpl) continue;
		try {
			const tracked = caster.getFlag?.(MODULE_ID, `${SUMMONS_TRACK_FLAG}.${tmpl}`);
			if (tracked?.tokenId === token.id) {
				await caster.unsetFlag(MODULE_ID, `${SUMMONS_TRACK_FLAG}.${tmpl}`);
			}
		} catch (error) {
			console.warn(`[${MODULE_ID}] Could not clear summon tracking on combat end`, error);
		}
	}

	// Batch-delete per scene.
	const byScene = new Map();
	for (const { scene, token } of hits) {
		if (!byScene.has(scene)) byScene.set(scene, []);
		byScene.get(scene).push(token.id);
	}
	for (const [scene, ids] of byScene) {
		try {
			await scene.deleteEmbeddedDocuments('Token', ids);
		} catch (error) {
			console.warn(`[${MODULE_ID}] Could not delete combat-expired summons`, error);
		}
	}

	// Turrets and undead minions expire on combat end too, so keep this generic
	// rather than naming the shadow minions it used to be the only cleanup for.
	postSummonChat(null, '<p><em>The summoned companions vanish as combat ends.</em></p>');
}

function onDeleteCombat(combat) {
	try {
		// Only one client should perform the deletions (isActingGM prefers the
		// designated active GM, falling back to any GM).
		if (!isActingGM()) return;
		void cleanupCombatSummons(combat);
	} catch (error) {
		console.warn(`[${MODULE_ID}] combat-end summon cleanup failed`, error);
	}
}

// Safe Rest (E): dismiss every lifebinding-spirit summon (all casters). Fires on
// the resting client; no active-GM guard (that client owns/deletes the tokens).
async function dismissAllLifebindingSpirits() {
	const tokens = [];
	for (const scene of game.scenes ?? []) {
		for (const token of scene.tokens ?? []) {
			if (getTokenSummonFlag(token)?.template === 'lifebinding-spirit') tokens.push(token);
		}
	}
	if (!tokens.length) return;
	for (const token of tokens) {
		await dismissSummon(token, {
			summonerActor: resolveSummonerFromToken(token),
			template: 'lifebinding-spirit',
		});
	}
	postSummonChat(null, '<p><em>The Lifebinding Spirits fade as the party takes a Safe Rest.</em></p>');
}

function onSummonRest(payload) {
	if (payload?.restType !== 'safe') return;
	dismissAllLifebindingSpirits().catch((error) =>
		console.warn(`[${MODULE_ID}] Safe Rest summon dismiss failed`, error),
	);
}

// Register the combat-end + rest hooks. The `useItem` hook (spawn + charge
// consumption) and the `activate` wrap (pre-activate gate) are already installed
// by installOnHitAutomation, so this only adds what that section doesn't.
// Idempotent, mirroring `onHitAutomationInstalled`.
let summonAutomationInstalled = false;
function installSummonAutomation() {
	if (summonAutomationInstalled) return;
	Hooks.on('deleteCombat', onDeleteCombat);
	// Auto Deploy! (Engineer L7): free Rifle Turret on combat start, plus the
	// late-joiner case (an Engineer added to an already-running combat).
	Hooks.on('combatStart', onCombatStart);
	Hooks.on('createCombatant', onCreateCombatant);
	Hooks.on(`${game.system?.id ?? 'nimble'}.rest`, onSummonRest);
	// Swarming Shadows group-attack path: minion group attacks bypass `useItem`
	// and post a single `minionGroupAttack` chat card instead.
	Hooks.on('createChatMessage', onCreateChatMessage);
	summonAutomationInstalled = true;
}

// ── Specter: Soul Touched workflow ───────────────────────────────────────────
// Soul Twist carries a native `markTarget` rule (flagKey `soul-touched`). Nimble
// stores the marks relationally on the SPECTER — flags.<sys>.toggledEffects
// ["soul-touched"] = [{ actorUuid, tokenUuid, name }] — and (when the rule names
// a statusCondition) stamps a marker ActiveEffect on each target carrying
// flags.<sys>.markTargetItemUuid = <Soul Twist item uuid> (see Nimble
// src/models/rules/markTarget.ts + src/utils/markTargetEffects.ts). This section
// treats that flag list as the single source of truth and layers on:
//
//   • Reconcile (active GM, on every change of the Specter's mark list): every
//     marked creature gets exactly one VISIBLE "Soul Touched (<Specter>)" marker
//     effect (keyed to the Soul Twist item, so Nimble's own eviction also clears
//     it), plus companion effects from owned Soul Sculpting picks on enemies —
//     Frozen Touch (Slowed) and Jinxed (Cursed). Unmarked creatures lose ours.
//     Deleting a marker effect by hand removes the mark (flag) too, so the
//     player/GM can always correct a mark from the token's effects.
//   • Rites (features flagged automation.rite.consumesMark = "soul-touched"):
//     pre-activation WARNING when a target isn't marked by this Specter (proceed /
//     cancel — never a hard block); after the Rite resolves the marks on its
//     targets are removed, with an Undo card that restores them. Reclaim Essence
//     heals STR per mark removed (Undo card); Lingering adds a "Reapply Soul
//     Touched (1 mana)" button to the removal card (spends mana, Undo card).
//     One mark per Rite; Master of the Veil: two. Extra marked targets keep
//     their mark (warning).
//   • Free Soul Twist: Soul Taker (enemy drops to 0 HP within Range 8, in combat)
//     and Bloodsong (the Specter gains a Wound, in combat) create a visible
//     "Free Soul Twist" effect (flag freeSoulTwist). The next Soul Twist in combat
//     skips Nimble's action deduction (activateItem's native `skipActionDeduction`)
//     and consumes the effect (Undo card restores it). Cleared when combat ends.
//   • End-of-turn save: when a Soul Touched enemy's turn ends, the GM gets a
//     whispered card (save stat, DC = 10 + the Specter's KEY, disadvantage with
//     Soothing) with a "Roll save" button. On a pass the mark is removed and the
//     owned on-save picks apply — Agony (STR+LVL damage), Dissonance (Dazed),
//     Earthbind (Prone), Rotting Flesh (Poisoned) — each with its own Undo card;
//     Rupture is a reminder line (its victims need GM judgement).
const SOUL_TOUCHED_KEY = 'soul-touched';
const SOUL_TWIST_IDENTIFIER = 'soul-twist';
// Soul Twist variants a Free Soul Twist applies to (Reanimated Soul is "Soul
// Twist to conjure … instead").
const SOUL_TWIST_VARIANTS = new Set([SOUL_TWIST_IDENTIFIER, 'reanimated-soul']);
const FREE_SOUL_TWIST_FLAG = 'freeSoulTwist';
const FREE_SOUL_TWIST_NAME = 'Free Soul Twist';
const SOUL_MARKER_FLAG = 'soulTouchedMarker';
const SOUL_COMPANION_FLAG = 'soulTouchedCompanion';
const SOUL_SAVE_FLAG = 'soulSave';
const SOUL_LINGERING_FLAG = 'soulLingering';
const SOUL_SAVE_APPLIED_FLAG = 'soulSaveApplied';
const SUFFERING_STAT_FLAG = 'sufferingSaveStat';
const NIMBLE_MARK_ITEM_FLAG = 'markTargetItemUuid'; // Nimble's marker-effect flag
const SOUL_TOUCHED_IMG = `modules/${MODULE_ID}/assets/features/specter/progression/soul-touched.webp`;
const SOUL_TWIST_IMG = `modules/${MODULE_ID}/assets/features/specter/progression/soul-twist.webp`;
const SAVE_STAT_LABELS = { strength: 'STR', dexterity: 'DEX', intelligence: 'INT', will: 'WIL' };
const EFFECT_ICON_ALWAYS = () => CONST.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2;

function findSoulTwistItem(specter) {
	return findOwnedFeature(specter, SOUL_TWIST_IDENTIFIER, 'Soul Twist');
}

// The uuid marker effects are keyed to: the Soul Twist item (what Nimble's own
// markTarget rule stamps), else the Specter itself.
function soulMarkSourceUuid(specter) {
	return findSoulTwistItem(specter)?.uuid ?? specter?.uuid ?? null;
}

function getSoulTouchedEntries(specter) {
	const list = specter?.getFlag?.(chargePoolScope(), 'toggledEffects')?.[SOUL_TOUCHED_KEY];
	return Array.isArray(list) ? list.filter((entry) => entry?.actorUuid) : [];
}

function isSoulTouchedBy(specter, targetActor) {
	const uuid = targetActor?.uuid;
	return Boolean(uuid) && getSoulTouchedEntries(specter).some((entry) => entry.actorUuid === uuid);
}

// Replace the Specter's whole soul-touched list (an array at a dotted path is
// replaced, not merged). The GM-side reconcile then fixes the visible effects.
async function writeSoulTouchedEntries(specter, list) {
	await specter.update({ [`flags.${chargePoolScope()}.toggledEffects.${SOUL_TOUCHED_KEY}`]: list });
}

async function addSoulTouchedMarks(specter, entries) {
	const fresh = (entries ?? []).filter((entry) => entry?.actorUuid);
	if (!specter || !fresh.length) return;
	const uuids = new Set(fresh.map((entry) => entry.actorUuid));
	const list = getSoulTouchedEntries(specter).filter((entry) => !uuids.has(entry.actorUuid));
	await writeSoulTouchedEntries(specter, [...list, ...fresh]);
}

// Remove marks for `actorUuids`; returns the removed entries (for Undo).
async function removeSoulTouchedMarks(specter, actorUuids) {
	const drop = new Set(actorUuids ?? []);
	const current = getSoulTouchedEntries(specter);
	const removed = current.filter((entry) => drop.has(entry.actorUuid));
	if (removed.length) await writeSoulTouchedEntries(specter, current.filter((entry) => !drop.has(entry.actorUuid)));
	return removed;
}

// Every character that can mark (owns Soul Twist) or currently has marks.
function listSpecters() {
	return (game.actors ?? []).filter(
		(actor) => actor?.type === 'character' && (findSoulTwistItem(actor) || getSoulTouchedEntries(actor).length),
	);
}

function resolveTokenDocSync(uuid) {
	try {
		const doc = uuid ? fromUuidSync(uuid) : null;
		return doc?.documentName === 'Token' ? doc : doc?.document?.documentName === 'Token' ? doc.document : null;
	} catch {
		return null;
	}
}

// A creature's token on the canvas (synthetic actors carry their own).
function actorTokenDoc(actor, tokenUuid) {
	return resolveTokenDocSync(tokenUuid) ?? actor?.token ?? actor?.getActiveTokens?.(true, true)?.[0] ?? null;
}

function isHostileToken(tokenDoc) {
	return tokenDoc?.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE;
}

// An "unwilling" creature for the end-of-turn save: not a hero, not friendly.
function isUnwillingSoulTarget(actor, tokenDoc) {
	if (!actor || actor.type === 'character') return false;
	return tokenDoc?.disposition !== CONST.TOKEN_DISPOSITIONS.FRIENDLY;
}

function conditionLabel(condition) {
	const raw = CONFIG.NIMBLE?.conditions?.[condition] ?? condition;
	try {
		return game.i18n.localize(raw);
	} catch {
		return condition;
	}
}

function buildSoulMarkerData(specter) {
	const soulTwist = findSoulTwistItem(specter);
	const sourceUuid = soulMarkSourceUuid(specter);
	// Honour the rule's statusCondition (token status icon) when the data sets one.
	const rule = (soulTwist?.system?.rules ?? []).find(
		(r) => r?.type === 'markTarget' && r?.flagKey === SOUL_TOUCHED_KEY,
	);
	const data = {
		name: `Soul Touched (${specter.name})`,
		img: SOUL_TOUCHED_IMG,
		origin: sourceUuid,
		showIcon: EFFECT_ICON_ALWAYS(),
		description:
			'<p>Susceptible to Specter Rites. Unwilling targets save (WIL vs Hero DC) at the end of their turns to remove it. Delete this effect to remove the mark.</p>',
		flags: {
			[chargePoolScope()]: { [NIMBLE_MARK_ITEM_FLAG]: sourceUuid },
			[MODULE_ID]: { [SOUL_MARKER_FLAG]: { specterUuid: specter.uuid } },
		},
	};
	if (rule?.statusCondition) data.statuses = [rule.statusCondition];
	return data;
}

// Companion effects an owned Soul Sculpting pick adds to a marked ENEMY. Keyed so
// the reconcile can add/remove each independently.
function soulCompanionSpecs(specter) {
	const specs = [];
	if (actorOwnsFeature(specter, 'frozen-touch', 'Frozen Touch')) {
		specs.push({
			key: 'frozen-touch',
			name: `${conditionLabel('slowed')} — Frozen Touch (${specter.name})`,
			img: CONFIG.NIMBLE?.conditionDefaultImages?.slowed ?? SOUL_TOUCHED_IMG,
			statuses: ['slowed'],
		});
	}
	if (actorOwnsFeature(specter, 'jinxed', 'Jinxed')) {
		// "Cursed" is not a core Nimble condition; use it as a status only when a
		// GM-defined custom condition with that id exists.
		const cursed = CONFIG.NIMBLE?.conditions?.cursed ? 'cursed' : null;
		specs.push({
			key: 'jinxed',
			name: `Cursed — Jinxed (${specter.name})`,
			img: (cursed && CONFIG.NIMBLE?.conditionDefaultImages?.cursed) || SOUL_TOUCHED_IMG,
			statuses: cursed ? [cursed] : [],
		});
	}
	return specs;
}

function isOurMarker(effect, sourceUuid) {
	return effect?.getFlag?.(chargePoolScope(), NIMBLE_MARK_ITEM_FLAG) === sourceUuid;
}

function companionOf(effect, specterUuid) {
	const flag = effect?.flags?.[MODULE_ID]?.[SOUL_COMPANION_FLAG];
	return flag && flag.specterUuid === specterUuid ? flag : null;
}

const SOUL_INTERNAL = { [`${MODULE_ID}Internal`]: true };

async function safeDeleteEffects(actor, ids) {
	const live = ids.filter((id) => actor?.effects?.get?.(id));
	if (!live.length) return;
	try {
		await actor.deleteEmbeddedDocuments('ActiveEffect', live, SOUL_INTERNAL);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Soul Touched effect cleanup failed`, error);
	}
}

// Active GM: make the visible effects match the Specter's mark list.
async function reconcileSoulTouched(specter) {
	if (!specter) return;
	const sourceUuid = soulMarkSourceUuid(specter);
	if (!sourceUuid) return;
	const entries = getSoulTouchedEntries(specter);
	const marked = new Map(entries.map((entry) => [entry.actorUuid, entry]));
	const specs = soulCompanionSpecs(specter);

	// Candidates: every marked creature + any creature on the loaded scenes still
	// carrying one of this Specter's effects.
	const candidates = new Map();
	for (const entry of entries) {
		// eslint-disable-next-line no-await-in-loop
		const doc = await fromUuid(entry.actorUuid).catch(() => null);
		const actor = doc instanceof Actor ? doc : doc?.actor ?? null;
		if (actor) candidates.set(actor.uuid, { actor, entry });
	}
	const scenes = new Set([canvas?.scene, game.scenes?.active].filter(Boolean));
	for (const scene of scenes) {
		for (const token of scene.tokens ?? []) {
			const actor = token.actor;
			if (!actor || candidates.has(actor.uuid)) continue;
			const has = actor.effects?.some?.((e) => isOurMarker(e, sourceUuid) || companionOf(e, specter.uuid));
			if (has) candidates.set(actor.uuid, { actor, entry: null });
		}
	}

	for (const { actor, entry } of candidates.values()) {
		const effects = [...(actor.effects ?? [])];
		const markers = effects.filter((e) => isOurMarker(e, sourceUuid));
		const companions = effects.filter((e) => companionOf(e, specter.uuid));
		if (!marked.has(actor.uuid)) {
			// eslint-disable-next-line no-await-in-loop
			await safeDeleteEffects(actor, [...markers, ...companions].map((e) => e.id));
			continue;
		}
		if (markers.length === 0) {
			// eslint-disable-next-line no-await-in-loop
			await actor.createEmbeddedDocuments('ActiveEffect', [buildSoulMarkerData(specter)]).catch((error) =>
				console.warn(`[${MODULE_ID}] Could not add Soul Touched marker`, error),
			);
		} else if (markers.length > 1) {
			// A native marker and ours raced — keep one.
			// eslint-disable-next-line no-await-in-loop
			await safeDeleteEffects(actor, markers.slice(1).map((e) => e.id));
		}
		const enemy = isHostileToken(actorTokenDoc(actor, entry?.tokenUuid));
		const wanted = enemy ? specs : [];
		const wantedKeys = new Set(wanted.map((spec) => spec.key));
		const haveKeys = new Set(companions.map((e) => companionOf(e, specter.uuid).key));
		const stale = companions.filter((e) => !wantedKeys.has(companionOf(e, specter.uuid).key));
		// eslint-disable-next-line no-await-in-loop
		if (stale.length) await safeDeleteEffects(actor, stale.map((e) => e.id));
		const missing = wanted
			.filter((spec) => !haveKeys.has(spec.key))
			.map((spec) => ({
				name: spec.name,
				img: spec.img,
				statuses: spec.statuses,
				origin: sourceUuid,
				showIcon: EFFECT_ICON_ALWAYS(),
				description: '<p>Lasts while this creature is Soul Touched; removed with the mark.</p>',
				flags: { [MODULE_ID]: { [SOUL_COMPANION_FLAG]: { specterUuid: specter.uuid, key: spec.key } } },
			}));
		if (missing.length) {
			// eslint-disable-next-line no-await-in-loop
			await actor.createEmbeddedDocuments('ActiveEffect', missing).catch((error) =>
				console.warn(`[${MODULE_ID}] Could not add Soul Touched companion effect`, error),
			);
		}
	}
}

// Debounced per Specter: lets Nimble's own marker creation land first (so the
// reconcile doesn't race it into a duplicate) and coalesces bursts of writes.
const soulReconcileTimers = new Map();
function scheduleSoulTouchedReconcile(specter, delay = 600) {
	if (!specter?.uuid || !isActingGM()) return;
	clearTimeout(soulReconcileTimers.get(specter.uuid));
	soulReconcileTimers.set(
		specter.uuid,
		setTimeout(() => {
			soulReconcileTimers.delete(specter.uuid);
			reconcileSoulTouched(specter).catch((error) =>
				console.error(`[${MODULE_ID}] Soul Touched reconcile failed`, error),
			);
		}, delay),
	);
}

// A marker deleted by hand (token HUD / effects tab) removes the mark itself.
async function onSoulMarkerDeleted(effect, options) {
	if (!isActingGM() || options?.[`${MODULE_ID}Internal`]) return;
	const sourceUuid = effect?.getFlag?.(chargePoolScope(), NIMBLE_MARK_ITEM_FLAG);
	if (!sourceUuid) return;
	let source = null;
	try {
		source = fromUuidSync(sourceUuid);
	} catch {
		return;
	}
	const specter = source instanceof Actor ? source : source?.actor;
	const isSoulSource =
		source instanceof Actor || SOUL_TWIST_VARIANTS.has(source?.system?.identifier ?? '');
	if (!(specter instanceof Actor) || !isSoulSource) return;
	const target = effect.parent;
	if (!(target instanceof Actor)) return;
	if (target.effects?.some?.((e) => e.id !== effect.id && isOurMarker(e, sourceUuid))) return;
	if (isSoulTouchedBy(specter, target)) await removeSoulTouchedMarks(specter, [target.uuid]);
	scheduleSoulTouchedReconcile(specter);
}

// ── Rites: pre-activation warning + post-resolution mark removal ──

function getRiteAutomation(item) {
	const automation = item?.getFlag?.(MODULE_ID, 'automation') ?? item?.flags?.[MODULE_ID]?.automation;
	const rite = automation?.rite;
	return rite && typeof rite === 'object' && rite.consumesMark ? rite : null;
}

// Runs inside the activate wrap, before any dialog/cost. Returns true to cancel.
// Never hard-blocks: an unverifiable target only asks "proceed anyway?".
async function riteActivationBlocked(item) {
	const rite = getRiteAutomation(item);
	if (!rite || rite.consumesMark !== SOUL_TOUCHED_KEY) return false;
	const specter = item?.actor;
	if (!(specter instanceof Actor) || specter.type !== 'character') return false;
	const targets = [...(game.user?.targets ?? [])];
	const unmarked = targets.filter((token) => !isSoulTouchedBy(specter, token?.actor ?? token?.document?.actor));
	if (targets.length && !unmarked.length) return false;
	const problem = targets.length
		? `${unmarked.map((t) => `<strong>${escapeHtml(t.name ?? t.document?.name ?? '?')}</strong>`).join(', ')} ${
				unmarked.length === 1 ? 'is' : 'are'
			} not Soul Touched by ${escapeHtml(specter.name)} (as far as the module can tell).`
		: 'No target is selected, so the module cannot check or remove Soul Touched.';
	const proceed = await foundry.applications.api.DialogV2.confirm({
		window: { title: `${item.name} — Soul Touched` },
		content: `<p>${problem}</p><p>A Rite does nothing unless it removes Soul Touched. Use it anyway?</p>`,
		yes: { label: 'Proceed anyway', icon: 'fa-solid fa-check' },
		no: { label: 'Cancel', icon: 'fa-solid fa-xmark', default: true },
		rejectClose: false,
		modal: true,
	}).catch(() => false);
	return !proceed;
}

function specterHpSnapshot(actor) {
	const hp = actor?.system?.attributes?.hp ?? {};
	return { value: Number(hp.value) || 0, temp: Number(hp.temp) || 0 };
}

// Post-Rite: remove this Specter's marks from the Rite's targets.
async function handleRiteResolved(item, context) {
	const rite = getRiteAutomation(item);
	if (!rite || rite.consumesMark !== SOUL_TOUCHED_KEY) return;
	const specter = item?.actor;
	if (!(specter instanceof Actor)) return;
	const markedActors = (context?.targets ?? [])
		.map((token) => token?.actor ?? token?.document?.actor)
		.filter((actor) => actor && isSoulTouchedBy(specter, actor));
	if (!markedActors.length) return;
	// A Rite removes one mark; Master of the Veil (L20) allows a 2nd Soul Touched.
	// Extra marked targets keep their mark (warned — remove it by hand if meant).
	const cap = actorOwnsFeature(specter, 'master-of-the-veil', 'Master of the Veil') ? 2 : 1;
	const targetActors = markedActors.slice(0, cap);
	const skipped = markedActors.slice(cap);
	if (skipped.length) {
		ui.notifications?.warn(
			`${item.name} removes Soul Touched from ${cap === 1 ? 'one target' : 'two targets'} only — ${skipped
				.map((actor) => actor.name)
				.join(', ')} keep${skipped.length === 1 ? 's' : ''} the mark (delete its Soul Touched effect by hand if needed).`,
		);
	}
	const removed = await removeSoulTouchedMarks(
		specter,
		targetActors.map((actor) => actor.uuid),
	);
	if (!removed.length) return;

	const names = removed.map((entry) => `<strong>${escapeHtml(entry.name || '?')}</strong>`).join(', ');
	const lingering = actorOwnsFeature(specter, 'lingering', 'Lingering');
	const card = await postUndoCard({
		actor: specter,
		flavor: item.name,
		text: `<p>${escapeHtml(item.name)} removed Soul Touched from ${names}.</p>${
			lingering
				? `<button type="button" data-bcx-lingering><i class="fa-solid fa-ghost"></i> Reapply Soul Touched (1 mana)</button>`
				: ''
		}`,
		undoAction: { type: 'soulTouchedRestore', data: { specterUuid: specter.uuid, entries: removed } },
	});
	if (card && lingering) {
		await card.setFlag(MODULE_ID, SOUL_LINGERING_FLAG, { specterUuid: specter.uuid, entries: removed, used: false });
	}

	// Reclaim Essence (Eidolon of Defiance): regain STR HP per Soul Touched removed.
	if (actorOwnsFeature(specter, 'reclaim-essence', 'Reclaim Essence')) {
		const str = Math.max(0, getAbilityMod(specter, 'strength'));
		const amount = str * removed.length;
		if (amount > 0) {
			const before = specterHpSnapshot(specter);
			await specter.applyHealing(amount);
			const after = specterHpSnapshot(specter);
			await postUndoCard({
				actor: specter,
				flavor: 'Reclaim Essence',
				text: `<p>${escapeHtml(specter.name)} regains <strong>${after.value - before.value}</strong> HP (STR × ${removed.length} Soul Touched removed). HP ${before.value} → ${after.value}.</p>`,
				undoAction: { type: 'specterHpRestore', data: { actorUuid: specter.uuid, ...before } },
			});
		}
	}

	// Reanimated Soul: removing Soul Touched destroys an undead minion (confirm).
	for (const actor of targetActors) {
		const tokenDoc = actor.token ?? null;
		const flag = getTokenSummonFlag(tokenDoc);
		if (!flag || flag.summonerActorUuid !== specter.uuid || flag.template !== 'undead-minion') continue;
		// eslint-disable-next-line no-await-in-loop
		const destroy = await foundry.applications.api.DialogV2.confirm({
			window: { title: 'Reanimated Soul' },
			content: `<p>Removing Soul Touched destroys <strong>${escapeHtml(tokenDoc.name)}</strong> (it leaves an exploitable corpse). Remove the token now?</p>`,
			rejectClose: false,
			modal: true,
		}).catch(() => false);
		if (!destroy) continue;
		const reason = `<p><strong>${escapeHtml(tokenDoc.name)}</strong> crumbles (Soul Touched removed).</p>`;
		if (tokenDoc.isOwner || game.user?.isGM) {
			// eslint-disable-next-line no-await-in-loop
			await dismissSummon(tokenDoc, { summonerActor: specter, template: 'undead-minion', reason });
		} else {
			// Players lack TOKEN_DELETE: the GM removes it (the relay checks that this
			// user owns the minion or its Specter).
			// eslint-disable-next-line no-await-in-loop
			await runAsGM('dismissTurret', { tokenUuid: tokenDoc.uuid, reason });
		}
	}
}

// Lingering: "Reapply Soul Touched (1 mana)" on the removal card.
async function onLingeringClick(message) {
	const data = message?.getFlag?.(MODULE_ID, SOUL_LINGERING_FLAG);
	if (!data || data.used) return;
	const specter = resolveActorByUuid(data.specterUuid);
	if (!specter || !(specter.isOwner || game.user?.isGM)) return;
	const mana = Number(specter.system?.resources?.mana?.current) || 0;
	if (mana < 1) {
		ui.notifications?.warn(
			`${specter.name} has no mana left to reapply Soul Touched. If that is wrong, fix mana on the sheet.`,
		);
		return;
	}
	await message.setFlag(MODULE_ID, `${SOUL_LINGERING_FLAG}.used`, true);
	await specter.update({ 'system.resources.mana.current': mana - 1 });
	await addSoulTouchedMarks(specter, data.entries ?? []);
	const names = (data.entries ?? []).map((e) => `<strong>${escapeHtml(e.name || '?')}</strong>`).join(', ');
	await postUndoCard({
		actor: specter,
		flavor: 'Lingering',
		text: `<p>${escapeHtml(specter.name)} spent <strong>1 mana</strong> (${mana} → ${mana - 1}) to reapply Soul Touched to ${names}.</p>`,
		undoAction: {
			type: 'soulLingeringUndo',
			data: {
				specterUuid: specter.uuid,
				actorUuids: (data.entries ?? []).map((e) => e.actorUuid),
				mana: 1,
				messageId: message.id,
			},
		},
	});
}

// Soul of Suffering: the Specter picks the stat unwilling targets save with.
async function promptSufferingStat(specter) {
	const current = specter.getFlag(MODULE_ID, SUFFERING_STAT_FLAG) ?? 'will';
	const stat = await foundry.applications.api.DialogV2.wait({
		window: { title: `${specter.name} — Soul of Suffering` },
		content: `<p>Which stat do unwilling targets use for their save to remove your Soul Touched?</p>
			<div style="display:flex;gap:12px">${Object.entries(SAVE_STAT_LABELS)
				.map(
					([key, label]) =>
						`<label><input type="radio" name="bcx-suffering-stat" value="${key}" ${key === current ? 'checked' : ''}> ${label}</label>`,
				)
				.join('')}</div>`,
		buttons: [
			{
				action: 'ok',
				label: 'Confirm',
				default: true,
				callback: (_event, button, dialog) =>
					(dialog?.element ?? button?.form ?? document).querySelector('input[name="bcx-suffering-stat"]:checked')
						?.value ?? null,
			},
		],
		rejectClose: false,
		modal: true,
	}).catch(() => null);
	if (!stat || !SAVE_STAT_LABELS[stat]) return;
	await specter.setFlag(MODULE_ID, SUFFERING_STAT_FLAG, stat);
	ui.notifications?.info(`${specter.name}: Soul Touched saves now use ${SAVE_STAT_LABELS[stat]}.`);
}

// useItem entry point for this section (called from onItemUsed).
async function handleSpecterItemUsed(item, context) {
	if (item?.actor?.type !== 'character') return;
	const identifier = item.system?.identifier ?? '';
	if (identifier === 'soul-of-suffering') {
		await promptSufferingStat(item.actor);
		return;
	}
	await handleRiteResolved(item, context);
}

// ── Reanimated Soul: one undead minion per Soul Power die ──

// Soul Power dice: 1 at L1, +1 at L5/10/15/20 (Soul Twist 2–4, Master of the Veil).
function soulPowerDice(actor) {
	return Math.floor(getCharacterLevel(actor) / 5) + 1;
}

// Spawn min(Soul Power dice, cap − live) minions around the Specter (the gate in
// summonActivationBlocked already refused a cast at/over the cap). Each is marked
// Soul Touched by its Specter ("Your minions … are Soul Touched") through the same
// mark list Soul Twist writes, so Rites/saves/effects treat them uniformly.
async function spawnSoulPowerMinions(item, caster, summon, baseActor, scene) {
	const live = findLiveSummons(caster, summon.template).length;
	const count = Math.max(0, Math.min(soulPowerDice(caster), summonCountCap(caster, summon) - live));
	if (count <= 0) return;
	const origin = computeSummonSpawnPosition(caster, scene);
	const grid = scene?.grid?.size ?? 100;
	// Fan out from the spot beside the Specter so the tokens don't stack.
	const offsets = [[0, 0], [0, 1], [0, -1], [1, 0], [1, 1], [1, -1], [-2, 1], [-2, -1]];
	const created = [];
	for (let i = 0; i < count; i += 1) {
		const [ox, oy] = offsets[i % offsets.length];
		// eslint-disable-next-line no-await-in-loop
		const token = await spawnSummonedToken({
			caster,
			summon,
			baseActor,
			scene,
			x: origin.x + ox * grid,
			y: origin.y + oy * grid,
		});
		if (token) created.push(token);
	}
	if (!created.length) {
		console.warn(`[${MODULE_ID}] Failed to spawn "${summon.template}" tokens.`);
		return;
	}
	let marked = false;
	if (findSoulTwistItem(caster)) {
		try {
			await addSoulTouchedMarks(
				caster,
				created.map((token) => ({ actorUuid: token.actor?.uuid, tokenUuid: token.uuid, name: token.name })),
			);
			marked = true;
		} catch (error) {
			console.warn(`[${MODULE_ID}] Could not mark undead minions Soul Touched`, error);
		}
	}
	postSummonChat(
		caster,
		`<p>${escapeHtml(caster.name)} conjures <strong>${created.length}</strong> ${escapeHtml(
			created[0].name ?? summon.template,
		)}${created.length === 1 ? '' : 's'} (${soulPowerDice(caster)} Soul Power ${
			soulPowerDice(caster) === 1 ? 'die' : 'dice'
		}, cap ${summonCountCap(caster, summon)}).${marked ? ' They are Soul Touched.' : ''}</p>`,
		item?.name,
	);
}

// ── Free Soul Twist ──

function findFreeSoulTwistEffect(actor) {
	return actor?.effects?.find?.((e) => e?.flags?.[MODULE_ID]?.[FREE_SOUL_TWIST_FLAG]) ?? null;
}

async function createFreeSoulTwistEffect(specter, reason) {
	if (!specter || findFreeSoulTwistEffect(specter)) return null;
	const [effect] =
		(await specter.createEmbeddedDocuments('ActiveEffect', [
			{
				name: FREE_SOUL_TWIST_NAME,
				img: SOUL_TWIST_IMG,
				origin: findSoulTwistItem(specter)?.uuid ?? specter.uuid,
				showIcon: EFFECT_ICON_ALWAYS(),
				description: `<p>Your next Soul Twist this encounter costs no action (${escapeHtml(reason ?? '')}). Consumed automatically; delete it by hand if it was granted by mistake.</p>`,
				flags: { [MODULE_ID]: { [FREE_SOUL_TWIST_FLAG]: true, reason: reason ?? '' } },
			},
		])) ?? [];
	return effect ?? null;
}

// Grant (active GM): visible effect + Undo card.
async function grantFreeSoulTwist(specter, reason) {
	const effect = await createFreeSoulTwistEffect(specter, reason);
	if (!effect) return;
	await postUndoCard({
		actor: specter,
		flavor: reason,
		text: `<p>${escapeHtml(specter.name)}'s next Soul Twist is <strong>free</strong> (${escapeHtml(reason)}).</p>`,
		undoAction: { type: 'freeSoulTwistRemove', data: { actorUuid: specter.uuid } },
	});
}

function tokenDistanceSpaces(a, b) {
	const size = a?.parent?.grid?.size ?? canvas?.grid?.size ?? 100;
	const center = (t) => ({
		x: (t.x ?? 0) + ((t.width ?? 1) * size) / 2,
		y: (t.y ?? 0) + ((t.height ?? 1) * size) / 2,
	});
	const ca = center(a);
	const cb = center(b);
	// Chebyshev distance between footprints, in grid spaces.
	const reach = ((a.width ?? 1) + (b.width ?? 1)) / 2;
	const reachY = ((a.height ?? 1) + (b.height ?? 1)) / 2;
	const dx = Math.max(0, Math.abs(ca.x - cb.x) / size - reach) + 1;
	const dy = Math.max(0, Math.abs(ca.y - cb.y) / size - reachY) + 1;
	return Math.round(Math.max(dx, dy));
}

// Soul Taker: an enemy dropping to 0 HP within Range 8 (combat only).
async function soulTakerOnDeath(actor) {
	if (!game.combat?.started || actor?.type === 'character') return;
	const deadToken = actorTokenDoc(actor);
	if (!deadToken || !isHostileToken(deadToken)) return;
	for (const specter of listSpecters()) {
		if (!actorOwnsFeature(specter, 'soul-taker', 'Soul Taker')) continue;
		if (findFreeSoulTwistEffect(specter)) continue;
		// Look on the fallen token's scene (not only the GM's viewed canvas).
		const own = findActorTokenDoc(specter, deadToken.parent);
		if (!own || tokenDistanceSpaces(own, deadToken) > 8) continue;
		// eslint-disable-next-line no-await-in-loop
		await grantFreeSoulTwist(specter, `Soul Taker — ${deadToken.name} fell`);
	}
}

// Bloodsong: the Specter gains a Wound (combat only). Wound counts are cached
// (every client, cheap) so an update can be told apart as a gain.
const specterWoundCache = new Map();
function readWounds(actor) {
	return Number(actor?.system?.attributes?.wounds?.value) || 0;
}

async function onSpecterActorUpdate(actor, changes, options) {
	const scope = chargePoolScope();
	if (actor?.type === 'character') {
		// Prefer the pre-update value the updating client stamped on the options
		// (onSpecterActorPreUpdate) — the cache misses actors created after ready.
		const stamped = options?.[MODULE_ID]?.prevWounds;
		const prevWounds = typeof stamped === 'number' ? stamped : specterWoundCache.get(actor.id);
		const wounds = readWounds(actor);
		specterWoundCache.set(actor.id, wounds);
		if (!isActingGM()) return;
		if (foundry.utils.hasProperty(changes, `flags.${scope}.toggledEffects`)) scheduleSoulTouchedReconcile(actor);
		if (
			prevWounds !== undefined &&
			wounds > prevWounds &&
			game.combat?.started &&
			actorOwnsFeature(actor, 'bloodsong', 'Bloodsong')
		) {
			await grantFreeSoulTwist(actor, 'Bloodsong — gained a Wound');
		}
		return;
	}
	if (!isActingGM()) return;
	if (foundry.utils.getProperty(changes, 'system.attributes.hp.value') === 0) await soulTakerOnDeath(actor);
}

async function clearFreeSoulTwists() {
	if (!isActingGM()) return;
	for (const specter of listSpecters()) {
		const effect = findFreeSoulTwistEffect(specter);
		// eslint-disable-next-line no-await-in-loop
		if (effect) await effect.delete().catch(() => null);
	}
}

// Wrap the character document's activateItem: a Soul Twist activated in combat
// while "Free Soul Twist" is up skips Nimble's native action deduction (and its
// insufficient-actions prompt) via `skipActionDeduction`, then consumes the effect.
function installFreeSoulTwistWrap() {
	const proto = CONFIG?.NIMBLE?.Actor?.documentClasses?.character?.prototype;
	if (!proto || typeof proto.activateItem !== 'function') {
		console.warn(`[${MODULE_ID}] character activateItem not found; Free Soul Twist not automated.`);
		return;
	}
	if (Object.prototype.hasOwnProperty.call(proto, '__blueCodexFreeTwistWrapped')) return;
	const original = proto.activateItem;
	proto.activateItem = async function blueCodexFreeTwistActivateItem(id, options = {}) {
		const item = this.items?.get?.(id);
		const effect =
			item && SOUL_TWIST_VARIANTS.has(item.system?.identifier ?? '') ? findFreeSoulTwistEffect(this) : null;
		const inCombat =
			effect && game.combat?.started && game.combat.combatants?.some?.((c) => c.actorId === this.id);
		// Keep the free twist when this activation would cost nothing anyway: a
		// non-action cost, or a native actionCost rule already setting it to 0
		// (Dying Surge while Dying).
		let costsAction = item?.system?.activation?.cost?.type === 'action';
		if (costsAction) {
			try {
				costsAction = !Array.from(this.rules ?? []).some(
					(rule) =>
						rule?.type === 'actionCost' &&
						rule.mode === 'set' &&
						rule.appliesTo?.() &&
						rule.matchesItem?.(item) &&
						rule.resolveValue?.() === 0,
				);
			} catch {
				/* fall through: treat as costing an action */
			}
		}
		if (!inCombat || !costsAction || options?.skipActionDeduction) return original.call(this, id, options);
		const result = await original.call(this, id, { ...options, skipActionDeduction: true });
		if (result) {
			try {
				await effect.delete();
				await postUndoCard({
					actor: this,
					flavor: FREE_SOUL_TWIST_NAME,
					text: `<p>${escapeHtml(this.name)} used a <strong>free</strong> ${escapeHtml(item.name)} — no action spent.</p>`,
					undoAction: {
						type: 'freeSoulTwistRestore',
						data: { actorUuid: this.uuid, reason: effect.flags?.[MODULE_ID]?.reason ?? '' },
					},
				});
			} catch (error) {
				console.warn(`[${MODULE_ID}] Could not consume Free Soul Twist`, error);
			}
		}
		return result;
	};
	proto.__blueCodexFreeTwistWrapped = true;
}

// ── End-of-turn Soul Touched save ──

function soulSaveDC(specter) {
	let key = 0;
	try {
		key = Number(specter.getRollData?.()?.key) || 0;
	} catch {
		key = 0;
	}
	return 10 + key;
}

function soulSaveStat(specter) {
	if (!actorOwnsFeature(specter, 'soul-of-suffering', 'Soul of Suffering')) return 'will';
	const stat = specter.getFlag(MODULE_ID, SUFFERING_STAT_FLAG);
	return SAVE_STAT_LABELS[stat] ? stat : 'will';
}

const soulTurnsHandled = new Set();
async function onSoulTurnEnd(combat, changes) {
	if (!isActingGM() || !combat?.started) return;
	if (!('turn' in (changes ?? {})) && !('round' in (changes ?? {}))) return;
	const prev = combat.previous;
	const combatantId = prev?.combatantId;
	if (!combatantId) return;
	// Only a forward step ends the previous turn; a rewind (Previous Turn/Round)
	// must not post a save card for the combatant being stepped back over.
	const round = Number(combat.round) || 0;
	const turn = Number(combat.turn) || 0;
	const prevRound = Number(prev.round) || 0;
	const prevTurn = Number(prev.turn) || 0;
	if (round < prevRound || (round === prevRound && turn <= prevTurn)) return;
	const key = `${combat.id}:${prev.round}:${prev.turn}:${combatantId}`;
	if (soulTurnsHandled.has(key)) return;
	soulTurnsHandled.add(key);
	const combatant = combat.combatants?.get?.(combatantId);
	const target = combatant?.actor;
	const tokenDoc = combatant?.token ?? null;
	if (!target || !isUnwillingSoulTarget(target, tokenDoc)) return;
	const gmIds = (game.users?.filter?.((u) => u.isGM) ?? []).map((u) => u.id);
	for (const specter of listSpecters()) {
		if (!isSoulTouchedBy(specter, target)) continue;
		const stat = soulSaveStat(specter);
		const dc = soulSaveDC(specter);
		const disadvantage = actorOwnsFeature(specter, 'soothing', 'Soothing');
		// eslint-disable-next-line no-await-in-loop
		await ChatMessage.create({
			whisper: gmIds,
			speaker: ChatMessage.getSpeaker({ actor: specter }),
			flavor: '<strong>Soul Touched — end of turn</strong>',
			content: `<div class="bcx-soul-save">
				<p><strong>${escapeHtml(tokenDoc?.name ?? target.name)}</strong> may save to remove ${escapeHtml(specter.name)}'s Soul Touched.</p>
				<p>${SAVE_STAT_LABELS[stat]} save vs <strong>DC ${dc}</strong> (10 + ${escapeHtml(specter.name)}'s KEY)${
					disadvantage ? ', with <strong>disadvantage</strong> (Soothing)' : ''
				}.</p>
				${
					actorOwnsFeature(specter, 'soul-of-suffering', 'Soul of Suffering')
						? `<p>Soul of Suffering — save stat: <select data-bcx-soul-stat>${Object.entries(SAVE_STAT_LABELS)
								.map(([k, l]) => `<option value="${k}" ${k === stat ? 'selected' : ''}>${l}</option>`)
								.join('')}</select></p>`
						: ''
				}
				<button type="button" data-bcx-soul-save><i class="fa-solid fa-dice-d20"></i> Roll save</button>
			</div>`,
			flags: {
				[MODULE_ID]: {
					[SOUL_SAVE_FLAG]: {
						specterUuid: specter.uuid,
						targetUuid: target.uuid,
						targetName: tokenDoc?.name ?? target.name,
						stat,
						dc,
						disadvantage,
						resolved: false,
					},
				},
			},
		});
	}
}

// Apply one condition as its own effect (so its Undo deletes exactly it).
async function applySoulCondition(target, condition, source) {
	const [effect] =
		(await target.createEmbeddedDocuments('ActiveEffect', [
			{
				name: `${conditionLabel(condition)} (${source})`,
				img: CONFIG.NIMBLE?.conditionDefaultImages?.[condition] ?? SOUL_TOUCHED_IMG,
				statuses: [condition],
				flags: { [MODULE_ID]: { [SOUL_SAVE_APPLIED_FLAG]: source } },
			},
		])) ?? [];
	return effect ?? null;
}

const soulSavesInFlight = new Set();
async function onSoulSaveClick(message, statOverride = null) {
	if (!game.user?.isGM) return;
	const stored = message?.getFlag?.(MODULE_ID, SOUL_SAVE_FLAG);
	const data = stored ? { ...stored } : null;
	if (!data || data.resolved || soulSavesInFlight.has(message.id)) return;
	soulSavesInFlight.add(message.id);
	try {
		const specter = resolveActorByUuid(data.specterUuid);
		const target = resolveActorByUuid(data.targetUuid);
		if (!specter || !target) {
			ui.notifications?.warn('Soul Touched save: the Specter or the creature no longer exists.');
			return;
		}
		if (!isSoulTouchedBy(specter, target)) {
			await message.setFlag(MODULE_ID, SOUL_SAVE_FLAG, { ...data, resolved: true, outcome: 'no longer Soul Touched' });
			return;
		}
		// Soul of Suffering: the card's stat picker (pre-set from the Specter's choice).
		if (statOverride && SAVE_STAT_LABELS[statOverride]) data.stat = statOverride;
		const saveCard = await target.rollSavingThrowToChat(data.stat, {
			rollModeModifier: data.disadvantage ? -1 : 0,
		});
		const total = Number(saveCard?.rolls?.[0]?.total);
		if (!saveCard || !Number.isFinite(total)) return; // cancelled — button stays live
		const passed = total >= data.dc;
		await message.setFlag(MODULE_ID, SOUL_SAVE_FLAG, {
			...data,
			resolved: true,
			outcome: `${passed ? 'Passed' : 'Failed'} (${total} vs DC ${data.dc})`,
		});
		if (!passed) return;

		const name = escapeHtml(data.targetName ?? target.name);
		const removed = await removeSoulTouchedMarks(specter, [target.uuid]);
		const rupture = actorOwnsFeature(specter, 'rupture', 'Rupture');
		const strLvl = Math.max(0, getAbilityMod(specter, 'strength')) + getCharacterLevel(specter);
		await postUndoCard({
			actor: specter,
			flavor: 'Soul Touched',
			text: `<p>${name} saved (${total} vs DC ${data.dc}) and is no longer Soul Touched by ${escapeHtml(specter.name)}.</p>${
				rupture
					? `<p><em>[M] Rupture: every enemy adjacent to ${name} takes <strong>${strLvl}</strong> damage (STR + LVL), ignoring armor — apply it by hand.</em></p>`
					: ''
			}`,
			undoAction: { type: 'soulTouchedRestore', data: { specterUuid: specter.uuid, entries: removed } },
		});

		// Agony: the saver takes STR + LVL damage, ignoring armor.
		if (actorOwnsFeature(specter, 'agony', 'Agony') && strLvl > 0) {
			const before = specterHpSnapshot(target);
			await target.applyDamage(strLvl);
			const after = specterHpSnapshot(target);
			await postUndoCard({
				actor: target,
				flavor: 'Agony',
				text: `<p>${name} takes <strong>${strLvl}</strong> damage (Agony: STR + LVL, ignores armor). HP ${before.value} → ${after.value}${
					before.temp !== after.temp ? `, temp ${before.temp} → ${after.temp}` : ''
				}.</p>`,
				undoAction: { type: 'specterHpRestore', data: { actorUuid: target.uuid, ...before } },
			});
		}
		const conditions = [
			['dissonance', 'Dissonance', 'dazed', '1 turn'],
			['earthbind', 'Earthbind', 'prone', ''],
			['rotting-flesh', 'Rotting Flesh', 'poisoned', '1 round'],
		];
		for (const [identifier, label, condition, duration] of conditions) {
			if (!actorOwnsFeature(specter, identifier, label)) continue;
			// eslint-disable-next-line no-await-in-loop
			const effect = await applySoulCondition(target, condition, label);
			if (!effect) continue;
			// eslint-disable-next-line no-await-in-loop
			await postUndoCard({
				actor: target,
				flavor: label,
				text: `<p>${name} is <strong>${escapeHtml(conditionLabel(condition))}</strong>${duration ? `, ${duration}` : ''} (${label}).${
					duration ? ' <em>[M] Remove it when the duration ends.</em>' : ''
				}</p>`,
				undoAction: { type: 'specterDeleteEffect', data: { actorUuid: target.uuid, effectId: effect.id } },
			});
		}
	} finally {
		soulSavesInFlight.delete(message.id);
	}
}

// ── Undo handlers (run on the GM via the undo-card relay) ──

registerUndoHandler('soulTouchedRestore', async ({ specterUuid, entries }) => {
	const specter = resolveActorByUuid(specterUuid);
	if (!specter || !Array.isArray(entries) || !entries.length) return false;
	await addSoulTouchedMarks(specter, entries);
	return `Soul Touched restored on ${entries.map((e) => e.name || '?').join(', ')}.`;
});

registerUndoHandler('soulLingeringUndo', async ({ specterUuid, actorUuids, mana, messageId }) => {
	const specter = resolveActorByUuid(specterUuid);
	if (!specter) return false;
	await removeSoulTouchedMarks(specter, actorUuids ?? []);
	const current = Number(specter.system?.resources?.mana?.current) || 0;
	await specter.update({ 'system.resources.mana.current': current + (Number(mana) || 0) });
	const card = messageId ? game.messages?.get(messageId) : null;
	if (card) await card.setFlag(MODULE_ID, `${SOUL_LINGERING_FLAG}.used`, false).catch(() => null);
	return `Soul Touched removed again; mana ${current} → ${current + (Number(mana) || 0)}.`;
});

registerUndoHandler('specterHpRestore', async ({ actorUuid, value, temp }) => {
	const actor = resolveActorByUuid(actorUuid);
	if (!actor) return false;
	await actor.update({ 'system.attributes.hp.value': Number(value) || 0, 'system.attributes.hp.temp': Number(temp) || 0 });
	return `HP restored to ${value}${temp ? ` (+${temp} temp)` : ''}.`;
});

registerUndoHandler('specterDeleteEffect', async ({ actorUuid, effectId }) => {
	const actor = resolveActorByUuid(actorUuid);
	const effect = actor?.effects?.get?.(effectId);
	if (effect) await effect.delete();
	return effect ? `${effect.name} removed.` : 'Effect was already gone.';
});

registerUndoHandler('freeSoulTwistRestore', async ({ actorUuid, reason }) => {
	const actor = resolveActorByUuid(actorUuid);
	if (!actor) return false;
	await createFreeSoulTwistEffect(actor, reason || 'restored');
	return 'Free Soul Twist restored.';
});

registerUndoHandler('freeSoulTwistRemove', async ({ actorUuid }) => {
	const actor = resolveActorByUuid(actorUuid);
	const effect = findFreeSoulTwistEffect(actor);
	if (effect) await effect.delete();
	return 'Free Soul Twist removed.';
});

// ── Card buttons + install ──

Hooks.on('renderChatMessageHTML', (message, html) => {
	try {
		const save = message?.flags?.[MODULE_ID]?.[SOUL_SAVE_FLAG];
		const saveButton = html.querySelector?.('[data-bcx-soul-save]');
		if (save && saveButton) {
			if (save.resolved || !game.user?.isGM) {
				saveButton.disabled = true;
				if (save.outcome) saveButton.insertAdjacentHTML('afterend', `<p><em>${escapeHtml(save.outcome)}</em></p>`);
			} else {
				saveButton.addEventListener('click', (event) => {
					event.preventDefault();
					saveButton.disabled = true;
					onSoulSaveClick(message, html.querySelector?.('[data-bcx-soul-stat]')?.value ?? null).finally(() => {
						if (!message.getFlag(MODULE_ID, SOUL_SAVE_FLAG)?.resolved) saveButton.disabled = false;
					});
				});
			}
		}
		const lingering = message?.flags?.[MODULE_ID]?.[SOUL_LINGERING_FLAG];
		const lingerButton = html.querySelector?.('[data-bcx-lingering]');
		if (lingerButton) {
			const specter = lingering ? resolveActorByUuid(lingering.specterUuid) : null;
			const canUse = lingering && !lingering.used && (game.user?.isGM || specter?.isOwner);
			if (!canUse) {
				lingerButton.disabled = true;
				if (lingering?.used) lingerButton.insertAdjacentHTML('afterend', '<p><em>Soul Touched reapplied.</em></p>');
			} else {
				lingerButton.addEventListener('click', (event) => {
					event.preventDefault();
					lingerButton.disabled = true;
					onLingeringClick(message).catch((error) => console.error(`[${MODULE_ID}] Lingering failed`, error));
				});
			}
		}
	} catch (error) {
		console.warn(`[${MODULE_ID}] Specter chat-card wiring failed`, error);
	}
});

let specterAutomationInstalled = false;
function installSpecterAutomation() {
	if (specterAutomationInstalled) return;
	specterAutomationInstalled = true;
	for (const actor of game.actors ?? []) {
		if (actor?.type === 'character') specterWoundCache.set(actor.id, readWounds(actor));
	}
	installFreeSoulTwistWrap();
	// preUpdateActor runs only on the updating client; its update options travel
	// with the update to every client's updateActor, so stamp the old value there.
	Hooks.on('preUpdateActor', (actor, changes, options) => {
		if (actor?.type !== 'character') return;
		if (!foundry.utils.hasProperty(changes, 'system.attributes.wounds.value')) return;
		options[MODULE_ID] = { ...(options[MODULE_ID] ?? {}), prevWounds: readWounds(actor) };
	});
	Hooks.on('updateActor', (actor, changes, options) => {
		onSpecterActorUpdate(actor, changes, options).catch((error) =>
			console.error(`[${MODULE_ID}] Specter actor-update automation failed`, error),
		);
	});
	Hooks.on('deleteActiveEffect', (effect, options) => {
		onSoulMarkerDeleted(effect, options).catch((error) =>
			console.error(`[${MODULE_ID}] Soul Touched marker sync failed`, error),
		);
	});
	// A native marker landing after our reconcile may duplicate ours — re-check.
	Hooks.on('createActiveEffect', (effect) => {
		if (!isActingGM()) return;
		const sourceUuid = effect?.getFlag?.(chargePoolScope(), NIMBLE_MARK_ITEM_FLAG);
		if (!sourceUuid) return;
		try {
			const source = fromUuidSync(sourceUuid);
			if (!SOUL_TWIST_VARIANTS.has(source?.system?.identifier ?? '')) return;
			const specter = source?.actor;
			if (specter instanceof Actor && specter.type === 'character') scheduleSoulTouchedReconcile(specter);
		} catch {
			/* unresolvable source — not ours */
		}
	});
	Hooks.on('updateCombat', (combat, changes) => {
		onSoulTurnEnd(combat, changes).catch((error) =>
			console.error(`[${MODULE_ID}] Soul Touched end-of-turn save failed`, error),
		);
		if (changes?.started === false) clearFreeSoulTwists();
	});
	Hooks.on('deleteCombat', () => {
		clearFreeSoulTwists();
	});
	// Gaining/losing Frozen Touch or Jinxed re-derives the companion effects.
	const onCompanionPickChange = (item) => {
		const actor = item?.parent;
		if (actor?.type !== 'character') return;
		if (['frozen-touch', 'jinxed'].includes(item.system?.identifier ?? '')) scheduleSoulTouchedReconcile(actor);
	};
	Hooks.on('createItem', onCompanionPickChange);
	Hooks.on('deleteItem', onCompanionPickChange);
	// A deleted token (dismissed minion, removed monster) drops out of every
	// Specter's mark list so saves/Rites never chase a ghost.
	Hooks.on('deleteToken', (tokenDoc) => {
		if (!isActingGM() || !tokenDoc?.uuid) return;
		for (const specter of listSpecters()) {
			const stale = getSoulTouchedEntries(specter)
				.filter((e) => e.tokenUuid === tokenDoc.uuid || e.actorUuid.startsWith(`${tokenDoc.uuid}.`))
				.map((e) => e.actorUuid);
			if (stale.length) {
				removeSoulTouchedMarks(specter, stale).catch((error) =>
					console.warn(`[${MODULE_ID}] Could not drop deleted token's Soul Touched`, error),
				);
			}
		}
	});
	// Bring existing marks' visible effects in line once on load.
	if (isActingGM()) for (const specter of listSpecters()) scheduleSoulTouchedReconcile(specter, 1500);
}

// ── Shadowmancer casting rules (Pilfered Power) ──────────────────────────────
// Shadowmancer casters differ from the generic Nimble mana model in two ways:
//   1. A custom spell-tier unlock table (steeper than the core [1,4,6,8,…]).
//   2. "Pilfered Power": mana.max == DEX and every tiered cast costs exactly
//      1 mana (= one of your DEX uses), regardless of the spell's tier.
// Only actors owning a class item with identifier 'shadowmancer' are affected;
// every other actor is untouched. Cantrips (tier 0, incl. Summon Shadow) are
// never touched. See installShadowmancerCasting for the four seams: (1) custom
// cap table, (2) flat 1-mana cost, (3) forced max-tier upcast (auto-answering the
// upcast dialog), and (4) 0-mana overdraft damage.
const SHADOWMANCER_TIER_THRESHOLDS = [2, 5, 7, 10, 13, 16, 19];

// Highest castable spell tier for a shadowmancer at `level` (0 below level 2).
function shadowmancerHighestTier(level) {
	for (let i = SHADOWMANCER_TIER_THRESHOLDS.length - 1; i >= 0; i -= 1) {
		if (level >= SHADOWMANCER_TIER_THRESHOLDS[i]) return i + 1;
	}
	return 0;
}

// True when the actor owns a shadowmancer class item (any multiclass slot).
function isShadowmancerActor(actor) {
	if (!(actor instanceof Actor)) return false;
	for (const item of actor.items ?? []) {
		if (item.type !== 'class') continue;
		const id = item.system?.identifier || item.name?.slugify?.({ strict: true }) || '';
		if (id === 'shadowmancer') return true;
	}
	return false;
}

// Pre-cast mana snapshot per caster (uuid → mana.current before the system's own
// deduction), written in preUseItem and consumed in useItem. Single-user casting
// means one live entry at a time; keyed by uuid to stay safe across actors.
const shadowmancerPreCastMana = new Map();

// Active forced-upcast mana fudge per caster (uuid → { resources, realMana }); set
// in runWrappedActivate, cleared/restored in onSpellPreUse (on cast) or the
// activate `finally` (on cancel). See runWrappedActivate for the rationale.
const shadowmancerManaFudge = new Map();

/* ── The cast dialog, kept open ──────────────────────────────────────────────
 *
 * A shadowmancer does not choose a tier: Pilfered Power always casts at the
 * highest tier they can reach. That is a rule about mana, and it used to be
 * enforced by answering the entire dialog on the player's behalf from inside
 * this render hook — `submitActivation` resolves the promise that
 * `ItemActivationManager` is awaiting, so the window closed before it could be
 * seen. Everything else the dialog decides went with it: advantage and
 * disadvantage, situational modifiers, the primary-die fields, and — for a
 * spell whose upcast offers alternatives — which one.
 *
 * The dialog now renders and waits. Only the part the class actually fixes is
 * forced, by wrapping `submitActivation` so the player's own submission passes
 * through with `upcast` overwritten on the way past. Whatever they chose
 * everywhere else survives untouched.
 *
 * The mana fudge in `runWrappedActivate` therefore has to stand for as long as
 * the dialog is open: the Svelte component refuses to submit when
 * `manaToSpend > currentMana` (SpellUpcastDialog.svelte:248), which under
 * Pilfered Power — where mana is a use-count, not a per-tier budget — would
 * block the 0-mana overdraft cast the class is built around. It is an in-memory
 * write that triggers no re-render, and `onSpellPreUse` still restores the true
 * value before the system's own deduction.
 */
function onRenderUpcastDialog(app) {
	try {
		const actor = app?.actor;
		const item = app?.item;
		if (!isShadowmancerActor(actor)) return;
		const tier = Number(item?.system?.tier) || 0;
		if (tier < 1) return;
		if (app.__blueCodexUpcastPrepared) return;
		app.__blueCodexUpcastPrepared = true;

		const cap = Number(actor.system?.resources?.highestUnlockedSpellTier) || 0;
		const scaling = item.system?.scaling;
		const canScale = !!scaling && scaling.mode && scaling.mode !== 'none';
		const doUpcast = canScale && cap > tier;
		const choices =
			doUpcast && scaling.mode === 'upcastChoice' && Array.isArray(scaling.choices)
				? scaling.choices
				: [];

		// Read at submit time, not captured now: the player may change it while
		// the dialog is open.
		const pick = { index: 0 };

		const submit = app.submitActivation.bind(app);
		app.submitActivation = (results = {}) =>
			submit({
				...results,
				upcast: doUpcast
					? { manaToSpend: cap, choiceIndex: choices.length ? pick.index : undefined }
					: undefined,
			});

		injectForcedUpcastSection(app, { cap, doUpcast, choices, pick });
	} catch (error) {
		console.warn(`[${MODULE_ID}] shadowmancer upcast dialog setup failed`, error);
	}
}

/**
 * Stand in for the system's upcast controls on a shadowmancer's cast dialog.
 *
 * The native section is hidden rather than reused: its mana slider offers a
 * choice this class does not have, and its choice radios are only drawn once
 * that slider has been dragged past the base tier — which, for a cast that is
 * forced to the cap, never happens. In its place goes a plain statement of the
 * tier being cast at, plus the radio group when the spell's upcast has genuine
 * alternatives.
 *
 * Every anchor is optional. If the system's markup moves, nothing is injected
 * and the dialog is left exactly as the system drew it — the cast still works,
 * it just loses the explanatory row.
 */
function injectForcedUpcastSection(app, { cap, doUpcast, choices, pick }) {
	if (!doUpcast) return;
	const root = app?.element instanceof HTMLElement ? app.element : app?.element?.[0];
	if (!(root instanceof HTMLElement)) return;

	ensurePilferedPowerStyles();

	const native = root.querySelector('.nimble-upcast-section');
	if (native instanceof HTMLElement) native.style.display = 'none';

	const section = document.createElement('div');
	section.className = 'bcx-forced-upcast';

	const rows = [
		'<h3 class="bcx-forced-upcast__heading"><i class="fa-solid fa-moon"></i> Pilfered Power</h3>',
		`<p class="bcx-forced-upcast__note">Cast at <strong>tier ${cap}</strong> — a shadowmancer always casts at the highest tier they can reach.</p>`,
	];
	if (choices.length) {
		rows.push('<fieldset class="bcx-forced-upcast__choices">');
		rows.push('<legend>Choose an enhancement</legend>');
		choices.forEach((choice, index) => {
			const label = escapeHtml(choice?.label ?? `Option ${index + 1}`);
			rows.push(
				`<label class="bcx-forced-upcast__option"><input type="radio" name="bcx-upcast-choice" value="${index}"${
					index === 0 ? ' checked' : ''
				}><span>${label}</span></label>`,
			);
		});
		rows.push('</fieldset>');
	}
	section.innerHTML = rows.join('');

	for (const input of section.querySelectorAll('input[type="radio"]')) {
		input.addEventListener('change', (event) => {
			const value = Number(event.currentTarget?.value);
			if (Number.isInteger(value)) pick.index = value;
		});
	}

	if (native instanceof HTMLElement) native.after(section);
	else (root.querySelector('.nimble-sheet__body') ?? root).append(section);
}

// preUseItem (fires before the system deducts mana, upcast passed by reference).
// For a shadowmancer tiered cast: restore any active mana fudge to the real value
// (so the deduction persists the true flat cost), snapshot the real pre-cast mana,
// and tell the system to deduct exactly 1 when an upcast result exists. Never
// blocks (always returns true).
function onSpellPreUse(item, context) {
	try {
		if (item?.type !== 'spell') return true;
		const actor = item.actor;
		if (!isShadowmancerActor(actor)) return true;
		if ((Number(item.system?.tier) || 0) < 1) return true; // cantrips are free/untouched
		const fudge = shadowmancerManaFudge.get(actor.uuid);
		let realMana;
		if (fudge) {
			shadowmancerManaFudge.delete(actor.uuid);
			if (fudge.resources?.mana) fudge.resources.mana.current = fudge.realMana;
			realMana = fudge.realMana;
		} else {
			realMana = Number(actor.system?.resources?.mana?.current) || 0;
		}
		shadowmancerPreCastMana.set(actor.uuid, realMana);
		// Flat Pilfered Power cost: make the system's deduction exactly 1 mana when
		// an upcast object is present (the useItem correction is the real backstop).
		if (context?.upcast && typeof context.upcast === 'object') context.upcast.manaSpent = 1;
	} catch (error) {
		console.warn(`[${MODULE_ID}] shadowmancer preUse cost hook failed`, error);
	}
	return true;
}

// Overdraft (Pilfered Power): a tiered cast made with no remaining uses draws the
// patron's notice — take floor(maxHP/2) damage via the system's own applyDamage
// (temp-then-value), with a plain HP update as a fallback.
async function applyPatronBacklash(actor) {
	try {
		const maxHp = Number(actor.system?.attributes?.hp?.max) || 0;
		const damage = Math.floor(maxHp / 2);
		if (damage > 0) {
			if (typeof actor.applyDamage === 'function') {
				await actor.applyDamage(damage);
			} else {
				const hp = actor.system?.attributes?.hp ?? {};
				const temp = Number(hp.temp) || 0;
				const value = Number(hp.value) || 0;
				const absorbed = Math.min(temp, damage);
				await actor.update({
					'system.attributes.hp.temp': temp - absorbed,
					'system.attributes.hp.value': Math.max(0, value - (damage - absorbed)),
				});
			}
		}
		postSummonChat(
			actor,
			`<p><em>Your patron takes notice.</em> ${escapeHtml(actor.name)} suffers <strong>${damage}</strong> damage (half max HP) for casting beyond Pilfered Power's limit.</p>`,
			'Pilfered Power',
		);
	} catch (error) {
		console.warn(`[${MODULE_ID}] patron backlash failed`, error);
	}
}

// useItem correction: enforce the flat 1-mana cost regardless of the tier the
// system deducted for, and apply overdraft damage when the caster had no uses
// left. Authoritative — covers the base-tier (no-upcast) and upcast paths alike.
// No-ops for any actor without a snapshot (so it only fires on a completed cast).
async function applyShadowmancerFlatCost(item, _context) {
	if (item?.type !== 'spell') return;
	// Tier gate: a tier-0 cantrip must never consume a snapshot (defence in depth
	// against a snapshot leaked by a tiered cast that aborted after onSpellPreUse).
	if ((Number(item.system?.tier) || 0) < 1) return;
	const actor = item.actor;
	if (!actor || !shadowmancerPreCastMana.has(actor.uuid)) return;
	const preMana = shadowmancerPreCastMana.get(actor.uuid);
	shadowmancerPreCastMana.delete(actor.uuid);
	const desired = Math.max(0, preMana - 1);
	const current = Number(actor.system?.resources?.mana?.current) || 0;
	if (current !== desired) {
		await actor.update({ 'system.resources.mana.current': desired });
	}
	if (preMana <= 0) await applyPatronBacklash(actor);
}

// Install: (1) custom cap table via a prepareDerivedData wrap on the character
// document class, and (2) the flat-cost hooks. Idempotent.
let shadowmancerCastingInstalled = false;
function installShadowmancerCasting() {
	if (shadowmancerCastingInstalled) return;

	// (1) Custom casting-cap table. Core assigns highestUnlockedSpellTier with `??=`
	// (a manually-set value sticks), so we override AFTER the original prep runs —
	// a straight assignment for shadowmancers. This intentionally supersedes the
	// manual +/- tier UI for shadowmancers, and reads the total character level
	// (exact for a pure shadowmancer; approximate for a multiclass).
	const charClass = CONFIG?.NIMBLE?.Actor?.documentClasses?.character;
	const proto = charClass?.prototype;
	if (proto && typeof proto.prepareDerivedData === 'function') {
		if (!Object.prototype.hasOwnProperty.call(proto, '__blueCodexPrepDerivedWrapped')) {
			const original = proto.prepareDerivedData;
			proto.prepareDerivedData = function blueCodexPrepareDerivedData(...args) {
				const result = original.apply(this, args);
				try {
					if (isShadowmancerActor(this)) {
						const resources = this.system?.resources;
						// Only for spellcasters (mana.max > 0), matching core semantics.
						if (resources && (Number(resources.mana?.max) || 0) > 0) {
							resources.highestUnlockedSpellTier = shadowmancerHighestTier(getCharacterLevel(this));
						}
					}
				} catch (error) {
					console.warn(`[${MODULE_ID}] shadowmancer cap override failed`, error);
				}
				return result;
			};
			proto.__blueCodexPrepDerivedWrapped = true;
			// Refresh any already-prepared shadowmancer characters so the cap applies
			// without a reload.
			for (const actor of game.actors ?? []) {
				if (actor?.type === 'character' && isShadowmancerActor(actor)) {
					try {
						actor.prepareData();
					} catch (error) {
						console.warn(`[${MODULE_ID}] Could not refresh shadowmancer prep`, error);
					}
				}
			}
		}
	} else {
		console.warn(`[${MODULE_ID}] character document class missing; shadowmancer cap table not installed.`);
	}

	// (2) Flat Pilfered Power cost. useItem is already handled by onItemUsed (which
	// calls applyShadowmancerFlatCost); here we only add the preUseItem snapshot.
	Hooks.on(`${game.system?.id ?? 'nimble'}.preUseItem`, onSpellPreUse);

	// (3) Forced max-tier upcast: auto-answer the SpellUpcastDialog. It is a
	// SvelteApplicationMixin(ApplicationV2) whose render lifecycle emits the
	// standard `render<ClassName>` hook (same pattern nim-plus uses for
	// renderCharacterCreationDialog / renderGenericDialog); keepNames keeps the
	// class name `SpellUpcastDialog` intact in the dist bundle.
	Hooks.on('renderSpellUpcastDialog', onRenderUpcastDialog);

	shadowmancerCastingInstalled = true;
}

// ── Shadowmancer "Fiendish Boon" invocation ──────────────────────────────────
// The core Nimble Greater Invocation "Fiendish Boon" (system feature
// YkmdeKqEaGwhcKz1) reads "Increase your DEX or INT by 1. You have 1 fewer
// maximum Hit Dice." but ships with `system.rules: []` — pure text, no
// automation. It can be picked multiple times (gainedAtLevels [4,6,9,14,18]);
// each pick is a separate embedded feature and should independently apply its
// chosen +1 ability and −1 max Hit Die. When a pick lands (createItem) — or, for
// characters who took it before this automation existed, on the reconciler sweep
// — we prompt the owner for DEX vs INT and write two rules onto that feature
// instance: `maxHitDice -1` (dieSize 0 → the class hit-die size, self-restoring
// each prepare cycle via HitDiceManager) and `abilityBonus +1` on the chosen
// ability (added to `abilities.<ability>.bonus`). Both are permanent and derived,
// so nothing is mutated directly on the actor.
const FIENDISH_BOON_SOURCE_ID = 'YkmdeKqEaGwhcKz1';
const FIENDISH_BOON_FLAG = 'fiendishBoon';

/** True for an embedded Fiendish Boon feature (by name or compendium source). */
function isFiendishBoonItem(item) {
	if (!item || item.type !== 'feature') return false;
	if (item.name === 'Fiendish Boon') return true;
	const source = item._stats?.compendiumSource ?? '';
	return typeof source === 'string' && source.includes(FIENDISH_BOON_SOURCE_ID);
}

/** True once a Fiendish Boon instance already carries our flag or bonus rule. */
function isFiendishBoonAutomated(item) {
	if (foundry.utils.getProperty(item, `flags.${MODULE_ID}.${FIENDISH_BOON_FLAG}`)) return true;
	const rules = item.system?.rules;
	return Array.isArray(rules) && rules.some((rule) => rule?.type === 'abilityBonus');
}

/** Small DEX-vs-INT chooser; returns 'dexterity' / 'intelligence', or null if dismissed. */
async function promptFiendishBoonAbility(actor) {
	const result = await foundry.applications.api.DialogV2.wait({
		window: { title: `${actor.name} — Fiendish Boon` },
		content: `<form class="blue-codex-boon-form">
				<p>Increase an ability score by <strong>1</strong>. Your maximum Hit Dice is reduced by 1.</p>
				<div class="blue-codex-boon-list">
					<label class="blue-codex-boon-pick"><input type="radio" name="blue-codex-boon" value="dexterity" checked> Dexterity (DEX)</label>
					<label class="blue-codex-boon-pick"><input type="radio" name="blue-codex-boon" value="intelligence"> Intelligence (INT)</label>
				</div>
			</form>
			<style>
				.blue-codex-boon-pick{display:flex;gap:8px;align-items:center;padding:3px 0;cursor:pointer}
				.blue-codex-boon-list{margin-top:4px}
			</style>`,
		buttons: [
			{
				action: 'confirm',
				label: 'Confirm',
				default: true,
				callback: (_event, button, dialog) => {
					const root = dialog?.element ?? button?.form ?? document;
					return root.querySelector('input[name="blue-codex-boon"]:checked')?.value ?? null;
				},
			},
		],
		rejectClose: false,
		modal: true,
	}).catch(() => null);
	return result === 'dexterity' || result === 'intelligence' ? result : null;
}

/** Write the two derived rules + our flag onto a Fiendish Boon instance. */
async function applyFiendishBoon(item, ability) {
	const existingRules = Array.isArray(item.system?.rules) ? item.system.rules : [];
	await item.update({
		'system.rules': [
			...existingRules,
			{ id: foundry.utils.randomID(), type: 'maxHitDice', value: '-1', dieSize: 0, label: 'Fiendish Boon' },
			{ id: foundry.utils.randomID(), type: 'abilityBonus', value: '1', abilities: [ability], label: 'Fiendish Boon' },
		],
	});
	await item.setFlag(MODULE_ID, FIENDISH_BOON_FLAG, { ability });
}

// In-flight prompts keyed by item.uuid (render-storm / duplicate-hook guard) and
// session-scoped declines so a dismissed prompt isn't reopened every re-render.
const fiendishBoonActive = new Set();
const fiendishBoonDeclined = new Set();

/** Prompt for + apply one Fiendish Boon instance (owner-only, idempotent). */
async function automateFiendishBoon(item) {
	const actor = item?.parent;
	if (!(actor instanceof Actor) || actor.type !== 'character' || !actor.isOwner) return;
	if (!isFiendishBoonItem(item) || isFiendishBoonAutomated(item)) return;
	if (fiendishBoonActive.has(item.uuid) || fiendishBoonDeclined.has(item.uuid)) return;

	fiendishBoonActive.add(item.uuid);
	try {
		const ability = await promptFiendishBoonAbility(actor);
		if (!ability) {
			// Dismissed — don't nag on every render; the sweep re-offers next session.
			fiendishBoonDeclined.add(item.uuid);
			return;
		}
		await applyFiendishBoon(item, ability);
		ui.notifications?.info(
			`Fiendish Boon: +1 ${ability === 'dexterity' ? 'DEX' : 'INT'}, −1 max Hit Die.`,
		);
	} finally {
		fiendishBoonActive.delete(item.uuid);
	}
}

/** Back-fill: automate any owned Fiendish Boon instances missing our rules (one at a time). */
async function backfillFiendishBoons(actor) {
	if (!(actor instanceof Actor) || actor.type !== 'character' || !actor.isOwner) return;
	const pending = (actor.items ?? []).filter(
		(item) => isFiendishBoonItem(item) && !isFiendishBoonAutomated(item),
	);
	for (const item of pending) {
		if (fiendishBoonActive.has(item.uuid) || fiendishBoonDeclined.has(item.uuid)) continue;
		// eslint-disable-next-line no-await-in-loop
		await automateFiendishBoon(item);
	}
}

// Combined handler: first back-fill any missing auto-grants (forms), then sync
// subclass spell schools, then offer any owed subclass-pool choices.
async function handleActorFeatures(actor) {
	if (!actor) return;
	try {
		await sweepStaleGrantCarriers(actor);
	} catch (error) {
		console.error(`[${MODULE_ID}] carrier sweep failed`, error);
	}
	try {
		await backfillAutoGrants(actor);
	} catch (error) {
		console.error(`[${MODULE_ID}] auto-grant back-fill failed`, error);
	}
	try {
		await backfillFiendishBoons(actor);
	} catch (error) {
		console.error(`[${MODULE_ID}] Fiendish Boon back-fill failed`, error);
	}
	try {
		// Runs before the subclass swap so a Shepherd already owns its death spells
		// (not necrotic) by the time a Luminary's school choice reads its schools.
		await classSpellRemapSync(actor);
	} catch (error) {
		console.error(`[${MODULE_ID}] class spell-school remap failed`, error);
	}
	try {
		// Runs before the subclass swap so a Specter already owns its two Dark
		// Knowledge Book-of-Ruin schools by the time Eidolon of Rage's element
		// choice reads the caster's current schools.
		await classSpellChoiceSync(actor);
	} catch (error) {
		console.error(`[${MODULE_ID}] class spell-school choice grant failed`, error);
	}
	try {
		await spellSchoolSync(actor);
	} catch (error) {
		console.error(`[${MODULE_ID}] spell-school sync failed`, error);
	}
	try {
		await maybePromptPools(actor);
	} catch (error) {
		console.error(`[${MODULE_ID}] pool prompt failed`, error);
	}
}

api.choosePoolOptions = (actor) => maybePromptPools(actor ?? game.user?.character);
api.syncSubclassFeatures = (actor) => handleActorFeatures(actor ?? game.user?.character);

// Re-open the subclass spell-school choice (clears the stored pick so the dialog
// is offered again). Useful if a player wants to re-decide their schools.
api.chooseSpellSchools = async (actor) => {
	const target = actor ?? game.user?.character;
	if (!target) return;
	await target.unsetFlag(MODULE_ID, 'spellSchools');
	return spellSchoolSync(target);
};

// Re-open a new module class's spell-school choice (Specter's Dark Knowledge —
// Lamentations lets the Specter re-pick on a Safe Rest). Offers the pick dialog;
// a dropped school's spells are listed in a confirm dialog (destructive) and
// removed, the Eidolon of Rage subclass set (`spellSchools`) is re-synced so the
// new Book-of-Ruin school replaces the old one there too, and the new school's
// unlocked tiers are granted. Cancelling either dialog changes nothing.
api.chooseClassSpellSchools = async (actor) => {
	const target = actor ?? game.user?.character;
	if (!target) return;
	const classInfo = getPrimaryClass(target);
	const config = CLASS_SPELL_CHOICE[classInfo?.classId];
	if (!config) {
		ui.notifications?.warn(`${target.name} has no class-level spell-school choice.`);
		return;
	}
	const previous = getClassChoiceSchools(target);
	if (!previous.length) return classSpellChoiceSync(target); // first pick — normal flow
	if (classChoiceActive.has(target.id)) return;

	classChoiceActive.add(target.id);
	let picked;
	try {
		picked = await promptClassSchoolChoice(target, config);
		if (!picked) return; // dismissed — keep the current pick
		const dropped = new Set(previous.filter((school) => !picked.includes(school)));
		const doomed = (target.items ?? []).filter(
			(item) => item.type === 'spell' && dropped.has(item.system?.school),
		);
		if (doomed.length) {
			const list = doomed
				.map((item) => `<li>${escapeHtml(item.name)} <em>(${escapeHtml(SCHOOL_LABEL(item.system.school))})</em></li>`)
				.join('');
			const ok = await foundry.applications.api.DialogV2.confirm({
				window: { title: `${target.name} — ${config.title}` },
				content: `<p>Switching schools removes these ${doomed.length} spell${doomed.length > 1 ? 's' : ''} from ${escapeHtml(target.name)}:</p><ul>${list}</ul><p>Continue?</p>`,
				rejectClose: false,
				modal: true,
			}).catch(() => false);
			if (!ok) return;
			await target.deleteEmbeddedDocuments('Item', doomed.map((item) => item.id));
		}
		// Re-sync an additive subclass set (Eidolon of Rage) to the new class schools.
		const subSet = target.getFlag(MODULE_ID, 'spellSchools');
		if (subSet && Array.isArray(subSet.schools)) {
			const schools = new Set(subSet.schools.filter((school) => !dropped.has(school)));
			for (const school of picked) schools.add(school);
			await target.setFlag(MODULE_ID, 'spellSchools', { ...subSet, schools: [...schools] });
		}
		// Store the new pick with no high-water mark so the sync grants every
		// unlocked tier of it (already-owned spells are skipped).
		await target.setFlag(MODULE_ID, 'classSpellChoice', {
			classId: classInfo.classId,
			schools: picked,
			grantedTier: -1,
		});
	} finally {
		classChoiceActive.delete(target.id);
	}
	return classSpellChoiceSync(target);
};

// Grant/offer subclass content after any level change, subclass selection, and
// when a character sheet opens.
Hooks.on('updateItem', (item, changes) => {
	if (item?.type !== 'class' && item?.type !== 'subclass') return;
	if (item?.type === 'class' && foundry.utils.getProperty(changes, 'system.classLevel') === undefined)
		return;
	const actor = item.parent;
	if (actor) {
		poolDeclinedAtLevel.delete(actor.id);
		handleActorFeatures(actor);
	}
});

Hooks.on('createItem', (item) => {
	if (item?.type === 'subclass') {
		const actor = item.parent;
		if (actor) handleActorFeatures(actor);
		return;
	}
	// A freshly-picked Fiendish Boon invocation → prompt the owner for the ability
	// it raises and write its derived rules (owner-only guard lives in automateFiendishBoon).
	if (item?.type === 'feature' && item.parent?.type === 'character' && isFiendishBoonItem(item)) {
		automateFiendishBoon(item);
	}
});

// ── Shadowmancer sheet reskin: "Pilfered Power" ──────────────────────────────
// Purely presentational. The Shadowmancer's casting resource is the same
// `system.resources.mana` field every Nimble caster uses, but themed as
// "Pilfered Power" (mana.max == DEX, flat 1-per-cast; see installShadowmancerCasting).
// On a shadowmancer's sheet only, we relabel the "Mana ✦" heading, swap the
// sparkles glyph for the shadow-school moon (matching SPELL_SCHOOLS.shadow above,
// `fa-solid fa-moon`), and recolor the mana bar shadow-violet.
//
// The label is a hardcoded text node in the system's PlayerCharacterSheet.svelte
// (h3.nimble-heading--mana) and the bar colors are Svelte-scoped in ManaBar.svelte,
// so the CSS overrides need an ancestor scope class (`.bcx-shadowmancer` on the
// sheet root) plus `!important`. Svelte 5 re-renders reactively without re-firing
// the Foundry render hook, so a MutationObserver keeps the patch alive; the sync
// is idempotent (no DOM writes once patched) so the observer never loops.

const PILFERED_POWER_STYLE_ID = 'bcx-pilfered-power';
const PILFERED_POWER_CSS = `
	.bcx-shadowmancer .nimble-mana-bar__bar::before {
		background: linear-gradient(to right, hsl(270 45% 18%) 0%, hsl(275 55% 42%) 100%) !important;
	}
	.bcx-shadowmancer .nimble-mana-bar {
		border-color: hsl(275 40% 45%) !important;
	}
	.bcx-shadowmancer h3.nimble-heading--mana i.fa-moon {
		color: hsl(275 60% 60%);
	}
	/* The forced-tier row that stands in for the system's upcast controls on a
	   shadowmancer's cast dialog. */
	.bcx-forced-upcast {
		border-top: 1px solid hsl(275 30% 40% / 0.5);
		margin-block-start: 0.5rem;
		padding-block-start: 0.5rem;
	}
	.bcx-forced-upcast__heading {
		align-items: center;
		display: flex;
		font-size: var(--font-size-14, 0.875rem);
		gap: 0.375rem;
		margin: 0 0 0.25rem;
	}
	.bcx-forced-upcast__heading i.fa-moon {
		color: hsl(275 60% 60%);
	}
	.bcx-forced-upcast__note {
		font-size: var(--font-size-12, 0.75rem);
		margin: 0 0 0.5rem;
		opacity: 0.85;
	}
	.bcx-forced-upcast__choices {
		border: 1px solid hsl(275 30% 40% / 0.5);
		border-radius: 4px;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin: 0;
		padding: 0.375rem 0.5rem 0.5rem;
	}
	.bcx-forced-upcast__choices legend {
		font-size: var(--font-size-12, 0.75rem);
		padding-inline: 0.25rem;
	}
	.bcx-forced-upcast__option {
		align-items: center;
		cursor: pointer;
		display: flex;
		gap: 0.375rem;
	}
`;

/** Inject the Pilfered Power stylesheet once (guarded by id). */
function ensurePilferedPowerStyles() {
	if (document.getElementById(PILFERED_POWER_STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = PILFERED_POWER_STYLE_ID;
	style.textContent = PILFERED_POWER_CSS;
	document.head.append(style);
}

/**
 * Idempotently reskin a shadowmancer's mana resource as "Pilfered Power".
 * On non-shadowmancer character sheets it strips the scope class and returns.
 * Every branch is a no-op once already applied, so the MutationObserver that
 * drives it never enters a mutation loop.
 */
function syncPilferedPower(app) {
	const actor = app?.document ?? app?.actor;
	const root = app?.element instanceof HTMLElement ? app.element : app?.element?.[0];
	if (!(root instanceof HTMLElement)) return;
	if (!(actor instanceof Actor) || actor.type !== 'character') return;

	if (!isShadowmancerActor(actor)) {
		root.classList.remove('bcx-shadowmancer');
		return;
	}

	ensurePilferedPowerStyles();
	root.classList.add('bcx-shadowmancer');

	const heading = root.querySelector('h3.nimble-heading--mana');
	if (!heading) return;

	// Relabel the hardcoded text node (first TEXT_NODE reading "Mana").
	for (const node of heading.childNodes) {
		if (node.nodeType !== Node.TEXT_NODE) continue;
		const trimmed = (node.nodeValue ?? '').trim();
		if (trimmed === 'Pilfered Power') break; // already patched
		if (trimmed === 'Mana') {
			node.nodeValue = (node.nodeValue ?? '').replace('Mana', 'Pilfered Power');
			break;
		}
	}

	// Swap the ✦ sparkles glyph for the shadow-school moon.
	const icon = heading.querySelector('i.fa-sparkles');
	if (icon) icon.classList.replace('fa-sparkles', 'fa-moon');
}

/**
 * Watch the sheet for reactive Svelte re-renders (which don't fire a Foundry
 * render hook) and keep the Pilfered Power reskin applied. Mirrors nim-plus's
 * setupFeatsTabObserver lifecycle.
 */
function setupPilferedPowerObserver(app) {
	const root = app?.element instanceof HTMLElement ? app.element : app?.element?.[0];
	if (!(root instanceof HTMLElement)) return;
	try {
		app.__bcxPilferedObserver?.disconnect();
	} catch (_error) {
		/* previous observer already gone */
	}
	const observer = new MutationObserver(() => syncPilferedPower(app));
	observer.observe(root, { childList: true, subtree: true });
	app.__bcxPilferedObserver = observer;
	syncPilferedPower(app);
}

Hooks.on('renderPlayerCharacterSheet', (app) => {
	const actor = app?.document ?? app?.actor;
	if (actor) {
		wrapTriggerLevelUp(actor);
		handleActorFeatures(actor);
	}
	setupPilferedPowerObserver(app);
});

Hooks.on('closePlayerCharacterSheet', (app) => {
	try {
		app.__bcxPilferedObserver?.disconnect();
	} catch (_error) {
		/* nothing to disconnect */
	}
	delete app.__bcxPilferedObserver;
});

// ── Compendium level badges for class features ───────────────────────────────
// Nimble's own renderCompendium hook badges each class-feature entry with its
// gainedAtLevels and sorts by level — but it is hard-scoped to the system's
// `nimble.nimble-class-features` pack. Replicate it for this module's pack so
// fixed features show a single level (3/7/11/15) while pool options show their
// full milestone list (e.g. "4, 6, 8, …"), exactly like the core subclasses.
// Reuses the system's CSS class names so the styling matches.
const CF_ENTRY_WITH_LEVEL_CLASS = 'nimble-compendium-entry-with-level';
const CF_LEVEL_BADGE_CLASS = 'nimble-compendium-entry-level';
const CF_LEVEL_NAME_FLEX_CLASS = 'nimble-class-feature-name-flex';

function cfToLevels(value) {
	const levels = new Set();
	const push = (candidate) => {
		const parsed = typeof candidate === 'number' ? candidate : Number.parseInt(candidate, 10);
		if (Number.isFinite(parsed) && parsed > 0) levels.add(parsed);
	};
	if (Array.isArray(value)) value.forEach(push);
	else if (typeof value === 'number') push(value);
	else if (typeof value === 'string') (value.match(/\d+/g) ?? []).forEach(push);
	return [...levels].sort((a, b) => a - b);
}

function cfEntryLevels(indexEntry) {
	const fromArray = cfToLevels(foundry.utils.getProperty(indexEntry ?? {}, 'system.gainedAtLevels'));
	if (fromArray.length > 0) return fromArray;
	return cfToLevels(foundry.utils.getProperty(indexEntry ?? {}, 'system.gainedAtLevel'));
}

function applyClassFeatureLevelBadges(pack, container) {
	const entries = [];
	for (const entryElement of container.querySelectorAll('[data-entry-id]')) {
		const entryId = entryElement.dataset.entryId;
		if (!entryId || !entryElement.parentElement) continue;
		const nameElement =
			entryElement.querySelector('.entry-name') ?? entryElement.querySelector('a') ?? entryElement;
		const levels = cfEntryLevels(pack.index.get(entryId));
		entries.push({ entryElement, nameElement, parent: entryElement.parentElement, levels });

		if (levels.length < 1) {
			entryElement.classList.remove(CF_ENTRY_WITH_LEVEL_CLASS);
			nameElement.classList.remove(CF_LEVEL_NAME_FLEX_CLASS);
			nameElement.querySelector(`.${CF_LEVEL_BADGE_CLASS}`)?.remove();
			continue;
		}

		nameElement.classList.add(CF_LEVEL_NAME_FLEX_CLASS);
		nameElement.style.setProperty('display', 'flex', 'important');
		nameElement.style.setProperty('align-items', 'center', 'important');
		nameElement.style.setProperty('width', '100%', 'important');
		nameElement.style.setProperty('min-width', '0', 'important');

		let badge = nameElement.querySelector(`.${CF_LEVEL_BADGE_CLASS}`);
		if (!badge) {
			badge = document.createElement('span');
			badge.classList.add(CF_LEVEL_BADGE_CLASS);
			nameElement.append(badge);
		}
		badge.style.setProperty('margin-left', 'auto', 'important');
		badge.style.setProperty('margin-right', '6px', 'important');
		badge.style.setProperty('display', 'inline-block', 'important');
		badge.style.setProperty('white-space', 'nowrap', 'important');
		badge.textContent = levels.join(', ');
		entryElement.classList.add(CF_ENTRY_WITH_LEVEL_CLASS);
	}

	// Sort entries within each folder by first level (then single-level before
	// multi-level, then name) — matching the core subclass ordering.
	const byParent = new Map();
	for (const entry of entries) {
		if (!byParent.has(entry.parent)) byParent.set(entry.parent, []);
		byParent.get(entry.parent).push(entry);
	}
	for (const [parent, group] of byParent) {
		group.sort((a, b) => {
			const aLevel = a.levels[0] ?? Number.MAX_SAFE_INTEGER;
			const bLevel = b.levels[0] ?? Number.MAX_SAFE_INTEGER;
			if (aLevel !== bLevel) return aLevel - bLevel;
			if (a.levels.length !== b.levels.length) return a.levels.length - b.levels.length;
			return (a.nameElement.textContent ?? '').localeCompare(b.nameElement.textContent ?? '', undefined, {
				numeric: true,
				sensitivity: 'base',
			});
		});
		for (const entry of group) parent.append(entry.entryElement);
	}
}

Hooks.on('renderCompendium', (application, element) => {
	const pack = application?.collection;
	if (!pack || pack.collection !== CLASS_FEATURES_PACK) return;
	const container = element instanceof HTMLElement ? element : element?.[0];
	if (!(container instanceof HTMLElement)) return;
	pack
		.getIndex({ fields: ['system.gainedAtLevel', 'system.gainedAtLevels'] })
		.then(() => applyClassFeatureLevelBadges(pack, container))
		.catch((error) =>
			console.error(`[${MODULE_ID}] Failed to badge class-feature levels`, error),
		);
});

// ── Class-content refresh (Engineer / Specter) ───────────────────────────────
// A character owns *copies* of every class feature, gadget, kit and firearm it
// was granted, so characters built before the Engineer/Specter automation pass
// kept stale copies (no chargePool / chargeConsumer / markTarget / grantItem
// rules, old activation and text) — and Nimble's `grantItem` only fires when the
// granting item is created, so the children those new rules name (Rite options,
// kit Toolbelt options, gadget Toolbelt features) never arrived.
//
//   await blueCodex.refreshClassContent(game.user.character);            // confirm dialog
//   await blueCodex.refreshClassContent(actor, { dryRun: true });        // plan only
//   await blueCodex.refreshClassContent(canvas.tokens.controlled[0].actor);
//
// Also on the character sheet's header menu ("Refresh Codex class content") for
// Engineer/Specter characters, and on `ready` the GM gets a whispered card
// listing stale characters with a Refresh button each.
//
// Matching is by compendium source (`_stats.compendiumSource`, or the legacy
// `flags.core.source` / `flags.core.sourceId`) into the Codex class-features
// pack (only features whose `system.class` is engineer/specter), the items pack
// (Engineer gear — the only content it ships) and the subclasses pack
// (engineer/specter subclasses: name/img/description/rules only). Class items
// are never touched — they hold level, HP rolls and ability-score history.
//
// Kept per actor: flags outside the module's pack-owned keys (so every native
// charge-pool `current` — item-scoped `flags.nimble.chargePools`, actor-scoped on
// the actor — spell/school and choice flags), the item's `_id`, and on objects
// `quantity` / `equipped` / `identified`. Exception: gadgets (misc objects of the
// items pack) are set equipped, since Nimble disables rules on unequipped
// objects and a gadget's scrap/use consumers must run.
//
// Missing grantItem children are created the way ItemGrantRule.preCreate builds
// them (pack `toObject()`, `_stats.compendiumSource` = the rule's uuid, the
// rule's quantity override) through the actor's createEmbeddedDocuments — which
// is Nimble's own `NimbleBaseItem.createDocuments`, so a child's own grant rules
// fire natively. Nimble tags no granter on the stored child (its `grantedBy` is
// in-memory only; deletes do not cascade), so neither do we. Idempotent: a
// second run finds nothing to do.
const CLASS_REFRESH_CLASSES = new Set(['engineer', 'specter']);
const CODEX_ITEMS_PACK = `${MODULE_ID}.blue-codex-items`;
const CODEX_SUBCLASSES_PACK = `${MODULE_ID}.blue-codex-subclasses`;
// Module flag keys that are content (authored in pack-sources), not actor state.
const PACK_OWNED_FLAG_KEYS = ['automation', 'turretTemplate', 'pool'];
const OBJECT_PRESERVED_KEYS = ['quantity', 'equipped', 'identified'];
const SUBCLASS_REFRESH_KEYS = ['description', 'rules'];
const CLASS_REFRESH_NOTICE_FLAG = 'classRefreshNotice';
const CLASS_REFRESH_NOTICE_SETTING = 'classRefreshNoticeKey';

function itemSourceUuid(item) {
	const core = item?.flags?.core ?? {};
	return item?._stats?.compendiumSource ?? core.source ?? core.sourceId ?? null;
}

function parseCodexItemSource(uuid) {
	const match = /^Compendium\.([^.]+\.[^.]+)\.(?:Item\.)?([A-Za-z0-9]{16})$/.exec(String(uuid ?? ''));
	if (!match || !match[1].startsWith(`${MODULE_ID}.`)) return null;
	return { pack: match[1], id: match[2] };
}

function refreshStableStringify(value) {
	if (value === null || value === undefined) return 'null';
	if (Array.isArray(value)) return `[${value.map(refreshStableStringify).join(',')}]`;
	if (typeof value === 'object') {
		const keys = Object.keys(value).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${refreshStableStringify(value[k])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function actorHasRefreshClass(actor) {
	return (actor?.items ?? []).some(
		(item) =>
			item.type === 'class' &&
			CLASS_REFRESH_CLASSES.has(item.system?.identifier || item.name?.slugify?.({ strict: true })),
	);
}

// Pack-id → allowed? for the class-features and subclasses packs (index only —
// never pack.getDocuments()).
async function loadRefreshScope() {
	const scope = { features: new Set(), subclasses: new Set() };
	const featurePack = game.packs.get(CLASS_FEATURES_PACK);
	if (featurePack) {
		const index = await featurePack.getIndex({ fields: ['system.class'] });
		for (const entry of index) {
			if (CLASS_REFRESH_CLASSES.has(entry.system?.class)) scope.features.add(entry._id);
		}
	}
	const subclassPack = game.packs.get(CODEX_SUBCLASSES_PACK);
	if (subclassPack) {
		const index = await subclassPack.getIndex({ fields: ['system.parentClass'] });
		for (const entry of index) {
			if (CLASS_REFRESH_CLASSES.has(entry.system?.parentClass)) scope.subclasses.add(entry._id);
		}
	}
	return scope;
}

function isInRefreshScope(parsed, scope) {
	if (!parsed) return false;
	if (parsed.pack === CLASS_FEATURES_PACK) return scope.features.has(parsed.id);
	if (parsed.pack === CODEX_SUBCLASSES_PACK) return scope.subclasses.has(parsed.id);
	return parsed.pack === CODEX_ITEMS_PACK;
}

// The update that brings `item` in line with `doc`, or null when it already is.
function buildRefreshUpdate(item, doc) {
	const packSource = doc.toObject();
	const current = item._source ?? item.toObject();
	const currentSystem = current.system ?? {};
	let system;
	let keys;
	if (item.type === 'subclass') {
		system = {};
		for (const key of SUBCLASS_REFRESH_KEYS) system[key] = foundry.utils.deepClone(packSource.system?.[key]);
		keys = SUBCLASS_REFRESH_KEYS;
	} else {
		system = foundry.utils.deepClone(packSource.system ?? {});
		if (item.type === 'object') {
			for (const key of OBJECT_PRESERVED_KEYS) {
				if (key in currentSystem) system[key] = foundry.utils.deepClone(currentSystem[key]);
				else delete system[key];
			}
			const isGadget = doc.pack === CODEX_ITEMS_PACK && packSource.system?.objectType === 'misc';
			if (isGadget && 'equipped' in (packSource.system ?? {})) system.equipped = true;
		}
		keys = Object.keys(system);
	}

	const changed = [];
	if (current.name !== packSource.name) changed.push('name');
	if (current.img !== packSource.img) changed.push('img');
	for (const key of keys) {
		if (refreshStableStringify(currentSystem[key]) !== refreshStableStringify(system[key])) changed.push(key);
	}
	const flagUpdates = {};
	const currentFlags = current.flags?.[MODULE_ID] ?? {};
	const packFlags = packSource.flags?.[MODULE_ID] ?? {};
	for (const key of PACK_OWNED_FLAG_KEYS) {
		const next = packFlags[key] ?? null;
		if (refreshStableStringify(currentFlags[key]) === refreshStableStringify(next)) continue;
		flagUpdates[`flags.${MODULE_ID}.${key}`] = next === null ? null : foundry.utils.deepClone(next);
		changed.push(`flag:${key}`);
	}
	if (!changed.length) return null;

	const update = { _id: item.id, name: packSource.name, img: packSource.img, ...flagUpdates };
	for (const key of keys) update[`system.${key}`] = system[key];
	return { update, changed, name: item.name, to: packSource.name };
}

function grantItemRulesOf(rules) {
	return (Array.isArray(rules) ? rules : []).filter(
		(rule) => rule?.type === 'grantItem' && !rule.disabled && !rule.inMemoryOnly && rule.uuid,
	);
}

/**
 * Plan a refresh for one actor (reads only; fromUuid per owned document).
 * @returns {Promise<{actor, updates: object[], children: object[], missingSources: string[]}>}
 */
async function planClassContentRefresh(actor, scope = null) {
	scope ??= await loadRefreshScope();
	const plan = { actor, updates: [], children: [], missingSources: [] };
	const owned = new Set();
	for (const item of actor.items ?? []) {
		const uuid = itemSourceUuid(item);
		if (uuid) owned.add(uuid);
	}

	const docCache = new Map();
	const loadDoc = async (uuid) => {
		if (!docCache.has(uuid)) {
			let doc = null;
			try {
				doc = await fromUuid(uuid);
			} catch (error) {
				console.warn(`[${MODULE_ID}] refresh: could not load ${uuid}`, error);
			}
			docCache.set(uuid, doc);
		}
		return docCache.get(uuid);
	};

	const planned = new Set();
	for (const item of actor.items ?? []) {
		if (item.type === 'class') continue;
		const uuid = itemSourceUuid(item);
		const parsed = parseCodexItemSource(uuid);
		if (!isInRefreshScope(parsed, scope)) continue;
		const doc = await loadDoc(uuid);
		if (!doc) {
			plan.missingSources.push(item.name);
			continue;
		}
		const refresh = buildRefreshUpdate(item, doc);
		if (refresh) plan.updates.push(refresh);

		// Children only for features: rules on unequipped objects are disabled, and
		// subclass/class grants belong to creation-time flows.
		if (item.type !== 'feature') continue;
		for (const rule of grantItemRulesOf(doc.toObject().system?.rules)) {
			if (owned.has(rule.uuid) || planned.has(rule.uuid)) continue;
			const child = await loadDoc(rule.uuid);
			if (!child) continue;
			planned.add(rule.uuid);
			plan.children.push({
				uuid: rule.uuid,
				name: child.name,
				granterId: item.id,
				granterName: doc.name,
				ruleId: rule.id ?? null,
				quantity: rule.quantity ?? null,
			});
		}
	}
	return plan;
}

// Build a grantItem child exactly as ItemGrantRule.preCreate does.
async function buildGrantedChildSource(child, granter) {
	const doc = await fromUuid(child.uuid);
	if (!doc) return null;
	const source = doc.toObject();
	delete source._id;
	delete source.folder;
	delete source.sort;
	delete source.ownership;
	source._stats ??= {};
	source._stats.compendiumSource = child.uuid;
	if (itemSourceUuid(granter) === child.uuid && Array.isArray(source.system?.rules)) {
		source.system.rules = source.system.rules.filter((rule) => rule.type !== 'GrantItem');
	}
	if (child.quantity !== null && source.system && 'quantity' in source.system) {
		source.system.quantity = child.quantity;
	}
	return source;
}

async function applyClassContentRefresh(plan) {
	const { actor } = plan;
	const result = { updated: 0, added: [], skipped: [] };
	if (plan.updates.length) {
		await actor.updateEmbeddedDocuments(
			'Item',
			plan.updates.map((entry) => entry.update),
		);
		result.updated = plan.updates.length;
	}

	// One at a time, re-checking ownership: a child's own grant rules fire natively
	// on creation and may already have produced a later child.
	for (const child of plan.children) {
		if ((actor.items ?? []).some((item) => itemSourceUuid(item) === child.uuid)) continue;
		const granter = actor.items.get(child.granterId);
		if (!granter) {
			result.skipped.push(child.name);
			continue;
		}
		const liveRule = granter.rules?.values
			? [...granter.rules.values()].find((rule) => rule?.type === 'grantItem' && rule.uuid === child.uuid)
			: null;
		if (liveRule && (liveRule.disabled || (typeof liveRule.appliesTo === 'function' && !liveRule.appliesTo()))) {
			result.skipped.push(child.name);
			continue;
		}
		const source = await buildGrantedChildSource(child, granter);
		if (!source) {
			result.skipped.push(child.name);
			continue;
		}
		await actor.createEmbeddedDocuments('Item', [source]);
		result.added.push(child.name);
	}
	return result;
}

function renderRefreshPlan(plan) {
	const updates = plan.updates
		.map((entry) => {
			const label =
				entry.name !== entry.to
					? `${escapeHtml(entry.name)} → <strong>${escapeHtml(entry.to)}</strong>`
					: escapeHtml(entry.name);
			return `<li>${label} <em>(${escapeHtml(entry.changed.join(', '))})</em></li>`;
		})
		.join('');
	const children = plan.children
		.map((child) => `<li><strong>${escapeHtml(child.name)}</strong> <em>(from ${escapeHtml(child.granterName)})</em></li>`)
		.join('');
	const missing = plan.missingSources.length
		? `<p><em>No longer in the packs (left untouched): ${plan.missingSources.map(escapeHtml).join(', ')}.</em></p>`
		: '';
	return (
		`<p>Refresh <strong>${escapeHtml(plan.actor.name)}</strong>'s Engineer/Specter content from the Blue's Codex packs. ` +
		`Charge-pool counters, quantities, equipped state and choices are kept; gadgets are set equipped.</p>` +
		`<div style="max-height:55vh;overflow:auto">` +
		(updates ? `<h4>${plan.updates.length} item(s) updated</h4><ul>${updates}</ul>` : '') +
		(children ? `<h4>${plan.children.length} granted item(s) added</h4><ul>${children}</ul>` : '') +
		missing +
		`</div>`
	);
}

/**
 * Refresh an actor's Engineer/Specter content from the packs.
 * @param {Actor} actor
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]  plan only: log + return the plan, write nothing
 * @param {boolean} [options.confirm=true]  show the confirm dialog before writing
 * @returns {Promise<object|null>}  the plan (dry run) or the applied result
 */
async function refreshClassContent(actor, { dryRun = false, confirm = true } = {}) {
	actor ??= game.user?.character ?? canvas?.tokens?.controlled?.[0]?.actor ?? null;
	if (!actor) {
		ui.notifications?.warn("Blue's Codex | No actor: pass one, assign a character, or select a token.");
		return null;
	}
	if (!dryRun && !actor.isOwner) {
		ui.notifications?.warn(`Blue's Codex | You don't own ${actor.name}.`);
		return null;
	}
	const plan = await planClassContentRefresh(actor);
	const summary = `${plan.updates.length} item(s) to update, ${plan.children.length} granted item(s) to add`;
	if (dryRun) {
		console.log(`[${MODULE_ID}] refresh dry run — ${actor.name}: ${summary}`, plan);
		ui.notifications?.info(`Blue's Codex | ${actor.name}: ${summary} (dry run, nothing written).`);
		return plan;
	}
	if (!plan.updates.length && !plan.children.length) {
		ui.notifications?.info(`Blue's Codex | ${actor.name}'s class content is up to date.`);
		return { updated: 0, added: [], skipped: [] };
	}
	if (confirm) {
		const ok = await foundry.applications.api.DialogV2.confirm({
			window: { title: `Refresh class content — ${actor.name}`, icon: 'fa-solid fa-arrows-rotate' },
			position: { width: 560 },
			content: renderRefreshPlan(plan),
			rejectClose: false,
			modal: true,
		}).catch(() => false);
		if (!ok) return null;
	}

	const result = await applyClassContentRefresh(plan);
	const owners = (game.users ?? []).filter((user) => user.isGM || actor.testUserPermission?.(user, 'OWNER'));
	const addedList = result.added.length
		? `<p>Added: ${result.added.map(escapeHtml).join(', ')}.</p>`
		: '';
	const skippedList = result.skipped.length
		? `<p><em>Skipped (grant no longer applies): ${result.skipped.map(escapeHtml).join(', ')}.</em></p>`
		: '';
	try {
		await ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor }),
			whisper: owners.map((user) => user.id),
			content:
				`<p><strong>Class content refreshed</strong> from the Blue's Codex packs: ` +
				`${result.updated} item(s) updated, ${result.added.length} granted item(s) added. ` +
				`Charge-pool counters were kept — click a counter on the sheet to correct it.</p>` +
				addedList +
				skippedList,
		});
	} catch (error) {
		console.warn(`[${MODULE_ID}] Could not post refresh summary`, error);
	}
	return result;
}

api.refreshClassContent = refreshClassContent;

// GM notice on ready: whisper a card listing stale Engineer/Specter characters,
// once per distinct (module version, stale-actor set).
async function noticeStaleClassContent() {
	if (!isActingGM()) return;
	const candidates = (game.actors ?? []).filter((actor) => actor?.type === 'character' && actorHasRefreshClass(actor));
	if (!candidates.length) return;
	const scope = await loadRefreshScope();
	const stale = [];
	for (const actor of candidates) {
		const plan = await planClassContentRefresh(actor, scope);
		if (plan.updates.length || plan.children.length) stale.push({ actor, plan });
	}
	if (!stale.length) return;
	const version = game.modules.get(MODULE_ID)?.version ?? '';
	const key = `${version}|${stale.map(({ actor }) => actor.id).sort().join(',')}`;
	if (game.settings.get(MODULE_ID, CLASS_REFRESH_NOTICE_SETTING) === key) return;
	await game.settings.set(MODULE_ID, CLASS_REFRESH_NOTICE_SETTING, key);

	const rows = stale
		.map(
			({ actor, plan }) =>
				`<li>${escapeHtml(actor.name)} — ${plan.updates.length} to update, ${plan.children.length} to add ` +
				`<button type="button" data-bcx-refresh-actor="${escapeHtml(actor.uuid)}"><i class="fa-solid fa-arrows-rotate"></i> Refresh</button></li>`,
		)
		.join('');
	await ChatMessage.create({
		whisper: (game.users ?? []).filter((user) => user.isGM).map((user) => user.id),
		flags: { [MODULE_ID]: { [CLASS_REFRESH_NOTICE_FLAG]: true } },
		content:
			`<p><strong>Blue's Codex:</strong> these characters hold Engineer/Specter content older than the packs ` +
			`(missing resource counters, automation or granted options):</p><ul>${rows}</ul>` +
			`<p><em>Or run <code>blueCodex.refreshClassContent(actor)</code>. Each refresh shows a preview first.</em></p>`,
	});
}

Hooks.on('renderChatMessageHTML', (message, html) => {
	if (!message?.flags?.[MODULE_ID]?.[CLASS_REFRESH_NOTICE_FLAG]) return;
	for (const button of html.querySelectorAll?.('[data-bcx-refresh-actor]') ?? []) {
		if (!game.user?.isGM) {
			button.remove();
			continue;
		}
		button.addEventListener('click', (event) => {
			event.preventDefault();
			const actor = fromUuidSync(button.dataset.bcxRefreshActor);
			if (!actor) {
				ui.notifications?.warn("Blue's Codex | That actor no longer exists.");
				return;
			}
			void refreshClassContent(actor).catch((error) =>
				console.error(`[${MODULE_ID}] class-content refresh failed`, error),
			);
		});
	}
});

// Character sheet header menu entry (Engineer/Specter characters, owners only).
Hooks.on('getHeaderControlsPlayerCharacterSheet', (app, controls) => {
	const actor = app?.actor ?? app?.document;
	if (!actor?.isOwner || !actorHasRefreshClass(actor) || !Array.isArray(controls)) return;
	controls.push({
		icon: 'fa-solid fa-arrows-rotate',
		label: 'Refresh Codex class content',
		action: 'bcxRefreshClassContent',
		onClick: () =>
			void refreshClassContent(actor).catch((error) =>
				console.error(`[${MODULE_ID}] class-content refresh failed`, error),
			),
	});
});

Hooks.once('init', () => {
	game.settings.register(MODULE_ID, CLASS_REFRESH_NOTICE_SETTING, {
		scope: 'world',
		config: false,
		type: String,
		default: '',
	});
});

Hooks.once('ready', () => {
	noticeStaleClassContent().catch((error) =>
		console.error(`[${MODULE_ID}] stale class-content check failed`, error),
	);
});
