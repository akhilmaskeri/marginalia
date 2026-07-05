/* eslint-disable obsidianmd/ui/sentence-case */

import {
	MarkdownView,
	Plugin,
	TFile,
	EditorPosition,
	Menu,
	Editor,
	setIcon,
} from "obsidian";
import {
	applyStyleToMargin,
	extractStyleFromOpeningTag,
	setStyleInOpeningTag,
} from "./style-utils";
import { SidenoteStyleModal } from "./style-modal";
import { EditorView, keymap, Command } from "@codemirror/view";
import { EditorState, EditorSelection } from "@codemirror/state";
import {
	DEFAULT_SETTINGS,
	SidenoteSettings,
	SidenoteSettingTab,
} from "./settings";

// CM6 building blocks for proper shortcuts + undo
import {
	defaultKeymap,
	history,
	historyKeymap,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
	// defaultHighlightStyle,
	syntaxHighlighting,
	HighlightStyle,
} from "@codemirror/language";
// eslint-disable-next-line import/no-extraneous-dependencies
import { tags } from "@lezer/highlight";

type CleanupFn = () => void;

// Near the top of the file, with your other type definitions
interface SidenoteMarginElement extends HTMLElement {
	_sidenoteCleanup?: () => void;
}

/** Minimal subset of Obsidian's Editor interface backed by a CM6 EditorView. */
interface MinimalEditor {
	getValue(): string;
	getLine(line: number): string;
	lineCount(): number;
	getCursor(): EditorPosition;
	setCursor(pos: EditorPosition): void;
	setSelection(anchor: EditorPosition, head?: EditorPosition): void;
	getSelection(): string;
	replaceSelection(text: string): void;
	getRange(from: EditorPosition, to: EditorPosition): string;
	replaceRange(
		text: string,
		from: EditorPosition,
		to?: EditorPosition,
	): void;
}

