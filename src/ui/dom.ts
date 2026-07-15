type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, unknown> = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (k.startsWith('on') && typeof v === 'function') {
			node.addEventListener(k.slice(2), v as EventListener);
		} else if (k === 'value') {
			(node as unknown as { value: string }).value = String(v);
		} else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') {
			(node as unknown as Record<string, boolean>)[k] = true;
		} else {
			node.setAttribute(k, v === true ? '' : String(v));
		}
	}
	for (const c of children) if (c != null && c !== false) node.append(c);
	return node;
}

export function clear(node: HTMLElement): HTMLElement {
	node.textContent = '';
	return node;
}
