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
      <arg direction="out" type="s" name="request_id"/>
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

        this._createBadge();
        this._createPanelIndicator();
        this._positionBadge();
        this._connectLayoutSignals();
        this._initProxy();
    }

    disable() {
        this._cancelAllTimeouts();
        this._stopPulse();
        this._disconnectLayoutSignals();
        this._disconnectProxy();
        this._destroyPanelIndicator();
        this._destroyBadge();

        this._state = null;
        this._customPosition = null;
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
        }
    }

    _toggleBadgeVisibility() {
        this._badgeVisible = !this._badgeVisible;
        if (this._badge) {
            if (this._badgeVisible) {
                this._badge.show();
                this._badge.ease({
                    opacity: 255,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                this._badge.ease({
                    opacity: 0,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (this._badge)
                            this._badge.hide();
                    },
                });
            }
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

        // Update panel icon
        this._updatePanelIcon(newState);

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

        let stopItem = this._createMenuItem('Stop', () => {
            this._callMethod('Stop');
            this._destroyContextMenu();
        });
        this._contextMenu.add_child(stopItem);

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