// Regex to detect sidenote spans in source text (includes the
// sidenote-left/sidenote-right variants — any extra classes after "sidenote")
const SIDENOTE_PATTERN = () =>
	/<span\s+class\s*=\s*["']sidenote(?:\s+[\w-]+)*["'][^>]*>/gi;

const SIDENOTE_SPAN_REGEX = () =>
	/<span\s+class\s*=\s*["']sidenote(?:\s+[\w-]+)*["'][^>]*>([\s\S]*?)<\/span>/gi;

// ======================================================
// ================= Main Plugin Class ==================
// ======================================================
export default class SidenotePlugin extends Plugin {
	settings: SidenoteSettings;

	private rafId: number | null = null;
	private cleanups: CleanupFn[] = [];
	private cmRoot: HTMLElement | null = null;
	private isMutating = false;
	private resizeObserver: ResizeObserver | null = null;
	private styleEl: HTMLStyleElement | null = null;

	// Map from sidenote text content (or position) to assigned number
	private sidenoteRegistry: Map<string, number> = new Map();
	private nextSidenoteNumber = 1;
	private headingSidenoteNumbers: Map<string, number> = new Map();

	// Track whether current document has any sidenotes
	private documentHasSidenotes = false;
	private needsFullRenumber = true;

	// Performance: Debounce/throttle timers
	private scrollDebounceTimer: number | null = null;
	private mutationDebounceTimer: number | null = null;
	private resizeThrottleTime: number = 0;

	// Performance: Layout caching
	private lastLayoutWidth: number = 0;
	private lastSidenoteCount: number = 0;
	private lastMode: string = "";

	// Performance: Visible sidenotes tracking
	private visibilityObserver: IntersectionObserver | null = null;
	private visibleSidenotes: Set<HTMLElement> = new Set();

	private totalSidenotesInDocument = 0;
	private isEditingMargin = false;
	private readingModeScrollTimer: number | null = null;

	public needsReadingModeRefresh = true;

	// Cached source content for reading mode (editor.getValue() can be empty)
	private cachedSourceContent: string = "";

	// Timing constants (in milliseconds)
	private static readonly RESIZE_DEBOUNCE = 100;
	private static readonly SCROLL_DEBOUNCE = 50;
	private static readonly MUTATION_DEBOUNCE = 100;
	private static readonly RENDER_DELAY = 100;
	private readingModeResizeThrottleTime: number = 0;
	private readingModeResizeTrailingTimer: number | null = null;

	private activeEditingMargin: HTMLElement | null = null;

	private spanCmView: EditorView | null = null;
	private spanOutsidePointerDown?: (ev: PointerEvent) => void;
	private spanOriginalText: string = "";

	// Reading-mode editing state
	private activeReadingModeMargin: HTMLElement | null = null;

	// Track the currently editing margin element for the global capture listener
	private currentlyEditingMargin: HTMLElement | null = null;
	// Cooldown timer after a reading-mode edit commit to prevent
	// the MutationObserver-triggered rebuild from overwriting the
	// freshly re-rendered margin with stale source data.
	private postEditCooldown: number | null = null;

	// Delegated click handler for reading mode margins (survives virtualization)
	private readingModeDelegateHandler: ((ev: MouseEvent) => void) | null =
		null;

	private layoutTrailingTimer: number | null = null;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new SidenoteSettingTab(this.app, this));
		this.injectStyles();
		this.setupVisibilityObserver();

		// Add command to insert sidenote
		this.addCommand({
			id: "insert-sidenote",
			name: "Insert sidenote",
			editorCallback: (editor) => {
				this.insertHtmlSidenote(editor, "sidenote");
			},
		});

		this.addCommand({
			id: "insert-left-sidenote",
			name: "Insert left sidenote",
			editorCallback: (editor) => {
				this.insertHtmlSidenote(editor, "sidenote sidenote-left");
			},
		});

		this.addCommand({
			id: "insert-right-sidenote",
			name: "Insert right sidenote",
			editorCallback: (editor) => {
				this.insertHtmlSidenote(editor, "sidenote sidenote-right");
			},
		});

		this.registerMarkdownPostProcessor((element) => {
			const hasContent =
				element.querySelectorAll("span.sidenote").length > 0;

			if (hasContent) {
				setTimeout(() => {
					requestAnimationFrame(() => {
						requestAnimationFrame(() => {
							this.processReadingModeSidenotes(element);
						});
					});
				}, 0);

				// Inject print sidenotes synchronously for PDF export
				this.injectPrintSidenotes(element);
			}
		});

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.resetRegistry();
				this.invalidateLayoutCache();
				this.needsReadingModeRefresh = true;
				this.scanDocumentForSidenotes();
				this.rebind();
				this.scheduleLayoutStable();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				// Update cached source so reading mode picks up edits
				// made in editing mode (and vice versa)
				this.scanDocumentForSidenotes();
				this.needsReadingModeRefresh = true;
				this.invalidateLayoutCache();
				this.rebindAndSchedule();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-open", (_file: TFile | null) => {
				this.resetRegistry();
				this.invalidateLayoutCache();
				this.needsReadingModeRefresh = true;
				this.scanDocumentForSidenotes();
				this.rebindAndSchedule();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("editor-change", () => {
				if (this.isEditingMargin) return;
				this.needsReadingModeRefresh = true;
				this.scanDocumentForSidenotes();
				this.needsFullRenumber = true;
				this.invalidateLayoutCache();
				this.scheduleLayoutDebounced(SidenotePlugin.MUTATION_DEBOUNCE);
			}),
		);

		this.registerDomEvent(window, "resize", () => {
			this.needsReadingModeRefresh = true;
			this.scheduleLayoutThrottled(SidenotePlugin.RESIZE_DEBOUNCE);
			this.scheduleReadingModeLayoutThrottled(100);
		});

		// Immediate — works if plugin is enabled/reloaded after startup
		// this.scanDocumentForSidenotes();
		// this.rebindAndSchedule();

		this.app.workspace.onLayoutReady(() => {
			this.scanDocumentForSidenotes();
			this.rebindAndSchedule();

			// Debug: log what state we're in
			setTimeout(() => {
				const cmRoot = this.cmRoot;
				console.log("[Sidenotes] Startup check:", {
					hasCmRoot: !!cmRoot,
					cmRootConnected: cmRoot?.isConnected,
					cmRootWidth: cmRoot?.getBoundingClientRect().width,
					mode: cmRoot?.dataset.sidenoteMode,
					hasSidenotes: cmRoot?.dataset.hasSidenotes,
					marginCount: cmRoot?.querySelectorAll("small.sidenote-margin")
						.length,
					resizeObserverExists: !!this.resizeObserver,
				});
			}, 2000);
		});
	}

	onunload() {
		this.cancelAllTimers();
		this.cleanups.forEach((fn) => fn());
		this.cleanups = [];

		this.currentlyEditingMargin = null;
		// Clear post-edit cooldown
		if (this.postEditCooldown !== null) {
			window.clearTimeout(this.postEditCooldown);
			this.postEditCooldown = null;
		}

		// Clear delegated reading mode handler
		this.readingModeDelegateHandler = null;

		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}

		if (this.visibilityObserver) {
			this.visibilityObserver.disconnect();
			this.visibilityObserver = null;
		}

		if (this.styleEl) {
			this.styleEl.remove();
			this.styleEl = null;
		}

		// Clean up reading mode scroll timer
		if (this.readingModeScrollTimer !== null) {
			window.clearTimeout(this.readingModeScrollTimer);
			this.readingModeScrollTimer = null;
		}

		const view = this.getMarkdownView();
		this.cleanupView(view);

		// Remove CSS custom properties and data attributes
		const root = document.documentElement;
		const propsToRemove = Array.from(root.style).filter((p) =>
			p.startsWith("--sn-"),
		);
		for (const prop of propsToRemove) {
			root.style.removeProperty(prop);
		}

		delete root.dataset.snBadgeStyle;
		delete root.dataset.snShowNumbers;
	}

	// Add public methods that the widget can call
	public renderLinksToFragmentPublic(text: string): DocumentFragment {
		return this.renderLinksToFragment(text);
	}

	public normalizeTextPublic(s: string): string {
		return this.normalizeText(s);
	}

	public formatNumberPublic(num: number): string {
		return this.formatNumber(num);
	}

	public scheduleEditingModeCollisionUpdate() {
		this.scheduleCollisionUpdate();
	}

	public setCurrentlyEditingMargin(margin: HTMLElement | null) {
		this.currentlyEditingMargin = margin;
	}

	public getCurrentlyEditingMargin(): HTMLElement | null {
		return this.currentlyEditingMargin;
	}

	public forceReadingModeRefreshPublic() {
		this.forceReadingModeRefresh();
	}

	public refreshCachedSourceContentPublic() {
		this.refreshCachedSourceContent();
	}

	public injectStylesPublic() {
		this.injectStyles();
	}

	/**
	 * Return the forced side for a sidenote element.
	 * <span class="sidenote sidenote-left"> → "left",
	 * <span class="sidenote sidenote-right"> → "right".
	 * Returns null when the note should use the global setting.
	 */
	public getForcedSide(el: HTMLElement): "left" | "right" | null {
		if (el.classList.contains("sidenote-left")) return "left";
		if (el.classList.contains("sidenote-right")) return "right";
		return null;
	}

	private cleanupView(view: MarkdownView | null) {
		if (!view) return;

		const cmRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		if (cmRoot) {
			cmRoot
				.querySelectorAll("span.sidenote-number")
				.forEach((wrapper) => {
					const parent = wrapper.parentNode;
					if (!parent) return;
					// Move the original span.sidenote back before the wrapper
					const sidenote = wrapper.querySelector("span.sidenote");
					if (sidenote) {
						parent.insertBefore(sidenote, wrapper);
					}
					// Now safe to remove the wrapper (only contains the margin)
					wrapper.remove();
				});
			cmRoot
				.querySelectorAll("small.sidenote-margin")
				.forEach((n) => n.remove());
			cmRoot.style.removeProperty("--editor-width");
			cmRoot.style.removeProperty("--sidenote-scale");
			cmRoot.dataset.sidenoteMode = "";
			cmRoot.dataset.hasSidenotes = "";
			cmRoot.dataset.sidenotePosition = "";
		}

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			readingRoot
				.querySelectorAll("span.sidenote-number")
				.forEach((n) => n.remove());
			readingRoot
				.querySelectorAll("small.sidenote-margin")
				.forEach((n) => n.remove());
			readingRoot.style.removeProperty("--editor-width");
			readingRoot.style.removeProperty("--sidenote-scale");
			readingRoot.dataset.sidenoteMode = "";
			readingRoot.dataset.hasSidenotes = "";
			readingRoot.dataset.sidenotePosition = "";

			// Clear processed flags
			readingRoot
				.querySelectorAll("[data-sidenotes-processed]")
				.forEach((el) => {
					delete (el as HTMLElement).dataset.sidenotesProcessed;
				});
		}
	}

	async loadSettings() {
		try {
			const data = (await this.loadData()) as
				| Partial<SidenoteSettings>
				| undefined;
			this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
			// Prune settings keys from removed features (footnote format,
			// margin notes) so they don't linger in data.json.
			const legacyKeys = [
				"sidenoteFormat",
				"hideFootnotes",
				"hideFootnoteNumbers",
				"marginNoteDisplay",
				"popupIcon",
				"marginNoteScaleFactor",
				"popupIconScaleFactor",
			];
			for (const key of legacyKeys) {
				delete (this.settings as unknown as Record<string, unknown>)[
					key
				];
			}
		} catch (error) {
			console.error("Sidenote plugin: Failed to load settings", error);
			this.settings = Object.assign({}, DEFAULT_SETTINGS);
		}
	}

	async saveSettings() {
		try {
			// Validate settings before saving
			const s = this.settings;

			// Ensure min <= max for widths
			if (s.minSidenoteWidth > s.maxSidenoteWidth) {
				s.minSidenoteWidth = s.maxSidenoteWidth;
			}

			// Ensure breakpoints are in order
			if (s.hideBelow >= s.compactBelow) {
				s.compactBelow = s.hideBelow + 100;
			}
			if (s.compactBelow >= s.fullAbove) {
				s.fullAbove = s.compactBelow + 100;
			}

			// Clamp values to reasonable ranges
			s.collisionSpacing = Math.max(0, Math.min(50, s.collisionSpacing));
			s.fontSize = Math.max(50, Math.min(150, s.fontSize));
			s.fontSizeCompact = Math.max(50, Math.min(150, s.fontSizeCompact));
			s.lineHeight = Math.max(1, Math.min(3, s.lineHeight));
			s.pageOffsetFactor = Math.max(0, Math.min(1, s.pageOffsetFactor));

			await this.saveData(this.settings);

			// Apply new CSS variables
			this.injectStyles();

			// Reset numbering state
			this.resetRegistry();
			this.invalidateLayoutCache();
			this.scanDocumentForSidenotes();

			// --- Reading mode: full teardown + rebuild ---
			this.cleanupReadingMode();
			this.needsReadingModeRefresh = true;
			this.forceReadingModeRefresh();

			// --- Editing mode: let CM6 handle it ---
			// Don't manually remove DOM inside .cm-content — that corrupts
			// CM6's internal state. Instead, force CM6 to re-render.
			const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
			const cmEditor = (mdView?.editor as { cm?: EditorView })?.cm;
			if (cmEditor) {
				// requestMeasure triggers a geometry pass so CM6 re-renders
				// with the new settings.
				cmEditor.requestMeasure();
			}

			// Re-bind scroll/resize/mutation observers and schedule layout
			this.rebindAndSchedule();
		} catch (error) {
			console.error("Sidenote plugin: Failed to save settings", error);
		}
	}

	private getMarkdownView(): MarkdownView | null {
		// Try active view first
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) return active;

		// Fallback: find any visible markdown leaf
		const leaves = this.app.workspace.getLeavesOfType("markdown");
		for (const leaf of leaves) {
			if (leaf.view instanceof MarkdownView) {
				return leaf.view;
			}
		}
		return null;
	}

	/**
	 * Clean up sidenote markup from reading mode only.
	 * Never manually remove DOM inside CM6 .cm-content — that
	 * corrupts CM6's internal state and causes sidenotes to vanish.
	 */
	private cleanupReadingMode() {
		const view = this.getMarkdownView();
		if (!view) return;

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			this.removeAllSidenoteMarkupFromReadingMode(readingRoot);
			readingRoot.dataset.sidenoteMode = "";
			readingRoot.dataset.hasSidenotes = "";
		}
	}

	/**
	 * Force a refresh of reading mode sidenotes.
	 */
	private forceReadingModeRefresh() {
		this.needsReadingModeRefresh = true;
		const view = this.getMarkdownView();
		if (!view) return;

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (!readingRoot) return;

		// Clear any processed flags
		readingRoot
			.querySelectorAll("[data-sidenotes-processed]")
			.forEach((el) => {
				delete (el as HTMLElement).dataset.sidenotesProcessed;
			});

		// Reset the mode so it gets recalculated
		readingRoot.dataset.sidenoteMode = "";
		readingRoot.style.removeProperty("--sidenote-scale");

		// Schedule reprocessing with a delay to ensure cleanup is complete
		setTimeout(() => {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					this.processReadingModeSidenotes(readingRoot);
				});
			});
		}, SidenotePlugin.RENDER_DELAY);
	}

	/**
	 * Install a single delegated click handler on the reading-mode root.
	 * This survives DOM virtualization because it lives on the persistent
	 * ancestor, not on individual margin elements that Obsidian may destroy.
	 */
	private ensureReadingModeDelegation(readingRoot: HTMLElement) {
		// Already installed on this element
		if (this.readingModeDelegateHandler) return;

		const handler = (ev: MouseEvent) => {
			const target = ev.target as HTMLElement | null;
			if (!target) return;

			const margin = target.closest<HTMLElement>("small.sidenote-margin");
			if (!margin) return;

			// Don't interfere with an editor that's already open
			if (margin.dataset.editing === "true") {
				ev.stopPropagation();
				return;
			}

			// Gear icon opens the per-note style modal (works even when
			// reading-mode editing is disabled)
			if (target.closest(".sidenote-style-gear")) {
				ev.preventDefault();
				ev.stopPropagation();
				this.openStyleModal(
					margin,
					margin.dataset.sidenoteRawText ?? "",
				);
				return;
			}

			if (!this.settings.editInReadingMode) return;

			// Don't intercept clicks on links inside the margin
			if (target.closest("a")) return;

			ev.preventDefault();
			ev.stopPropagation();

			if (margin.dataset.sidenoteType !== "html") return;

			const rawText = margin.dataset.sidenoteRawText ?? "";
			if (!rawText) return;

			// Find this exact text in the source to confirm it exists
			const view2 = this.app.workspace.getActiveViewOfType(MarkdownView);
			const content =
				view2?.editor?.getValue() ||
				(view2 as { data?: string })?.data ||
				this.cachedSourceContent ||
				"";
			if (!content) return;

			// Search for a span containing this exact raw text
			const regex = SIDENOTE_SPAN_REGEX();
			let m: RegExpExecArray | null;
			while ((m = regex.exec(content)) !== null) {
				if (m[1] === rawText) {
					this.startReadingModeHtmlEdit(margin, rawText);
					break;
				}
			}
		};

		readingRoot.addEventListener("click", handler, true);
		this.readingModeDelegateHandler = handler;

		// Store a cleanup that removes the handler if the view is torn down
		this.cleanups.push(() => {
			readingRoot.removeEventListener("click", handler, true);
			this.readingModeDelegateHandler = null;
		});
	}

	/**
	 * Shared implementation for the insert commands (plain, forced-left,
	 * forced-right sidenote). Inserts an HTML span with the given classes,
	 * wrapping the current selection if there is one.
	 */
	private insertHtmlSidenote(editor: Editor, cssClass: string) {
		const cursor = editor.getCursor();
		const selectedText = editor.getSelection();

		const openTag = `<span class="${cssClass}">`;
		if (selectedText) {
			editor.replaceSelection(`${openTag}${selectedText}</span>`);
		} else {
			editor.replaceRange(`${openTag}</span>`, cursor);
			editor.setCursor({
				line: cursor.line,
				ch: cursor.ch + openTag.length,
			});
		}
	}

	// ==================== Performance Utilities ====================

	private cancelAllTimers() {
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		if (this.scrollDebounceTimer !== null) {
			window.clearTimeout(this.scrollDebounceTimer);
			this.scrollDebounceTimer = null;
		}
		if (this.mutationDebounceTimer !== null) {
			window.clearTimeout(this.mutationDebounceTimer);
			this.mutationDebounceTimer = null;
		}
	}

	private invalidateLayoutCache() {
		this.lastLayoutWidth = 0;
		this.lastSidenoteCount = 0;
		this.lastMode = "";
		// this.lastCollisionHash = "";
	}

	private scheduleLayoutDebounced(
		delay: number = SidenotePlugin.MUTATION_DEBOUNCE,
	) {
		if (this.mutationDebounceTimer !== null) {
			window.clearTimeout(this.mutationDebounceTimer);
		}
		this.mutationDebounceTimer = window.setTimeout(() => {
			this.mutationDebounceTimer = null;
			this.scheduleLayout();
		}, delay);
	}

	private scheduleLayoutThrottled(
		minInterval: number = SidenotePlugin.RESIZE_DEBOUNCE,
	) {
		const now = Date.now();
		if (now - this.resizeThrottleTime >= minInterval) {
			this.resizeThrottleTime = now;
			this.scheduleLayout();
		}
	}

	private scheduleReadingModeLayoutThrottled(
		minInterval: number = SidenotePlugin.RESIZE_DEBOUNCE,
	) {
		const now = Date.now();

		// Clear any pending trailing call
		if (this.readingModeResizeTrailingTimer !== null) {
			window.clearTimeout(this.readingModeResizeTrailingTimer);
		}

		if (now - this.readingModeResizeThrottleTime >= minInterval) {
			this.readingModeResizeThrottleTime = now;
			this.scheduleReadingModeLayout();
		}

		// Always schedule a trailing call to catch the final state
		this.readingModeResizeTrailingTimer = window.setTimeout(() => {
			this.readingModeResizeTrailingTimer = null;
			this.readingModeResizeThrottleTime = Date.now();
			this.scheduleReadingModeLayout();
		}, minInterval);
	}

	private setupVisibilityObserver() {
		this.visibilityObserver = new IntersectionObserver(
			(entries) => {
				let needsCollisionUpdate = false;
				for (const entry of entries) {
					const el = entry.target as HTMLElement;

					// Check if element is still in the DOM
					if (!el.isConnected) {
						this.visibleSidenotes.delete(el);
						continue;
					}

					if (entry.isIntersecting) {
						if (!this.visibleSidenotes.has(el)) {
							this.visibleSidenotes.add(el);
							needsCollisionUpdate = true;
						}
					} else {
						if (this.visibleSidenotes.has(el)) {
							this.visibleSidenotes.delete(el);
							needsCollisionUpdate = true;
						}
					}
				}
				if (needsCollisionUpdate) {
					this.scheduleCollisionUpdate();
				}
			},
			{
				rootMargin: "100px 0px",
				threshold: 0,
			},
		);
	}

	private observeSidenoteVisibility(margin: HTMLElement) {
		if (this.visibilityObserver) {
			this.visibilityObserver.observe(margin);
		}
	}

	private unobserveSidenoteVisibility(margin: HTMLElement) {
		if (this.visibilityObserver) {
			this.visibilityObserver.unobserve(margin);
			this.visibleSidenotes.delete(margin);
		}
	}

	// ==================== Style Injection ====================

	private injectStyles() {
		const s = this.settings;
		const root = document.documentElement;

		// Layout variables
		root.style.setProperty("--sn-base-width", `${s.minSidenoteWidth}rem`);
		root.style.setProperty(
			"--sn-max-extra",
			`${s.maxSidenoteWidth - s.minSidenoteWidth}rem`,
		);
		root.style.setProperty("--sn-gap", `${s.sidenoteGap}rem`);
		root.style.setProperty("--sn-gap2", `${s.sidenoteGap2}rem`);
		root.style.setProperty(
			"--sn-page-offset-factor",
			`${s.pageOffsetFactor}`,
		);

		// Compact mode
		root.style.setProperty(
			"--sn-base-width-compact",
			`${Math.max(s.minSidenoteWidth - 2, 6)}rem`,
		);
		root.style.setProperty(
			"--sn-max-extra-compact",
			`${Math.max((s.maxSidenoteWidth - s.minSidenoteWidth) / 2, 2)}rem`,
		);
		root.style.setProperty(
			"--sn-gap-compact",
			`${Math.max(s.sidenoteGap - 1, 0.5)}rem`,
		);
		root.style.setProperty(
			"--sn-gap2-compact",
			`${Math.max(s.sidenoteGap2 - 0.5, 0.25)}rem`,
		);

		// Full mode
		root.style.setProperty(
			"--sn-base-width-full",
			`${s.maxSidenoteWidth}rem`,
		);
		root.style.setProperty("--sn-gap-full", `${s.sidenoteGap + 1}rem`);
		root.style.setProperty("--sn-gap2-full", `${s.sidenoteGap2 + 0.5}rem`);

		// Typography
		root.style.setProperty("--sn-font-size", `${s.fontSize}%`);
		root.style.setProperty(
			"--sn-font-size-compact",
			`${s.fontSizeCompact}%`,
		);

		// Text Color
		root.style.setProperty(
			"--sn-text-color",
			s.textColor || "var(--text-normal)",
		);

		// Text color on hover
		if (s.hoverColor) {
			root.style.setProperty("--sn-hover-color", s.hoverColor);
		} else {
			root.style.removeProperty("--sn-hover-color");
		}

		// Line Height
		root.style.setProperty("--sn-line-height", `${s.lineHeight}`);
		root.style.setProperty(
			"--sn-line-height-compact",
			`${Math.max(s.lineHeight - 0.1, 1.1)}`,
		);

		// Text alignment
		const defaultAlignment =
			s.sidenotePosition === "left" ? "right" : "left";
		const textAlign =
			s.textAlignment === "justify"
				? "justify"
				: s.textAlignment === "left" || s.textAlignment === "right"
					? s.textAlignment
					: defaultAlignment;
		root.style.setProperty("--sn-text-align", textAlign);

		// Number color
		if (s.numberColor) {
			root.style.setProperty("--sn-number-color", s.numberColor);
		} else {
			root.style.removeProperty("--sn-number-color");
		}

		// Transitions
		root.style.setProperty(
			"--sn-transition",
			s.enableTransitions
				? "width 0.15s ease-out, left 0.15s ease-out, right 0.15s ease-out, opacity 0.15s ease-out"
				: "none",
		);

		// Print margin changes
		this.injectPrintPageStyle();

		// Data attributes for CSS selectors
		root.dataset.snBadgeStyle = s.numberBadgeStyle;
		root.dataset.snShowNumbers = s.showSidenoteNumbers ? "true" : "false";
	}

	/**
	 * Calculate and apply sidenote positioning based on anchor mode and gaps.
	 *
	 * For LEFT sidenotes:
	 * - TEXT ANCHOR: Sidenote's right edge is gap1 away from text. As editor widens,
	 *   gap between sidenote and editor edge increases.
	 * - EDGE ANCHOR: Sidenote's left edge is gap2 away from editor edge. As editor widens,
	 *   gap between sidenote and text increases.
	 *
	 * Both modes respect both gap constraints as minimums.
	 */
	private updateSidenotePositioning(
		root: HTMLElement,
		isReadingMode: boolean,
	) {
		const s = this.settings;
		const position = s.sidenotePosition;
		const anchorMode = s.sidenoteAnchor;

		// Get root element rect
		const rootRect = root.getBoundingClientRect();

		console.log("[Sidenotes] updateSidenotePositioning:", {
			rootWidth: rootRect.width,
			isReadingMode,
			isConnected: root.isConnected,
		});

		// Get rem to px conversion
		const remToPx =
			parseFloat(getComputedStyle(document.documentElement).fontSize) ||
			16;
		// Base gaps (minimums)
		const baseGap1 = s.sidenoteGap * remToPx; // gap between sidenote and text
		const baseGap2 = s.sidenoteGap2 * remToPx; // gap between sidenote and edge

		// Scale gaps proportionally as editor grows.
		// Use the pageOffsetFactor setting to control growth rate.
		// At hideBelow width, gaps are at their minimum.
		// As width increases, gaps grow by a fraction of the extra available space.
		const editorWidth = rootRect.width;
		const growthFactor = s.sidenoteGapDrift; // 0 = no growth, 1 = maximum growth
		const extraSpace = Math.max(0, editorWidth - s.hideBelow);
		const gapGrowth = extraSpace * growthFactor * 0.25; // subtle growth

		const gap1 = baseGap1 + gapGrowth;
		const gap2 = baseGap2 + gapGrowth;

		// Find a representative line/paragraph to measure the text column edge.
		// In reading mode, Obsidian virtualises content so the first <p> may
		// have zero size or be nested inside a blockquote/list.  Walk the
		// sizer's direct child <div>s and pick the first one that contains a
		// visible block-level element at the top level of the content flow.
		let refLine: HTMLElement | null = null;
		if (isReadingMode) {
			const sizer = root.querySelector<HTMLElement>(
				".markdown-preview-sizer",
			);
			if (sizer) {
				const sections =
					sizer.querySelectorAll<HTMLElement>(":scope > div");
				for (const section of Array.from(sections)) {
					if (section.offsetHeight === 0) continue;
					const candidate = section.querySelector<HTMLElement>(
						":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6",
					);
					if (candidate && candidate.offsetHeight > 0) {
						refLine = candidate;
						break;
					}
				}
			}
			if (!refLine) {
				refLine = root.querySelector<HTMLElement>(
					".markdown-preview-sizer",
				);
			}
		} else {
			refLine = this.findStableCmRefLine(root);
		}

		if (!refLine) return;

		const refRect = refLine.getBoundingClientRect();

		// Get sidenote width from an existing margin element, or fall back to calculation
		const sidenoteWidth = this.getSidenoteWidthPx(root);

		if (position === "left") {
			// Available space between editor left edge and the text (refLine left edge)
			const textLeft = isReadingMode
				? (this.getReadingTextLeft(root) ?? refRect.left)
				: (this.getEditorTextEdges(root)?.left ?? refRect.left);

			// Calculate the CSS left value (negative = to the left of refLine)
			let cssLeft: number;

			if (anchorMode === "text") {
				// TEXT ANCHOR MODE:
				// Position sidenote so its right edge is exactly gap1 from text (if in left margin)

				cssLeft = -(gap1 + sidenoteWidth);
			} else {
				// EDGE ANCHOR MODE (LEFT):
				// Use the real editor edge (scroller/view), not rootRect.left (which may already be padded).
				const editorEdgeLeft = (() => {
					if (isReadingMode) return root.getBoundingClientRect().left;
					const scroller = root.querySelector<HTMLElement>(".cm-scroller");
					return (scroller ?? root).getBoundingClientRect().left;
				})();

				// Place sidenote so its LEFT edge is gap2 from the editor edge
				// cssLeft is relative to the text column edge (textLeft)
				cssLeft = editorEdgeLeft + gap2 - textLeft;

				// Keep it from intruding into the text column (best-effort safety).
				// If cssLeft is too large (not negative enough), the sidenote overlaps text.
				const maxCssLeft = -(gap1 + sidenoteWidth);
				if (cssLeft > maxCssLeft) cssLeft = maxCssLeft;
			}

			root.style.setProperty("--sidenote-offset", `${cssLeft}px`);
		} else {
			// RIGHT POSITION
			// Available space between text (refLine right edge) and editor right edge
			const textEdges = !isReadingMode
				? this.getEditorTextEdges(root)
				: null;
			const textRight = textEdges ? textEdges.right : refRect.right;

			let cssRight: number;

			if (anchorMode === "text") {
				// TEXT ANCHOR MODE:
				// Position sidenote so its left edge is exactly gap1 from text
				// cssRight works inversely: negative moves element to the right
				cssRight = -(gap1 + sidenoteWidth);
			} else {
				const editorEdgeRight = (() => {
					if (isReadingMode) return root.getBoundingClientRect().right;

					const scroller = root.querySelector<HTMLElement>(".cm-scroller");
					return (scroller ?? root).getBoundingClientRect().right;
				})();

				cssRight = editorEdgeRight - gap2 - textRight;

				const maxCssRight = -(gap1 + sidenoteWidth);
				if (cssRight > maxCssRight) cssRight = maxCssRight;
			}

			root.style.setProperty("--sidenote-offset", `${cssRight}px`);
		}
	}

	private measureCssLengthPx(
		host: HTMLElement,
		cssLengthExpr: string,
	): number {
		const probe = document.createElement("div");
		probe.style.position = "absolute";
		probe.style.visibility = "hidden";
		probe.style.pointerEvents = "none";
		probe.style.width = cssLengthExpr;
		probe.style.height = "0";
		host.appendChild(probe);
		const w = probe.getBoundingClientRect().width;
		probe.remove();
		return w;
	}

	private getSidenoteWidthPx(root: HTMLElement): number {
		// Root here should be the element that has --sidenote-width in scope
		const cs = getComputedStyle(root);
		const expr = cs.getPropertyValue("--sidenote-width").trim();
		if (expr) return this.measureCssLengthPx(root, expr);

		// fallback
		const remToPx =
			parseFloat(getComputedStyle(document.documentElement).fontSize) ||
			16;
		return this.settings.minSidenoteWidth * remToPx;
	}

	private getReadingTextLeft(root: HTMLElement): number | null {
		const sizer = root.querySelector<HTMLElement>(
			".markdown-preview-sizer",
		);
		if (!sizer) return null;
		const r = sizer.getBoundingClientRect();
		const cs = getComputedStyle(sizer);
		const pl = parseFloat(cs.paddingLeft) || 0;
		return r.left + pl;
	}

	private getEditorTextEdges(
		root: HTMLElement,
	): { left: number; right: number } | null {
		// The page offset for sidenotes is applied to the scroller, so measure from it.
		const scroller = root.querySelector<HTMLElement>(".cm-scroller");
		if (!scroller) return null;

		const r = scroller.getBoundingClientRect();
		const cs = getComputedStyle(scroller);
		const pl = parseFloat(cs.paddingLeft) || 0;
		const pr = parseFloat(cs.paddingRight) || 0;

		return {
			left: r.left + pl,
			right: r.right - pr,
		};
	}

	/**
	 * Helper for updateSidenotePositioning to find a stable reference line
	 * This helps to establish reliable positioning even when the first lines are empty or virtualized.
	 * @param root
	 * @returns
	 */
	private findStableCmRefLine(root: HTMLElement): HTMLElement | null {
		const rootRect = root.getBoundingClientRect();
		const lines = Array.from(
			root.querySelectorAll<HTMLElement>(".cm-line"),
		);

		// Prefer a line that is:
		// - visible (height > 0)
		// - not collapsed to left edge (left significantly inside the root)
		// - has non-trivial width
		for (const el of lines) {
			if (!el.isConnected) continue;
			const r = el.getBoundingClientRect();
			if (r.height < 8) continue;
			if (r.width < 40) continue;

			const inset = r.left - rootRect.left;

			// Heuristic: text column is usually inset by padding/gutter; reject 0–2px.
			if (inset <= 2) continue;

			return el;
		}

		// Fallback: first line with height
		for (const el of lines) {
			const r = el.getBoundingClientRect();
			if (r.height > 0) return el;
		}

		return null;
	}

	/**
	 * Correct per-wrapper --sidenote-offset for sidenotes inside indented
	 * containers (li, blockquote, callout).  Called AFTER updateSidenotePositioning
	 * so that the global --sidenote-offset on the root is already set.
	 *
	 * Uses the SAME refLine search logic as updateSidenotePositioning to
	 * guarantee consistency. The global offset positions sidenotes relative
	 * to refLine. For wrappers inside an indented parent, position:absolute
	 * resolves against that parent instead, so we compute a per-wrapper
	 * offset that compensates for the difference.
	 */
	private correctIndentedSidenotePositions(root: HTMLElement) {
		const position = this.settings.sidenotePosition;

		// Read the global offset that updateSidenotePositioning just set
		const globalOffset =
			parseFloat(root.style.getPropertyValue("--sidenote-offset")) || 0;

		// Find the SAME reference element updateSidenotePositioning used
		const sizer = root.querySelector<HTMLElement>(
			".markdown-preview-sizer",
		);
		if (!sizer) return;

		let refEl: HTMLElement | null = null;
		const sections = sizer.querySelectorAll<HTMLElement>(":scope > div");
		for (const section of Array.from(sections)) {
			if (section.offsetHeight === 0) continue;
			const candidate = section.querySelector<HTMLElement>(
				":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6",
			);
			if (candidate && candidate.offsetHeight > 0) {
				refEl = candidate;
				break;
			}
		}
		if (!refEl) return;

		const refRect = refEl.getBoundingClientRect();

		const wrappers = root.querySelectorAll<HTMLElement>(
			"span.sidenote-number",
		);

		for (const wrapper of Array.from(wrappers)) {
			const indentedParent = wrapper.closest<HTMLElement>(
				"li, blockquote, .callout-content",
			);

			if (!indentedParent) {
				// Not indented — inherit the global offset
				wrapper.style.removeProperty("--sidenote-offset");
				continue;
			}

			const parentRect = indentedParent.getBoundingClientRect();

			if (position === "left") {
				// Global offset is relative to refEl's left edge.
				// This wrapper resolves position:absolute against indentedParent.
				// Shift = how much further right the parent is vs refEl.
				const shift = parentRect.left - refRect.left;
				wrapper.style.setProperty(
					"--sidenote-offset",
					`${globalOffset - shift}px`,
				);
			} else {
				// Global offset is relative to refEl's right edge.
				// Shift = how much further left the parent's right edge is vs refEl.
				const shift = refRect.right - parentRect.right;
				wrapper.style.setProperty(
					"--sidenote-offset",
					`${globalOffset - shift}px`,
				);
			}
		}
	}

	/**
	 * Find an HTML sidenote in the source by its text content.
	 * Returns the match details or null if not found.
	 */
	private findHtmlSidenoteInSource(sidenoteText: string): {
		text: string;
		fullMatch: string;
		index: number;
		openingTag: string;
	} | null {
		const view = this.getMarkdownView();
		const content =
			view?.editor?.getValue() ||
			(view as { data?: string })?.data ||
			this.cachedSourceContent ||
			"";
		if (!content) return null;

		const regex = SIDENOTE_SPAN_REGEX();
		let match: RegExpExecArray | null;

		// Try exact match first
		while ((match = regex.exec(content)) !== null) {
			if ((match[1] ?? "") === sidenoteText) {
				return {
					text: match[1] ?? "",
					fullMatch: match[0],
					index: match.index,
					openingTag: match[0].substring(0, match[0].indexOf(">") + 1),
				};
			}
		}

		// Fallback: try normalized match
		const normalized = this.normalizeText(sidenoteText);
		const regex2 = SIDENOTE_SPAN_REGEX();
		while ((match = regex2.exec(content)) !== null) {
			if (this.normalizeText(match[1] ?? "") === normalized) {
				return {
					text: match[1] ?? "",
					fullMatch: match[0],
					index: match.index,
					openingTag: match[0].substring(0, match[0].indexOf(">") + 1),
				};
			}
		}
		return null;
	}

	// ==================== Number Formatting ====================

	private formatNumber(num: number): string {
		switch (this.settings.numberStyle) {
			case "roman":
				return this.toRoman(num);
			case "letters":
				return this.toLetters(num);
			case "arabic":
			default:
				return String(num);
		}
	}

	private toRoman(num: number): string {
		const romanNumerals: [number, string][] = [
			[1000, "m"],
			[900, "cm"],
			[500, "d"],
			[400, "cd"],
			[100, "c"],
			[90, "xc"],
			[50, "l"],
			[40, "xl"],
			[10, "x"],
			[9, "ix"],
			[5, "v"],
			[4, "iv"],
			[1, "i"],
		];
		let result = "";
		for (const [value, numeral] of romanNumerals) {
			while (num >= value) {
				result += numeral;
				num -= value;
			}
		}
		return result || "i";
	}

	private toLetters(num: number): string {
		if (num <= 0) return "a"; // Handle edge case
		let result = "";
		while (num > 0) {
			num--;
			result = String.fromCharCode(97 + (num % 26)) + result;
			num = Math.floor(num / 26);
		}
		return result;
	}

	// ==================== Reading Mode Processing ====================

	private processReadingModeSidenotes(element: HTMLElement) {
		const view = this.getMarkdownView();
		if (!view) return;

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (!readingRoot) return;

		// Skip full reprocessing during the post-edit cooldown.
		// After a reading-mode edit, the margin was already re-rendered
		// with the correct text. Obsidian's async DOM re-render fires
		// the MutationObserver, but source caches may still be stale.
		// Let the cooldown expire before allowing a full rebuild.
		if (this.postEditCooldown !== null) {
			return;
		}

		// Ensure the delegated click handler is installed (survives virtualization)
		this.ensureReadingModeDelegation(readingRoot);

		// Check if there are sidenote spans not yet wrapped
		const unwrappedSpans = readingRoot.querySelectorAll(
			"span.sidenote:not(.sidenote-number span.sidenote)",
		);
		const hasUnwrapped = unwrappedSpans.length > 0;

		const hasAnyMargins =
			readingRoot.querySelector("small.sidenote-margin") !== null;

		// If nothing new to wrap and no full refresh needed, still recompute positioning.
		// This is required when settings like sidenoteAnchor / sidenotePosition change.
		if (!this.needsReadingModeRefresh && !hasUnwrapped) {
			if (hasAnyMargins) {
				requestAnimationFrame(() => {
					if (!readingRoot.isConnected) return;

					// Force reflow so measurements are accurate
					void readingRoot.offsetHeight;

					// Re-apply global offset based on current settings (text vs edge)
					this.updateSidenotePositioning(readingRoot, true);

					// Re-apply per-wrapper corrections (li/blockquote/callout)
					this.correctIndentedSidenotePositions(readingRoot);

					// Optional but usually good: re-resolve collisions
					const allMargins = Array.from(
						readingRoot.querySelectorAll<HTMLElement>(
							"small.sidenote-margin",
						),
					).filter((m) => m.isConnected);

					this.resolveCollisions(
						allMargins,
						this.settings.collisionSpacing,
					);
				});
			}
			return;
		}

		const isFullRefresh = this.needsReadingModeRefresh;

		const rect = readingRoot.getBoundingClientRect();
		const width = rect.width;

		readingRoot.style.setProperty("--editor-width", `${width}px`);

		const mode = this.calculateMode(width);
		readingRoot.dataset.sidenoteMode = mode;
		readingRoot.dataset.sidenotePosition = this.settings.sidenotePosition;
		readingRoot.dataset.sidenoteAnchor = this.settings.sidenoteAnchor;

		const scaleFactor = this.calculateScaleFactor(width);
		readingRoot.style.setProperty(
			"--sidenote-scale",
			scaleFactor.toFixed(3),
		);

		if (mode === "hidden") {
			return;
		}

		// Only do full teardown on explicit refresh (file change, settings change).
		// For incremental processing (new sections scrolled into view), keep
		// existing sidenotes and only wrap the new unwrapped refs.
		if (isFullRefresh) {
			this.removeAllSidenoteMarkupFromReadingMode(readingRoot);
		}

		const allItems: {
			el: HTMLElement;
			rect: DOMRect;
			text: string;
			rawText: string;
		}[] = [];

		// Build list of raw source texts for HTML sidenotes
		const htmlSidenoteRawTexts: string[] = [];
		{
			const view2 = this.app.workspace.getActiveViewOfType(MarkdownView);
			const sourceContent =
				view2?.editor?.getValue() ||
				(view2 as { data?: string })?.data ||
				this.cachedSourceContent ||
				"";
			if (sourceContent) {
				const regex = SIDENOTE_SPAN_REGEX();
				let m: RegExpExecArray | null;
				while ((m = regex.exec(sourceContent)) !== null) {
					htmlSidenoteRawTexts.push(m[1] ?? "");
				}
			}
		}

		const spans = Array.from(
			readingRoot.querySelectorAll<HTMLElement>("span.sidenote"),
		).filter(
			(span) =>
				!span.parentElement?.classList.contains("sidenote-number"),
		);

		let rawIdx = 0;
		for (const el of spans) {
			allItems.push({
				el,
				rect: el.getBoundingClientRect(),
				text: el.textContent ?? "",
				rawText: htmlSidenoteRawTexts[rawIdx] ?? el.textContent ?? "",
			});
			rawIdx++;
		}

		if (allItems.length === 0) {
			readingRoot.dataset.hasSidenotes = "false";
			return;
		}

		this.needsReadingModeRefresh = false;

		readingRoot.dataset.hasSidenotes = "true";

		// Sort by vertical position. Items with valid rects sort by top position;
		// items with zero rects (not yet laid out) sort by their DOM order,
		// which querySelectorAll already preserves.
		allItems.sort((a, b) => a.rect.top - b.rect.top);

		// Start numbering from 1
		let num = 1;

		const createdMargins: HTMLElement[] = [];

		for (const item of allItems) {
			if (this.settings.resetNumberingPerHeading) {
				const heading = this.findPrecedingHeading(item.el);
				if (heading) {
					const headingId = this.getHeadingId(heading);
					if (!this.headingSidenoteNumbers.has(headingId)) {
						this.headingSidenoteNumbers.set(headingId, 1);
					}
					num = this.headingSidenoteNumbers.get(headingId)!;
					this.headingSidenoteNumbers.set(headingId, num + 1);
				}
			}

			const forcedSide = this.getForcedSide(item.el);
			const numStr = this.formatNumber(num++);

			const wrapper = document.createElement("span");
			wrapper.className = "sidenote-number";
			const margin = document.createElement("small");
			margin.className = "sidenote-margin";

			if (forcedSide) {
				wrapper.dataset.sidenoteSide = forcedSide;
				margin.dataset.sidenoteSide = forcedSide;
			}
			wrapper.dataset.sidenoteNum = numStr;
			margin.dataset.sidenoteNum = numStr;

			this.cloneContentToMargin(item.el, margin);

			applyStyleToMargin(margin, item.el.getAttribute("style"));
			this.attachStyleGear(margin);

			// Raw text + type are needed by the style gear even when
			// reading-mode editing is disabled.
			margin.dataset.sidenoteType = "html";
			margin.dataset.sidenoteRawText = item.rawText ?? item.text;
			if (this.settings.editInReadingMode) {
				margin.dataset.editing = "false";
				margin.style.cursor = "pointer";
			}

			item.el.parentNode?.insertBefore(wrapper, item.el);
			wrapper.appendChild(item.el);
			wrapper.appendChild(margin);

			this.applyLineOffset(wrapper, margin, false);

			this.observeSidenoteVisibility(margin);
			createdMargins.push(margin);
		}

		// Run positioning after DOM is fully settled and elements are laid out.
		// We defer twice: once to let the browser insert elements, once to lay them out.

		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (!readingRoot.isConnected) return;

				// Force reflow
				void readingRoot.offsetHeight;

				// Recompute line offsets now that elements are actually laid out
				const wrappers = readingRoot.querySelectorAll<HTMLElement>(
					"span.sidenote-number",
				);
				for (const wrapper of Array.from(wrappers)) {
					const margin = wrapper.querySelector<HTMLElement>(
						"small.sidenote-margin",
					);
					if (margin) {
						this.applyLineOffset(wrapper, margin, false);
					}
				}

				// Calculate and apply global sidenote positioning
				this.updateSidenotePositioning(readingRoot, true);

				// Correct per-wrapper offset for indented parents
				this.correctIndentedSidenotePositions(readingRoot);

				// Use all margins in the DOM (not just newly created ones)
				// so that collisions between old and new sidenotes are resolved.
				const allMargins = Array.from(
					readingRoot.querySelectorAll<HTMLElement>(
						"small.sidenote-margin",
					),
				).filter((m) => m.isConnected);

				this.resolveCollisions(allMargins, this.settings.collisionSpacing);
			});
		});
	}

	private injectPrintPageStyle() {
		document.getElementById("sidenote-print-page-style")?.remove();

		const style = document.createElement("style");
		style.id = "sidenote-print-page-style";

		const isRight = this.settings.sidenotePosition !== "left";

		style.textContent = isRight
			? `@page { 
				margin-left: 1.5cm; 
				margin-right: 0.1cm; 
				margin-top: 1.5cm; 
				margin-bottom: 1.5cm; 
			}`
			: `@page { 
				margin-left: 0.1cm; 
				margin-right: 1.5cm; 
				margin-top: 1.5cm; 
				margin-bottom: 1.5cm; 
			}`;

		document.head.appendChild(style);
	}

	/**
	 * Calculate and apply the vertical offset so the sidenote aligns with
	 * the specific line where the reference appears, not the top of the paragraph.
	 */
	private applyLineOffset(
		wrapper: HTMLElement,
		margin: HTMLElement,
		isEditingMode: boolean = false,
	) {
		if (isEditingMode) {
			// In editing mode, sidenotes are inside .cm-line which already has position: relative
			// The wrapper is inline within the line, so we need to find the offset within the line
			const line = wrapper.closest<HTMLElement>(".cm-line");
			if (!line) return;

			// Get positions
			const wrapperRect = wrapper.getBoundingClientRect();
			const lineRect = line.getBoundingClientRect();

			// The offset is how far down the wrapper is from the top of the line
			// For single-line content this is ~0, for wrapped text it could be more
			const lineOffset = wrapperRect.top - lineRect.top;

			margin.style.setProperty(
				"--sidenote-line-offset",
				`${lineOffset}px`,
			);
		} else {
			// Reading mode: anchor to the nearest positioning context that *you* define in CSS
			const positionedParent =
				(wrapper.closest(
					"p, li, h1, h2, h3, h4, h5, h6, blockquote, .callout",
				) as HTMLElement | null) ??
				(wrapper.parentElement as HTMLElement | null);

			if (!positionedParent) return;

			// For inline content, prefer the first line box rect (more stable than getBoundingClientRect)
			const rects = wrapper.getClientRects();
			const wrapperRect = rects.length > 0 ? rects.item(0) : null;
			const effectiveWrapperRect =
				wrapperRect ?? wrapper.getBoundingClientRect();

			const parentRect = positionedParent.getBoundingClientRect();
			const lineOffset = effectiveWrapperRect.top - parentRect.top;

			margin.style.setProperty(
				"--sidenote-line-offset",
				`${lineOffset}px`,
			);
		}
	}

	/**
	 * Remove all sidenote markup from reading mode to allow fresh processing.
	 */
	private removeAllSidenoteMarkupFromReadingMode(root: HTMLElement) {
		const wrappers = root.querySelectorAll<HTMLElement>(
			"span.sidenote-number",
		);

		for (const wrapper of Array.from(wrappers)) {
			// Find the original element inside
			const originalEl =
				wrapper.querySelector<HTMLElement>("span.sidenote");

			// Clean up margin
			const margin = wrapper.querySelector<HTMLElement>(
				"small.sidenote-margin",
			);
			if (margin) {
				const snMargin = margin as SidenoteMarginElement;
				if (snMargin._sidenoteCleanup) {
					snMargin._sidenoteCleanup();
					delete snMargin._sidenoteCleanup;
				}
				this.unobserveSidenoteVisibility(margin);
				margin.remove();
			}

			// Unwrap original element
			if (originalEl && wrapper.parentNode) {
				wrapper.parentNode.insertBefore(originalEl, wrapper);
			}

			wrapper.remove();
		}
		// Also remove any print-only sidenote elements
		root.querySelectorAll(".sidenote-print").forEach((el) => el.remove());
	}

	private findPrecedingHeading(el: HTMLElement): HTMLElement | null {
		let current: Element | null = el;
		while (current) {
			let sibling = current.previousElementSibling;
			while (sibling) {
				if (/^H[1-6]$/.test(sibling.tagName)) {
					return sibling as HTMLElement;
				}
				const heading = sibling.querySelector("h1, h2, h3, h4, h5, h6");
				if (heading) {
					return heading as HTMLElement;
				}
				sibling = sibling.previousElementSibling;
			}
			current = current.parentElement;
		}
		return null;
	}

	private getHeadingId(heading: HTMLElement): string {
		return (
			heading.textContent?.trim() || heading.id || Math.random().toString()
		);
	}

	/**
	 * Clone content from a sidenote span to a margin element,
	 * preserving links and other HTML elements.
	 * Also sets up click handlers for internal Obsidian links.
	 */
	private cloneContentToMargin(source: HTMLElement, target: HTMLElement) {
		for (const child of Array.from(source.childNodes)) {
			const cloned = child.cloneNode(true);

			if (cloned instanceof HTMLAnchorElement) {
				this.setupLink(cloned);
			}

			if (cloned instanceof HTMLElement) {
				const links = cloned.querySelectorAll("a");
				links.forEach((link) => this.setupLink(link));
			}

			target.appendChild(cloned);
		}
	}

	// ==================== Reading Mode HTML Editing ========================

	/**
	 * Open a CM6 editor for an HTML span sidenote in reading mode,
	 * using the raw markdown source text.
	 */
	private startReadingModeHtmlEdit(margin: HTMLElement, rawText: string) {
		if (this.spanCmView) return;

		this.spanOriginalText = rawText;
		this.activeReadingModeMargin = margin;

		margin.dataset.editing = "true";
		margin.innerHTML = "";

		const commitAndClose = (opts: { commit: boolean }) => {
			const cm = this.spanCmView;
			if (!cm) return;

			const newText = cm.state.doc.toString();
			const renderText = opts.commit ? newText : this.spanOriginalText;

			if (this.spanOutsidePointerDown) {
				document.removeEventListener(
					"pointerdown",
					this.spanOutsidePointerDown,
					true,
				);
				this.spanOutsidePointerDown = undefined;
			}

			this.spanCmView = null;
			cm.destroy();

			setWorkspaceActiveEditor(this, null);

			margin.dataset.editing = "false";

			if (opts.commit && newText !== this.spanOriginalText) {
				this.commitHtmlSpanSidenoteText(this.spanOriginalText, newText);
			}

			margin.innerHTML = "";
			margin.appendChild(
				this.renderLinksToFragment(this.normalizeText(renderText)),
			);
			this.attachStyleGear(margin);

			if (this.settings.editInReadingMode) {
				margin.style.cursor = "pointer";
			}

			this.activeReadingModeMargin = null;

			if (opts.commit && newText !== this.spanOriginalText) {
				this.refreshCachedSourceContent();
				this.needsReadingModeRefresh = true;
				this.needsFullRenumber = true;
				this.invalidateLayoutCache();
			}
		};

		const closeKeymap = keymap.of([
			{
				key: "Escape",
				run: () => {
					commitAndClose({ commit: false });
					return true;
				},
				preventDefault: true,
			},
			{
				key: "Enter",
				run: () => {
					commitAndClose({ commit: true });
					return true;
				},
				preventDefault: true,
			},
			{
				key: "Shift-Enter",
				run: (view) => {
					view.dispatch(view.state.replaceSelection("\n"));
					return true;
				},
				preventDefault: true,
			},
		]);

		const state = EditorState.create({
			doc: rawText,
			extensions: [
				closeKeymap,
				sidenoteEditorTheme,
				history(),
				markdown(),
				syntaxHighlighting(sidenoteHighlightStyle, { fallback: true }),
				markdownEditHotkeys,
				keymap.of(historyKeymap),
				keymap.of(defaultKeymap),
				EditorView.lineWrapping,
			],
		});

		const cm = new EditorView({ state, parent: margin });
		this.spanCmView = cm;
		cm.dom.classList.add("sidenote-cm-editor");

		const scroller = cm.dom.querySelector<HTMLElement>(".cm-scroller");
		if (scroller) {
			setCssProps(scroller, { "padding-left": "0", padding: "0" }, true);
		}

		cm.dom.addEventListener(
			"focusin",
			() => setWorkspaceActiveEditor(this, cm),
			true,
		);
		cm.dom.addEventListener(
			"focusout",
			() => setWorkspaceActiveEditor(this, null),
			true,
		);

		const cleanupKeyboard = this.setupMarginKeyboardCapture(margin);
		const snMargin = margin as SidenoteMarginElement;
		snMargin._sidenoteCleanup = () => {
			cleanupKeyboard();
			if (this.spanCmView === cm) {
				commitAndClose({ commit: false });
			}
		};

		this.spanOutsidePointerDown = (ev: PointerEvent) => {
			const target = ev.target as Node | null;
			if (!target) return;
			if (margin.contains(target) || cm.dom.contains(target)) return;
			commitAndClose({ commit: true });
		};
		document.addEventListener(
			"pointerdown",
			this.spanOutsidePointerDown,
			true,
		);

		requestAnimationFrame(() => cm.focus());
	}


	/**
	 * Set up a link element with proper attributes and click handlers.
	 * Handles both external links and internal Obsidian links.
	 */
	private setupLink(link: HTMLAnchorElement) {
		// Check if it's an internal Obsidian link
		const isInternalLink =
			link.classList.contains("internal-link") ||
			link.hasAttribute("data-href") ||
			(link.href &&
				!link.href.startsWith("http://") &&
				!link.href.startsWith("https://") &&
				!link.href.startsWith("mailto:"));

		if (isInternalLink) {
			// Get the target from data-href (Obsidian's way) or href
			const target =
				link.getAttribute("data-href") || link.getAttribute("href") || "";

			// Ensure it has the internal-link class
			link.classList.add("internal-link");

			// Set data-href if not present
			if (!link.hasAttribute("data-href") && target) {
				link.setAttribute("data-href", target);
			}

			// Add click handler for internal navigation
			link.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();

				const linkTarget =
					link.getAttribute("data-href") ||
					link.getAttribute("href") ||
					"";
				if (linkTarget) {
					void this.app.workspace.openLinkText(linkTarget, "", false);
				}
			});

			// Don't open in new tab
			link.removeAttribute("target");
		} else {
			// External link - add external-link class for the icon
			link.classList.add("external-link");
			link.rel = "noopener noreferrer";
			link.target = "_blank";
		}
	}

	// ==================== Mode Calculation ====================

	private calculateMode(
		width: number,
	): "hidden" | "compact" | "normal" | "full" {
		const s = this.settings;
		// Sanity check: if width is 0 or unreasonably small, hide
		if (width <= 0 || width < 200) {
			return "hidden";
		}
		if (width < s.hideBelow) {
			return "hidden";
		} else if (width < s.compactBelow) {
			return "compact";
		} else if (width < s.fullAbove) {
			return "normal";
		} else {
			return "full";
		}
	}

	private calculateScaleFactor(width: number): number {
		const s = this.settings;
		if (width < s.hideBelow) {
			return 0;
		}
		return Math.min(
			1,
			(width - s.hideBelow) / (s.fullAbove - s.hideBelow),
		);
	}

	// ==================== Reading Mode Layout ====================

	private scheduleReadingModeLayout() {
		requestAnimationFrame(() => {
			const view = this.getMarkdownView();
			if (!view) return;

			const readingRoot = view.containerEl.querySelector<HTMLElement>(
				".markdown-reading-view",
			);
			if (!readingRoot) return;

			const rect = readingRoot.getBoundingClientRect();
			const width = rect.width;

			readingRoot.style.setProperty("--editor-width", `${width}px`);

			const mode = this.calculateMode(width);
			readingRoot.dataset.sidenoteMode = mode;
			readingRoot.dataset.sidenotePosition =
				this.settings.sidenotePosition;
			readingRoot.dataset.sidenoteAnchor = this.settings.sidenoteAnchor;

			const scaleFactor = this.calculateScaleFactor(width);
			readingRoot.style.setProperty(
				"--sidenote-scale",
				scaleFactor.toFixed(3),
			);

			// Check if we have sidenotes
			const hasMargins =
				readingRoot.querySelectorAll("small.sidenote-margin").length > 0;

			// If no margins exist but we should have sidenotes, reprocess
			if (!hasMargins && this.documentHasSidenotes && mode !== "hidden") {
				this.processReadingModeSidenotes(readingRoot);
				return;
			}

			// Update positioning and run collision avoidance
			if (mode !== "hidden" && hasMargins) {
				requestAnimationFrame(() => {
					this.updateSidenotePositioning(readingRoot, true);
					this.correctIndentedSidenotePositions(readingRoot);
					this.updateReadingModeCollisions();
				});
			}
		});
	}

	// ==================== Document Scanning ====================

	private scanDocumentForSidenotes() {
		console.warn("[Sidenotes] Scanning document for sidenotes...");
		const view = this.getMarkdownView();
		if (!view) {
			this.documentHasSidenotes = false;
			return;
		}

		const editor = view.editor;
		if (!editor) {
			this.documentHasSidenotes = false;
			return;
		}

		const content = editor.getValue();

		// Cache source content for reading mode
		// (view.editor.getValue() can return "" in reading mode)
		if (content) {
			this.cachedSourceContent = content;
		}

		this.documentHasSidenotes = SIDENOTE_PATTERN().test(content);
		SIDENOTE_PATTERN().lastIndex = 0;

		// Count total sidenotes in document for validation
		if (this.needsFullRenumber) {
			this.totalSidenotesInDocument = this.countSidenotesInSource(content);
		}

		const cmRoot = this.cmRoot;
		if (cmRoot) {
			cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
				? "true"
				: "false";
		}

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			readingRoot.dataset.hasSidenotes = this.documentHasSidenotes
				? "true"
				: "false";
		}
	}

	/**
	 * Re-read source content from the editor and update the cache.
	 * Call this after any commit (editing or reading mode) so that
	 * subsequent mode switches and undo operations see fresh data.
	 */
	private refreshCachedSourceContent() {
		const view = this.getMarkdownView();
		const content =
			view?.editor?.getValue() || (view as { data?: string })?.data || "";
		if (content) {
			this.cachedSourceContent = content;
		}
	}

	/**
	 * Count the total number of sidenotes in the source document.
	 */
	private countSidenotesInSource(content: string): number {
		const sidenoteRegex = SIDENOTE_SPAN_REGEX();
		let count = 0;
		while (sidenoteRegex.exec(content) !== null) {
			count++;
		}
		return count;
	}


	// ==================== Print Handling ====================

	/**
	 * Inject print sidenotes into a post-processed element.
	 * Runs synchronously so the elements exist before Obsidian
	 * captures the DOM for PDF export.
	 */
	private injectPrintSidenotes(element: HTMLElement) {
		// Only inject print sidenotes when rendering for PDF export.
		// Check if the element is inside a .print container.
		const isPrintContext =
			element.closest?.(".print") ??
			element.parentElement?.closest?.(".print");
		if (!isPrintContext || !this.settings.pdfExport) return;

		if (element.querySelector(".sidenote-print")) return;

		const position = this.settings.sidenotePosition;
		const isRight = position !== "left";

		const spans = element.querySelectorAll<HTMLElement>("span.sidenote");
		if (spans.length === 0) return;

		const sidenotesByAnchor = new Map<HTMLElement, HTMLElement[]>();
		let counter = 0;

		for (const span of Array.from(spans)) {
			const text = span.textContent ?? "";
			if (!text.trim()) continue;

			const numStr = this.formatNumber(++counter);

			const refNum = document.createElement("sup");
			refNum.style.cssText =
				"font-size: 0.75em; font-weight: bold; color: #000;";
			refNum.textContent = numStr;
			span.parentNode?.insertBefore(refNum, span.nextSibling);

			const printEl = this.buildPrintSidenote(text, numStr);

			const anchor = span.closest(
				"p, li, h1, h2, h3, h4, h5, h6",
			) as HTMLElement | null;
			if (anchor) {
				const list = sidenotesByAnchor.get(anchor) ?? [];
				list.push(printEl);
				sidenotesByAnchor.set(anchor, list);
			}
		}

		this.buildPrintTables(element, sidenotesByAnchor, isRight);
	}

	/**
	 * Shared logic: wrap anchor paragraphs in table layouts and
	 * inject the max-width style constraint.
	 */
	private buildPrintTables(
		element: HTMLElement,
		sidenotesByAnchor: Map<HTMLElement, HTMLElement[]>,
		isRight: boolean,
	) {
		if (sidenotesByAnchor.size === 0) return;

		for (const [anchor, sidenotes] of sidenotesByAnchor) {
			if (!anchor.parentNode) continue;

			const table = document.createElement("table");
			table.className = "sidenote-print-table";
			table.style.cssText = `
				width: 100%; 
				border-collapse: collapse; 
				border: none; 
				margin: 0; 
				padding: 0; 
				table-layout: fixed;
			`;

			const row = document.createElement("tr");
			row.style.cssText = "border: none; vertical-align: top;";

			const contentCell = document.createElement("td");
			contentCell.style.cssText =
				"border: none; padding: 0; vertical-align: top; width: 70%;";

			const sidenoteCell = document.createElement("td");
			sidenoteCell.style.cssText = isRight
				? `border: none; 
				padding: 2.5em 0 0 2em; 
				vertical-align: top; 
				width: 30%; 
				font-size: 0.75em; 
				line-height: 1.35; 
				color: #11111b;`
				: `border: none; 
				padding: 2.5em 2em 0 0; 
				vertical-align: top; 
				width: 30%; 
				font-size: 0.75em; 
				line-height: 1.35; 
				color: #11111b; 
				text-align: right;`;

			anchor.parentNode.insertBefore(table, anchor);
			contentCell.appendChild(anchor);

			for (const sn of sidenotes) {
				if (sidenoteCell.childNodes.length > 0) {
					const spacer = document.createElement("div");
					spacer.style.cssText = "height: 0.4em;";
					sidenoteCell.appendChild(spacer);
				}
				sidenoteCell.appendChild(sn);
			}

			if (isRight) {
				row.appendChild(contentCell);
				row.appendChild(sidenoteCell);
			} else {
				row.appendChild(sidenoteCell);
				row.appendChild(contentCell);
			}

			table.appendChild(row);
		}

		// Inject width-constraining style
		if (!element.querySelector(".sidenote-print-width-style")) {
			const style = document.createElement("style");
			style.className = "sidenote-print-width-style";
			style.textContent = isRight
				? `
				p, li, h1, h2, h3, h4, h5, h6, blockquote, .callout,
				ul, ol, hr, .math, .MathJax, pre, .contains-task-list {
					max-width: 70% !important;
				}
				.sidenote-print-table,
				.sidenote-print-table td,
				.sidenote-print-table p,
				.sidenote-print-table li,
				.sidenote-print-table h1,
				.sidenote-print-table h2,
				.sidenote-print-table h3,
				.sidenote-print-table h4,
				.sidenote-print-table h5,
				.sidenote-print-table h6 {
					max-width: none !important;
				}
			`
				: `
				p, li, h1, h2, h3, h4, h5, h6, blockquote, .callout,
				ul, ol, hr, .math, .MathJax, pre, .contains-task-list {
					max-width: 70% !important;
					margin-left: 30% !important;
				}
				.sidenote-print-table,
				.sidenote-print-table td,
				.sidenote-print-table p,
				.sidenote-print-table li,
				.sidenote-print-table h1,
				.sidenote-print-table h2,
				.sidenote-print-table h3,
				.sidenote-print-table h4,
				.sidenote-print-table h5,
				.sidenote-print-table h6 {
					max-width: none !important;
					margin-left: 0 !important;
				}
			`;
			element.appendChild(style);
		}
	}

	private buildPrintSidenote(text: string, numStr: string): HTMLElement {
		const printEl = document.createElement("small");
		printEl.className = "sidenote-print";
		// Use inline style so nothing can override visibility
		printEl.style.cssText = "display: block; margin: 0; padding: 0;";

		if (this.settings.showSidenoteNumbers && numStr) {
			const numSpan = document.createElement("span");
			numSpan.style.cssText =
				"font-weight: bold; margin-right: 0.3em; color: #11111b;";
			numSpan.textContent = numStr + ".";
			printEl.appendChild(numSpan);
		}

		printEl.appendChild(
			this.renderLinksToFragment(this.normalizeText(text)),
		);

		return printEl;
	}

	// ==================== Scheduling ====================

	private cancelScheduled() {
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
	}

	private scheduleLayout() {
		this.cancelScheduled();
		this.rafId = requestAnimationFrame(() => {
			this.rafId = null;
			this.layout();
		});
	}

	private scheduleLayoutStable() {
		this.cancelScheduled();

		// Leading pass: ASAP
		this.rafId = requestAnimationFrame(() => {
			this.rafId = null;
			this.layout();
		});

		// Trailing pass: catches the “one second later” reflow
		if (this.layoutTrailingTimer !== null) {
			window.clearTimeout(this.layoutTrailingTimer);
		}
		this.layoutTrailingTimer = window.setTimeout(() => {
			this.layoutTrailingTimer = null;
			this.layout();
		}, 200);
	}

	private rebindAndSchedule() {
		this.rebind();
		this.scheduleLayout();
	}

	// ==================== Binding ====================

	private rebind() {
		// First confirm we have a view and cmRoot to bind to before tearing down the old setup,
		const view = this.getMarkdownView();
		if (!view) return; // Don't tear down if there's no view to bind to

		const root = view.containerEl;
		const cmRoot = root.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		if (!cmRoot) return; // Don't tear down if there's no cmRoot

		// Only now tear down the old setup after confirming we have a new view and cmRoot to bind to,
		this.cleanups.forEach((fn) => fn());
		this.cleanups = [];

		this.visibleSidenotes.clear();

		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}

		this.cmRoot = cmRoot;

		cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
			? "true"
			: "false";
		cmRoot.dataset.sidenotePosition = this.settings.sidenotePosition;
		// cmRoot.dataset.sidenoteAnchor = this.settings.sidenoteAnchor;

		// Handle resize events with a debounce to prevent thrashing
		let resizeTimeout: number | null = null;
		let lastObservedWidth = 0;

		this.resizeObserver = new ResizeObserver((entries) => {
			const entry = entries[0];
			const currentWidth = entry?.contentRect?.width ?? 0;

			console.log("[Sidenotes] ResizeObserver fired:", {
				currentWidth,
				lastObservedWidth,
				connected: cmRoot.isConnected,
			});

			if (Math.abs(currentWidth - lastObservedWidth) < 1) return;
			lastObservedWidth = currentWidth;

			if (resizeTimeout !== null) {
				window.clearTimeout(resizeTimeout);
			}
			resizeTimeout = window.setTimeout(() => {
				resizeTimeout = null;
				this.scheduleLayout();
				this.scheduleReadingModeLayout();
			}, 50);
		});
		this.resizeObserver.observe(cmRoot);

		// Store cleanup for the resize timeout
		this.cleanups.push(() => {
			if (resizeTimeout !== null) {
				window.clearTimeout(resizeTimeout);
				resizeTimeout = null;
			}
		});

		const readingRoot = root.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			this.resizeObserver.observe(readingRoot);
			readingRoot.dataset.sidenotePosition =
				this.settings.sidenotePosition;
			readingRoot.dataset.sidenoteAnchor = this.settings.sidenoteAnchor;

			// Ensure delegated click handler for reading mode margins
			this.ensureReadingModeDelegation(readingRoot);

			// Add scroll listener for reading mode collision updates
			const readingScroller =
				readingRoot.querySelector<HTMLElement>(".markdown-preview-view") ??
				readingRoot;

			const onReadingScroll = () => {
				if (this.readingModeScrollTimer !== null) {
					window.clearTimeout(this.readingModeScrollTimer);
				}
				this.readingModeScrollTimer = window.setTimeout(() => {
					this.readingModeScrollTimer = null;
					this.avoidCollisionsInReadingMode(readingRoot);
				}, 100);
			};

			readingScroller.addEventListener("scroll", onReadingScroll, {
				passive: true,
			});
		}

		const scroller = cmRoot.querySelector<HTMLElement>(".cm-scroller");
		if (!scroller) return;

		const onScroll = () => {
			if (this.scrollDebounceTimer !== null) {
				window.clearTimeout(this.scrollDebounceTimer);
			}
			this.scrollDebounceTimer = window.setTimeout(() => {
				this.scrollDebounceTimer = null;
				this.scheduleLayout();
			}, SidenotePlugin.SCROLL_DEBOUNCE);
		};
		scroller.addEventListener("scroll", onScroll, { passive: true });
		this.cleanups.push(() =>
			scroller.removeEventListener("scroll", onScroll),
		);

		const content = cmRoot.querySelector<HTMLElement>(".cm-content");
		if (content) {
			const mo = new MutationObserver(() => {
				if (this.isMutating) return;
				this.scheduleLayoutDebounced(SidenotePlugin.MUTATION_DEBOUNCE);
			});
			mo.observe(content, {
				childList: true,
				subtree: true,
				characterData: true,
			});
			this.cleanups.push(() => mo.disconnect());
		}

		// Watch for Live Preview / Source mode toggle on cmRoot
		const modeMo = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				if (
					mutation.type === "attributes" &&
					mutation.attributeName === "class"
				) {
					// View mode changed, reschedule layout
					this.invalidateLayoutCache();
					this.scheduleLayout();
					break;
				}
			}
		});
		modeMo.observe(cmRoot, {
			attributes: true,
			attributeFilter: ["class"],
		});
		this.cleanups.push(() => modeMo.disconnect());
	}

	// ==================== Document Position ====================

	private getDocumentPosition(el: HTMLElement): number | null {
		const view = this.getMarkdownView();
		if (!view) return null;

		const editor = (view.editor as { cm?: EditorView })?.cm;
		if (!editor?.state || !editor?.lineBlockAt) return null;

		const lineEl = el.closest(".cm-line");
		if (!lineEl) return null;

		const rect = lineEl.getBoundingClientRect();

		const pos = editor.posAtCoords({
			x: rect.left,
			y: rect.top + rect.height / 2,
		});
		if (pos === null) return null;

		const spanRect = el.getBoundingClientRect();
		const offsetInLine = spanRect.left - rect.left;

		return pos * 10000 + Math.floor(offsetInLine);
	}

	// ==================== Registry Management ====================

	private resetRegistry() {
		this.sidenoteRegistry.clear();
		this.nextSidenoteNumber = 1;
		this.headingSidenoteNumbers.clear();
		this.needsFullRenumber = true;
		this.totalSidenotesInDocument = 0;
	}

	// ==================== Main Layout ====================

	private layout() {
		const cmRoot = this.cmRoot;
		if (!cmRoot) {
			console.log("[Sidenotes] layout() - no cmRoot");
			return;
		}

		const cmRootRect = cmRoot.getBoundingClientRect();
		const editorWidth = cmRootRect.width;
		const mode = this.calculateMode(editorWidth);

		console.log("[Sidenotes] layout():", {
			editorWidth,
			mode,
			isConnected: cmRoot.isConnected,
			unwrappedCount: cmRoot.querySelectorAll(
				"span.sidenote:not(.sidenote-number span.sidenote)",
			).length,
			wrappedCount: cmRoot.querySelectorAll("small.sidenote-margin")
				.length,
		});

		cmRoot.style.setProperty("--editor-width", `${editorWidth}px`);
		cmRoot.dataset.sidenoteMode = mode;
		cmRoot.dataset.sidenotePosition = this.settings.sidenotePosition;
		cmRoot.dataset.sidenoteAnchor = this.settings.sidenoteAnchor;

		const scaleFactor = this.calculateScaleFactor(editorWidth);
		cmRoot.style.setProperty("--sidenote-scale", scaleFactor.toFixed(3));

		// HTML sidenote processing
		cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
			? "true"
			: "false";

		const unwrappedSpans = Array.from(
			cmRoot.querySelectorAll<HTMLElement>("span.sidenote"),
		).filter(
			(span) => !span.parentElement?.classList.contains("sidenote-number"),
		);
		// console.warn(unwrappedSpans.length, "unwrapped sidenote spans found");
		// If there are new sidenotes to process, we need to renumber everything
		if (unwrappedSpans.length > 0 && mode !== "hidden") {
			// Remove all existing sidenote wrappers and margins to renumber from scratch
			this.removeAllSidenoteMarkup(cmRoot);

			// Get the source content to determine correct indices
			const view = this.getMarkdownView();
			if (!view?.editor) return;

			const content = view.editor.getValue();

			// Build a map of sidenote text content + position to their index
			const sidenoteIndexMap = this.buildSidenoteOnlyIndexMap(content);

			// Now get ALL sidenote spans (they're all unwrapped now)
			const allSpans = Array.from(
				cmRoot.querySelectorAll<HTMLElement>("span.sidenote"),
			);

			if (allSpans.length === 0) {
				this.lastSidenoteCount = 0;
				return;
			}

			// Collect all sidenotes to process
			const allItems = allSpans.map((el) => ({
				el,
				docPos: this.getDocumentPosition(el),
				text: el.textContent ?? "",
			}));

			// Match each visible item to its index in the full document
			const itemsWithIndex = allItems.map((item) => {
				const index = this.findSidenoteIndex(
					sidenoteIndexMap,
					item.text,
					item.docPos,
				);
				return { ...item, index };
			});

			// Assign source index BEFORE sorting (DOM order = source order)
			let sourceCounter = 1;
			const itemsWithSourceIndex = itemsWithIndex.map((item) => ({
				...item,
				sourceIndex: sourceCounter++,
			}));

			// Sort by index for consistent display ordering
			itemsWithSourceIndex.sort((a, b) => a.index - b.index);

			this.isMutating = true;
			try {
				for (const item of itemsWithSourceIndex) {
					const forcedSide = this.getForcedSide(item.el);
					const numStr = this.formatNumber(item.index);
					const wrapper = document.createElement("span");
					wrapper.className = "sidenote-number";
					const margin = document.createElement("small");
					margin.className = "sidenote-margin";

					if (forcedSide) {
						wrapper.dataset.sidenoteSide = forcedSide;
						margin.dataset.sidenoteSide = forcedSide;
					}

					wrapper.dataset.sidenoteNum = numStr;
					margin.dataset.sidenoteNum = numStr;

					const raw = this.normalizeText(item.el.textContent ?? "");
					margin.appendChild(this.renderLinksToFragment(raw));

					applyStyleToMargin(margin, item.el.getAttribute("style"));
					this.attachStyleGear(margin);

					// Make margin editable and set up edit handling
					this.setupMarginEditing(
						margin,
						item.el,
						item.docPos,
						item.index,
					);

					// Add click handler to select only text content
					this.setupSidenoteClickHandler(wrapper, item.text);

					item.el.parentNode?.insertBefore(wrapper, item.el);
					wrapper.appendChild(item.el);
					wrapper.appendChild(margin);

					// Calculate line offset for this sidenote (editing mode)
					this.applyLineOffset(wrapper, margin, true);

					this.observeSidenoteVisibility(margin);
				}
			} finally {
				this.isMutating = false;
			}

			this.lastSidenoteCount =
				cmRoot.querySelectorAll(".sidenote-margin").length;

			// Run positioning and collision avoidance after DOM is settled
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					if (!cmRoot.isConnected) return;
					this.updateSidenotePositioning(cmRoot, false);
					this.updateEditingModeCollisions();
				});
			});
		} else {
			// No new sidenotes to process
			this.lastSidenoteCount =
				cmRoot.querySelectorAll(".sidenote-margin").length;

			if (this.lastSidenoteCount > 0 && mode !== "hidden") {
				// Still run positioning and collision avoidance for existing sidenotes
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						if (!cmRoot.isConnected) return;
						this.updateSidenotePositioning(cmRoot, false);
						this.updateEditingModeCollisions();
					});
				});
			}
		}
	}

	/**
	 * Build a map of sidenotes in the source document, indexed in order
	 * of appearance. Used for numbering in editing mode.
	 */
	private buildSidenoteOnlyIndexMap(content: string): {
		index: number;
		charPos: number;
		text: string;
	}[] {
		const items: {
			index: number;
			charPos: number;
			text: string;
		}[] = [];

		const sidenoteRegex = SIDENOTE_SPAN_REGEX();
		let match: RegExpExecArray | null;

		while ((match = sidenoteRegex.exec(content)) !== null) {
			items.push({
				index: 0,
				charPos: match.index,
				text: this.normalizeText(match[1] ?? ""),
			});
		}

		// Sort by position and assign indices
		items.sort((a, b) => a.charPos - b.charPos);
		let counter = 1;
		items.forEach((item) => {
			item.index = counter++;
		});

		return items;
	}

	/**
	 * Find the index of a sidenote in the document based on its text and approximate position.
	 */
	private findSidenoteIndex(
		sidenoteMap: {
			index: number;
			charPos: number;
			text: string;
		}[],
		text: string,
		docPos: number | null,
	): number {
		const normalizedText = this.normalizeText(text);

		// Find all sidenotes with matching text
		const matchingByText = sidenoteMap.filter(
			(s) => s.text === normalizedText,
		);

		if (matchingByText.length === 1) {
			const match = matchingByText[0];
			if (match) {
				return match.index;
			}
		}

		if (matchingByText.length > 1 && docPos !== null) {
			const approxCharPos = Math.floor(docPos / 10000);
			let closest: {
				index: number;
				charPos: number;
				text: string;
			} | null = null;
			let closestDist = Infinity;

			for (const s of matchingByText) {
				const dist = Math.abs(s.charPos - approxCharPos);
				if (dist < closestDist) {
					closestDist = dist;
					closest = s;
				}
			}

			if (closest) {
				return closest.index;
			}
		}

		// Fallback: return next available index
		const maxIndex = sidenoteMap.reduce(
			(max, s) => Math.max(max, s.index),
			0,
		);
		return maxIndex + 1;
	}

	/**
	 * Remove all sidenote markup (wrappers and margins) so we can renumber from scratch.
	 * This unwraps the original span.sidenote elements.
	 */
	private removeAllSidenoteMarkup(root: HTMLElement) {
		const wrappers = root.querySelectorAll<HTMLElement>(
			"span.sidenote-number",
		);

		for (const wrapper of Array.from(wrappers)) {
			const sidenoteSpan =
				wrapper.querySelector<HTMLElement>("span.sidenote");

			const margin = wrapper.querySelector<HTMLElement>(
				"small.sidenote-margin",
			);
			if (margin) {
				// Call cleanup if it exists
				const snMargin = margin as SidenoteMarginElement;
				if (snMargin._sidenoteCleanup) {
					snMargin._sidenoteCleanup();
					delete snMargin._sidenoteCleanup;
				}
				this.unobserveSidenoteVisibility(margin);
				margin.remove();
			}

			if (sidenoteSpan && wrapper.parentNode) {
				wrapper.parentNode.insertBefore(sidenoteSpan, wrapper);
			}

			wrapper.remove();
		}
	}

	// ==================== Text Normalization ====================

	private normalizeText(s: string): string {
		return (s ?? "")
			.replace(/<br\s*\/?>/gi, "\n") // Preserve <br> as newlines
			.replace(/[ \t]+/g, " ") // Collapse spaces/tabs (but not \n)
			.trim();
	}

	/**
	 * Append text to a fragment, converting \n to <br> elements.
	 */
	private appendTextWithBreaks(
		frag: DocumentFragment | HTMLElement,
		text: string,
	) {
		const parts = text.split("\n");
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i] ?? "";

			if (part) {
				frag.appendChild(document.createTextNode(part));
			}
			if (i < parts.length - 1) {
				frag.appendChild(document.createElement("br"));
			}
		}
	}

	/**
	 * Set up a click handler on the sidenote wrapper to select only the text content,
	 * not the HTML tags, when clicked in the editor.
	 */
	private setupSidenoteClickHandler(
		wrapper: HTMLElement,
		sidenoteText: string,
	) {
		wrapper.addEventListener("click", (e) => {
			const target = e.target as HTMLElement;
			if (target.closest(".sidenote-margin")) {
				return;
			}

			e.preventDefault();
			e.stopPropagation();

			const view = this.getMarkdownView();
			if (!view?.editor) return;

			const editor = view.editor;

			const found = this.findHtmlSidenoteInSource(sidenoteText);
			if (found) {
				const openingTagEnd = found.openingTag.length;
				const textStart = found.index + openingTagEnd;
				const textEnd = textStart + found.text.length;

				const from = editor.offsetToPos(textStart);
				const to = editor.offsetToPos(textEnd);

				editor.setSelection(from, to);
				editor.focus();
			}
		});
	}

	// ==================== Margin Editing ====================

	/**
	 * Set up a margin element to be editable in place.
	 * When clicked, it becomes editable. On blur, changes are saved to the source.
	 */
	private setupMarginEditing(
		margin: HTMLElement,
		sourceSpan: HTMLElement,
		docPos: number | null,
		sidenoteIndex: number,
	) {
		margin.dataset.editing = "false";
		margin.dataset.sidenoteIndex = String(sidenoteIndex);

		const onMouseDown = (e: MouseEvent) => {
			// When editing, allow normal mousedown behavior for cursor positioning
			if (margin.dataset.editing === "true") {
				// Don't stop propagation or prevent default - let browser handle cursor
				return;
			}
			e.stopPropagation();
			e.preventDefault();
		};

		const onClick = (e: MouseEvent) => {
			// When editing, allow normal click behavior
			if (margin.dataset.editing === "true") {
				e.stopPropagation(); // Still prevent clicks from bubbling to parent elements
				return;
			}

			e.preventDefault();
			e.stopPropagation();

			// Gear icon opens the per-note style modal instead of editing
			const target = e.target as HTMLElement | null;
			if (target?.closest(".sidenote-style-gear")) {
				this.openStyleModal(margin, margin.textContent ?? "");
				return;
			}

			this.startMarginEdit(margin, sourceSpan, sidenoteIndex, e);
		};

		margin.addEventListener("mousedown", onMouseDown);
		margin.addEventListener("click", onClick);

		// Store cleanup reference on the element for later removal
		(margin as SidenoteMarginElement)._sidenoteCleanup = () => {
			margin.removeEventListener("mousedown", onMouseDown);
			margin.removeEventListener("click", onClick);
		};
	}

	/**
	 * Start editing a margin sidenote in place.
	 */
	private startMarginEdit(
		margin: HTMLElement,
		sourceSpan: HTMLElement,
		_sidenoteIndex: number,
		clickEvent?: MouseEvent,
	) {
		if (this.spanCmView) return;

		// Read current text from source by matching content
		const marginText = margin.textContent ?? "";
		const found = this.findHtmlSidenoteInSource(marginText);
		this.spanOriginalText = found?.text ?? sourceSpan.textContent ?? "";

		margin.dataset.editing = "true";
		margin.innerHTML = "";

		const commitAndClose = (opts: { commit: boolean }) => {
			const cmInner = this.spanCmView;
			if (!cmInner) return;

			const newText = cmInner.state.doc.toString();
			const renderText = opts.commit ? newText : this.spanOriginalText;

			if (this.spanOutsidePointerDown) {
				document.removeEventListener(
					"pointerdown",
					this.spanOutsidePointerDown,
					true,
				);
				this.spanOutsidePointerDown = undefined;
			}

			this.spanCmView = null;
			cmInner.destroy();

			margin.dataset.editing = "false";

			if (opts.commit && newText !== this.spanOriginalText) {
				this.commitHtmlSpanSidenoteText(this.spanOriginalText, newText);
			}

			margin.innerHTML = "";
			margin.appendChild(
				this.renderLinksToFragment(this.normalizeText(renderText)),
			);
			this.attachStyleGear(margin);
		};

		// Keymap: ESC cancels; Enter commits; Shift-Enter inserts newline (optional)
		const closeKeymap = keymap.of([
			{
				key: "Escape",
				run: () => {
					commitAndClose({ commit: false });
					return true;
				},
				preventDefault: true,
			},
			{
				key: "Enter",
				run: () => {
					commitAndClose({ commit: true });
					return true;
				},
				preventDefault: true,
			},
			{
				key: "Shift-Enter",
				run: (view) => {
					view.dispatch(view.state.replaceSelection("\n"));
					return true;
				},
				preventDefault: true,
			},
		]);

		const state = EditorState.create({
			doc: this.spanOriginalText,
			extensions: [
				closeKeymap,
				sidenoteEditorTheme,
				history(),
				markdown(),
				syntaxHighlighting(sidenoteHighlightStyle, { fallback: true }),
				// Your markdown formatting hotkeys (Mod-b/i/k) if you added them:
				markdownEditHotkeys,
				// Keep standard CM key behavior (arrow keys, delete, etc.)
				keymap.of(historyKeymap),
				keymap.of(defaultKeymap),
				EditorView.lineWrapping,
			],
		});

		const cm = new EditorView({
			state,
			parent: margin,
		});

		cm.dom.addEventListener(
			"focusin",
			() => {
				setWorkspaceActiveEditor(this, cm);
			},
			true,
		);

		cm.dom.addEventListener(
			"focusout",
			() => {
				setWorkspaceActiveEditor(this, null);
			},
			true,
		);

		this.spanCmView = cm;
		cm.dom.classList.add("sidenote-cm-editor");
		const scroller = cm.dom.querySelector<HTMLElement>(".cm-scroller");
		if (scroller) {
			setCssProps(scroller, { "padding-left": "0", padding: "0" }, true);
		}

		// Click anywhere outside the margin editor => commit and close
		this.spanOutsidePointerDown = (ev: PointerEvent) => {
			const target = ev.target as Node | null;
			if (!target) return;
			if (margin.contains(target) || cm.dom.contains(target)) return;

			commitAndClose({ commit: true });
		};
		document.addEventListener(
			"pointerdown",
			this.spanOutsidePointerDown,
			true,
		);

		requestAnimationFrame(() => cm.focus());
	}

	private commitHtmlSpanSidenoteText(
		originalText: string,
		newText: string,
	) {
		const view = this.getMarkdownView();
		if (!view?.editor) return;

		const editor = view.editor;

		const scroller =
			this.cmRoot?.querySelector<HTMLElement>(".cm-scroller");
		const scrollTop = scroller?.scrollTop ?? 0;

		this.isEditingMargin = true;

		const content = editor.getValue();
		const regex = SIDENOTE_SPAN_REGEX();
		let match: RegExpExecArray | null;

		while ((match = regex.exec(content)) !== null) {
			if (match[1] === originalText) {
				const from = editor.offsetToPos(match.index);
				const to = editor.offsetToPos(match.index + match[0].length);

				const originalTag = match[0].substring(
					0,
					match[0].indexOf(">") + 1,
				);
				const newSpan = `${originalTag}${newText}</span>`;

				this.isMutating = true;
				try {
					editor.replaceRange(newSpan, from, to);
				} finally {
					this.isMutating = false;
				}
				break;
			}
		}

		if (scroller) scroller.scrollTop = scrollTop;
		this.isEditingMargin = false;
	}

	// ==================== Per-Note Styling ====================

	/**
	 * Add the style gear button to a margin box. The button is SVG-only
	 * (no text nodes) so margin.textContent still equals the note text.
	 */
	private attachStyleGear(margin: HTMLElement) {
		if (margin.querySelector(".sidenote-style-gear")) return;
		const gear = margin.createEl("button", {
			cls: "sidenote-style-gear",
		});
		gear.setAttribute("aria-label", "Style sidenote");
		gear.setAttribute("type", "button");
		setIcon(gear, "settings");
	}

	/**
	 * Open the per-note style modal for a margin box. `rawText` is the
	 * note's source text, used to locate the span in the document.
	 */
	private openStyleModal(margin: HTMLElement, rawText: string) {
		if (!rawText) return;
		const found = this.findHtmlSidenoteInSource(rawText);
		if (!found) return;

		const currentStyle = extractStyleFromOpeningTag(found.openingTag);
		const side =
			(margin.dataset.sidenoteSide as "left" | "right" | undefined) ??
			this.settings.sidenotePosition;

		// Snapshot the full inline style (including --sidenote-shift etc.)
		// so cancel can restore the margin exactly.
		const savedInline = margin.getAttribute("style");
		const savedBg = margin.dataset.snStyledBg;
		const savedApplied = margin.dataset.snAppliedProps;

		new SidenoteStyleModal(this.app, {
			side,
			noteText: found.text,
			initialStyle: currentStyle,
			onPreview: (styleText) => {
				applyStyleToMargin(margin, styleText);
			},
			onCancel: () => {
				if (savedInline === null) margin.removeAttribute("style");
				else margin.setAttribute("style", savedInline);
				if (savedBg) margin.dataset.snStyledBg = savedBg;
				else delete margin.dataset.snStyledBg;
				if (savedApplied) margin.dataset.snAppliedProps = savedApplied;
				else delete margin.dataset.snAppliedProps;
			},
			onSave: (styleText) => {
				applyStyleToMargin(margin, styleText);
				this.commitHtmlSpanSidenoteStyle(found.text, styleText);
			},
		}).open();
	}

	/**
	 * Rewrite the style attribute on a sidenote span's opening tag in the
	 * document source, leaving classes/other attributes and the note body
	 * untouched. Matches by inner text (same first-occurrence limitation
	 * as text editing).
	 */
	private commitHtmlSpanSidenoteStyle(
		innerText: string,
		newStyle: string | null,
	) {
		const view = this.getMarkdownView();
		if (!view?.editor) return;

		const editor = view.editor;

		const scroller =
			this.cmRoot?.querySelector<HTMLElement>(".cm-scroller");
		const scrollTop = scroller?.scrollTop ?? 0;

		this.isEditingMargin = true;

		const content = editor.getValue();
		const regex = SIDENOTE_SPAN_REGEX();
		let match: RegExpExecArray | null;

		while ((match = regex.exec(content)) !== null) {
			if (match[1] === innerText) {
				const openingTag = match[0].substring(
					0,
					match[0].indexOf(">") + 1,
				);
				const newTag = setStyleInOpeningTag(openingTag, newStyle);
				if (newTag === openingTag) break;

				const from = editor.offsetToPos(match.index);
				const to = editor.offsetToPos(
					match.index + openingTag.length,
				);

				this.isMutating = true;
				try {
					editor.replaceRange(newTag, from, to);
				} finally {
					this.isMutating = false;
				}

				this.refreshCachedSourceContent();
				this.needsReadingModeRefresh = true;
				this.needsFullRenumber = true;
				this.invalidateLayoutCache();
				break;
			}
		}

		if (scroller) scroller.scrollTop = scrollTop;
		this.isEditingMargin = false;
	}

	// ==================== Collision Avoidance ====================

	/**
	 * Core collision avoidance algorithm.
	 *
	 * Each margin is absolutely positioned to align with its anchor (the inline reference).
	 * With --sidenote-shift: 0px, the margin's top aligns with its anchor's top.
	 * We apply positive shifts to push margins down when they would overlap.
	 *
	 * @param margins - Array of margin elements to check for collisions
	 * @param spacing - Minimum pixels between stacked sidenotes
	 */
	private resolveCollisions(margins: HTMLElement[], spacing: number) {
		if (!margins || margins.length === 0) return;

		// Filter to only connected, visible margins
		const validMargins = margins.filter(
			(m) => m.isConnected && m.offsetHeight > 0,
		);

		if (validMargins.length === 0) return;

		// Step 1: Reset all shifts to measure natural/anchor positions
		for (const margin of validMargins) {
			setCssProps(margin, { "--sidenote-shift": "0px" });
		}

		// Step 2: Force synchronous reflow to get accurate measurements
		void document.body.offsetHeight;

		// Step 3: Measure each margin at its natural position (shift=0)
		const items: {
			el: HTMLElement;
			anchorY: number; // Top position when shift=0 (aligned with anchor)
			height: number;
			shift: number; // Shift to apply (will be calculated)
			side: "left" | "right";
		}[] = [];

		for (const margin of validMargins) {
			const rect = margin.getBoundingClientRect();
			if (rect.height <= 0) continue;

			// Determine which column this margin lives in so left and right
			// sidenotes never interfere with each other's collision pass.
			const side: "left" | "right" =
				margin.dataset.sidenoteSide === "left" ||
				margin.dataset.sidenoteSide === "right"
					? margin.dataset.sidenoteSide
					: this.settings.sidenotePosition;

			items.push({
				el: margin,
				anchorY: rect.top,
				height: rect.height,
				shift: 0,
				side,
			});
		}

		if (items.length === 0) return;

		// Step 4: Sort by DOM order, not measured position.
		// Using rect.top can produce wrong order during layout transitions
		// (e.g. after editing a sidenote that changes height). DOM order
		// always reflects source order because decorations are sorted by
		// document position.
		items.sort((a, b) => {
			const pos = a.el.compareDocumentPosition(b.el);
			if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
			if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
			return 0;
		});

		// Step 5: Greedily assign positions to avoid collisions, per column.
		// Left and right sidenotes are in separate columns and must never
		// influence each other's vertical stacking.
		let nextFreeLeftY = -Infinity;
		let nextFreeRightY = -Infinity;
		for (const item of items) {
			const nextFreeY =
				item.side === "left" ? nextFreeLeftY : nextFreeRightY;
			const targetY = Math.max(item.anchorY, nextFreeY);
			item.shift = targetY - item.anchorY;
			if (item.side === "left") {
				nextFreeLeftY = targetY + item.height + spacing;
			} else {
				nextFreeRightY = targetY + item.height + spacing;
			}
		}

		// Step 6: Apply the calculated shifts
		for (const item of items) {
			if (item.shift > 0.5) {
				item.el.style.setProperty("--sidenote-shift", `${item.shift}px`);
			} else {
				item.el.style.setProperty("--sidenote-shift", `${0}px`);
			}
		}
	}

	/**
	 * Schedule collision resolution for editing mode.
	 */
	private scheduleCollisionUpdate() {
		if (this.rafId !== null) return;

		this.rafId = requestAnimationFrame(() => {
			this.rafId = null;
			this.updateEditingModeCollisions();
		});
	}

	/**
	 * Update collisions in editing mode (source view).
	 */
	private updateEditingModeCollisions() {
		if (!this.cmRoot) return;

		const margins = Array.from(
			this.cmRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
		);

		this.resolveCollisions(margins, this.settings.collisionSpacing);
	}

	/**
	 * Update collisions in reading mode.
	 */
	private updateReadingModeCollisions() {
		const view = this.getMarkdownView();
		if (!view) return;

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (!readingRoot) return;

		const margins = Array.from(
			readingRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
		);

		this.resolveCollisions(margins, this.settings.collisionSpacing);
	}

	/**
	 * Run collision avoidance specifically for reading mode sidenotes.
	 * This is called after processing sidenotes in reading mode.
	 * @param readingRoot The root element of the reading view to search for margins
	 */
	private avoidCollisionsInReadingMode(readingRoot: HTMLElement) {
		if (!readingRoot?.isConnected) return;

		const margins = Array.from(
			readingRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
		);

		this.resolveCollisions(margins, this.settings.collisionSpacing);
	}

	// ==================== Markdown Formatting ====================

	/**
	 * Apply markdown formatting to the current selection or cursor position in a contenteditable element.
	 * @param element The contenteditable element
	 * @param prefix The prefix to add (e.g., "**" for bold, "*" for italic)
	 * @param suffix The suffix to add (defaults to prefix)
	 * @param linkMode If true, handle as a link with [text](url) format
	 */
	private applyMarkdownFormatting(
		element: HTMLElement,
		prefix: string,
		suffix: string = prefix,
		linkMode: boolean = false,
	) {
		// Ensure focus is on the element
		element.focus();

		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return;

		const range = selection.getRangeAt(0);

		// Check if selection is within the element
		if (
			!element.contains(range.startContainer) ||
			!element.contains(range.endContainer)
		) {
			// Selection is outside - just insert at end of element
			const textContent = element.textContent || "";
			if (linkMode) {
				element.textContent = textContent + "[link text](url)";
			} else {
				element.textContent = textContent + prefix + suffix;
			}
			// Place cursor appropriately
			const newRange = document.createRange();
			const textNode = element.firstChild || element;
			const pos = textContent.length + prefix.length;
			try {
				newRange.setStart(textNode, pos);
				newRange.setEnd(textNode, pos);
				selection.removeAllRanges();
				selection.addRange(newRange);
			} catch (e) {
				console.error("Error setting cursor position:", e);
				// Ignore
			}
			return;
		}

		const selectedText = range.toString();

		// Get the text content and cursor positions relative to the element's text
		const fullText = element.textContent || "";

		// Calculate the start offset within the full text
		let startOffset = 0;
		let endOffset = 0;

		// Walk through text nodes to find the actual offsets
		const walker = document.createTreeWalker(
			element,
			NodeFilter.SHOW_TEXT,
			null,
		);
		let currentOffset = 0;
		let foundStart = false;
		let foundEnd = false;
		let node: Text | null;

		while ((node = walker.nextNode() as Text | null)) {
			const nodeLength = node.textContent?.length || 0;

			if (!foundStart && node === range.startContainer) {
				startOffset = currentOffset + range.startOffset;
				foundStart = true;
			}
			if (!foundEnd && node === range.endContainer) {
				endOffset = currentOffset + range.endOffset;
				foundEnd = true;
			}

			if (foundStart && foundEnd) break;
			currentOffset += nodeLength;
		}

		// Handle case where container is the element itself
		if (!foundStart && range.startContainer === element) {
			startOffset = 0;
			for (
				let i = 0;
				i < range.startOffset && i < element.childNodes.length;
				i++
			) {
				startOffset += element.childNodes[i]?.textContent?.length ?? 0;
			}
		}
		if (!foundEnd && range.endContainer === element) {
			endOffset = 0;
			for (
				let i = 0;
				i < range.endOffset && i < element.childNodes.length;
				i++
			) {
				endOffset += element.childNodes[i]?.textContent?.length ?? 0;
			}
		}

		// Build the new text
		let newText: string;
		let newCursorStart: number;
		let newCursorEnd: number;

		if (linkMode) {
			const linkText = selectedText || "link text";
			const replacement = `[${linkText}](url)`;
			newText =
				fullText.slice(0, startOffset) +
				replacement +
				fullText.slice(endOffset);
			// Select "url"
			newCursorStart = startOffset + 1 + linkText.length + 2; // [linkText](
			newCursorEnd = newCursorStart + 3; // url
		} else if (selectedText) {
			// Wrap selection
			const replacement = `${prefix}${selectedText}${suffix}`;
			newText =
				fullText.slice(0, startOffset) +
				replacement +
				fullText.slice(endOffset);
			// Select the wrapped text
			newCursorStart = startOffset + prefix.length;
			newCursorEnd = newCursorStart + selectedText.length;
		} else {
			// Insert at cursor
			newText =
				fullText.slice(0, startOffset) +
				prefix +
				suffix +
				fullText.slice(endOffset);
			// Place cursor between prefix and suffix
			newCursorStart = startOffset + prefix.length;
			newCursorEnd = newCursorStart;
		}

		// Update the element
		element.textContent = newText;

		// Restore cursor position
		requestAnimationFrame(() => {
			element.focus();
			const sel = window.getSelection();
			if (!sel) return;

			const textNode = element.firstChild;
			if (!textNode) return;

			try {
				const newRange = document.createRange();
				newRange.setStart(
					textNode,
					Math.min(newCursorStart, newText.length),
				);
				newRange.setEnd(textNode, Math.min(newCursorEnd, newText.length));
				sel.removeAllRanges();
				sel.addRange(newRange);
			} catch (e) {
				// Fallback - place at end
				console.error("Error setting cursor position:", e);
				const fallbackRange = document.createRange();
				fallbackRange.selectNodeContents(element);
				fallbackRange.collapse(false);
				sel.removeAllRanges();
				sel.addRange(fallbackRange);
			}
		});
	}

	/**
	 * Public version for widget to use.
	 * @param element The contenteditable element
	 * @param prefix The prefix to add (e.g., "**" for bold, "*" for italic)
	 * @param suffix The suffix to add (defaults to prefix)
	 * @param linkMode If true, handle as a link with [text](url) format
	 */
	public applyMarkdownFormattingPublic(
		element: HTMLElement,
		prefix: string,
		suffix: string = prefix,
		linkMode: boolean = false,
	) {
		this.applyMarkdownFormatting(element, prefix, suffix, linkMode);
	}

	/**
	 * Insert markdown wrapper (like ** for bold, * for italic) around the
	 * current selection in a contentEditable element, or at cursor if no selection.
	 * Uses manual text manipulation to maintain plain-text editing.
	 */
	private insertMarkdownWrapper(element: HTMLElement, wrapper: string) {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return;

		const range = selection.getRangeAt(0);
		if (
			!element.contains(range.startContainer) ||
			!element.contains(range.endContainer)
		)
			return;

		const fullText = element.textContent || "";

		// Calculate offsets within the full text
		const offsets = this.getSelectionOffsets(element, range);
		if (!offsets) return;

		const { start, end } = offsets;
		const selectedText = fullText.slice(start, end);

		let newText: string;
		let cursorStart: number;
		let cursorEnd: number;

		if (selectedText) {
			// Wrap selection
			newText =
				fullText.slice(0, start) +
				wrapper +
				selectedText +
				wrapper +
				fullText.slice(end);
			cursorStart = start + wrapper.length;
			cursorEnd = cursorStart + selectedText.length;
		} else {
			// Insert wrapper pair at cursor
			newText =
				fullText.slice(0, start) + wrapper + wrapper + fullText.slice(end);
			cursorStart = start + wrapper.length;
			cursorEnd = cursorStart;
		}

		element.textContent = newText;

		// Restore cursor
		requestAnimationFrame(() => {
			element.focus();
			const sel = window.getSelection();
			if (!sel || !element.firstChild) return;
			try {
				const newRange = document.createRange();
				newRange.setStart(
					element.firstChild,
					Math.min(cursorStart, newText.length),
				);
				newRange.setEnd(
					element.firstChild,
					Math.min(cursorEnd, newText.length),
				);
				sel.removeAllRanges();
				sel.addRange(newRange);
			} catch (e) {
				// Fallback
				console.error("Sidenotes - Error setting cursor position:", e);
			}
		});
	}

	/**
	 * Insert a markdown link at the current cursor/selection in a contentEditable element.
	 */
	private insertMarkdownLink(element: HTMLElement) {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return;

		const range = selection.getRangeAt(0);
		if (
			!element.contains(range.startContainer) ||
			!element.contains(range.endContainer)
		)
			return;

		const fullText = element.textContent || "";
		const offsets = this.getSelectionOffsets(element, range);
		if (!offsets) return;

		const { start, end } = offsets;
		const selectedText = fullText.slice(start, end);

		const linkText = selectedText || "link text";
		const replacement = `[${linkText}](url)`;

		const newText =
			fullText.slice(0, start) + replacement + fullText.slice(end);

		// Position cursor to select "url"
		const urlStart = start + 1 + linkText.length + 2; // [linkText](
		const urlEnd = urlStart + 3; // url

		element.textContent = newText;

		requestAnimationFrame(() => {
			element.focus();
			const sel = window.getSelection();
			if (!sel || !element.firstChild) return;
			try {
				const newRange = document.createRange();
				newRange.setStart(
					element.firstChild,
					Math.min(urlStart, newText.length),
				);
				newRange.setEnd(
					element.firstChild,
					Math.min(urlEnd, newText.length),
				);
				sel.removeAllRanges();
				sel.addRange(newRange);
			} catch (e) {
				console.error("Sidenotes - Error setting cursor position:", e);
				// Fallback
			}
		});
	}

	//
	/**
	 * Render markdown-formatted text to a DocumentFragment.
	 * Supports: **bold**, *italic*, _italic_, `code`, [links](url), and [[wiki links]]
	 * @param text The markdown-formatted text to render
	 */
	private renderLinksToFragment(text: string): DocumentFragment {
		const frag = document.createDocumentFragment();

		// Combined regex for all supported formats:
		// - Bold: **text** or __text__
		// - Italic: *text* or _text_ (but not inside **)
		// - Code: `text`
		// - Markdown links: [text](url)
		// - Wiki links: [[target]] or [[target|display]]
		const combinedRe =
			/\*\*(.+?)\*\*|__(.+?)__|\*([^*]+?)\*|(?<![*_])_([^_]+?)_(?![*_])|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

		let last = 0;
		let m: RegExpExecArray | null;

		while ((m = combinedRe.exec(text)) !== null) {
			const start = m.index;
			const fullMatch = m[0];

			// Add text before the match
			if (start > last) {
				this.appendTextWithBreaks(frag, text.slice(last, start));
			}

			if (m[1] !== undefined) {
				// Bold: **text**
				const strong = document.createElement("strong");
				strong.textContent = m[1];
				frag.appendChild(strong);
			} else if (m[2] !== undefined) {
				// Bold: __text__
				const strong = document.createElement("strong");
				strong.textContent = m[2];
				frag.appendChild(strong);
			} else if (m[3] !== undefined) {
				// Italic: *text*
				const em = document.createElement("em");
				em.textContent = m[3];
				frag.appendChild(em);
			} else if (m[4] !== undefined) {
				// Italic: _text_
				const em = document.createElement("em");
				em.textContent = m[4];
				frag.appendChild(em);
			} else if (m[5] !== undefined) {
				// Code: `text`
				const code = document.createElement("code");
				code.textContent = m[5];
				frag.appendChild(code);
			} else if (m[6] !== undefined && m[7] !== undefined) {
				// Markdown link: [text](url)
				const label = m[6];
				const url = m[7].trim();

				const isExternal =
					url.startsWith("http://") ||
					url.startsWith("https://") ||
					url.startsWith("mailto:");

				const a = document.createElement("a");
				a.textContent = label;

				if (isExternal) {
					a.href = url;
					a.className = "external-link";
					a.rel = "noopener noreferrer";
					a.target = "_blank";
				} else {
					// Treat as internal link
					a.className = "internal-link";
					a.setAttribute("data-href", url);
					a.addEventListener("click", (e) => {
						e.preventDefault();
						e.stopPropagation();
						void this.app.workspace.openLinkText(url, "", false);
					});
				}
				frag.appendChild(a);
			} else if (m[8] !== undefined) {
				// Wiki link: [[target]] or [[target|display]]
				const target = m[8].trim();
				const display = m[9]?.trim() || target;

				const a = document.createElement("a");
				a.textContent = display;
				a.className = "internal-link";
				a.setAttribute("data-href", target);
				a.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					void this.app.workspace.openLinkText(target, "", false);
				});
				frag.appendChild(a);
			}

			last = start + fullMatch.length;
		}

		// Add remaining text
		if (last < text.length) {
			this.appendTextWithBreaks(frag, text.slice(last));
		}

		return frag;
	}

	// ==================== Keyboard Handling for Margin Editing ====================
	/**
	 * Get the start and end character offsets of the current selection
	 * within a contentEditable element's text content.
	 * @param element The contentEditable element
	 * @param range The current selection range
	 */
	private getSelectionOffsets(
		element: HTMLElement,
		range: Range,
	): { start: number; end: number } | null {
		const walker = document.createTreeWalker(
			element,
			NodeFilter.SHOW_TEXT,
			null,
		);
		let currentOffset = 0;
		let startOffset = 0;
		let endOffset = 0;
		let foundStart = false;
		let foundEnd = false;
		let node: Text | null;

		while ((node = walker.nextNode() as Text | null)) {
			const nodeLength = node.textContent?.length || 0;

			if (!foundStart && node === range.startContainer) {
				startOffset = currentOffset + range.startOffset;
				foundStart = true;
			}
			if (!foundEnd && node === range.endContainer) {
				endOffset = currentOffset + range.endOffset;
				foundEnd = true;
			}

			if (foundStart && foundEnd) break;
			currentOffset += nodeLength;
		}

		// Handle case where container is the element itself
		if (!foundStart && range.startContainer === element) {
			startOffset = 0;
			for (
				let i = 0;
				i < range.startOffset && i < element.childNodes.length;
				i++
			) {
				startOffset += element.childNodes[i]?.textContent?.length ?? 0;
			}
			foundStart = true;
		}
		if (!foundEnd && range.endContainer === element) {
			endOffset = 0;
			for (
				let i = 0;
				i < range.endOffset && i < element.childNodes.length;
				i++
			) {
				endOffset += element.childNodes[i]?.textContent?.length ?? 0;
			}
			foundEnd = true;
		}

		if (!foundStart || !foundEnd) return null;
		return { start: startOffset, end: endOffset };
	}

	/**
	 * Set up keyboard interception that prevents CM6 from seeing ANY key events
	 * while a margin is being edited.
	 *
	 * We attach a capture-phase listener on the .cm-editor element itself
	 * and call stopImmediatePropagation to prevent CM6's own handlers from firing.
	 * We also attach on document as a fallback for reading mode (where there's no CM6).
	 *
	 * Returns a cleanup function.
	 * @param margin The margin element being edited
	 */
	private setupMarginKeyboardCapture(margin: HTMLElement): () => void {
		this.setCurrentlyEditingMargin(margin);

		const handler = (e: KeyboardEvent) => {
			if (margin.contentEditable !== "true") return;
			if (
				document.activeElement !== margin &&
				!margin.contains(document.activeElement)
			)
				return;

			const isMod = e.metaKey || e.ctrlKey;

			if (e.key === "Escape") {
				e.preventDefault();
				e.stopImmediatePropagation();
				margin.dataset.cancelled = "true";
				margin.blur();
				return;
			}

			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				e.stopImmediatePropagation();
				margin.blur();
				return;
			}

			if (
				isMod &&
				e.key.toLowerCase() === "b" &&
				!e.shiftKey &&
				!e.altKey
			) {
				// console.warn("BOLD shortcut detected");
				e.preventDefault();
				e.stopImmediatePropagation();
				this.insertMarkdownWrapper(margin, "**");
				return;
			}

			if (
				isMod &&
				e.key.toLowerCase() === "i" &&
				!e.shiftKey &&
				!e.altKey
			) {
				// console.warn("ITALICS shortcut detected");
				e.preventDefault();
				e.stopImmediatePropagation();
				this.insertMarkdownWrapper(margin, "*");
				return;
			}

			if (
				isMod &&
				e.key.toLowerCase() === "k" &&
				!e.shiftKey &&
				!e.altKey
			) {
				e.preventDefault();
				e.stopImmediatePropagation();
				this.insertMarkdownLink(margin);
				return;
			}

			if (
				isMod &&
				e.key.toLowerCase() === "a" &&
				!e.shiftKey &&
				!e.altKey
			) {
				e.preventDefault();
				e.stopImmediatePropagation();
				const selection = window.getSelection();
				const range = document.createRange();
				range.selectNodeContents(margin);
				selection?.removeAllRanges();
				selection?.addRange(range);
				return;
			}

			if (isMod && e.key.toLowerCase() === "z") {
				e.stopImmediatePropagation();
				return;
			}

			if (
				["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
			) {
				e.stopImmediatePropagation();

				const selection = window.getSelection();
				if (!selection || selection.rangeCount === 0) return;
				const range = selection.getRangeAt(0);

				const atStart =
					range.collapsed &&
					range.startOffset === 0 &&
					(range.startContainer === margin ||
						range.startContainer === margin.firstChild);

				let atEnd = false;
				if (range.collapsed) {
					if (range.startContainer === margin) {
						atEnd = range.startOffset === margin.childNodes.length;
					} else if (range.startContainer.nodeType === Node.TEXT_NODE) {
						const len = range.startContainer.textContent?.length ?? 0;
						atEnd =
							range.startOffset === len &&
							(range.startContainer === margin.lastChild ||
								range.startContainer.parentNode === margin);
					}
				}

				if (atStart && e.key === "ArrowLeft") {
					e.preventDefault();
					return;
				}
				if (atEnd && e.key === "ArrowRight") {
					e.preventDefault();
					return;
				}

				if (e.key === "ArrowUp" || e.key === "ArrowDown") {
					const cursorRect = range.getBoundingClientRect();
					const marginRect = margin.getBoundingClientRect();
					const lh = parseFloat(getComputedStyle(margin).lineHeight) || 20;
					if (
						e.key === "ArrowUp" &&
						cursorRect.top - marginRect.top < lh
					) {
						e.preventDefault();
						return;
					}
					if (
						e.key === "ArrowDown" &&
						marginRect.bottom - cursorRect.bottom < lh
					) {
						e.preventDefault();
						return;
					}
				}
				return;
			}

			// Block ALL other keys from reaching Obsidian/CM6
			e.stopImmediatePropagation();
		};

		// CRITICAL: Attach to window (not document, not cm-editor) in capture phase.
		// Capture flows: window → document → ... → element.
		// Obsidian's hotkey system registers on document, so window fires first.
		window.addEventListener("keydown", handler, true);

		return () => {
			window.removeEventListener("keydown", handler, true);
			this.setCurrentlyEditingMargin(null);
		};
	}

	public setupMarginKeyboardCapturePublic(
		margin: HTMLElement,
	): () => void {
		return this.setupMarginKeyboardCapture(margin);
	}

	/**
	 * Attach a context menu to a sidenote margin element with options to edit or delete the sidenote.
	 * This is currently unused
	 * @param margin The margin element to attach the context menu to
	 * @param opts Options for the context menu actions
	 */
	private attachSidenoteContextMenu(
		margin: HTMLElement,
		opts: {
			onEdit?: () => void;
			onDelete?: () => void;
		},
	) {
		margin.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();

			const menu = new Menu();

			if (opts.onEdit) {
				menu.addItem((item) =>
					item
						.setTitle("Edit sidenote")
						.setIcon("pencil")
						.onClick(() => opts.onEdit!()),
				);
			}

			if (opts.onDelete) {
				menu.addItem((item) =>
					item
						.setTitle("Delete sidenote")
						.setIcon("trash")
						.onClick(() => opts.onDelete!()),
				);
			}

			menu.showAtMouseEvent(e);
		});
	}

}

