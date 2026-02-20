import type { Contents } from "epubjs";
import type { ResolvedReaderAppearanceTheme } from "../types";

interface PendingLongPress {
	anchor: HTMLAnchorElement;
	timerId: number;
	startX: number;
	startY: number;
	fired: boolean;
}

interface BoundContentsState {
	contents: Contents;
	document: Document;
	popoverEl: HTMLElement;
	activeAnchor: HTMLAnchorElement | null;
	pendingLongPress: PendingLongPress | null;
	suppressClickAnchor: HTMLAnchorElement | null;
	suppressClickTimerId: number | null;
	autoHideTimerId: number | null;
	handlers: {
		pointerOver: (event: Event) => void;
		pointerOut: (event: Event) => void;
		mouseOver: (event: Event) => void;
		mouseOut: (event: Event) => void;
		touchStart: (event: Event) => void;
		touchMove: (event: Event) => void;
		touchEnd: (event: Event) => void;
		touchCancel: (event: Event) => void;
		click: (event: Event) => void;
	};
}

const LONG_PRESS_MS = 450;
const SUPPRESS_CLICK_MS = 900;
const AUTO_HIDE_MS = 2000;
const MAX_TEXT_LENGTH = 320;
const POSITION_MARGIN_PX = 12;
const POPUP_OFFSET_PX = 8;
const TOUCH_MOVE_CANCEL_THRESHOLD_PX = 10;

export class FootnotePopoverController {
	private theme: ResolvedReaderAppearanceTheme;
	private states = new Map<Document, BoundContentsState>();

	constructor(theme: ResolvedReaderAppearanceTheme) {
		this.theme = theme;
	}

	async bindContents(contents: Contents): Promise<void> {
		const doc = contents.document;
		if (this.states.has(doc)) {
			return;
		}

		const popoverEl = this.createPopoverElement(doc);
		const handlers = {
			pointerOver: (event: Event) => {
				this.handlePointerOver(state, event);
			},
			pointerOut: (event: Event) => {
				this.handlePointerOut(state, event);
			},
			mouseOver: (event: Event) => {
				this.handleMouseOver(state, event);
			},
			mouseOut: (event: Event) => {
				this.handleMouseOut(state, event);
			},
			touchStart: (event: Event) => {
				if (!this.isTouchEvent(event)) {
					return;
				}
				this.handleTouchStart(state, event);
			},
			touchMove: (event: Event) => {
				if (!this.isTouchEvent(event)) {
					return;
				}
				this.handleTouchMove(state, event);
			},
			touchEnd: (_event: Event) => {
				this.handleTouchEndOrCancel(state);
			},
			touchCancel: (_event: Event) => {
				this.handleTouchEndOrCancel(state);
			},
			click: (event: Event) => {
				this.handleClick(state, event);
			},
		};
		const state: BoundContentsState = {
			contents,
			document: doc,
			popoverEl,
			activeAnchor: null,
			pendingLongPress: null,
			suppressClickAnchor: null,
			suppressClickTimerId: null,
			autoHideTimerId: null,
			handlers,
		};

		doc.addEventListener("pointerover", handlers.pointerOver, true);
		doc.addEventListener("pointerout", handlers.pointerOut, true);
		doc.addEventListener("mouseover", handlers.mouseOver, true);
		doc.addEventListener("mouseout", handlers.mouseOut, true);
		doc.addEventListener("touchstart", handlers.touchStart, true);
		doc.addEventListener("touchmove", handlers.touchMove, true);
		doc.addEventListener("touchend", handlers.touchEnd, true);
		doc.addEventListener("touchcancel", handlers.touchCancel, true);
		doc.addEventListener("click", handlers.click, true);

		this.states.set(doc, state);
		this.applyTheme(popoverEl, this.theme);
	}

