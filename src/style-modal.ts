import { App, Modal, Setting, TextComponent } from "obsidian";
import {
	StyleDecl,
	SUPPORTED_FONT_FAMILIES,
	applyStyleToMargin,
	getDecl,
	parseStyleAttr,
	sanitizeStyleValue,
	serializeStyleAttr,
	setDecl,
} from "./style-utils";

export interface StyleModalOptions {
	/** Effective side of the note; mirrors the modal layout. */
	side: "left" | "right";
	/** Raw source text of the note, shown in the preview pane. */
	noteText: string;
	/** Current style attribute value, or null if none. */
	initialStyle: string | null;
	/** Called on every control change so the real margin updates live. */
	onPreview?: (styleText: string | null) => void;
	/** Called when Save is pressed. Null means "remove the attribute". */
	onSave: (styleText: string | null) => void;
	/** Called on Cancel / Escape / click-outside (revert live preview). */
	onCancel?: () => void;
}

const CUSTOM_FONT_KEY = "__custom__";
const DEFAULT_FONT_KEY = "";

/**
 * Per-sidenote style editor. Preview pane and config pane sit side by
 * side, mirrored to match the note's margin side; every change restyles
 * the preview (and the real margin via onPreview). Save writes back to
 * the document, Cancel discards.
 */
export class SidenoteStyleModal extends Modal {
	private opts: StyleModalOptions;
	private decls: StyleDecl[];
	private previewNote!: HTMLElement;
	private saved = false;

	constructor(app: App, opts: StyleModalOptions) {
		super(app);
		this.opts = opts;
		this.decls = parseStyleAttr(opts.initialStyle ?? "");
	}

	private serialized(): string | null {
		return this.decls.length ? serializeStyleAttr(this.decls) : null;
	}

	private update(prop: string, value: string | null) {
		setDecl(
			this.decls,
			prop,
			value ? sanitizeStyleValue(value) : null,
		);
		const styleText = this.serialized();
		applyStyleToMargin(this.previewNote, styleText);
		this.opts.onPreview?.(styleText);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle("Sidenote style");

		const body = contentEl.createDiv({ cls: "sn-style-modal-body" });
		body.dataset.side = this.opts.side;

		// Preview pane (CSS mirrors the order based on data-side)
		const previewPane = body.createDiv({ cls: "sn-style-preview" });
		this.previewNote = previewPane.createEl("small", {
			cls: "sn-style-preview-note",
			text: this.opts.noteText,
		});
		applyStyleToMargin(this.previewNote, this.serialized());

		const configPane = body.createDiv({ cls: "sn-style-config" });

		this.addColorSetting(
			configPane,
			"Background color",
			"background",
		);
		this.addColorSetting(configPane, "Text color", "color");
		this.addFontSizeSetting(configPane);
		this.addFontFamilySetting(configPane);

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Save")
					.setCta()
					.onClick(() => {
						this.saved = true;
						this.opts.onSave(this.serialized());
						this.close();
					}),
			)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close()),
			);
	}

	onClose() {
		if (!this.saved) this.opts.onCancel?.();
		this.contentEl.empty();
	}

	private addColorSetting(
		parent: HTMLElement,
		name: string,
		prop: string,
	) {
		const initial = getDecl(this.decls, prop);
		new Setting(parent)
			.setName(name)
			.addColorPicker((picker) => {
				if (initial && /^#[0-9a-f]{3,8}$/i.test(initial)) {
					picker.setValue(initial);
				}
				picker.onChange((value) => this.update(prop, value));
			})
			.addExtraButton((btn) =>
				btn
					.setIcon("x")
					.setTooltip("Clear")
					.onClick(() => this.update(prop, null)),
			);
	}

	private addFontSizeSetting(parent: HTMLElement) {
		new Setting(parent)
			.setName("Font size")
			.setDesc("e.g. 14px or 90%")
			.addText((text) => {
				text.setPlaceholder("default").setValue(
					getDecl(this.decls, "font-size") ?? "",
				);
				text.onChange((value) => {
					let v = value.trim();
					// Bare numbers get px appended
					if (v && /^\d+(\.\d+)?$/.test(v)) v = `${v}px`;
					this.update("font-size", v || null);
				});
			});
	}

	private addFontFamilySetting(parent: HTMLElement) {
		const initial = getDecl(this.decls, "font-family") ?? "";
		const isKnown =
			initial === "" || SUPPORTED_FONT_FAMILIES.includes(initial);

		let customInput: TextComponent | null = null;
		let customSetting: Setting | null = null;

		new Setting(parent).setName("Font").addDropdown((dropdown) => {
			dropdown.addOption(DEFAULT_FONT_KEY, "(theme default)");
			for (const font of SUPPORTED_FONT_FAMILIES) {
				dropdown.addOption(font, font.replace(/'/g, ""));
			}
			dropdown.addOption(CUSTOM_FONT_KEY, "Custom…");
			dropdown.setValue(isKnown ? initial : CUSTOM_FONT_KEY);
			dropdown.onChange((value) => {
				const custom = value === CUSTOM_FONT_KEY;
				customSetting?.settingEl.toggle(custom);
				if (custom) {
					this.update(
						"font-family",
						quoteFontFamily(customInput?.getValue() ?? ""),
					);
				} else {
					this.update("font-family", value || null);
				}
			});
		});

		customSetting = new Setting(parent)
			.setName("Custom font")
			.addText((text) => {
				customInput = text;
				text.setPlaceholder("Font name").setValue(
					isKnown ? "" : initial,
				);
				text.onChange((value) =>
					this.update("font-family", quoteFontFamily(value)),
				);
			});
		customSetting.settingEl.toggle(!isKnown);
	}
}

/** Quote multi-word font names with single quotes for the style attr. */
function quoteFontFamily(name: string): string | null {
	const trimmed = name.trim().replace(/["']/g, "");
	if (!trimmed) return null;
	return /\s/.test(trimmed) ? `'${trimmed}'` : trimmed;
}