function setCssProps(
	el: HTMLElement,
	props: Record<string, string>,
	important: boolean = false,
) {
	for (const [key, value] of Object.entries(props)) {
		el.style.setProperty(key, value, important ? "important" : "");
	}
}

function cmToPos(view: EditorView, offset: number): EditorPosition {
	const line = view.state.doc.lineAt(offset);
	return { line: line.number - 1, ch: offset - line.from };
}

function posToCm(view: EditorView, pos: EditorPosition): number {
	const line = view.state.doc.line(pos.line + 1);
	return Math.max(line.from, Math.min(line.to, line.from + pos.ch));
}

export function cmEditorAdapter(view: EditorView): MinimalEditor {
	return {
		getValue() {
			return view.state.doc.toString();
		},

		getLine(line: number) {
			return view.state.doc.line(line + 1).text;
		},

		lineCount() {
			return view.state.doc.lines;
		},

		getCursor() {
			return cmToPos(view, view.state.selection.main.head);
		},

		setCursor(pos: EditorPosition) {
			const off = posToCm(view, pos);
			view.dispatch({ selection: { anchor: off } });
		},

		setSelection(anchor: EditorPosition, head?: EditorPosition) {
			const a = posToCm(view, anchor);
			const h = posToCm(view, head ?? anchor);
			view.dispatch({ selection: { anchor: a, head: h } });
		},

		getSelection() {
			const sel = view.state.selection.main;
			return view.state.sliceDoc(sel.from, sel.to);
		},

		replaceSelection(text: string) {
			const sel = view.state.selection.main;
			view.dispatch({
				changes: { from: sel.from, to: sel.to, insert: text },
			});
		},

		getRange(from: EditorPosition, to: EditorPosition) {
			const a = posToCm(view, from);
			const b = posToCm(view, to);
			return view.state.sliceDoc(Math.min(a, b), Math.max(a, b));
		},

		replaceRange(text: string, from: EditorPosition, to?: EditorPosition) {
			const a = posToCm(view, from);
			const b = posToCm(view, to ?? from);
			view.dispatch({
				changes: {
					from: Math.min(a, b),
					to: Math.max(a, b),
					insert: text,
				},
			});
		},
	};
}