	unbindContents(contents: Contents): void {
		const doc = contents.document;
		const state = this.states.get(doc);
		if (!state) {
			return;
		}

		doc.removeEventListener("pointerover", state.handlers.pointerOver, true);
		doc.removeEventListener("pointerout", state.handlers.pointerOut, true);
		doc.removeEventListener("mouseover", state.handlers.mouseOver, true);
		doc.removeEventListener("mouseout", state.handlers.mouseOut, true);
		doc.removeEventListener("touchstart", state.handlers.touchStart, true);
		doc.removeEventListener("touchmove", state.handlers.touchMove, true);
		doc.removeEventListener("touchend", state.handlers.touchEnd, true);
		doc.removeEventListener("touchcancel", state.handlers.touchCancel, true);
		doc.removeEventListener("click", state.handlers.click, true);

		this.clearPendingLongPress(state);
		this.clearSuppressClick(state);
		this.clearAutoHide(state);
		this.hidePopover(state);
		state.popoverEl.remove();
		this.states.delete(doc);
	}

	async updateTheme(theme: ResolvedReaderAppearanceTheme): Promise<void> {
		this.theme = theme;
		for (const state of this.states.values()) {
			this.applyTheme(state.popoverEl, theme);
		}
	}

	destroy(): void {
		const states = Array.from(this.states.values());
		for (const state of states) {
			this.unbindContents(state.contents);
		}
		this.states.clear();
	}

	private handlePointerOver(state: BoundContentsState, event: Event): void {
		if (!this.isMousePointerEvent(event)) {
			return;
		}
		this.handleHoverOver(state, event.target);
	}

	private handlePointerOut(state: BoundContentsState, event: Event): void {
		if (!this.isMousePointerEvent(event)) {
			return;
		}
		const eventLike = event as { relatedTarget?: EventTarget | null };
		this.handleHoverOut(state, event.target, eventLike.relatedTarget ?? null);
	}

	private handleMouseOver(state: BoundContentsState, event: Event): void {
		this.handleHoverOver(state, event.target);
	}

	private handleMouseOut(state: BoundContentsState, event: Event): void {
		const mouseEventLike = event as { relatedTarget?: EventTarget | null };
		this.handleHoverOut(state, event.target, mouseEventLike.relatedTarget ?? null);
	}

	private handleHoverOver(state: BoundContentsState, target: EventTarget | null): void {
		const anchor = this.findAnchorFromTarget(target);
		if (!anchor) {
			return;
		}

		const footnoteText = this.extractFootnoteText(anchor, state.document);
		if (!footnoteText) {
			return;
		}

		state.activeAnchor = anchor;
		this.showPopover(state, anchor, footnoteText);
	}

	private handleHoverOut(
		state: BoundContentsState,
		target: EventTarget | null,
		relatedTarget: EventTarget | null,
	): void {
		if (!state.activeAnchor) {
			return;
		}

		const fromAnchor = this.findAnchorFromTarget(target);
		if (!fromAnchor || fromAnchor !== state.activeAnchor) {
			return;
		}

		const relatedAnchor = this.findAnchorFromTarget(relatedTarget);
		if (relatedAnchor === fromAnchor) {
			return;
		}

		state.activeAnchor = null;
		this.hidePopover(state);
	}

	private handleTouchStart(state: BoundContentsState, event: TouchEvent): void {
		const anchor = this.findAnchorFromTarget(event.target);
		if (!anchor) {
			this.clearPendingLongPress(state);
			return;
		}
		if (!this.extractFootnoteText(anchor, state.document)) {
			this.clearPendingLongPress(state);
			return;
		}

		const touch = event.touches[0];
		if (!touch) {
			return;
		}

		this.clearPendingLongPress(state);
		const timerId = window.setTimeout(() => {
			this.fireLongPress(state);
		}, LONG_PRESS_MS);

		state.pendingLongPress = {
			anchor,
			timerId,
			startX: touch.clientX,
			startY: touch.clientY,
			fired: false,
		};
	}

	private handleTouchMove(state: BoundContentsState, event: TouchEvent): void {
		const pending = state.pendingLongPress;
		if (!pending || pending.fired) {
			return;
		}

		const touch = event.touches[0];
		if (!touch) {
			return;
		}

		const deltaX = Math.abs(touch.clientX - pending.startX);
		const deltaY = Math.abs(touch.clientY - pending.startY);
		if (deltaX > TOUCH_MOVE_CANCEL_THRESHOLD_PX || deltaY > TOUCH_MOVE_CANCEL_THRESHOLD_PX) {
			this.clearPendingLongPress(state);
		}
	}

