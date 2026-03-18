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
    <method name="ToggleBargeIn">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="GetBargeIn">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="ToggleHandsFree">
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
        this._state = States.IDLE;
        this._proxy = null;
        this._proxySignals = [];
        this._signals = [];
        this._timeouts = [];
        this._pulseTransition = null;
        this._isDragging = false;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._dragBadgeStartX = 0;
        this._dragBadgeStartY = 0;
        this._customPosition = null;
        this._badgeVisible = true;
        this._audioLevel = 0;
        this._settings = this.getSettings();

        this._createBadge();
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
                // Name appeared (service started or restarted)
                if (this._proxy)
                    this._syncState();
                else
                    this._initProxy();
            },
            () => {
                // Name vanished (service stopped) — reset badge to idle
                this._setState(States.IDLE);
            },
        );
    }

    disable() {
        if (this._busWatchId) {
            Gio.bus_unwatch_name(this._busWatchId);
            this._busWatchId = 0;
        }

        this._cancelAllTimeouts();
        this._stopPulse();
        this._disconnectNotificationReader();
        this._removeKeybindings();
        this._disconnectLayoutSignals();
        this._disconnectProxy();
        this._destroyPanelIndicator();
        this._destroyBadge();

        this._state = null;
        this._customPosition = null;
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
        this._notifSourceAddedId = Main.messageTray.connect('source-added', (tray, source) => {
            let notifAddedId = source.connect('notification-added', (src, notification) => {
                this._onNotification(notification);
            });
            if (!this._notifSignals)
                this._notifSignals = [];
            this._notifSignals.push({obj: source, id: notifAddedId});
        });
    }

    _disconnectNotificationReader() {
        if (this._notifSourceAddedId) {
            Main.messageTray.disconnect(this._notifSourceAddedId);
            this._notifSourceAddedId = null;
        }
        if (this._notifSignals) {
            for (let sig of this._notifSignals) {
                try { sig.obj.disconnect(sig.id); } catch (e) { /* ok */ }
            }
            this._notifSignals = null;
        }
    }

    _onNotification(notification) {
        // Only read notifications if enabled in config
        // Check by reading the speech-to-cli config
        let configPath = GLib.build_filenamev([
            GLib.get_home_dir(), '.config', 'speech-to-cli', 'config.json',
        ]);
        try {
            let [ok, contents] = GLib.file_get_contents(configPath);
            if (ok) {
                let decoder = new TextDecoder('utf-8');
                let config = JSON.parse(decoder.decode(contents));
                if (!config.read_notifications)
                    return;
            }
        } catch (e) {
            return;
        }

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

        // Voice quality pill — always visible, compact in idle
        this._qualityPill = new St.Label({
            text: '✦',
            style_class: 'gnome-speaks-quality-hd',
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._qualityPill.connect('button-release-event', (actor, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            this._toggleVoiceQuality();
            return Clutter.EVENT_STOP;
        });
        // Prevent pill clicks from triggering badge drag/click
        this._qualityPill.connect('button-press-event', () => Clutter.EVENT_STOP);
        this._badge.add_child(this._qualityPill);

        // Mode pill — always visible, compact in idle
        this._conversationMode = false;
        this._modePill = new St.Label({
            text: '✏️',
            style_class: 'gnome-speaks-mode-dict',
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._modePill.connect('button-release-event', (actor, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            this._toggleMode();
            return Clutter.EVENT_STOP;
        });
        // Prevent pill clicks from triggering badge drag/click
        this._modePill.connect('button-press-event', () => Clutter.EVENT_STOP);
        this._badge.add_child(this._modePill);

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

            if (!this._isDragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5))
                this._isDragging = true;

            if (this._isDragging) {
                actor.set_position(
                    this._dragBadgeStartX + dx,
                    this._dragBadgeStartY + dy
                );
                this._customPosition = {x: actor.x, y: actor.y};
            }
            return Clutter.EVENT_STOP;
        });
        this._signals.push({obj: this._badge, id: motionId});

        let releaseId = this._badge.connect('button-release-event', (actor, event) => {
            if (event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;

            this._dragButton = 0;

            if (!this._isDragging) {
                this._onBadgeClicked();
            }
            this._isDragging = false;
            return Clutter.EVENT_STOP;
        });
        this._signals.push({obj: this._badge, id: releaseId});

        let leaveId = this._badge.connect('leave-event', () => {
            if (this._dragButton === 1 && this._isDragging) {
                // Continue drag even if pointer leaves badge momentarily
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._signals.push({obj: this._badge, id: leaveId});

        Main.layoutManager.addTopChrome(this._badge, {
            affectsInputRegion: true,
            trackFullscreen: false,
        });
    }

    _toggleVoiceQuality() {
        if (!this._proxy) {
            // Local toggle for testing without service
            this._voiceQuality = this._voiceQuality === 'hd' ? 'fast' : 'hd';
            this._updateQualityPill();
            return;
        }
        this._proxy.ToggleVoiceQualityRemote((result, error) => {
            if (error) return;
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
        let compact = this._state === States.IDLE;
        this._qualityPill.text = isHD
            ? (compact ? '✦' : '✦ HD')
            : (compact ? '⚡' : '⚡ Fast');
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
            if (error) return;
            let enabled = result[0];
            this._conversationMode = enabled;
            this._updateModePill();
            // Sync the panel menu toggle (without re-triggering its callback)
            if (this._menuConversationToggle)
                this._menuConversationToggle.setToggleState(enabled);
        });
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
        let compact = this._state === States.IDLE;
        this._modePill.text = isChat
            ? (compact ? '🤖' : '🤖 AI')
            : (compact ? '✏️' : '✏️ Type');
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
            Main.layoutManager.removeChrome(this._badge);
            this._badge.destroy();
            this._badge = null;
        }
        this._icon = null;
        this._label = null;
        this._qualityPill = null;
        this._modePill = null;
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

        // ── Listen / Stop ──
        this._menuListenItem = new PopupMenu.PopupMenuItem('Start Listening');
        this._menuListenItem.connect('activate', () => {
            if (this._state === States.LISTENING)
                this._callMethod('StopListening');
            else if (this._state === States.IDLE)
                this._callMethod('StartListening');
        });
        menu.addMenuItem(this._menuListenItem);

        // ── Stop ──
        this._menuStopItem = new PopupMenu.PopupMenuItem('Stop');
        this._menuStopItem.connect('activate', () => {
            this._callMethod('Stop');
        });
        menu.addMenuItem(this._menuStopItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ── Speak Clipboard ──
        let speakClipItem = new PopupMenu.PopupMenuItem('Speak Clipboard');
        speakClipItem.connect('activate', () => {
            this._callMethod('SpeakClipboard');
        });
        menu.addMenuItem(speakClipItem);

        // ── Read Selection ──
        let readSelItem = new PopupMenu.PopupMenuItem('Read Selection');
        readSelItem.connect('activate', () => {
            this._callMethod('SpeakSelection');
        });
        menu.addMenuItem(readSelItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ── Continuous Dictation toggle ──
        this._menuContinuousToggle = new PopupMenu.PopupSwitchMenuItem('Continuous Dictation', false);
        this._menuContinuousToggle.connect('toggled', () => {
            this._callMethod('ToggleContinuousDictation');
        });
        menu.addMenuItem(this._menuContinuousToggle);

        // ── Conversation Mode toggle ──
        this._menuConversationToggle = new PopupMenu.PopupSwitchMenuItem('Conversation Mode', false);
        this._menuConversationToggle.connect('toggled', (item, state) => {
            if (!this._proxy) return;
            this._proxy.ToggleConversationModeRemote((result, error) => {
                if (error) return;
                let enabled = result[0];
                this._conversationMode = enabled;
                this._updateModePill();
                // Re-sync toggle if service returned a different state than expected
                if (enabled !== state)
                    item.setToggleState(enabled);
            });
        });
        menu.addMenuItem(this._menuConversationToggle);

        // ── Voice Quality toggle (HD ↔ Fast) ──
        this._voiceQuality = 'hd';
        this._menuVoiceQualityItem = new PopupMenu.PopupMenuItem('Voice: HD');
        this._menuVoiceQualityItem.connect('activate', () => this._toggleVoiceQuality());
        menu.addMenuItem(this._menuVoiceQualityItem);

        // ── Audio Device info (read-only) ──
        this._menuAudioInfoItem = new PopupMenu.PopupMenuItem('Audio: detecting...');
        this._menuAudioInfoItem.setSensitive(false);
        menu.addMenuItem(this._menuAudioInfoItem);

        // ── Language submenu ──
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

        // ── Toggle Badge ──
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
                        onComplete: () => { if (this._badge) this._badge.hide(); },
                    });
                }
            }
        });
        menu.addMenuItem(this._menuBadgeToggle);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ── Settings ──
        let settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => {
            this.openPreferences();
        });
        menu.addMenuItem(settingsItem);
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

        if (this._customPosition) {
            this._badge.set_position(this._customPosition.x, this._customPosition.y);
            return;
        }

        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        // We need to wait for the badge to be allocated to get its width
        // Use a small delay to ensure the actor is laid out
        let timeoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (!this._badge)
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
            this._positionBadge();
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
        try {
            this._proxy = new GnomeSpeaksProxy(
                Gio.DBus.session,
                DBUS_NAME,
                DBUS_PATH,
                (proxy, error) => {
                    if (error) {
                        log(`[GNOME Speaks] DBus proxy creation failed: ${error.message}`);
                        this._proxy = null;
                        return;
                    }
                    this._connectProxySignals();
                    this._syncState();
                }
            );
        } catch (e) {
            log(`[GNOME Speaks] Failed to create DBus proxy: ${e.message}`);
            this._proxy = null;
        }
    }

    _connectProxySignals() {
        if (!this._proxy)
            return;

        let stateChangedId = this._proxy.connectSignal('StateChanged', (proxy, sender, [state]) => {
            this._setState(state);
        });
        this._proxySignals.push(stateChangedId);

        let transcriptionId = this._proxy.connectSignal('TranscriptionReady', (proxy, sender, [text]) => {
            this._showTranscription(text);
        });
        this._proxySignals.push(transcriptionId);

        let partialId = this._proxy.connectSignal('PartialTranscription', (proxy, sender, [text]) => {
            this._showPartialTranscription(text);
        });
        this._proxySignals.push(partialId);

        let audioLevelId = this._proxy.connectSignal('AudioLevel', (proxy, sender, [level]) => {
            this._onAudioLevel(level);
        });
        this._proxySignals.push(audioLevelId);

        let errorId = this._proxy.connectSignal('Error', (proxy, sender, [message]) => {
            this._showError(message);
        });
        this._proxySignals.push(errorId);
    }

    _disconnectProxy() {
        if (this._proxy) {
            for (let sigId of this._proxySignals) {
                try {
                    this._proxy.disconnectSignal(sigId);
                } catch (e) {
                    // Already disconnected
                }
            }
            this._proxySignals = [];
            this._proxy = null;
        }
    }

    _syncState() {
        if (!this._proxy)
            return;

        this._proxy.GetStateRemote((result, error) => {
            if (error) {
                log(`[GNOME Speaks] GetState failed: ${error.message}`);
                return;
            }
            if (result && result[0])
                this._setState(result[0]);
        });

        // Sync voice quality pill + menu label
        this._proxy.GetVoiceQualityRemote((result, error) => {
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
            if (!error && result && result[0]) {
                try {
                    let info = JSON.parse(result[0]);
                    this._updateAudioInfoMenu(info);
                } catch (e) {
                    // Ignore parse errors
                }
            }
        });

        // No GetConversationMode D-Bus method — initialize to dict mode
        this._conversationMode = false;
        this._updateModePill();
        if (this._menuConversationToggle)
            this._menuConversationToggle.setToggleState(false);
    }

    _setState(newState) {
        if (!Object.values(States).includes(newState))
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

        // Pills: compact (icon-only) in idle, full labels when expanded
        this._updateQualityPill();
        this._updateModePill();

        // Update panel icon and menu
        this._updatePanelIcon(newState);
        this._updatePanelMenu();

        // Reset audio level when leaving listening state
        if (newState !== States.LISTENING)
            this._audioLevel = 0;

        // Handle animations
        if (newState === States.LISTENING || newState === States.SPEAKING) {
            this._startPulse();
        } else {
            this._stopPulse();
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
        if (!this._badge || !this._pulseActive)
            return;

        let targetScale = this._pulseUp ? 1.06 : 1.0;

        this._badge.ease({
            scale_x: targetScale,
            scale_y: targetScale,
            duration: 800,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            onComplete: () => {
                if (!this._pulseActive || !this._badge)
                    return;
                this._pulseUp = !this._pulseUp;
                // Schedule next pulse asynchronously to prevent stack overflow
                // if ease() completes synchronously (e.g., target === current value)
                this._pulseNextId = GLib.timeout_add(GLib.PRIORITY_LOW, 16, () => {
                    this._pulseNextId = null;
                    this._doPulse();
                    return GLib.SOURCE_REMOVE;
                });
            },
        });
    }

    _stopPulse() {
        this._pulseActive = false;

        if (this._pulseNextId) {
            GLib.Source.remove(this._pulseNextId);
            this._pulseNextId = null;
        }

        if (!this._badge)
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
            // No action during processing
            break;
        }
    }

    _callMethod(methodName, ...args) {
        if (!this._proxy) {
            this._initProxy();
            let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                if (this._proxy)
                    this._callMethodInternal(methodName, ...args);
                return GLib.SOURCE_REMOVE;
            });
            this._trackTimeout(timeoutId);
            return;
        }

        this._callMethodInternal(methodName, ...args);
    }

    _callMethodInternal(methodName, ...args) {
        if (!this._proxy)
            return;

        let remoteName = `${methodName}Remote`;
        if (typeof this._proxy[remoteName] !== 'function') {
            log(`[GNOME Speaks] Unknown method: ${methodName}`);
            return;
        }

        let callback = (result, error) => {
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
        if (!this._badge || !this._label)
            return;
        if (this._state !== 'listening')
            return;

        // Debounce: skip if last update was < 50ms ago
        let now = GLib.get_monotonic_time();
        if (this._lastPartialTime && (now - this._lastPartialTime) < 50000)
            return;
        this._lastPartialTime = now;

        let displayText = text;
        if (displayText.length > 50)
            displayText = `...${displayText.substring(displayText.length - 47)}`;

        this._label.text = displayText;
        this._label.show();
    }

    _showTranscription(text) {
        if (!this._badge || !this._label)
            return;

        let displayText = text;
        if (displayText.length > 60)
            displayText = `${displayText.substring(0, 57)}...`;

        this._label.text = displayText;
        this._label.show();

        // Cancel any existing transcription fade-out
        this._cancelTimeout('transcription');

        let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            if (!this._badge || !this._label)
                return GLib.SOURCE_REMOVE;

            // Only hide if we're still showing transcription (i.e., back to idle)
            if (this._state === States.IDLE) {
                this._label.text = '';
                this._label.hide();
            }
            this._removeTimeout('transcription');
            return GLib.SOURCE_REMOVE;
        });
        this._trackTimeout(timeoutId, 'transcription');
    }

    _showError(message) {
        log(`[GNOME Speaks] Error: ${message}`);

        if (!this._badge)
            return;

        this._badge.add_style_class_name('gnome-speaks-error');

        this._cancelTimeout('error');

        let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            if (this._badge)
                this._badge.remove_style_class_name('gnome-speaks-error');
            this._removeTimeout('error');
            return GLib.SOURCE_REMOVE;
        });
        this._trackTimeout(timeoutId, 'error');
    }

    // -- Audio level visualization -----------------------------------------

    _onAudioLevel(level) {
        this._audioLevel = level;
        if (!this._badge || this._state !== States.LISTENING)
            return;

        // Scale the badge slightly based on audio level for visual feedback
        let baseScale = 1.0;
        let levelBoost = Math.min(level, 1.0) * 0.12;
        let targetScale = baseScale + levelBoost;

        // Only update if pulse isn't actively animating (avoid conflict)
        if (this._pulseActive) {
            // Modulate the pulse intensity based on level
            this._badge.ease({
                scale_x: targetScale,
                scale_y: targetScale,
                duration: 80,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _showContextMenu(event) {
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
                onComplete: () => { if (this._badge) this._badge.hide(); },
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
        this._timeouts.push({id, name});
    }

    _cancelTimeout(name) {
        let idx = this._timeouts.findIndex(t => t.name === name);
        if (idx >= 0) {
            GLib.Source.remove(this._timeouts[idx].id);
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
