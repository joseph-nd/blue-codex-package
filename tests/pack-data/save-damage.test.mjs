/**
 * Damage dealt on a save has no attack roll, so it can't miss or crit. Nimble rolls a damage
 * node with canCrit / canMiss unset as an attack (both default to true), so every damage node
 * under a savingThrow (its `on` branches or `sharedRolls`) must say false. Nim+ fixes copies already
 * on sheets at runtime (its scripts/core/document-patches.mjs); this keeps the packs honest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../pack-sources');

function unflagged(effects, inSave = false, out = []) {
	if (!Array.isArray(effects)) return out;
	for (const node of effects) {
		if (!node || typeof node !== 'object') continue;
		if (inSave && node.type === 'damage' && (node.canCrit !== false || node.canMiss !== false)) out.push(node.id ?? node.formula);
		const childrenInSave = inSave || node.type === 'savingThrow';
		for (const branch of Object.values(node.on ?? {})) unflagged(branch, childrenInSave, out);
		unflagged(node.sharedRolls, childrenInSave, out);
	}
	return out;
}

describe('pack-data: damage on a save', () => {
	it('never misses or crits (canCrit and canMiss false)', () => {
		const found = [];
		for (const file of fs.readdirSync(ROOT, { recursive: true })) {
			if (!String(file).endsWith('.json')) continue;
			const doc = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf-8'));
			if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue;
			for (const item of [doc, ...(Array.isArray(doc.items) ? doc.items : [])]) {
				for (const node of unflagged(item?.system?.activation?.effects)) found.push(`${file}: ${item.name} (${node})`);
			}
		}
		expect(found).toEqual([]);
	});
});