	private handleTouchEndOrCancel(state: BoundContentsState): void {
		const pending = state.pendingLongPress;
		if (!pending) {
			return;
		}

		if (!pending.fired) {
			this.clearPendingLongPress(state);
			return;
		}

		window.clearTimeout(pending.timerId);
		state.pendingLongPress = null;
	}

	private fireLongPress(state: BoundContentsState): void {
		const pending = state.pendingLongPress;
		if (!pending) {
			return;
		}

		pending.fired = true;
		const footnoteText = this.extractFootnoteText(pending.anchor, state.document);
		if (!footnoteText) {
			return;
		}

		this.showPopover(state, pending.anchor, footnoteText);
		this.startSuppressClick(state, pending.anchor);
		this.scheduleAutoHide(state);
	}

	private handleClick(state: BoundContentsState, event: Event): void {
		const suppressAnchor = state.suppressClickAnchor;
		if (!suppressAnchor) {
			return;
		}

		const anchor = this.findAnchorFromTarget(event.target);
		if (anchor !== suppressAnchor) {
			return;
		}

		const eventLike = event as {
			preventDefault?: () => void;
			stopPropagation?: () => void;
			stopImmediatePropagation?: () => void;
		};
		eventLike.preventDefault?.();
		eventLike.stopPropagation?.();
		eventLike.stopImmediatePropagation?.();
		this.clearSuppressClick(state);
	}

	private createPopoverElement(doc: Document): HTMLElement {
		const popoverEl = doc.createElement("aside");
		popoverEl.setAttribute("role", "tooltip");
		popoverEl.className = "reader-footnote-popover";
		this.setCssProps(popoverEl, {
			all: "initial",
			position: "fixed",
			"z-index": "2147483000",
			display: "none",
			"pointer-events": "none",
			"max-width": "320px",
			padding: "8px 10px",
			"border-radius": "8px",
			border: "1px solid transparent",
			"line-height": "1.5",
			"font-size": "0.9rem",
			"font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
			"white-space": "normal",
			"word-break": "break-word",
			"box-sizing": "border-box",
			"box-shadow": "0 10px 24px rgba(0, 0, 0, 0.25)",
		});

		doc.body.appendChild(popoverEl);
		return popoverEl;
	}

	private showPopover(state: BoundContentsState, anchor: HTMLAnchorElement, text: string): void {
		const view = state.document.defaultView;
		if (!view) {
			return;
		}

		this.clearAutoHide(state);
		const popoverEl = state.popoverEl;
		popoverEl.textContent = text;
		this.setCssProps(popoverEl, {
			display: "block",
			visibility: "hidden",
		});

		const anchorRect = anchor.getBoundingClientRect();
		const popoverRect = popoverEl.getBoundingClientRect();

		let left = anchorRect.left;
		if (left + popoverRect.width + POSITION_MARGIN_PX > view.innerWidth) {
			left = view.innerWidth - popoverRect.width - POSITION_MARGIN_PX;
		}
		if (left < POSITION_MARGIN_PX) {
			left = POSITION_MARGIN_PX;
		}

		let top = anchorRect.bottom + POPUP_OFFSET_PX;
		if (top + popoverRect.height + POSITION_MARGIN_PX > view.innerHeight) {
			top = anchorRect.top - popoverRect.height - POPUP_OFFSET_PX;
		}
		if (top < POSITION_MARGIN_PX) {
			top = POSITION_MARGIN_PX;
		}

		this.setCssProps(popoverEl, {
			left: `${Math.round(left)}px`,
			top: `${Math.round(top)}px`,
			visibility: "visible",
		});
	}

	private hidePopover(state: BoundContentsState): void {
		this.setCssProps(state.popoverEl, {
			display: "none",
			visibility: "hidden",
		});
	}

	private scheduleAutoHide(state: BoundContentsState): void {
		this.clearAutoHide(state);
		state.autoHideTimerId = window.setTimeout(() => {
			this.hidePopover(state);
			state.autoHideTimerId = null;
		}, AUTO_HIDE_MS);
	}

	private clearAutoHide(state: BoundContentsState): void {
		if (state.autoHideTimerId === null) {
			return;
		}
		window.clearTimeout(state.autoHideTimerId);
		state.autoHideTimerId = null;
	}

