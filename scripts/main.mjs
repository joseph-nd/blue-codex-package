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

			const coverage = await ensureCodexCoverage();
			if (!coverage || coverage.size === 0) return result;

			const filtered = new foundry.utils.Collection();
			for (const [key, entry] of result.entries()) {
				if (entry?.type === 'spell') {
					const school = entry?.system?.school;
					const tier = entry?.system?.tier ?? 0;
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

Hooks.once('ready', () => {
	const module = game.modules.get(MODULE_ID);
	if (module) module.api = api;
	globalThis.blueCodex = api;

	patchSpellGrantIndex();
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
};

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
async function sweepStaleGrantCarriers(actor) {
	if (levelUpContext?.actorId === actor.id) return;
	const stale = (actor.items ?? [])
		.filter((item) =>
			foundry.utils.getProperty(item, `flags.${MODULE_ID}.${SWAP_GRANT_CARRIER_FLAG}`),
		)
		.map((item) => item.id);
	if (stale.length === 0) return;
	try {
		await actor.deleteEmbeddedDocuments('Item', stale);
	} catch (error) {
		console.error(`[${MODULE_ID}] Failed to sweep stale spell-grant carrier`, error);
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
	// Slots left for keeping base schools once mandatory + one-per-choose are set.
	const slots = Math.max(0, policy.cap - mandatory.length - choosePairs.length);
	const keepCandidates = policy.replaceAll
		? []
		: [...current].filter((school) => !mandatory.includes(school));
	const mustPickKeep = slots > 0 && keepCandidates.length > slots;

	const mandatoryLine = mandatory.length
		? `<p>You gain: <strong>${mandatory.map(SCHOOL_LABEL).join(', ')}</strong>.</p>`
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
		} else {
			for (const school of keepCandidates) final.add(school); // room for all
		}
		return final;
	}
}

/**
 * Sync the actor's spell items to `finalSchools`: delete owned managed-school
 * spells not in the set, then grant every Codex spell of the chosen schools up to
 * the caster's unlocked tier that they don't already own. Idempotent.
 */
async function applySpellSchools(actor, finalSchools, level) {
	const maxTier = maxSpellTierForLevel(level);
	const spellItems = (actor.items ?? []).filter((item) => item.type === 'spell');

	const toDelete = spellItems
		.filter(
			(item) =>
				MANAGED_SPELL_SCHOOLS.has(item.system?.school) && !finalSchools.has(item.system?.school),
		)
		.map((item) => item.id);
	if (toDelete.length) await actor.deleteEmbeddedDocuments('Item', toDelete);

	const bySchool = await loadCodexSpellsBySchool();
	const ownedSources = new Set(
		(actor.items ?? []).map((item) => item._stats?.compendiumSource).filter(Boolean),
	);
	const ownedNameSchool = new Set(
		spellItems.map((item) => `${item.name}|${item.system?.school}`),
	);

	const toCreate = [];
	const seen = new Set();
	for (const school of finalSchools) {
		const list = bySchool.get(school); // necrotic/official schools aren't in the Codex pack
		if (!list) continue;
		for (const { uuid, tier } of list) {
			if (tier > maxTier || seen.has(uuid) || ownedSources.has(uuid)) continue;
			seen.add(uuid);
			// eslint-disable-next-line no-await-in-loop
			const doc = await fromUuid(uuid);
			if (!doc) continue;
			if (ownedNameSchool.has(`${doc.name}|${doc.system?.school}`)) continue;
			const obj = doc.toObject();
			delete obj._id;
			obj._stats = obj._stats ?? {};
			obj._stats.compendiumSource = doc.uuid;
			toCreate.push(obj);
		}
	}
	if (toCreate.length) await actor.createEmbeddedDocuments('Item', toCreate);
	return { removed: toDelete.length, granted: toCreate.length };
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
	// Hold the guard continuously across prompt + setFlag + apply so our own
	// document writes (which re-fire the sheet-render hook) can't re-enter.
	spellSyncActive.add(actor.id);
	try {
		let finalSchools;
		if (stored && stored.subclass === subclassId && Array.isArray(stored.schools)) {
			finalSchools = new Set(stored.schools);
		} else {
			// New/changed subclass — offer the choice.
			finalSchools = await promptSchoolChoice(actor, policy);
			if (!finalSchools) return; // deferred
			await actor.setFlag(MODULE_ID, 'spellSchools', {
				subclass: subclassId,
				schools: [...finalSchools],
			});
		}

		const { removed, granted } = await applySpellSchools(actor, finalSchools, classInfo.classLevel);
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

// Block the base class (or a manual add) from giving a swapped caster a spell of
// a managed school they didn't choose — this is what stops an Invoker of Ether
// from continuing to gain Book of Elements spells on every level-up. Runs as its
// own hook because the official-spell filter above returns early for non-official
// (i.e. Codex) spells, which we still need to gate here.
Hooks.on('preCreateItem', (item, data) => {
	try {
		if (!isReplaceSpellsEnabled()) return true;
		if (item?.type !== 'spell') return true;
		const actor = item?.parent;
		if (!(actor instanceof Actor) || actor.type !== 'character') return true;

		const stored = actor.getFlag(MODULE_ID, 'spellSchools');
		if (!stored || !Array.isArray(stored.schools)) return true;

		const school = item?.system?.school ?? data?.system?.school;
		if (school && MANAGED_SPELL_SCHOOLS.has(school) && !stored.schools.includes(school)) {
			console.log(
				`[${MODULE_ID}] Blocked ${school} spell "${item.name}" — not among this subclass's chosen schools (${stored.schools.join(', ')}).`,
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
			const subclassId = classInfo?.classId ? getActorSubclassId(this, classInfo.classId) : '';
			levelUpContext = subclassId ? { actorId: this.id, subclassId } : null;
			// Seed the native preview/grant with the chosen swapped schools (transient;
			// removed in the finally so it never sticks on the sheet).
			carrierId = await createSwapGrantCarrier(this, subclassId);
			return await originalTriggerLevelUp.apply(this, args);
		} finally {
			levelUpContext = previous;
			if (carrierId) {
				try {
					await this.deleteEmbeddedDocuments('Item', [carrierId]);
				} catch (error) {
					console.error(`[${MODULE_ID}] Failed to remove transient spell-grant carrier`, error);
				}
			}
		}
	};
	proto.__blueCodexLevelUpWrapped = true;
	levelUpWrapInstalled = true;
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
	if (item?.type !== 'subclass') return;
	const actor = item.parent;
	if (actor) handleActorFeatures(actor);
});

Hooks.on('renderPlayerCharacterSheet', (app) => {
	const actor = app?.document ?? app?.actor;
	if (actor) {
		wrapTriggerLevelUp(actor);
		handleActorFeatures(actor);
	}
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
