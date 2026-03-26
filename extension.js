// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME Speaks — TTS/STT floating badge for GNOME Shell
// Copyright (C) 2025 JP Hein
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const DBUS_NAME = 'org.gnome.Speaks';
const DBUS_PATH = '/org/gnome/Speaks';
const DBUS_INTERFACE = 'org.gnome.Speaks';

const DBUS_XML = `
<node>
  <interface name="org.gnome.Speaks">
    <method name="StartListening">
      <arg direction="out" type="s" name="result"/>
    </method>
    <method name="StopListening">
      <arg direction="out" type="s" name="transcription"/>
    </method>
    <method name="Speak">
      <arg direction="in" type="s" name="text"/>
      <arg direction="out" type="b" name="success"/>
    </method>
    <method name="SpeakClipboard">
      <arg direction="out" type="b" name="success"/>
    </method>
    <method name="SpeakSelection">
      <arg direction="out" type="b" name="success"/>
    </method>
    <method name="SetLanguage">
      <arg direction="in" type="s" name="language"/>
      <arg direction="out" type="b" name="success"/>
    </method>
    <method name="GetLanguage">
      <arg direction="out" type="s" name="language"/>
    </method>
    <method name="ToggleConversationMode">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="ToggleContinuousDictation">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="ToggleVoiceQuality">
      <arg direction="out" type="s" name="quality"/>
    </method>
    <method name="GetVoiceQuality">
      <arg direction="out" type="s" name="quality"/>
    </method>
    <method name="Talk">
      <arg direction="in" type="s" name="text"/>
      <arg direction="out" type="s" name="reply"/>
    </method>
    <method name="GetContinuousDictation">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="GetConversationMode">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="ToggleTerminalMode">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="GetTerminalMode">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="GetAudioInfo">
      <arg direction="out" type="s" name="info"/>
    </method>
    <method name="SetSTTMode">
      <arg direction="in" type="s" name="mode"/>
      <arg direction="out" type="b" name="success"/>
    </method>
    <method name="GetSTTMode">
      <arg direction="out" type="s" name="mode"/>
    </method>
    <method name="GetSTTModes">
      <arg direction="out" type="s" name="modes"/>
    </method>
    <method name="Stop">
      <arg direction="out" type="b" name="success"/>
    </method>
    <method name="GetState">
      <arg direction="out" type="s" name="state"/>
    </method>
    <signal name="StateChanged">
      <arg type="s" name="state"/>
    </signal>
    <signal name="TranscriptionReady">
      <arg type="s" name="text"/>
    </signal>
    <signal name="PartialTranscription">
      <arg type="s" name="text"/>
    </signal>
    <signal name="SubtitleUpdate">
      <arg type="s" name="text"/>
      <arg type="d" name="duration"/>
      <arg type="i" name="percent"/>
    </signal>
    <signal name="AudioLevel">
      <arg type="d" name="level"/>
    </signal>
    <signal name="Error">
      <arg type="s" name="message"/>
    </signal>
  </interface>
</node>`;

const GnomeSpeaksProxy = Gio.DBusProxy.makeProxyWrapper(DBUS_XML);

const States = {
    IDLE: 'idle',
    LISTENING: 'listening',
    PROCESSING: 'processing',
    SPEAKING: 'speaking',
};

const STATE_CONFIG = {
    [States.IDLE]: {
        iconName: 'audio-input-microphone-symbolic',
        label: '',
        styleClass: 'gnome-speaks-idle',
        showLabel: false,
    },
    [States.LISTENING]: {
        iconName: 'audio-input-microphone-symbolic',
        label: 'Listening...',
        styleClass: 'gnome-speaks-listening',
        showLabel: true,
    },
    [States.PROCESSING]: {
        iconName: 'process-working-symbolic',
        label: 'Processing...',
        styleClass: 'gnome-speaks-processing',
        showLabel: true,
    },
    [States.SPEAKING]: {
        iconName: 'audio-speakers-symbolic',
        label: 'Speaking...',
        styleClass: 'gnome-speaks-speaking',
        showLabel: true,
    },
};

export default class GnomeSpeaksExtension extends Extension {
    enable() {
        try {
            this._enable();
        } catch (e) {
            log(`[GNOME Speaks] enable() failed: ${e.message}\n${e.stack}`);
        }
    }

