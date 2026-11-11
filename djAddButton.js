// NAME: DJ Add Button
// AUTHOR: Brian-Simmons1
// DESCRIPTION: Restores the "Save to Liked Songs / Add to Playlist" button in the playbar when Spotify hides it (e.g. during AI DJ sessions).
// VERSION: 1.1.0

(async function djAddButton() {
	"use strict";

	// ---- Wait for the Spicetify APIs we depend on -------------------------------------------
	const ready = () =>
		Spicetify?.Player?.data !== undefined &&
		Spicetify?.Platform?.LibraryAPI &&
		Spicetify?.SVGIcons &&
		Spicetify?.showNotification &&
		Spicetify?.PopupModal;

	while (!ready()) {
		await new Promise((r) => setTimeout(r, 300));
	}

	// ---- Constants ----------------------------------------------------------------------------
	const TAG = "[djAddButton]";
	const MARKER = "data-dj-add-button"; // marks our element so native detection ignores it
	const DJ_CONTEXT_URI = "spotify:playlist:37i9dQZF1EYkqdzj48dyYq";

	// Spotify 1.2.x used `.main-nowPlayingWidget-nowPlaying`; 1.3.x uses `now-playing-widget-v2`.
	// Spicetify's own Playbar.Widget only knows the old class, so we insert our button ourselves.
	const WIDGET_SELECTOR = '[data-testid="now-playing-widget-v2"], .main-nowPlayingWidget-nowPlaying';
	const TRACK_INFO_SELECTOR = ".main-nowPlayingWidget-trackInfo";
	// Buttons in the widget that are never the native add/like button.
	const NON_NATIVE_SELECTOR = '[data-testid="cover-art-button"], .main-nowPlayingWidget-coverArtContainer';

	const ICON_UNSAVED = "plus-alt";
	const ICON_SAVED = "check-alt-fill";
	const LABEL_UNSAVED = "Save to Liked Songs (right-click: add to playlist)";
	const LABEL_SAVED = "Remove from Liked Songs (right-click: add to playlist)";

	// ---- State --------------------------------------------------------------------------------
	let visible = false;
	let currentUri = null;
	let saved = false;
	let evalToken = 0; // guards against stale async results after a track change
	let observedNode = null;
	let observer = null;
	let debounceTimer = null;

	// ---- Styles -------------------------------------------------------------------------------
	const style = document.createElement("style");
	style.textContent = `
		.dj-add-button {
			display: inline-flex; align-items: center; justify-content: center;
			flex-shrink: 0; width: 32px; height: 32px; min-width: 32px;
			margin-inline-start: 8px; padding: 0; border: 0; border-radius: 50%;
			background: transparent; cursor: pointer;
			color: var(--spice-subtext, #b3b3b3);
		}
		.dj-add-button:hover { color: var(--spice-text, #fff); transform: scale(1.04); }
		.dj-add-button.is-saved, .dj-add-button.is-saved:hover { color: var(--spice-button-active, #1ed760); }
		.dj-add-button svg { width: 16px; height: 16px; }
	`;
	document.head.append(style);

	// ---- Button -------------------------------------------------------------------------------
	const button = document.createElement("button");
	button.type = "button";
	button.className = "dj-add-button";
	button.setAttribute(MARKER, "");
	button.addEventListener("click", onLeftClick);
	button.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (currentUri) openPlaylistPicker(currentUri);
	});
	const tippy = Spicetify.Tippy?.(button, { content: LABEL_UNSAVED, ...Spicetify.TippyProps });

	function setIcon(name) {
		button.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${Spicetify.SVGIcons[name]}</svg>`;
	}

	function setLabel(text) {
		button.setAttribute("aria-label", text);
		tippy ? tippy.setContent(text) : button.setAttribute("title", text);
	}

	function renderSaved(isSaved) {
		saved = isSaved;
		setIcon(isSaved ? ICON_SAVED : ICON_UNSAVED);
		setLabel(isSaved ? LABEL_SAVED : LABEL_UNSAVED);
		button.classList.toggle("is-saved", isSaved);
		button.setAttribute("aria-checked", String(isSaved));
	}
	renderSaved(false);

	/** Put the button right after the track title/artist, re-inserting if Spotify re-rendered. */
	function mountButton(widget) {
		if (!widget) return;
		const info = widget.querySelector(TRACK_INFO_SELECTOR);
		if (info) {
			if (info.nextElementSibling !== button) info.after(button);
		} else if (button.parentElement !== widget) {
			widget.append(button);
		}
	}

	function setVisible(show, widget) {
		if (show) mountButton(widget);
		if (show === visible) return;
		visible = show;
		if (!show) button.remove();
	}

	// ---- Detection helpers --------------------------------------------------------------------
	function getWidget() {
		return document.querySelector(WIDGET_SELECTOR);
	}

	function getTrackUri() {
		const uri = Spicetify.Player.data?.item?.uri;
		return typeof uri === "string" && uri.startsWith("spotify:track:") ? uri : null;
	}

	function isDjContext() {
		return Spicetify.Player.data?.context?.uri === DJ_CONTEXT_URI;
	}

	function isShown(el) {
		if (!el.isConnected || el.getClientRects().length === 0) return false;
		const s = getComputedStyle(el);
		return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
	}

	/**
	 * Any visible button in the now-playing widget other than the cover art (and ours) is
	 * treated as the native add/like button. Spotify renames its classes often, so we don't
	 * depend on a specific selector.
	 */
	function nativeButtonVisible(widget) {
		for (const el of widget.querySelectorAll("button")) {
			if (el === button || el.closest(`[${MARKER}]`) || el.matches(NON_NATIVE_SELECTOR)) continue;
			if (el.closest(TRACK_INFO_SELECTOR)) continue; // links/buttons inside the title area
			if (isShown(el)) return true;
		}
		return false;
	}

	async function isTrackSaved(uri) {
		try {
			const result = await Spicetify.Platform.LibraryAPI.contains(uri);
			return Array.isArray(result) ? !!result[0] : !!result;
		} catch (err) {
			console.warn(TAG, "LibraryAPI.contains failed, falling back to getHeart()", err);
			return !!Spicetify.Player.getHeart?.();
		}
	}

	// ---- Core evaluation ----------------------------------------------------------------------
	async function evaluate() {
		const token = ++evalToken;
		const widget = getWidget();
		ensureObserver(widget);

		const uri = getTrackUri();
		currentUri = uri;

		// Not a music track (DJ voice, ad, podcast, nothing playing) -> hide.
		if (!uri || !widget) {
			if (!widget && uri && isDjContext()) console.warn(TAG, "Now-playing widget not found; Spotify markup may have changed.");
			return setVisible(false);
		}

		if (nativeButtonVisible(widget)) return setVisible(false);

		const isSaved = await isTrackSaved(uri);
		if (token !== evalToken) return; // a newer evaluation superseded this one
		renderSaved(isSaved);
		setVisible(true, getWidget());
	}

	function scheduleEvaluate() {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(evaluate, 150);
	}

	// ---- DOM observation ----------------------------------------------------------------------
	function ensureObserver(widget) {
		if (!widget || widget === observedNode) return;
		observer?.disconnect();
		observedNode = widget;
		observer = new MutationObserver((mutations) => {
			const relevant = mutations.some((m) => {
				if (m.target === button || button.contains(m.target)) return false;
				const nodes = [...m.addedNodes, ...m.removedNodes];
				if (m.type === "childList" && nodes.length && nodes.every((n) => n === button)) return false;
				return true;
			});
			if (relevant) scheduleEvaluate();
		});
		observer.observe(widget, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["class", "style", "hidden", "aria-hidden"],
		});
	}

	// Spotify sometimes replaces the whole now-playing widget; re-attach and re-mount when it does.
	setInterval(() => {
		const widget = getWidget();
		if (widget !== observedNode || (visible && !button.isConnected)) scheduleEvaluate();
	}, 1000);

	// ---- Actions ------------------------------------------------------------------------------
	async function onLeftClick() {
		const uri = currentUri;
		if (!uri) return;
		const wasSaved = saved;
		renderSaved(!wasSaved); // optimistic

		// No success toast: LibraryAPI.add/remove already trigger Spotify's own
		// "Added to / Removed from Liked Songs" notification.
		try {
			const library = Spicetify.Platform.LibraryAPI;
			if (wasSaved) await library.remove({ uris: [uri] });
			else await library.add({ uris: [uri] });
		} catch (err) {
			console.error(TAG, "Failed to update Liked Songs", err);
			if (uri === currentUri) renderSaved(wasSaved);
			Spicetify.showNotification("Couldn't update Liked Songs", true);
		}
	}

	async function getEditablePlaylists() {
		const root = await Spicetify.Platform.RootlistAPI.getContents();
		const all = [];
		const walk = (items) => {
			for (const item of items || []) {
				if (item.type === "folder") walk(item.items);
				else if (item.type === "playlist") all.push(item);
			}
		};
		walk(root?.items);
		const editable = all.filter((p) => (typeof p.canAdd === "boolean" ? p.canAdd : p.isOwnedBySelf || p.isCollaborative));
		// If Spotify renamed the ownership fields, show everything rather than nothing.
		return editable.length ? editable : all;
	}

	async function addToPlaylist(playlistUri, trackUri) {
		try {
			await Spicetify.Platform.PlaylistAPI.add(playlistUri, [trackUri], { after: "end" });
		} catch (err) {
			console.warn(TAG, "PlaylistAPI.add failed, trying CosmosAsync", err);
			await Spicetify.CosmosAsync.post(`sp://core-playlist/v1/playlist/${playlistUri}`, {
				operation: "add",
				uris: [trackUri],
				after: "end",
			});
		}
	}

	async function openPlaylistPicker(trackUri) {
		let playlists;
		try {
			playlists = await getEditablePlaylists();
		} catch (err) {
			console.error(TAG, "Couldn't load playlists", err);
			Spicetify.showNotification("Couldn't load your playlists", true);
			return;
		}

		const container = document.createElement("div");
		container.style.cssText = "display:flex;flex-direction:column;gap:8px;";

		const filter = document.createElement("input");
		filter.type = "search";
		filter.placeholder = "Filter playlists";
		filter.style.cssText =
			"padding:8px 12px;border-radius:4px;border:1px solid var(--spice-button-disabled,#535353);" +
			"background:var(--spice-main-elevated,#242424);color:var(--spice-text,#fff);";
		container.append(filter);

		const list = document.createElement("div");
		list.style.cssText = "display:flex;flex-direction:column;max-height:50vh;overflow-y:auto;";
		container.append(list);

		const rows = playlists.map((p) => {
			const row = document.createElement("button");
			row.type = "button";
			row.textContent = p.name || p.uri;
			row.style.cssText =
				"text-align:left;padding:10px 12px;border:0;border-radius:4px;cursor:pointer;" +
				"background:transparent;color:var(--spice-text,#fff);font-size:14px;";
			row.addEventListener("mouseenter", () => (row.style.background = "var(--spice-highlight,#2a2a2a)"));
			row.addEventListener("mouseleave", () => (row.style.background = "transparent"));
			row.addEventListener("click", async () => {
				Spicetify.PopupModal.hide();
				try {
					await addToPlaylist(p.uri, trackUri);
					Spicetify.showNotification(`Added to ${p.name}`);
				} catch (err) {
					console.error(TAG, "Failed to add to playlist", err);
					Spicetify.showNotification(`Couldn't add to ${p.name}`, true);
				}
			});
			list.append(row);
			return { row, name: (p.name || "").toLowerCase() };
		});

		if (!rows.length) list.textContent = "No playlists found.";

		filter.addEventListener("input", () => {
			const q = filter.value.trim().toLowerCase();
			for (const { row, name } of rows) row.style.display = name.includes(q) ? "" : "none";
		});

		Spicetify.PopupModal.display({ title: "Add to playlist", content: container });
		setTimeout(() => filter.focus(), 50);
	}

	// ---- Wire up ------------------------------------------------------------------------------
	Spicetify.Player.addEventListener("songchange", scheduleEvaluate);

	// Keep the icon in sync when the track is liked/unliked elsewhere in the app.
	try {
		Spicetify.Platform.LibraryAPI.getEvents?.()?.addListener?.("operation_complete", () => {
			if (visible) scheduleEvaluate();
		});
	} catch (err) {
		console.warn(TAG, "LibraryAPI events unavailable", err);
	}

	evaluate();
})();