type WorkspaceWithActiveEditor = {
	activeEditor: null | {
		editor: MinimalEditor;
		file: TFile | null;
	};
};

function setWorkspaceActiveEditor(
	plugin: SidenotePlugin,
	view: EditorView | null,
) {
	const ws = plugin.app.workspace as unknown as WorkspaceWithActiveEditor;

	if (!view) {
		ws.activeEditor = null;
		return;
	}

	ws.activeEditor = {
		editor: cmEditorAdapter(view),
		file: plugin.app.workspace.getActiveFile(),
	};
}

function wrapSelection(view: EditorView, left: string, right: string) {
	const changes: { from: number; to: number; insert: string }[] = [];
	const ranges: { anchor: number; head: number }[] = [];

	for (const range of view.state.selection.ranges) {
		const from = Math.min(range.from, range.to);
		const to = Math.max(range.from, range.to);
		const selected = view.state.sliceDoc(from, to);

		const insert = left + selected + right;
		changes.push({ from, to, insert });

		// place cursor inside markers when no selection; otherwise keep selection
		if (from === to) {
			const cursor = from + left.length;
			ranges.push({ anchor: cursor, head: cursor });
		} else {
			ranges.push({
				anchor: from + left.length,
				head: to + left.length,
			});
		}
	}

	view.dispatch({
		changes,
		selection: EditorSelection.create(
			ranges.map((r) => EditorSelection.range(r.anchor, r.head)),
		),
		userEvent: "input",
	});
}