    _enable() {
        this._destroyed = false;
        this._state = States.IDLE;
        this._proxy = null;
        this._proxyReady = false;
        this._proxyPending = false;
        this._proxySignals = [];
        this._signals = [];
        this._timeouts = [];
        this._pulseTransition = null;
        this._isDragging = false;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._dragBadgeStartX = 0;
        this._dragBadgeStartY = 0;
        this._badgeVisible = true;
        this._audioLevel = 0;
        this._lastAudioLevelTime = 0;
        this._lastPartialTime = 0;
        this._lastPartialText = null;
        this._lastRenderedPartial = null;
        this._pendingPartialText = null;
        this._partialDebounceId = null;
        this._lastSubtitleUpdateTime = 0;
        this._pendingSubtitleReveal = null;
        this._subtitleDebounceId = null;
        this._subtitleText = '';
        this._subtitleVisible = false;
        this._settings = this.getSettings();

        // Restore persisted badge position
        let savedX = this._settings.get_int('badge-position-x');
        let savedY = this._settings.get_int('badge-position-y');
        this._customPosition = (savedX >= 0 && savedY >= 0)
            ? {x: savedX, y: savedY} : null;

        this._createBadge();
        this._createSubtitleOverlay();
        this._createPanelIndicator();
        this._positionBadge();
        this._connectLayoutSignals();
        this._registerKeybindings();
        this._initProxy();
        this._connectNotificationReader();

        // Watch for service restarts — re-sync state when the bus name reappears
        this._busWatchId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            DBUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => {
                if (this._destroyed) return;
                // Name appeared (service started or restarted)
                if (this._proxyReady)
                    this._syncState();
                else if (!this._proxyPending)
                    this._initProxy();
            },
            () => {
                if (this._destroyed) return;
                // Name vanished (service stopped) — reset badge to idle
                this._setState(States.IDLE);
            },
        );
    }

    disable() {
        try {
            this._disable();
        } catch (e) {
            log(`[GNOME Speaks] disable() failed: ${e.message}\n${e.stack}`);
        }
    }

    _disable() {
        this._destroyed = true;

        if (this._busWatchId) {
            Gio.bus_unwatch_name(this._busWatchId);
            this._busWatchId = 0;
        }

        this._endDrag();
        this._partialDebounceId = null;
        this._subtitleDebounceId = null;
        this._cancelAllTimeouts();
        this._stopPulse();
        this._disconnectNotificationReader();
        this._removeKeybindings();
        this._disconnectLayoutSignals();

        // Destroy UI actors BEFORE disconnecting proxy — actor destruction
        // can trigger GC, and we need the proxy reference alive so GC
        // doesn't try to finalize GjsDBusImplementation during the sweep.
        this._destroySubtitleOverlay();
        this._destroyPanelIndicator();
        this._destroyBadge();
        this._disconnectProxy();

        this._state = null;
        this._proxyReady = false;
        this._settings = null;
    }

    // -- Keyboard shortcuts ------------------------------------------------

    _registerKeybindings() {
        Main.wm.addKeybinding(
            'toggle-listening-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                if (this._state === States.LISTENING)
                    this._callMethod('StopListening');
                else if (this._state === States.IDLE)
                    this._callMethod('StartListening');
            }
        );

        Main.wm.addKeybinding(
            'speak-clipboard-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._callMethod('SpeakClipboard')
        );

        Main.wm.addKeybinding(
            'read-selection-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._callMethod('SpeakSelection')
        );

        Main.wm.addKeybinding(
            'toggle-voice-quality-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggleVoiceQuality()
        );
    }

    _removeKeybindings() {
        Main.wm.removeKeybinding('toggle-listening-shortcut');
        Main.wm.removeKeybinding('speak-clipboard-shortcut');
        Main.wm.removeKeybinding('read-selection-shortcut');
        Main.wm.removeKeybinding('toggle-voice-quality-shortcut');
    }

    // -- Notification reader -----------------------------------------------

    _connectNotificationReader() {
        this._notifSignals = [];

        this._notifSourceAddedId = Main.messageTray.connect('source-added', (tray, source) => {
            if (this._destroyed) return;
            try {
                let notifAddedId = source.connect('notification-added', (src, notification) => {
                    if (this._destroyed) return;
                    this._onNotification(notification);
                });
                this._notifSignals.push({obj: source, id: notifAddedId});
            } catch (e) {
                // Source may already be disposed during shell init/restart
            }
        });

        // Proactively drop references when sources are removed, before GC disposes them
        this._notifSourceRemovedId = Main.messageTray.connect('source-removed', (tray, source) => {
            if (!this._notifSignals) return;
            this._notifSignals = this._notifSignals.filter(sig => {
                if (sig.obj === source) {
                    try { source.disconnect(sig.id); } catch (e) { /* ok */ }
                    return false;
                }
                return true;
            });
        });
    }

    _disconnectNotificationReader() {
        if (this._notifSourceAddedId) {
            Main.messageTray.disconnect(this._notifSourceAddedId);
            this._notifSourceAddedId = null;
        }
        if (this._notifSourceRemovedId) {
            Main.messageTray.disconnect(this._notifSourceRemovedId);
            this._notifSourceRemovedId = null;
        }
        if (this._notifSignals) {
            for (let sig of this._notifSignals) {
                try { sig.obj.disconnect(sig.id); } catch (e) { /* disposed, ok */ }
            }
            this._notifSignals = null;
        }
    }

    _onNotification(notification) {
        // Only read notifications if enabled in config.
        // Cache the config to avoid blocking the compositor with disk I/O
        // on every notification. Refresh cache at most once per 10 seconds.
        let now = GLib.get_monotonic_time();
        if (!this._notifConfigCache || (now - this._notifConfigCacheTime) > 10000000) {
            let configPath = GLib.build_filenamev([
                GLib.get_home_dir(), '.config', 'speech-to-cli', 'config.json',
            ]);
            try {
                let [ok, contents] = GLib.file_get_contents(configPath);
                if (ok) {
                    let decoder = new TextDecoder('utf-8');
                    this._notifConfigCache = JSON.parse(decoder.decode(contents));
                } else {
                    this._notifConfigCache = {};
                }
            } catch (e) {
                this._notifConfigCache = {};
            }
            this._notifConfigCacheTime = now;
        }

        if (!this._notifConfigCache.read_notifications)
            return;

        let title = notification.title || '';
        let body = notification.body || '';
        let text = title;
        if (body)
            text += `. ${body}`;
        if (text && this._state === States.IDLE)
            this._callMethod('Speak', text);
    }

    _createBadge() {
        this._icon = new St.Icon({
            icon_name: STATE_CONFIG[States.IDLE].iconName,
            icon_size: 22,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        this._badge = new St.BoxLayout({
            style_class: 'gnome-speaks-badge gnome-speaks-idle',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            vertical: false,
        });

        this._badge.add_child(this._icon);
        this._badge.add_child(this._label);

        // Pills — hidden in idle, shown when active
        this._conversationMode = false;
        this._continuousMode = false;
        this._terminalMode = false;

        this._qualityPill = this._createPill('✦', 'gnome-speaks-quality-hd', () => this._toggleVoiceQuality());
        this._modePill = this._createPill('✏️', 'gnome-speaks-mode-dict', () => this._toggleMode());
        this._continuousPill = this._createPill('🔄', 'gnome-speaks-pill-off', () => this._toggleContinuous());
        this._terminalPill = this._createPill('>', 'gnome-speaks-pill-off', () => this._toggleTerminal());

        this._badge.add_child(this._qualityPill);
        this._badge.add_child(this._modePill);
        this._badge.add_child(this._continuousPill);
        this._badge.add_child(this._terminalPill);

        this._pills = [this._qualityPill, this._modePill, this._continuousPill, this._terminalPill];
        for (let pill of this._pills)
            pill.hide();

        this._badge.set_pivot_point(0.5, 0.5);

        let pressId = this._badge.connect('button-press-event', (actor, event) => {
            let button = event.get_button();
            if (button === 3) {
                this._showContextMenu(event);
                return Clutter.EVENT_STOP;
            }
            if (button === 1) {
                let [stageX, stageY] = event.get_coords();
                this._dragStartX = stageX;
                this._dragStartY = stageY;
                this._dragBadgeStartX = actor.x;
                this._dragBadgeStartY = actor.y;
                this._isDragging = false;
                this._dragButton = button;
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._signals.push({obj: this._badge, id: pressId});

        let motionId = this._badge.connect('motion-event', (actor, event) => {
            if (this._dragButton !== 1)
                return Clutter.EVENT_PROPAGATE;

            let [stageX, stageY] = event.get_coords();
            let dx = stageX - this._dragStartX;
            let dy = stageY - this._dragStartY;

            if (!this._isDragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
                this._isDragging = true;
                // Grab all input so drag continues even when cursor
                // leaves the badge bounds
                this._dragGrab = global.stage.grab(this._badge);
            }

            if (this._isDragging) {
                actor.set_position(
                    this._dragBadgeStartX + dx,
                    this._dragBadgeStartY + dy
                );
                this._customPosition = {x: actor.x, y: actor.y};
                if (this._settings) {
                    this._settings.set_int('badge-position-x', Math.round(actor.x));
                    this._settings.set_int('badge-position-y', Math.round(actor.y));
                }
            }
            return Clutter.EVENT_STOP;
        });
        this._signals.push({obj: this._badge, id: motionId});

        let releaseId = this._badge.connect('button-release-event', () => {
            // Always end drag state on any release — the grab routes
            // all events here, so we must unconditionally clean up
            let wasDragging = this._isDragging;
            this._endDrag();

            if (!wasDragging) {
                this._onBadgeClicked();
            }
            return Clutter.EVENT_STOP;
        });
        this._signals.push({obj: this._badge, id: releaseId});

        Main.layoutManager.addTopChrome(this._badge, {
            affectsInputRegion: true,
            trackFullscreen: false,
        });
    }

    _endDrag() {
        this._dragButton = 0;
        this._isDragging = false;
        if (this._dragGrab) {
            this._dragGrab.dismiss();
            this._dragGrab = null;
        }
    }

    _toggleVoiceQuality() {
        if (!this._proxy) {
            // Local toggle for testing without service
            this._voiceQuality = this._voiceQuality === 'hd' ? 'fast' : 'hd';
            this._updateQualityPill();
            return;
        }
        this._proxy.ToggleVoiceQualityRemote((result, error) => {
            if (this._destroyed || error) return;
            let quality = result[0];
            this._voiceQuality = quality;
            this._updateQualityPill();
            if (this._menuVoiceQualityItem)
                this._menuVoiceQualityItem.label.text = quality === 'hd'
                    ? 'Voice: HD' : 'Voice: Fast';
        });
    }

    _updateQualityPill() {
        if (!this._qualityPill) return;
        let isHD = this._voiceQuality === 'hd';
        this._qualityPill.text = isHD ? '✦ HD' : '⚡ Fast';
        this._qualityPill.remove_style_class_name(
            isHD ? 'gnome-speaks-quality-fast' : 'gnome-speaks-quality-hd');
        this._qualityPill.add_style_class_name(
            isHD ? 'gnome-speaks-quality-hd' : 'gnome-speaks-quality-fast');
    }

    _toggleMode() {
        if (!this._proxy) {
            // Local toggle for testing without service
            this._conversationMode = !this._conversationMode;
            this._updateModePill();
            return;
        }
        this._proxy.ToggleConversationModeRemote((result, error) => {
            if (this._destroyed || error) return;
            let enabled = result[0];
            this._conversationMode = enabled;
            this._updateModePill();
            // Sync the panel menu toggle (without re-triggering its callback)
            if (this._menuConversationToggle)
                this._menuConversationToggle.setToggleState(enabled);
        });
    }

    _createPill(text, styleClass, onClick) {
        let pill = new St.Label({
            text: text,
            style_class: styleClass,
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        pill.connect('button-release-event', (actor, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            onClick();
            return Clutter.EVENT_STOP;
        });
        pill.connect('button-press-event', () => Clutter.EVENT_STOP);
        return pill;
    }

    _toggleContinuous() {
        if (!this._proxy) {
            this._continuousMode = !this._continuousMode;
            this._updateContinuousPill();
            return;
        }
        this._proxy.ToggleContinuousDictationRemote((result, error) => {
            if (this._destroyed || error) return;
            this._continuousMode = result[0];
            this._updateContinuousPill();
            if (this._menuContinuousToggle)
                this._menuContinuousToggle.setToggleState(this._continuousMode);
        });
    }

    _updateContinuousPill() {
        if (!this._continuousPill) return;
        let on = this._continuousMode;
        this._continuousPill.text = on ? '🔄 Loop' : '🔄';
        this._continuousPill.remove_style_class_name(on ? 'gnome-speaks-pill-off' : 'gnome-speaks-pill-on');
        this._continuousPill.add_style_class_name(on ? 'gnome-speaks-pill-on' : 'gnome-speaks-pill-off');
    }

    _toggleTerminal() {
        if (!this._proxy) {
            this._terminalMode = !this._terminalMode;
            this._updateTerminalPill();
            return;
        }
        this._proxy.ToggleTerminalModeRemote((result, error) => {
            if (this._destroyed || error) return;
            this._terminalMode = result[0];
            this._updateTerminalPill();
        });
    }

    _updateTerminalPill() {
        if (!this._terminalPill) return;
        let on = this._terminalMode;
        this._terminalPill.text = on ? '> Term' : '>';
        this._terminalPill.remove_style_class_name(on ? 'gnome-speaks-pill-off' : 'gnome-speaks-pill-on');
        this._terminalPill.add_style_class_name(on ? 'gnome-speaks-pill-on' : 'gnome-speaks-pill-off');
    }

    _showPills(visible) {
        if (!this._pills) return;
        for (let pill of this._pills) {
            if (visible)
                pill.show();
            else
                pill.hide();
        }
    }

    // -- Subtitle overlay --------------------------------------------------

    _createSubtitleOverlay() {
        this._subtitleOverlay = new St.BoxLayout({
            style_class: 'gnome-speaks-subtitle-overlay',
            vertical: true,
            reactive: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });

        this._subtitleLabel = new St.Label({
            style_class: 'gnome-speaks-subtitle-text',
            text: '',
            x_align: Clutter.ActorAlign.CENTER,
        });

        // Enable word wrap on the underlying ClutterText
        let clutterText = this._subtitleLabel.get_clutter_text();
        clutterText.set_line_wrap(true);
        clutterText.set_line_wrap_mode(0); // PANGO_WRAP_WORD
        clutterText.set_ellipsize(0); // PANGO_ELLIPSIZE_NONE

        this._subtitleOverlay.add_child(this._subtitleLabel);

        // Apply color variant from settings
        this._applySubtitleColor();

        // Start hidden
        this._subtitleOverlay.opacity = 0;
        this._subtitleOverlay.hide();
        this._subtitleVisible = false;

        Main.uiGroup.add_child(this._subtitleOverlay);

        this._positionSubtitleOverlay();

        // Listen for settings changes
        if (this._settings) {
            let colorChangedId = this._settings.connect('changed::subtitle-color', () => {
                this._applySubtitleColor();
            });
            this._signals.push({obj: this._settings, id: colorChangedId});
        }
    }

    _applySubtitleColor() {
        if (!this._subtitleOverlay || !this._settings)
            return;

        // Remove existing color classes
        let colors = ['cream', 'gold', 'green', 'amber', 'cyan'];
        for (let c of colors)
            this._subtitleOverlay.remove_style_class_name(`gnome-speaks-subtitle-${c}`);

        let color = this._settings.get_string('subtitle-color');
        if (color && color !== 'cream')
            this._subtitleOverlay.add_style_class_name(`gnome-speaks-subtitle-${color}`);
    }

    _positionSubtitleOverlay() {
        if (!this._subtitleOverlay)
            return;

        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        // Position centered horizontally, 100px from bottom
        let overlayWidth = Math.min(800, monitor.width - 80);
        let x = monitor.x + Math.round((monitor.width - overlayWidth) / 2);
        let y = monitor.y + monitor.height - 100 - 60; // 100px from bottom, ~60px for overlay height

        this._subtitleOverlay.set_position(x, y);
        this._subtitleOverlay.set_width(overlayWidth);
    }

    _showSubtitle(text, isPartial = false) {
        if (this._destroyed)
            return;

        // Respect live_subtitles setting
        if (this._settings && !this._settings.get_boolean('live-subtitles'))
            return;

        if (!this._subtitleOverlay || !this._subtitleLabel)
            return;

        // Smart text display: sliding window for very long text
        let displayText = text;
        if (displayText.length > 300) {
            // Show last ~200 chars, word-aligned
            let start = displayText.length - 200;
            let spaceIdx = displayText.indexOf(' ', start);
            if (spaceIdx > 0 && spaceIdx < start + 30)
                start = spaceIdx + 1;
            displayText = `...${displayText.substring(start)}`;
        }

        this._subtitleText = displayText;
        this._subtitleLabel.text = displayText;

        // Apply partial/final style
        this._subtitleOverlay.remove_style_class_name('gnome-speaks-subtitle-partial');
        this._subtitleOverlay.remove_style_class_name('gnome-speaks-subtitle-final');
        this._subtitleOverlay.add_style_class_name(
            isPartial ? 'gnome-speaks-subtitle-partial' : 'gnome-speaks-subtitle-final');

        // Reposition in case the monitor changed
        this._positionSubtitleOverlay();

        // Cancel any pending fade-out
        this._cancelTimeout('subtitle-fadeout');

        if (!this._subtitleVisible) {
            // Fade in
            this._subtitleOverlay.show();
            this._subtitleOverlay.remove_all_transitions();
            this._subtitleOverlay.ease({
                opacity: 255,
                duration: 300,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            this._subtitleVisible = true;
        }
    }

    _hideSubtitle(immediate = false) {
        if (!this._subtitleOverlay || !this._subtitleVisible)
            return;

        if (immediate) {
            this._subtitleOverlay.remove_all_transitions();
            this._subtitleOverlay.opacity = 0;
            this._subtitleOverlay.hide();
            this._subtitleVisible = false;
            this._subtitleText = '';
            return;
        }

        // Fade out over 500ms — no onComplete (GC safety)
        this._subtitleOverlay.remove_all_transitions();
        this._subtitleOverlay.ease({
            opacity: 0,
            duration: 500,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
        let fadeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 520, () => {
            this._cancelTimeout('subtitle-fade-finish');
            if (this._subtitleOverlay && !this._destroyed) {
                this._subtitleOverlay.hide();
                this._subtitleVisible = false;
                this._subtitleText = '';
            }
            return GLib.SOURCE_REMOVE;
        });
        this._trackTimeout(fadeId, 'subtitle-fade-finish');
    }

    _scheduleSubtitleFadeout(delayMs = 3000) {
        this._cancelTimeout('subtitle-fadeout');
        let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            if (!this._destroyed)
                this._hideSubtitle();
            this._removeTimeout('subtitle-fadeout');
            return GLib.SOURCE_REMOVE;
        });
        this._trackTimeout(timeoutId, 'subtitle-fadeout');
    }

    _destroySubtitleOverlay() {
        this._cancelTimeout('subtitle-fadeout');
        if (this._subtitleOverlay) {
            this._subtitleOverlay.remove_all_transitions();
            Main.uiGroup.remove_child(this._subtitleOverlay);
            this._subtitleOverlay.destroy();
            this._subtitleOverlay = null;
            this._subtitleLabel = null;
        }
        this._subtitleVisible = false;
        this._subtitleText = '';
    }

    _updateAudioInfoMenu(info) {
        if (!this._menuAudioInfoItem)
            return;
        let icon = info.device_type === 'headphones' ? '\u{1F3A7}' : '\u{1F50A}';
        let type = info.device_type === 'headphones' ? 'Headphones'
            : info.device_type === 'speakers' ? 'Speakers' : 'Unknown';
        let desc = info.description || '';
        let duplex = info.half_duplex ? 'half-duplex' : 'full-duplex';
        let ec = info.echo_cancel ? ', EC' : '';
        let label = `${icon} ${type}: ${duplex}${ec}`;
        if (desc)
            label = `${icon} ${desc} (${duplex}${ec})`;
        this._menuAudioInfoItem.label.text = label;
    }

    _updateModePill() {
        if (!this._modePill) return;
        let isChat = this._conversationMode;
        this._modePill.text = isChat ? '🤖 AI' : '✏️ Type';
        this._modePill.remove_style_class_name(
            isChat ? 'gnome-speaks-mode-dict' : 'gnome-speaks-mode-chat');
        this._modePill.add_style_class_name(
            isChat ? 'gnome-speaks-mode-chat' : 'gnome-speaks-mode-dict');

        // Update badge border tint for chat mode
        if (this._badge) {
            if (isChat)
                this._badge.add_style_class_name('gnome-speaks-chat-active');
            else
                this._badge.remove_style_class_name('gnome-speaks-chat-active');
        }
    }

    _destroyBadge() {
        for (let sig of this._signals) {
            try {
                sig.obj.disconnect(sig.id);
            } catch (e) {
                // Already disconnected
            }
        }
        this._signals = [];

        this._destroyContextMenu();

        if (this._badge) {
            this._badge.remove_all_transitions();
            Main.layoutManager.removeChrome(this._badge);
            this._badge.destroy();
            this._badge = null;
        }
        this._icon = null;
        this._label = null;
        this._qualityPill = null;
        this._modePill = null;
        this._continuousPill = null;
        this._terminalPill = null;
        this._pills = null;
    }

    _createPanelIndicator() {
        this._panelButton = new PanelMenu.Button(0.0, 'GNOME Speaks', false);

        this._panelIcon = new St.Icon({
            icon_name: 'audio-input-microphone-symbolic',
            style_class: 'system-status-icon gnome-speaks-panel-idle',
        });
        this._panelButton.add_child(this._panelIcon);

        // Build the dropdown menu
        this._buildPanelMenu();

        Main.panel.addToStatusArea('gnome-speaks', this._panelButton);
    }

    _buildPanelMenu() {
        let menu = this._panelButton.menu;

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Actions'));

        this._menuListenItem = new PopupMenu.PopupMenuItem('Start Listening');
        this._menuListenItem.connect('activate', () => {
            if (this._state === States.LISTENING)
                this._callMethod('StopListening');
            else if (this._state === States.IDLE)
                this._callMethod('StartListening');
        });
        menu.addMenuItem(this._menuListenItem);

        this._menuStopItem = new PopupMenu.PopupMenuItem('Stop');
        this._menuStopItem.connect('activate', () => {
            this._callMethod('Stop');
        });
        menu.addMenuItem(this._menuStopItem);

        let speakClipItem = new PopupMenu.PopupMenuItem('Speak Clipboard');
        speakClipItem.connect('activate', () => {
            this._callMethod('SpeakClipboard');
        });
        menu.addMenuItem(speakClipItem);

        let readSelItem = new PopupMenu.PopupMenuItem('Read Selection');
        readSelItem.connect('activate', () => {
            this._callMethod('SpeakSelection');
        });
        menu.addMenuItem(readSelItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Mode'));

        this._menuConversationToggle = new PopupMenu.PopupSwitchMenuItem('AI Conversation', false);
        this._menuConversationToggle.connect('toggled', (item, state) => {
            if (!this._proxy) return;
            this._proxy.ToggleConversationModeRemote((result, error) => {
                if (this._destroyed || error) return;
                let enabled = result[0];
                this._conversationMode = enabled;
                this._updateModePill();
                if (enabled !== state)
                    item.setToggleState(enabled);
            });
        });
        menu.addMenuItem(this._menuConversationToggle);

        this._menuContinuousToggle = new PopupMenu.PopupSwitchMenuItem('Continuous Dictation', false);
        this._menuContinuousToggle.connect('toggled', () => {
            this._callMethod('ToggleContinuousDictation');
        });
        menu.addMenuItem(this._menuContinuousToggle);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Voice & Audio'));

        this._voiceQuality = 'fast';
        this._menuVoiceQualityItem = new PopupMenu.PopupMenuItem('Voice: HD');
        this._menuVoiceQualityItem.connect('activate', () => this._toggleVoiceQuality());
        menu.addMenuItem(this._menuVoiceQualityItem);

        this._menuAudioInfoItem = new PopupMenu.PopupMenuItem('Audio: detecting...');
        this._menuAudioInfoItem.setSensitive(false);
        menu.addMenuItem(this._menuAudioInfoItem);

        this._langSubMenu = new PopupMenu.PopupSubMenuMenuItem('Language: en-US');
        let languages = ['en-US', 'en-GB', 'en-AU', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'ja-JP', 'ko-KR', 'zh-CN', 'pt-BR', 'ru-RU', 'ar-SA', 'hi-IN', 'nl-NL'];
        for (let lang of languages) {
            let item = new PopupMenu.PopupMenuItem(lang);
            item.connect('activate', () => {
                this._callMethod('SetLanguage', lang);
                this._langSubMenu.label.text = `Language: ${lang}`;
            });
            this._langSubMenu.menu.addMenuItem(item);
        }
        menu.addMenuItem(this._langSubMenu);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._menuBadgeToggle = new PopupMenu.PopupSwitchMenuItem('Show Badge', this._badgeVisible);
        this._menuBadgeToggle.connect('toggled', (item, state) => {
            this._badgeVisible = state;
            if (this._badge) {
                if (state) {
                    this._badge.show();
                    this._badge.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                } else {
                    this._badge.ease({
                        opacity: 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
                        if (!this._destroyed && this._badge) this._badge.hide();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }
        });
        menu.addMenuItem(this._menuBadgeToggle);

        let settingsItem = new PopupMenu.PopupMenuItem('Preferences...');
        settingsItem.connect('activate', () => {
            this.openPreferences();
        });
        menu.addMenuItem(settingsItem);

        let disableItem = new PopupMenu.PopupMenuItem('Disable Extension');
        disableItem.connect('activate', () => {
            Main.extensionManager.disableExtension(this.uuid);
        });
        menu.addMenuItem(disableItem);
    }

    _updatePanelMenu() {
        if (!this._menuListenItem)
            return;

        switch (this._state) {
        case States.IDLE:
            this._menuListenItem.label.text = 'Start Listening';
            this._menuListenItem.setSensitive(true);
            this._menuStopItem.setSensitive(false);
            break;
        case States.LISTENING:
            this._menuListenItem.label.text = 'Stop Listening';
            this._menuListenItem.setSensitive(true);
            this._menuStopItem.setSensitive(true);
            break;
        case States.SPEAKING:
            this._menuListenItem.label.text = 'Start Listening';
            this._menuListenItem.setSensitive(false);
            this._menuStopItem.setSensitive(true);
            break;
        case States.PROCESSING:
            this._menuListenItem.label.text = 'Start Listening';
            this._menuListenItem.setSensitive(false);
            this._menuStopItem.setSensitive(false);
            break;
        }
    }

    _destroyPanelIndicator() {
        if (this._panelButton) {
            this._panelButton.destroy();
            this._panelButton = null;
            this._panelIcon = null;
            this._menuListenItem = null;
            this._menuStopItem = null;
            this._menuBadgeToggle = null;
            this._menuContinuousToggle = null;
            this._menuConversationToggle = null;
            this._menuVoiceQualityItem = null;
            this._menuAudioInfoItem = null;
            this._langSubMenu = null;
        }
    }

    _positionBadge() {
        if (!this._badge)
            return;

        let monitor = Main.layoutManager.primaryMonitor;

        if (this._customPosition) {
            // If saved position is within the current monitor, use it.
            // Otherwise reset to default center-bottom (the user moved it
            // on a different display config).
            if (monitor) {
                let cx = this._customPosition.x;
                let cy = this._customPosition.y;
                let inBounds = cx >= monitor.x && cy >= monitor.y
                    && cx < monitor.x + monitor.width - 20
                    && cy < monitor.y + monitor.height - 20;
                if (inBounds) {
                    this._badge.set_position(cx, cy);
                    return;
                }
                // Out of bounds — fall through to default positioning
                this._customPosition = null;
                if (this._settings) {
                    this._settings.set_int('badge-position-x', -1);
                    this._settings.set_int('badge-position-y', -1);
                }
            } else {
                this._badge.set_position(this._customPosition.x, this._customPosition.y);
                return;
            }
        }

        if (!monitor)
            return;

        // We need to wait for the badge to be allocated to get its width
        // Use a small delay to ensure the actor is laid out
        let timeoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._destroyed || !this._badge)
                return GLib.SOURCE_REMOVE;

            let badgeWidth = this._badge.get_width();
            let badgeHeight = this._badge.get_height();

            if (badgeWidth <= 0)
                badgeWidth = 48;
            if (badgeHeight <= 0)
                badgeHeight = 48;

            let x = monitor.x + Math.round((monitor.width - badgeWidth) / 2);
            let y = monitor.y + monitor.height - 80;

            this._badge.set_position(x, y);
            return GLib.SOURCE_REMOVE;
        });
        this._trackTimeout(timeoutId);
    }

    _connectLayoutSignals() {
        let monitorId = Main.layoutManager.connect('monitors-changed', () => {
            this._customPosition = null;
            if (this._settings) {
                this._settings.set_int('badge-position-x', -1);
                this._settings.set_int('badge-position-y', -1);
            }
            this._positionBadge();
            this._positionSubtitleOverlay();
        });
        this._layoutSignalId = monitorId;
    }

    _disconnectLayoutSignals() {
        if (this._layoutSignalId) {
            Main.layoutManager.disconnect(this._layoutSignalId);
            this._layoutSignalId = null;
        }
    }

    _initProxy() {
        if (this._proxyPending) return;
        this._proxyPending = true;
        try {
            let p = new GnomeSpeaksProxy(
                Gio.DBus.session,
                DBUS_NAME,
                DBUS_PATH,
                (proxy, error) => {
                    this._proxyPending = false;
                    if (this._destroyed) return;
                    if (error) {
                        log(`[GNOME Speaks] DBus proxy creation failed: ${error.message}`);
                        this._proxy = null;
                        this._proxyReady = false;
                        return;
                    }
                    this._proxy = p;
                    this._proxyReady = true;
                    this._connectProxySignals();
                    this._syncState();
                }
            );
        } catch (e) {
            log(`[GNOME Speaks] Failed to create DBus proxy: ${e.message}`);
            this._proxyPending = false;
            this._proxy = null;
            this._proxyReady = false;
        }
    }

    _connectProxySignals() {
        if (!this._proxy)
            return;

        let stateChangedId = this._proxy.connectSignal('StateChanged', (proxy, sender, [state]) => {
            if (this._destroyed) return;
            this._setState(state);
        });
        this._proxySignals.push(stateChangedId);

        let transcriptionId = this._proxy.connectSignal('TranscriptionReady', (proxy, sender, [text]) => {
            if (this._destroyed) return;
            this._showTranscription(text);
        });
        this._proxySignals.push(transcriptionId);

        let partialId = this._proxy.connectSignal('PartialTranscription', (proxy, sender, [text]) => {
            if (this._destroyed) return;
            this._showPartialTranscription(text);
        });
        this._proxySignals.push(partialId);

        let subtitleUpdateId = this._proxy.connectSignal('SubtitleUpdate', (proxy, sender, [text, duration, percent]) => {
            if (this._destroyed) return;
            this._onSubtitleUpdate(text, duration, percent);
        });
        this._proxySignals.push(subtitleUpdateId);

        let audioLevelId = this._proxy.connectSignal('AudioLevel', (proxy, sender, [level]) => {
            if (this._destroyed) return;
            this._onAudioLevel(level);
        });
        this._proxySignals.push(audioLevelId);

        let errorId = this._proxy.connectSignal('Error', (proxy, sender, [message]) => {
            if (this._destroyed) return;
            this._showError(message);
        });
        this._proxySignals.push(errorId);
    }

    _disconnectProxy() {
        this._proxyReady = false;
        this._proxyPending = false;
        if (this._proxy) {
            for (let sigId of this._proxySignals) {
                try {
                    this._proxy.disconnectSignal(sigId);
                } catch (e) {
                    // Already disconnected
                }
            }
            this._proxySignals = [];
            // Prevent proxy from being GC'd during disable() — defer the
            // reference drop to the next idle cycle so GjsDBusImplementation
            // finalization doesn't trigger JS callbacks during the GC sweep.
            let oldProxy = this._proxy;
            this._proxy = null;
            GLib.idle_add(GLib.PRIORITY_LOW, () => {
                void oldProxy;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _syncState() {
        if (!this._proxy || this._destroyed)
            return;

        this._proxy.GetStateRemote((result, error) => {
            if (this._destroyed || !this._proxy) return;
            if (error) {
                log(`[GNOME Speaks] GetState failed: ${error.message}`);
                return;
            }
            if (result && result[0])
                this._setState(result[0]);
        });

        // Sync voice quality pill + menu label
        this._proxy.GetVoiceQualityRemote((result, error) => {
            if (this._destroyed || !this._proxy) return;
            if (!error && result && result[0]) {
                this._voiceQuality = result[0];
                this._updateQualityPill();
                if (this._menuVoiceQualityItem)
                    this._menuVoiceQualityItem.label.text = result[0] === 'hd'
                        ? 'Voice: HD' : 'Voice: Fast';
            }
        });

        // Sync audio device info
        this._proxy.GetAudioInfoRemote((result, error) => {
            if (this._destroyed || !this._proxy) return;
            if (!error && result && result[0]) {
                try {
                    let info = JSON.parse(result[0]);
                    this._updateAudioInfoMenu(info);
                } catch (e) {
                    // Ignore parse errors
                }
            }
        });

        // Sync mode states from service
        this._proxy.GetConversationModeRemote((result, error) => {
            if (this._destroyed || !this._proxy) return;
            if (!error && result) {
                this._conversationMode = result[0];
                this._updateModePill();
                if (this._menuConversationToggle)
                    this._menuConversationToggle.setToggleState(this._conversationMode);
            }
        });
        this._proxy.GetContinuousDictationRemote((result, error) => {
            if (this._destroyed || !this._proxy) return;
            if (!error && result) {
                this._continuousMode = result[0];
                this._updateContinuousPill();
                if (this._menuContinuousToggle)
                    this._menuContinuousToggle.setToggleState(this._continuousMode);
            }
        });
        this._proxy.GetTerminalModeRemote((result, error) => {
            if (this._destroyed || !this._proxy) return;
            if (!error && result) {
                this._terminalMode = result[0];
                this._updateTerminalPill();
            }
        });
    }

    _setState(newState) {
        if (this._destroyed) return;
        if (!Object.values(States).includes(newState))
            return;
        if (this._state === newState)
            return;

        let oldState = this._state;
        this._state = newState;

        if (!this._badge)
            return;

        let config = STATE_CONFIG[newState];

        // Update style classes — only remove old, add new (avoids 4 remove calls)
        if (oldState && STATE_CONFIG[oldState]) {
            this._badge.remove_style_class_name(STATE_CONFIG[oldState].styleClass);
        }
        this._badge.remove_style_class_name('gnome-speaks-error');
        this._badge.add_style_class_name(config.styleClass);

        // Update icon
        if (this._icon) {
            this._icon.icon_name = config.iconName;
            this._icon.x_expand = (newState === States.IDLE);
        }

        // Update label
        if (this._label) {
            if (config.showLabel) {
                this._label.text = config.label;
                this._label.show();
            } else {
                this._label.text = '';
                this._label.hide();
            }
        }

        // Pills: hidden in idle, shown when active
        let showPills = newState !== States.IDLE;
        let wasShowingPills = oldState && oldState !== States.IDLE;
        if (showPills !== wasShowingPills) {
            this._showPills(showPills);
            // Only refresh pill content when transitioning visibility
            if (showPills) {
                this._updateQualityPill();
                this._updateModePill();
                this._updateContinuousPill();
                this._updateTerminalPill();
            }
        }

        // Update panel icon and menu
        this._updatePanelIcon(newState);
        this._updatePanelMenu();

        // Re-sync mode flags when returning to idle (catches one-shot AI mode).
        // Debounce: skip if we just synced < 2s ago (avoids D-Bus flood in AI+Loop)
        if (newState === States.IDLE && this._proxy) {
            let now = GLib.get_monotonic_time();
            if (!this._lastModeSyncTime || (now - this._lastModeSyncTime) > 2000000) {
                this._lastModeSyncTime = now;
                this._proxy.GetConversationModeRemote((result, error) => {
                    if (this._destroyed || !this._proxy) return;
                    if (!error && result) {
                        this._conversationMode = result[0];
                        this._updateModePill();
                        if (this._menuConversationToggle)
                            this._menuConversationToggle.setToggleState(this._conversationMode);
                    }
                });
            }
        }

        // Reset audio level when leaving listening state
        if (newState !== States.LISTENING)
            this._audioLevel = 0;

        // Handle animations
        if (newState === States.LISTENING || newState === States.SPEAKING) {
            this._startPulse();
        } else {
            this._stopPulse();
        }

        // Subtitle overlay state management:
        // - IDLE: schedule a graceful 3s fade-out (don't hide immediately)
        // - PROCESSING: keep subtitles visible (transcription just finished)
        // - LISTENING/SPEAKING: subtitles managed by their signal handlers
        if (newState === States.IDLE) {
            // Don't immediately hide — schedule a gentle fade-out
            if (this._subtitleVisible)
                this._scheduleSubtitleFadeout(3000);
        } else if (newState === States.PROCESSING) {
            // Keep transcription visible while processing
            this._cancelTimeout('subtitle-fadeout');
        }

        // Reposition badge if going to/from idle (size changes)
        if ((oldState === States.IDLE && newState !== States.IDLE) ||
            (oldState !== States.IDLE && newState === States.IDLE)) {
            if (!this._customPosition) {
                let delay = (newState === States.IDLE) ? 16 : 50;
                let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                    this._positionBadge();
                    return GLib.SOURCE_REMOVE;
                });
                this._trackTimeout(timeoutId);
            }
        }
    }

    _updatePanelIcon(state) {
        if (!this._panelIcon)
            return;

        let panelClasses = [
            'gnome-speaks-panel-idle',
            'gnome-speaks-panel-listening',
            'gnome-speaks-panel-processing',
            'gnome-speaks-panel-speaking',
        ];

        for (let cls of panelClasses)
            this._panelIcon.remove_style_class_name(cls);

        let config = STATE_CONFIG[state];
        this._panelIcon.icon_name = config.iconName;
        this._panelIcon.add_style_class_name(`gnome-speaks-panel-${state}`);
    }

    _startPulse() {
        this._stopPulse();

        if (!this._badge)
            return;

        this._pulseUp = true;
        this._pulseActive = true;
        this._doPulse();
    }

    _doPulse() {
        if (this._destroyed || !this._badge || !this._pulseActive)
            return;

        let targetScale = this._pulseUp ? 1.06 : 1.0;

        // No onComplete — GC can invoke Clutter transition callbacks during
        // sweep, causing "JS callback during garbage collection" and black screen.
        // Use a GLib timeout instead; GLib sources are not actor-bound.
        this._badge.ease({
            scale_x: targetScale,
            scale_y: targetScale,
            duration: 800,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
        });
        this._pulseNextId = GLib.timeout_add(GLib.PRIORITY_LOW, 820, () => {
            this._pulseNextId = null;
            if (this._destroyed || !this._pulseActive || !this._badge)
                return GLib.SOURCE_REMOVE;
            this._pulseUp = !this._pulseUp;
            this._doPulse();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopPulse() {
        this._pulseActive = false;

        if (this._pulseNextId) {
            try { GLib.Source.remove(this._pulseNextId); } catch (e) { /* already fired */ }
            this._pulseNextId = null;
        }

        // Cancel any pending audio-level pulse resume
        this._cancelTimeout('audio-pulse-resume');

        if (!this._badge || this._destroyed)
            return;

        this._badge.remove_all_transitions();

        this._badge.ease({
            scale_x: 1.0,
            scale_y: 1.0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _onBadgeClicked() {
        switch (this._state) {
        case States.IDLE:
            this._callMethod('StartListening');
            break;
        case States.LISTENING:
            this._callMethod('StopListening');
            break;
        case States.SPEAKING:
            this._callMethod('Stop');
            break;
        case States.PROCESSING:
            this._callMethod('Stop');
            break;
        }
    }

    _callMethod(methodName, ...args) {
        if (this._destroyed) return;
        if (!this._proxy) {
            this._initProxy();
            let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                if (this._destroyed || !this._proxy)
                    return GLib.SOURCE_REMOVE;
                this._callMethodInternal(methodName, ...args);
                return GLib.SOURCE_REMOVE;
            });
            this._trackTimeout(timeoutId);
            return;
        }

        this._callMethodInternal(methodName, ...args);
    }

    _callMethodInternal(methodName, ...args) {
        if (this._destroyed || !this._proxy)
            return;

        let remoteName = `${methodName}Remote`;
        if (typeof this._proxy[remoteName] !== 'function') {
            log(`[GNOME Speaks] Unknown method: ${methodName}`);
            return;
        }

        let callback = (result, error) => {
            if (this._destroyed) return;
            if (error) {
                log(`[GNOME Speaks] ${methodName} failed: ${error.message}`);
                this._showError(`${methodName} failed`);
            }
        };

        if (args.length > 0)
            this._proxy[remoteName](...args, callback);
        else
            this._proxy[remoteName](callback);
    }

    _showPartialTranscription(text) {
        if (this._destroyed)
            return;
        if (this._state !== States.LISTENING && this._state !== States.SPEAKING)
            return;

        // Skip if text hasn't changed
        if (text === this._lastPartialText)
            return;
        this._lastPartialText = text;

        // Coalescing debounce: buffer the latest text and render at most
        // every 300ms (~3 updates/sec). If a timeout is already pending,
        // just update the buffered text — the pending timeout will pick it up.
        this._pendingPartialText = text;

        if (this._partialDebounceId)
            return; // timeout already scheduled, it will use _pendingPartialText

        // First update in this window — render immediately
        this._showSubtitle(text, true);
        this._lastPartialTime = GLib.get_monotonic_time();

        // Schedule the gate: after 300ms, flush the latest buffered text
        let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._partialDebounceId = null;
            this._removeTimeout('partial-debounce');
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            // If newer text arrived while we were waiting, render it now
            if (this._pendingPartialText && this._pendingPartialText !== this._lastRenderedPartial) {
                this._showSubtitle(this._pendingPartialText, true);
                this._lastRenderedPartial = this._pendingPartialText;
            }
            return GLib.SOURCE_REMOVE;
        });
        this._partialDebounceId = timeoutId;
        this._lastRenderedPartial = text;
        this._trackTimeout(timeoutId, 'partial-debounce');
    }

    _onSubtitleUpdate(text, duration, percent) {
        if (this._destroyed)
            return;
        if (this._state !== States.SPEAKING)
            return;

        // When reveal reaches 100%, always render immediately (final state)
        if (percent >= 100) {
            this._cancelTimeout('subtitle-debounce');
            this._showSubtitle(text, false);
            this._scheduleSubtitleFadeout(2000);
            return;
        }

        // Progressive reveal: show text up to the current estimated position
        let charPos = Math.floor((percent / 100.0) * text.length);
        let revealed = text.substring(0, charPos);

        if (revealed.length === 0)
            return;

        // Throttle progressive reveals to ~3/sec (330ms)
        let now = GLib.get_monotonic_time();
        if (this._lastSubtitleUpdateTime && (now - this._lastSubtitleUpdateTime) < 330000) {
            // Buffer the latest reveal text for the next scheduled flush
            this._pendingSubtitleReveal = revealed;
            if (!this._subtitleDebounceId) {
                let remaining = 330 - Math.floor((now - this._lastSubtitleUpdateTime) / 1000);
                let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(remaining, 16), () => {
                    this._subtitleDebounceId = null;
                    this._removeTimeout('subtitle-debounce');
                    if (this._destroyed || !this._pendingSubtitleReveal)
                        return GLib.SOURCE_REMOVE;
                    this._showSubtitle(this._pendingSubtitleReveal, true);
                    this._lastSubtitleUpdateTime = GLib.get_monotonic_time();
                    this._pendingSubtitleReveal = null;
                    return GLib.SOURCE_REMOVE;
                });
                this._subtitleDebounceId = timeoutId;
                this._trackTimeout(timeoutId, 'subtitle-debounce');
            }
            return;
        }

        this._lastSubtitleUpdateTime = now;
        this._showSubtitle(revealed, true);
    }

    _showTranscription(text) {
        if (this._destroyed)
            return;

        // Show in the subtitle overlay — final, non-italic style
        this._showSubtitle(text, false);

        // Schedule fade-out after 3 seconds
        this._scheduleSubtitleFadeout(3000);

    }

    _showError(message) {
        log(`[GNOME Speaks] Error: ${message}`);

        if (this._destroyed || !this._badge)
            return;

        this._badge.add_style_class_name('gnome-speaks-error');

        this._cancelTimeout('error');

        let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            if (!this._destroyed && this._badge)
                this._badge.remove_style_class_name('gnome-speaks-error');
            this._removeTimeout('error');
            return GLib.SOURCE_REMOVE;
        });
        this._trackTimeout(timeoutId, 'error');
    }

    // -- Audio level visualization -----------------------------------------

    _onAudioLevel(level) {
        if (this._destroyed) return;
        this._audioLevel = level;
        if (!this._badge || (this._state !== States.LISTENING && this._state !== States.SPEAKING))
            return;

        // Throttle to ~12fps to avoid flooding the animation system
        let now = GLib.get_monotonic_time();
        if ((now - this._lastAudioLevelTime) < 80000) // 80ms
            return;
        this._lastAudioLevelTime = now;

        // Suspend pulse animation while audio levels drive the scale,
        // otherwise ease() and set_scale() fight over the same property
        // causing rapid jiggling.
        if (this._pulseActive) {
            this._pulseActive = false;
            if (this._pulseNextId) {
                try { GLib.Source.remove(this._pulseNextId); } catch (e) { /* already fired */ }
                this._pulseNextId = null;
            }
            this._badge.remove_all_transitions();
        }

        // Set scale directly (no ease) to avoid GL errors on NVIDIA
        // proprietary drivers from concurrent ease() calls.
        let baseScale = 1.0;
        let levelBoost = Math.min(level, 1.0) * 0.12;
        let targetScale = baseScale + levelBoost;
        this._badge.set_scale(targetScale, targetScale);

        // Resume pulse after 300ms of silence
        this._cancelTimeout('audio-pulse-resume');
        let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._removeTimeout('audio-pulse-resume');
            if (!this._destroyed && this._badge &&
                (this._state === States.LISTENING || this._state === States.SPEAKING)) {
                this._startPulse();
            }
            return GLib.SOURCE_REMOVE;
        });
        this._trackTimeout(timeoutId, 'audio-pulse-resume');
    }

    _showContextMenu(event) {
        if (!this._badge) return;
        this._destroyContextMenu();

        this._contextMenu = new St.BoxLayout({
            vertical: true,
            style_class: 'popup-menu-content',
            style: 'background-color: rgba(40,40,40,0.95); border-radius: 12px; padding: 8px 0; min-width: 200px;',
            reactive: true,
        });

        let titleItem = new St.Label({
            text: 'GNOME Speaks',
            style: 'padding: 8px 16px; font-weight: bold; color: rgba(255,255,255,0.5); font-size: 12px;',
        });
        this._contextMenu.add_child(titleItem);

        let separator = new St.Widget({
            style: 'height: 1px; background-color: rgba(255,255,255,0.1); margin: 4px 8px;',
        });
        this._contextMenu.add_child(separator);

        let speakClipboardItem = this._createMenuItem('Speak Clipboard', () => {
            this._callMethod('SpeakClipboard');
            this._destroyContextMenu();
        });
        this._contextMenu.add_child(speakClipboardItem);

        let readSelItem = this._createMenuItem('Read Selection', () => {
            this._callMethod('SpeakSelection');
            this._destroyContextMenu();
        });
        this._contextMenu.add_child(readSelItem);

        let stopItem = this._createMenuItem('Stop', () => {
            this._callMethod('Stop');
            this._destroyContextMenu();
        });
        this._contextMenu.add_child(stopItem);

        let separator2 = new St.Widget({
            style: 'height: 1px; background-color: rgba(255,255,255,0.1); margin: 4px 8px;',
        });
        this._contextMenu.add_child(separator2);

        let hideItem = this._createMenuItem('Hide Badge', () => {
            this._badgeVisible = false;
            if (this._menuBadgeToggle)
                this._menuBadgeToggle.setToggleState(false);
            this._badge.ease({
                opacity: 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
                if (!this._destroyed && this._badge) this._badge.hide();
                return GLib.SOURCE_REMOVE;
            });
            this._destroyContextMenu();
        });
        this._contextMenu.add_child(hideItem);

        Main.layoutManager.addTopChrome(this._contextMenu);

        // Position menu above the badge
        let [badgeX, badgeY] = this._badge.get_transformed_position();
        let badgeWidth = this._badge.get_width();

        // Wait for menu to be allocated so we know its size
        let posId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (!this._contextMenu)
                return GLib.SOURCE_REMOVE;

            let menuWidth = this._contextMenu.get_width();
            let menuHeight = this._contextMenu.get_height();

            let menuX = badgeX + (badgeWidth - menuWidth) / 2;
            let menuY = badgeY - menuHeight - 8;

            let monitor = Main.layoutManager.primaryMonitor;
            if (monitor) {
                if (menuX < monitor.x + 8)
                    menuX = monitor.x + 8;
                if (menuX + menuWidth > monitor.x + monitor.width - 8)
                    menuX = monitor.x + monitor.width - menuWidth - 8;
                if (menuY < monitor.y + 8)
                    menuY = badgeY + this._badge.get_height() + 8;
            }

            this._contextMenu.set_position(menuX, menuY);
            return GLib.SOURCE_REMOVE;
        });
        this._trackTimeout(posId);

        // Close menu when clicking elsewhere
        this._menuGrabId = global.stage.connect('button-press-event', (actor, pressEvent) => {
            let [px, py] = pressEvent.get_coords();
            if (!this._contextMenu)
                return Clutter.EVENT_PROPAGATE;

            let [mx, my] = this._contextMenu.get_transformed_position();
            let mw = this._contextMenu.get_width();
            let mh = this._contextMenu.get_height();

            if (px < mx || px > mx + mw || py < my || py > my + mh) {
                this._destroyContextMenu();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _createMenuItem(text, callback) {
        let item = new St.Label({
            text: text,
            style: 'padding: 8px 16px; color: white; font-size: 14px;',
            reactive: true,
            track_hover: true,
        });

        item.connect('enter-event', () => {
            item.set_style('padding: 8px 16px; color: white; font-size: 14px; background-color: rgba(255,255,255,0.1);');
            return Clutter.EVENT_PROPAGATE;
        });

        item.connect('leave-event', () => {
            item.set_style('padding: 8px 16px; color: white; font-size: 14px;');
            return Clutter.EVENT_PROPAGATE;
        });

        item.connect('button-release-event', () => {
            callback();
            return Clutter.EVENT_STOP;
        });

        return item;
    }

    _destroyContextMenu() {
        if (this._menuGrabId) {
            global.stage.disconnect(this._menuGrabId);
            this._menuGrabId = null;
        }

        if (this._contextMenu) {
            Main.layoutManager.removeChrome(this._contextMenu);
            this._contextMenu.destroy();
            this._contextMenu = null;
        }
    }

    _trackTimeout(id, name = null) {
        // Deduplicate: cancel any existing timeout with the same name
        // to prevent orphaned timers that fire unexpectedly.
        if (name) this._cancelTimeout(name);
        this._timeouts.push({id, name});
    }

    _cancelTimeout(name) {
        let idx = this._timeouts.findIndex(t => t.name === name);
        if (idx >= 0) {
            try { GLib.Source.remove(this._timeouts[idx].id); } catch (e) { /* already fired */ }
            this._timeouts.splice(idx, 1);
        }
    }

    _removeTimeout(name) {
        let idx = this._timeouts.findIndex(t => t.name === name);
        if (idx >= 0)
            this._timeouts.splice(idx, 1);
    }

    _cancelAllTimeouts() {
        for (let t of this._timeouts) {
            try {
                GLib.Source.remove(t.id);
            } catch (e) {
                // Source already removed
            }
        }
        this._timeouts = [];
    }
}