	private startSuppressClick(state: BoundContentsState, anchor: HTMLAnchorElement): void {
		this.clearSuppressClick(state);
		state.suppressClickAnchor = anchor;
		state.suppressClickTimerId = window.setTimeout(() => {
			this.clearSuppressClick(state);
		}, SUPPRESS_CLICK_MS);
	}

	private clearSuppressClick(state: BoundContentsState): void {
		state.suppressClickAnchor = null;
		if (state.suppressClickTimerId !== null) {
			window.clearTimeout(state.suppressClickTimerId);
			state.suppressClickTimerId = null;
		}
	}

	private clearPendingLongPress(state: BoundContentsState): void {
		const pending = state.pendingLongPress;
		if (!pending) {
			return;
		}
		window.clearTimeout(pending.timerId);
		state.pendingLongPress = null;
	}

	private findAnchorFromTarget(target: EventTarget | null): HTMLAnchorElement | null {
		let targetElement: Element | null = null;
		const nodeLike = target as { nodeType?: number; parentElement?: Element | null } | null;
		if (!nodeLike || typeof nodeLike.nodeType !== "number") {
			return null;
		}

		if (nodeLike.nodeType === 1) {
			targetElement = target as Element;
		} else if (nodeLike.nodeType === 3) {
			targetElement = nodeLike.parentElement ?? null;
		}

		if (!targetElement) {
			return null;
		}
		const anchor = targetElement.closest("a");
		if (!anchor) {
			return null;
		}
		return anchor.tagName.toLowerCase() === "a" ? anchor : null;
	}

	private isFootnoteAnchor(anchor: HTMLAnchorElement): boolean {
		const href = anchor.getAttribute("href");
		if (!href || !href.includes("#")) {
			return false;
		}

		const epubType =
			anchor.getAttribute("epub:type") ??
			anchor.getAttributeNS("http://www.idpf.org/2007/ops", "type") ??
			"";
		const role = anchor.getAttribute("role") ?? "";
		const rel = anchor.getAttribute("rel") ?? "";
		const className = anchor.getAttribute("class") ?? "";
		const id = anchor.getAttribute("id") ?? "";

		if (this.hasToken(epubType, "noteref")) {
			return true;
		}
		if (this.hasToken(role, "doc-noteref")) {
			return true;
		}
		if (this.hasToken(rel, "footnote")) {
			return true;
		}
		if (this.hasFootnoteKeyword(className) || this.hasFootnoteKeyword(id)) {
			return true;
		}
		if (this.isSuperscriptLikeAnchor(anchor)) {
			return true;
		}
		if (this.isFootnoteMarkerText(anchor.textContent ?? "")) {
			return true;
		}

		return anchor.closest("sup") !== null;
	}

	private hasToken(value: string, token: string): boolean {
		return value
			.split(/\s+/)
			.map((part) => part.trim().toLowerCase())
			.filter((part) => part.length > 0)
			.includes(token.toLowerCase());
	}

	private extractFootnoteText(anchor: HTMLAnchorElement, doc: Document): string | null {
		const target = this.resolveFootnoteTarget(anchor, doc);
		if (!target) {
			return null;
		}
		if (!this.isFootnoteAnchor(anchor) && !this.isLikelyFootnoteTarget(target)) {
			return null;
		}

		const rawText = this.extractTextFromTarget(target);
		const normalized = rawText.replace(/\s+/g, " ").trim();
		if (!normalized) {
			return null;
		}

		if (normalized.length <= MAX_TEXT_LENGTH) {
			return normalized;
		}
		return `${normalized.slice(0, MAX_TEXT_LENGTH - 1)}…`;
	}

	private resolveFootnoteTarget(anchor: HTMLAnchorElement, doc: Document): Element | null {
		const rawHref = anchor.getAttribute("href");
		if (!rawHref || !rawHref.includes("#")) {
			return null;
		}

		const hashIndex = rawHref.indexOf("#");
		const rawFragment = hashIndex >= 0 ? rawHref.slice(hashIndex + 1) : "";
		if (!rawFragment) {
			return null;
		}

		const fragmentId = this.decodeFragment(rawFragment);
		if (!fragmentId) {
			return null;
		}

		const byId = doc.getElementById(fragmentId);
		if (byId) {
			return byId;
		}

		const byName = doc.getElementsByName(fragmentId);
		return byName.item(0);
	}