const mdBold: Command = (view) => {
	wrapSelection(view, "**", "**");
	return true;
};

const mdItalic: Command = (view) => {
	wrapSelection(view, "*", "*");
	return true;
};

const mdLink: Command = (view) => {
	// If selection: [text]()
	// If none: []() and cursor inside []
	const changes: { from: number; to: number; insert: string }[] = [];
	const ranges: { anchor: number; head: number }[] = [];

	for (const range of view.state.selection.ranges) {
		const from = Math.min(range.from, range.to);
		const to = Math.max(range.from, range.to);
		const selected = view.state.sliceDoc(from, to);

		const insert = `[${selected}]()`;
		changes.push({ from, to, insert });

		if (from === to) {
			// cursor between [ ]
			const cursor = from + 1;
			ranges.push({ anchor: cursor, head: cursor });
		} else {
			// keep selection on the text inside []
			ranges.push({
				anchor: from + 1,
				head: from + 1 + selected.length,
			});
		}
	}

	view.dispatch({
		changes,
		selection: EditorSelection.create(
			ranges.map((r) => EditorSelection.range(r.anchor, r.head)),
		),
		userEvent: "input",
	});

	return true;
};

const markdownEditHotkeys = keymap.of([
	{ key: "Mod-b", run: mdBold, preventDefault: true },
	{ key: "Mod-i", run: mdItalic, preventDefault: true },
	{ key: "Mod-k", run: mdLink, preventDefault: true },
]);

