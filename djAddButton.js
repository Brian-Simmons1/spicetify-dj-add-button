// NAME: DJ Add Button
// AUTHOR: Brian-Simmons1
// DESCRIPTION: Restores the "Save to Liked Songs / Add to Playlist" button in the playbar when Spotify hides it (e.g. during AI DJ sessions).
// VERSION: 1.0.0

(async function djAddButton() {
	"use strict";

	// ---- Wait for the Spicetify APIs we depend on -------------------------------------------
	const ready = () =>
		Spicetify?.Player?.data !== undefined &&
		Spicetify?.Platform?.LibraryAPI &&
		Spicetify?.Playbar?.Widget &&
		Spicetify?.showNotification &&
		Spicetify?.PopupModal;

	while (!ready()) {
		await new Promise((r) => setTimeout(r, 300));
	}

	// ---- Constants ----------------------------------------------------------------------------
	const TAG = "[djAddButton]";
	const MARKER = "data-dj-add-button"; // marks our element so native detection ignores it
	const DJ_CONTEXT_URI = "spotify:playlist:37i9dQZF1EYkqdzj48dyYq";
	const WIDGET_SELECTOR = ".main-nowPlayingWidget-nowPlaying";

	// Spotify has shipped the native "+" / heart under several markups; match any of them.
	const NATIVE_BUTTON_SELECTORS = [
		'[data-testid="add-button"]',
		"button.main-addButton-button",
		"button.control-button-heart",
		'button[data-encore-id="buttonTertiary"][aria-checked]',
	].join(",");

	const ICON_UNSAVED = "plus-alt";
	const ICON_SAVED = "check-alt-fill";
	const LABEL_UNSAVED = "Save to Liked Songs (right-click: add to playlist)";
	const LABEL_SAVED = "Remove from Liked Songs (right-click: add to playlist)";

	// ---- State --------------------------------------------------------------------------------
	let registered = false;
	let currentUri = null;
	let saved = false;
	let evalToken = 0; // guards against stale async results after a track change
	let observedNode = null;
	let observer = null;
	let debounceTimer = null;

	// ---- Button -------------------------------------------------------------------------------
	const button = new Spicetify.Playbar.Widget(LABEL_UNSAVED, ICON_UNSAVED, onLeftClick, false, false, false);
	button.element.setAttribute(MARKER, "");
	button.element.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (currentUri) openPlaylistPicker(currentUri);
	});

	function setVisible(visible) {
		if (visible === registered) return;
		registered = visible;
		visible ? button.register() : button.deregister();
	}

	function renderSaved(isSaved) {
		saved = isSaved;
		button.icon = isSaved ? ICON_SAVED : ICON_UNSAVED;
		button.label = isSaved ? LABEL_SAVED : LABEL_UNSAVED;
		button.active = isSaved;
	}

	// ---- Detection helpers --------------------------------------------------------------------
	function getTrackUri() {
		const uri = Spicetify.Player.data?.item?.uri;
		return typeof uri === "string" && uri.startsWith("spotify:track:") ? uri : null;
	}

	function isDjContext() {
		return Spicetify.Player.data?.context?.uri === DJ_CONTEXT_URI;
	}

	function isShown(el) {
		if (!el.isConnected || el.getClientRects().length === 0) return false;
		const style = getComputedStyle(el);
		return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
	}

	/** true / false when the playbar widget is in the DOM; null when we cannot tell. */
	function nativeButtonVisible() {
		const widget = document.querySelector(WIDGET_SELECTOR);
		if (!widget) return null;
		for (const el of widget.querySelectorAll(NATIVE_BUTTON_SELECTORS)) {
			if (el.hasAttribute(MARKER) || el.closest(`[${MARKER}]`)) continue;
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
		ensureObserver();

		const uri = getTrackUri();
		currentUri = uri;

		// Not a music track (DJ voice, ad, podcast, nothing playing) -> hide.
		if (!uri) return setVisible(false);

		const native = nativeButtonVisible();
		// If the widget isn't in the DOM yet, only show for known DJ sessions.
		const needed = native === null ? isDjContext() : !native;
		if (!needed) return setVisible(false);

		const isSaved = await isTrackSaved(uri);
		if (token !== evalToken) return; // a newer evaluation superseded this one
		renderSaved(isSaved);
		setVisible(true);
	}

	function scheduleEvaluate() {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(evaluate, 150);
	}

	// ---- DOM observation ----------------------------------------------------------------------
	function ensureObserver() {
		const widget = document.querySelector(WIDGET_SELECTOR);
		if (!widget || widget === observedNode) return;
		observer?.disconnect();
		observedNode = widget;
		observer = new MutationObserver((mutations) => {
			// Ignore mutations caused purely by our own button being (de)registered.
			const relevant = mutations.some((m) => {
				const nodes = [...m.addedNodes, ...m.removedNodes];
				if (m.type === "childList" && nodes.length && nodes.every((n) => n === button.element)) return false;
				if (m.type === "attributes" && m.target instanceof Element && m.target.closest(`[${MARKER}]`)) return false;
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

	// Spotify sometimes re-renders the whole now-playing widget; re-attach when that happens.
	setInterval(() => {
		if (!observedNode || !observedNode.isConnected) {
			observedNode = null;
			scheduleEvaluate();
		}
	}, 2000);

	// ---- Actions ------------------------------------------------------------------------------
	async function onLeftClick() {
		const uri = currentUri;
		if (!uri) return;
		const wasSaved = saved;
		renderSaved(!wasSaved); // optimistic

		try {
			const library = Spicetify.Platform.LibraryAPI;
			if (wasSaved) {
				await library.remove({ uris: [uri] });
				Spicetify.showNotification("Removed from Liked Songs");
			} else {
				await library.add({ uris: [uri] });
				Spicetify.showNotification("Added to Liked Songs");
			}
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
		const editable = all.filter((p) => p.isOwnedBySelf || p.isCollaborative || p.canAdd);
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
			if (registered) scheduleEvaluate();
		});
	} catch (err) {
		console.warn(TAG, "LibraryAPI events unavailable", err);
	}

	evaluate();
})();