	private isLikelyFootnoteTarget(target: Element): boolean {
		const role = target.getAttribute("role") ?? "";
		if (this.hasToken(role, "doc-footnote") || this.hasToken(role, "doc-endnote")) {
			return true;
		}

		const epubType =
			target.getAttribute("epub:type") ??
			target.getAttributeNS("http://www.idpf.org/2007/ops", "type") ??
			"";
		if (
			this.hasToken(epubType, "footnote") ||
			this.hasToken(epubType, "endnote") ||
			this.hasToken(epubType, "note")
		) {
			return true;
		}

		const id = target.getAttribute("id") ?? "";
		const className = target.getAttribute("class") ?? "";
		if (this.hasFootnoteKeyword(id) || this.hasFootnoteKeyword(className)) {
			return true;
		}

		return target.closest("aside, li") !== null;
	}

	private hasFootnoteKeyword(value: string): boolean {
		return /(footnote|endnote|note|fn|nref)/i.test(value);
	}

	private extractTextFromTarget(target: Element): string {
		const parentBlock = target.closest("p, li, dd, div, aside, td");
		const ownText = target.textContent ?? "";
		const ownNormalized = this.normalizeText(ownText);
		const parentText = parentBlock?.textContent ?? "";
		const parentNormalized = this.normalizeText(parentText);

		// Footnote entries often put an id on <a> and actual text in the parent paragraph.
		// In that case, prioritize the parent block so popup contains the full note text.
		if (parentNormalized.length > 0) {
			const isAnchorTarget = target.tagName.toLowerCase() === "a";
			const isShortOwnText = ownNormalized.length > 0 && ownNormalized.length <= 8;
			if (
				isAnchorTarget ||
				isShortOwnText ||
				this.isFootnoteMarkerText(ownNormalized) ||
				parentNormalized.length > ownNormalized.length + 8
			) {
				return parentText;
			}
		}

		if (ownNormalized.length > 0) {
			return ownText;
		}

		if (parentBlock) {
			return parentText;
		}

		const nextBlock = target.nextElementSibling;
		if (nextBlock) {
			return nextBlock.textContent ?? "";
		}

		return "";
	}

	private normalizeText(value: string): string {
		return value.replace(/\s+/g, " ").trim();
	}

	private isSuperscriptLikeAnchor(anchor: HTMLAnchorElement): boolean {
		return (
			anchor.closest("sup") !== null ||
			anchor.closest(".super, .sup, .superscript, [class*='super']") !== null
		);
	}

	private isFootnoteMarkerText(text: string): boolean {
		const normalized = text.replace(/\s+/g, "").trim();
		if (!normalized) {
			return false;
		}

		if (/^[\d†‡*]+$/.test(normalized)) {
			return true;
		}
		return /^\[\d+\]$/.test(normalized);
	}

	private decodeFragment(fragment: string): string {
		try {
			return decodeURIComponent(fragment).trim();
		} catch {
			return fragment.trim();
		}
	}

	private applyTheme(popoverEl: HTMLElement, theme: ResolvedReaderAppearanceTheme): void {
		if (theme === "dark") {
			this.setCssProps(popoverEl, {
				"background-color": "#1b2430",
				color: "#dce6f3",
				"border-color": "#324458",
			});
			return;
		}
		if (theme === "sepia") {
			this.setCssProps(popoverEl, {
				"background-color": "#f0e4cb",
				color: "#4f3f31",
				"border-color": "#b39d76",
			});
			return;
		}

		this.setCssProps(popoverEl, {
			"background-color": "#ffffff",
			color: "#1f2937",
			"border-color": "#d7dce5",
		});
	}

	private setCssProps(element: HTMLElement, props: Record<string, string>): void {
		const maybeSetCssProps = (element as HTMLElement & { setCssProps?: (nextProps: Record<string, string>) => void })
			.setCssProps;
		if (typeof maybeSetCssProps === "function") {
			maybeSetCssProps.call(element, props);
			return;
		}

		for (const [key, value] of Object.entries(props)) {
			element.style.setProperty(key, value);
		}
	}

	private isTouchEvent(event: Event): event is TouchEvent {
		return "touches" in event;
	}

	private isMousePointerEvent(event: Event): boolean {
		const pointerEventLike = event as { pointerType?: unknown };
		return pointerEventLike.pointerType === "mouse";
	}
}