const sidenoteEditorTheme = EditorView.theme({
	"&": {
		backgroundColor: "transparent !important",
		color: "inherit !important",
		padding: "0 !important",
		margin: "0 !important",
		border: "none !important",
		height: "auto !important",
		minHeight: "0 !important",
		fontFamily: "inherit !important",
		fontSize: "inherit !important",
	},
	"& .cm-scroller": {
		padding: "0 !important",
		paddingLeft: "0 !important",
		paddingRight: "0 !important",
		margin: "0 !important",
		overflow: "visible !important",
		height: "auto !important",
		minHeight: "0 !important",
		fontFamily: "inherit !important",
	},
	"& .cm-content": {
		padding: "2px 0 !important",
		paddingLeft: "0 !important",
		margin: "0 !important",
		minHeight: "auto !important",
		fontFamily: "inherit !important",
		fontSize: "inherit !important",
		lineHeight: "inherit !important",
		caretColor:
			"var(--caret-color, var(--text-accent, var(--text-normal))) !important",
	},
	"& .cm-content[contenteditable]": {
		padding: "2px 0 !important",
		paddingLeft: "0 !important",
	},
	"& .cm-line": {
		padding: "0 !important",
		paddingLeft: "0 !important",
		margin: "0 !important",
		fontFamily: "inherit !important",
	},
	"& .cm-gutters": {
		display: "none !important",
		width: "0 !important",
		minWidth: "0 !important",
		border: "none !important",
	},
	"& .cm-cursor": {
		borderLeftColor: "var(--caret-color, var(--text-normal)) !important",
	},
	"&.cm-focused": {
		outline: "none !important",
	},
	"&.cm-focused .cm-cursor": {
		borderLeftColor: "var(--caret-color, var(--text-normal)) !important",
	},
	"& .cm-activeLineGutter": {
		backgroundColor: "transparent !important",
		display: "none !important",
	},
	"& .cm-activeLine": {
		backgroundColor: "transparent !important",
	},
});

const sidenoteHighlightStyle = HighlightStyle.define([
	{ tag: tags.strong, fontWeight: "bold" },
	{ tag: tags.emphasis, fontStyle: "italic" },
	{ tag: tags.strikethrough, textDecoration: "line-through" },
	{
		tag: tags.monospace,
		fontFamily: "var(--font-monospace)",
		fontSize: "0.9em",
	},
	{
		tag: tags.link,
		color: "var(--link-color, var(--text-accent))",
		textDecoration: "underline",
	},
	{ tag: tags.url, color: "var(--link-color, var(--text-accent))" },
	// Dim the markdown syntax characters (**, *, `, [, ], etc.)
	{ tag: tags.processingInstruction, color: "var(--text-faint)" },
]);

