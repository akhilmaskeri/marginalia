/**
 * Helpers for per-sidenote inline styles.
 *
 * Styles are persisted as a `style="..."` attribute on the sidenote span in
 * the markdown source. These functions parse/serialize that attribute,
 * rewrite the opening tag while preserving all other attributes, and apply
 * the declarations to the rendered margin element.
 */

export interface StyleDecl {
	prop: string;
	value: string;
}

/** Fonts offered in the style modal dropdown. */
export const SUPPORTED_FONT_FAMILIES = [
	"Georgia",
	"'Times New Roman'",
	"Garamond",
	"Palatino",
	"Arial",
	"Helvetica",
	"Verdana",
	"'Trebuchet MS'",
	"'Courier New'",
	"serif",
	"sans-serif",
	"monospace",
];

/** Parse a style attribute value into ordered declarations. */
export function parseStyleAttr(style: string): StyleDecl[] {
	const decls: StyleDecl[] = [];
	for (const part of style.split(";")) {
		const idx = part.indexOf(":");
		if (idx < 0) continue;
		const prop = part.slice(0, idx).trim().toLowerCase();
		const value = part.slice(idx + 1).trim();
		if (prop && value) decls.push({ prop, value });
	}
	return decls;
}

export function serializeStyleAttr(decls: StyleDecl[]): string {
	return decls.map((d) => `${d.prop}: ${d.value}`).join("; ");
}

/** Property aliases treated as the same declaration. */
const ALIASES: Record<string, string[]> = {
	background: ["background", "background-color"],
	"background-color": ["background-color", "background"],
};

function aliasesFor(prop: string): string[] {
	return ALIASES[prop] ?? [prop];
}

/** Return the value of the first declaration matching any of the props. */
export function getDecl(decls: StyleDecl[], prop: string): string | null {
	const names = aliasesFor(prop);
	for (const d of decls) {
		if (names.includes(d.prop)) return d.value;
	}
	return null;
}

/**
 * Update a declaration in place (or its alias, if that's what the source
 * used), append if missing, or remove it when value is null.
 * Returns the same array for convenience.
 */
export function setDecl(
	decls: StyleDecl[],
	prop: string,
	value: string | null,
): StyleDecl[] {
	const names = aliasesFor(prop);
	const existing = decls.find((d) => names.includes(d.prop));
	if (value === null || value === "") {
		if (existing) decls.splice(decls.indexOf(existing), 1);
	} else if (existing) {
		existing.value = value;
	} else {
		decls.push({ prop, value });
	}
	return decls;
}

/**
 * Keep style values from breaking the span's opening tag: the sidenote
 * regexes require the tag to contain no ">" and the attribute is delimited
 * by double quotes. Single quotes stay allowed for font names.
 */
export function sanitizeStyleValue(value: string): string {
	// eslint-disable-next-line no-control-regex
	return value.replace(/[><";\u0000-\u001f]/g, "").trim();
}

const STYLE_ATTR_REGEX = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i;

/** Extract the style attribute value from a span opening tag, if any. */
export function extractStyleFromOpeningTag(openingTag: string): string | null {
	const m = openingTag.match(STYLE_ATTR_REGEX);
	if (!m) return null;
	return m[2] ?? m[3] ?? null;
}

/**
 * Return the opening tag with its style attribute replaced, added, or
 * removed (newStyle null/empty). All other attributes are untouched.
 */
export function setStyleInOpeningTag(
	openingTag: string,
	newStyle: string | null,
): string {
	const hasAttr = STYLE_ATTR_REGEX.test(openingTag);
	if (hasAttr) {
		return openingTag.replace(
			/\s*\bstyle\s*=\s*("[^"]*"|'[^']*')/i,
			newStyle ? ` style="${newStyle}"` : "",
		);
	}
	if (!newStyle) return openingTag;
	return openingTag.replace(/\s*\/?>$/, ` style="${newStyle}">`);
}

/**
 * Properties never copied to the margin element — they would break the
 * plugin's absolute positioning and collision layout.
 */
const BLOCKED_PROPS = new Set([
	"position",
	"top",
	"left",
	"right",
	"bottom",
	"width",
	"min-width",
	"max-width",
	"transform",
	"z-index",
	"display",
	"float",
	"overflow",
]);

/**
 * Apply a style attribute's declarations to a margin element.
 * Uses setProperty per declaration (never setAttribute) so the plugin's own
 * inline properties like --sidenote-shift survive.
 */
export function applyStyleToMargin(
	margin: HTMLElement,
	styleText: string | null,
): void {
	// Clear any previously applied per-note declarations first.
	const prev = margin.dataset.snAppliedProps;
	if (prev) {
		for (const prop of prev.split(",")) {
			if (prop) margin.style.removeProperty(prop);
		}
	}
	delete margin.dataset.snStyledBg;
	delete margin.dataset.snAppliedProps;

	if (!styleText) return;

	const applied: string[] = [];
	let hasBg = false;
	for (const { prop, value } of parseStyleAttr(styleText)) {
		if (BLOCKED_PROPS.has(prop)) continue;
		margin.style.setProperty(prop, value);
		applied.push(prop);
		if (prop === "background" || prop === "background-color") {
			hasBg = true;
		}
	}
	if (applied.length) margin.dataset.snAppliedProps = applied.join(",");
	if (hasBg) margin.dataset.snStyledBg = "true";
}
