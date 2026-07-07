export function getProperty(object, key) {
	if (!key || !object) return undefined;
	if (key in object) return object[key];
	let target = object;
	for (const p of key.split('.')) {
		if (!target || typeof target !== 'object') return undefined;
		if (p in target) target = target[p];
		else return undefined;
	}
	return target;
}

export function setProperty(object, key, value) {
	if (!key) return false;

	let target = object;
	let prop = key;
	if (key.indexOf('.') !== -1) {
		const parts = key.split('.');
		prop = parts.pop();
		target = parts.reduce((o, i) => {
			if (!Object.hasOwn(o, i)) o[i] = {};
			return o[i];
		}, object);
	}

	if (!(prop in target) || target[prop] !== value) {
		target[prop] = value;
		return true;
	}
	return false;
}
