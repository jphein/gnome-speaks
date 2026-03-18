import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// ─── Azure Speech Service regions ────────────────────────────────────────────
const REGIONS = [
    ['eastus', 'East US'],
    ['eastus2', 'East US 2'],
    ['westus', 'West US'],
    ['westus2', 'West US 2'],
    ['westus3', 'West US 3'],
    ['centralus', 'Central US'],
    ['northcentralus', 'North Central US'],
    ['southcentralus', 'South Central US'],
    ['canadacentral', 'Canada Central'],
    ['northeurope', 'North Europe (Ireland)'],
    ['westeurope', 'West Europe (Netherlands)'],
    ['uksouth', 'UK South'],
    ['francecentral', 'France Central'],
    ['germanywestcentral', 'Germany West Central'],
    ['swedencentral', 'Sweden Central'],
    ['switzerlandnorth', 'Switzerland North'],
    ['norwayeast', 'Norway East'],
    ['eastasia', 'East Asia (Hong Kong)'],
    ['southeastasia', 'Southeast Asia (Singapore)'],
    ['japaneast', 'Japan East'],
    ['japanwest', 'Japan West'],
    ['koreacentral', 'Korea Central'],
    ['australiaeast', 'Australia East'],
    ['centralindia', 'Central India'],
    ['brazilsouth', 'Brazil South'],
    ['uaenorth', 'UAE North'],
    ['southafricanorth', 'South Africa North'],
];

const SUBTITLE_COLORS = [
    ['default', 'Default'],
    ['green', 'Green'],
    ['light_green', 'Light Green'],
    ['yellow', 'Yellow'],
    ['amber', 'Amber'],
    ['rust', 'Rust'],
    ['red', 'Red'],
    ['light_red', 'Light Red'],
    ['blue', 'Blue'],
    ['light_blue', 'Light Blue'],
    ['cyan', 'Cyan'],
    ['light_cyan', 'Light Cyan'],
    ['magenta', 'Magenta'],
    ['light_magenta', 'Light Magenta'],
    ['white', 'White'],
    ['gray', 'Gray'],
];

// ─── Main Preferences Class ─────────────────────────────────────────────────
export default class GnomeSpeaksPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._config = this._loadConfig();
        this._settings = this.getSettings();
        this._saveTimeoutId = null;

        window.set_default_size(720, 860);
        window.set_search_enabled(true);

        window.connect('close-request', () => {
            this._flushConfigSave();
            return false;
        });

        this._addAzurePage(window);
        this._addVoicePage(window);
        this._addListeningPage(window);
        this._addAudioPage(window);
        this._addFeedbackPage(window);
        this._addExtensionPage(window);
        this._addAdvancedPage(window);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Page 1 — Azure Service Configuration
    // ═══════════════════════════════════════════════════════════════════
    _addAzurePage(window) {
        const page = new Adw.PreferencesPage({
            title: 'Azure',
            icon_name: 'network-server-symbolic',
        });

        // ── Authentication ──
        const authGroup = new Adw.PreferencesGroup({
            title: 'Authentication',
            description: 'Azure Speech Services credentials. Get a key at portal.azure.com.',
        });
        page.add(authGroup);

        this._addPasswordRow(authGroup, 'API Key', 'key',
            'Azure Speech Services subscription key');

        this._addRegionCombo(authGroup, 'Region', 'region',
            'Primary region for STT and TTS', 'westus2');

        // ── Separate TTS Region ──
        const ttsGroup = new Adw.PreferencesGroup({
            title: 'TTS Region (Optional)',
            description: 'Use a different region for text-to-speech, e.g. eastus for DragonHD voices.',
        });
        page.add(ttsGroup);

        this._addRegionCombo(ttsGroup, 'TTS Region', 'tts_region',
            'Leave empty to use the primary region', '');

        this._addPasswordRow(ttsGroup, 'TTS API Key', 'tts_key',
            'Leave empty to use the primary key');

        window.add(page);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Page 2 — Voice & TTS
    // ═══════════════════════════════════════════════════════════════════
    _addVoicePage(window) {
        const page = new Adw.PreferencesPage({
            title: 'Voice',
            icon_name: 'audio-speakers-symbolic',
        });

        // ── HD Voice ──
        const hdGroup = new Adw.PreferencesGroup({
            title: 'HD Voice',
            description: 'High-quality DragonHD voice with natural prosody. Requires a supported region (e.g. eastus).',
        });
        page.add(hdGroup);

        this._addEntryRow(hdGroup, 'HD Voice Name', 'voice',
            'en-US-Ava:DragonHDLatestNeural');

        // ── Fast Voice ──
        const fastGroup = new Adw.PreferencesGroup({
            title: 'Fast Voice',
            description: 'Low-latency neural voice for quick responses (~120ms).',
        });
        page.add(fastGroup);

        this._addEntryRow(fastGroup, 'Fast Voice Name', 'fast_voice',
            'en-US-AvaNeural');

        // ── Common voices reference ──
        const refGroup = new Adw.PreferencesGroup({
            title: 'Common Voice Names',
            description: [
                'HD: en-US-Ava:DragonHDLatestNeural, en-US-Andrew:DragonHDLatestNeural,',
                'en-US-Brian:DragonHDLatestNeural, en-US-Emma:DragonHDLatestNeural',
                '',
                'Fast: en-US-AvaNeural, en-US-AndrewNeural, en-US-JennyNeural,',
                'en-US-GuyNeural, en-US-DavisNeural, en-US-AriaNeural',
            ].join('\n'),
        });
        page.add(refGroup);

        // ── Speech Parameters ──
        const paramGroup = new Adw.PreferencesGroup({
            title: 'Speech Parameters',
        });
        page.add(paramGroup);

        this._addSpinRow(paramGroup, 'Speed', 'speed',
            0.5, 3.0, 0.1, 1, 1.0);

        this._addComboRow(paramGroup, 'Pitch', 'pitch', [
            ['default', 'Default'],
            ['x-low', 'Extra Low'],
            ['low', 'Low'],
            ['medium', 'Medium'],
            ['high', 'High'],
            ['x-high', 'Extra High'],
        ], 'default');

        this._addComboRow(paramGroup, 'Volume', 'volume', [
            ['default', 'Default'],
            ['silent', 'Silent'],
            ['x-soft', 'Extra Soft'],
            ['soft', 'Soft'],
            ['medium', 'Medium'],
            ['loud', 'Loud'],
            ['x-loud', 'Extra Loud'],
        ], 'default');

        window.add(page);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Page 3 — Listening / STT
    // ═══════════════════════════════════════════════════════════════════
    _addListeningPage(window) {
        const page = new Adw.PreferencesPage({
            title: 'Listening',
            icon_name: 'audio-input-microphone-symbolic',
        });

        // ── Dictation ──
        const dictGroup = new Adw.PreferencesGroup({
            title: 'Dictation',
            description: 'When enabled, transcribed speech is typed at the cursor position using wtype (Wayland) or xdotool (X11). When disabled, text is copied to clipboard only.',
        });
        page.add(dictGroup);

        this._addSwitchRow(dictGroup, 'Type at Cursor',
            'Type transcribed text where the cursor is',
            'dictation_mode', true);

        this._addSwitchRow(dictGroup, 'Continuous Dictation',
            'Automatically restart listening after each utterance',
            'continuous_dictation', false);

        this._addSwitchRow(dictGroup, 'Voice Commands',
            'Convert spoken punctuation (period, comma, etc.) to characters',
            'voice_commands', true);

        // ── Timing ──
        const timingGroup = new Adw.PreferencesGroup({
            title: 'Timing',
            description: 'Control when recording starts and stops.',
        });
        page.add(timingGroup);

        this._addSpinRow(timingGroup, 'Silence Timeout', 'silence_timeout',
            0.5, 10.0, 0.5, 1, 3.0,
            'Seconds of silence after speech before auto-stop');

        this._addSpinRow(timingGroup, 'No Speech Timeout', 'no_speech_timeout',
            1.0, 30.0, 1.0, 0, 7.0,
            'Max seconds to wait for any speech');

        this._addSpinRow(timingGroup, 'Talk Silence Timeout', 'talk_silence_timeout',
            0.5, 10.0, 0.5, 1, 4.0,
            'Silence timeout for talk/converse mode');

        this._addSpinRow(timingGroup, 'Max Record Seconds', 'max_record_seconds',
            5, 300, 5, 0, 120,
            'Absolute maximum recording duration');

        // ── Detection ──
        const detectGroup = new Adw.PreferencesGroup({
            title: 'Detection',
            description: 'Fine-tune speech detection sensitivity.',
        });
        page.add(detectGroup);

        this._addEntryRow(detectGroup, 'End Word', 'end_word', 'over',
            'Say this word at the end of a sentence to immediately stop recording. Leave empty to disable.');

        this._addSpinRow(detectGroup, 'VAD Aggressiveness', 'vad_aggressiveness',
            0, 3, 1, 0, 3,
            '0 = least aggressive, 3 = most aggressive noise rejection');

        this._addSpinRow(detectGroup, 'Energy Multiplier', 'energy_multiplier',
            0.5, 20.0, 0.5, 1, 2.5,
            'Noise gate threshold multiplier. Lower = more sensitive to quiet speech');

        // ── Language ──
        const langGroup = new Adw.PreferencesGroup({
            title: 'Language',
        });
        page.add(langGroup);

        this._addEntryRow(langGroup, 'STT Language', 'language', 'en-US',
            'BCP-47 language code for speech recognition (e.g. en-US, de-DE, ja-JP)');

        window.add(page);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Page 4 — Audio Devices
    // ═══════════════════════════════════════════════════════════════════
    _addAudioPage(window) {
        const page = new Adw.PreferencesPage({
            title: 'Audio',
            icon_name: 'audio-card-symbolic',
        });

        // ── Playback ──
        const playGroup = new Adw.PreferencesGroup({
            title: 'Playback',
        });
        page.add(playGroup);

        this._addComboRow(playGroup, 'Player', 'player', [
            ['auto', 'Auto-detect'],
            ['aplay', 'aplay (ALSA)'],
            ['pw-play', 'pw-play (PipeWire)'],
            ['pw-cat', 'pw-cat (PipeWire)'],
            ['ffplay', 'ffplay (FFmpeg)'],
        ], 'auto');

        this._addEntryRow(playGroup, 'Speaker Sink', 'speaker_sink', '',
            'PipeWire node name or ID for output. Leave empty for default.');

        // ── Recording ──
        const recGroup = new Adw.PreferencesGroup({
            title: 'Recording',
        });
        page.add(recGroup);

        this._addComboRow(recGroup, 'Recorder', 'recorder', [
            ['auto', 'Auto-detect'],
            ['pw-record', 'pw-record (PipeWire)'],
            ['arecord', 'arecord (ALSA)'],
        ], 'auto');

        this._addEntryRow(recGroup, 'Mic Source', 'mic_source', '',
            'PipeWire node name or ID for microphone input. Leave empty for default.');

        // ── Duplex ──
        const duplexGroup = new Adw.PreferencesGroup({
            title: 'Duplex Mode',
            description: 'Controls whether TTS and STT can run simultaneously.',
        });
        page.add(duplexGroup);

        this._addComboRow(duplexGroup, 'Half Duplex', 'half_duplex', [
            ['auto', 'Auto (speakers→half, headphones→full)'],
            ['true', 'Force Half Duplex (speak then listen)'],
            ['false', 'Force Full Duplex (simultaneous)'],
        ], 'auto');

        window.add(page);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Page 5 — Feedback (Chimes & Visual)
    // ═══════════════════════════════════════════════════════════════════
    _addFeedbackPage(window) {
        const page = new Adw.PreferencesPage({
            title: 'Feedback',
            icon_name: 'preferences-desktop-notifications-symbolic',
        });

        // ── Sound Chimes ──
        const chimeGroup = new Adw.PreferencesGroup({
            title: 'Sound Chimes',
            description: 'Audio feedback cues during speech operations.',
        });
        page.add(chimeGroup);

        this._addSwitchRow(chimeGroup, 'Ready Chime',
            'Play ascending tone when microphone opens',
            'chime_ready', true);

        this._addSwitchRow(chimeGroup, 'Processing Chime',
            'Play blip when speech is recognized',
            'chime_processing', false);

        this._addSwitchRow(chimeGroup, 'Speak Chime',
            'Play descending tone before TTS starts',
            'chime_speak', false);

        this._addSwitchRow(chimeGroup, 'Done Chime',
            'Play double-tap tone when TTS finishes',
            'chime_done', false);

        this._addSwitchRow(chimeGroup, 'Thinking Hum',
            'Play looping 150Hz hum while processing',
            'chime_hum', false);

        // ── Visual Feedback ──
        const visualGroup = new Adw.PreferencesGroup({
            title: 'Visual Feedback',
        });
        page.add(visualGroup);

        this._addSwitchRow(visualGroup, 'Live Subtitles',
            'Show real-time transcription text',
            'live_subtitles', true);

        this._addSwitchRow(visualGroup, 'VU Meter',
            'Show volume meter animation during audio',
            'vu_meter', true);

        this._addSwitchRow(visualGroup, 'Visual Indicator',
            'Show status icons in terminal',
            'visual_indicator', true);

        // ── Subtitle Colors ──
        const colorGroup = new Adw.PreferencesGroup({
            title: 'Subtitle Colors',
        });
        page.add(colorGroup);

        this._addComboRow(colorGroup, 'User Speech Color', 'subtitle_color_user',
            SUBTITLE_COLORS, 'light_green');

        this._addComboRow(colorGroup, 'TTS Speech Color', 'subtitle_color_tts',
            SUBTITLE_COLORS, 'amber');

        window.add(page);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Page 6 — Extension Settings (GSettings)
    // ═══════════════════════════════════════════════════════════════════
    _addExtensionPage(window) {
        const page = new Adw.PreferencesPage({
            title: 'Extension',
            icon_name: 'preferences-system-symbolic',
        });

        // ── Badge ──
        const badgeGroup = new Adw.PreferencesGroup({
            title: 'Floating Badge',
            description: 'The floating voice-status badge on your desktop.',
        });
        page.add(badgeGroup);

        this._addGSettingsSwitchRow(badgeGroup, 'Show Badge',
            'Display the floating badge on the desktop',
            'show-badge');

        this._addGSettingsSpinRow(badgeGroup, 'Position X', 'badge-position-x',
            -1, 5000, 1, 0,
            '-1 for auto-center');

        this._addGSettingsSpinRow(badgeGroup, 'Position Y', 'badge-position-y',
            -1, 5000, 1, 0,
            '-1 for auto-position at bottom');

        // ── Panel ──
        const panelGroup = new Adw.PreferencesGroup({
            title: 'Panel Indicator',
        });
        page.add(panelGroup);

        this._addGSettingsSwitchRow(panelGroup, 'Show Panel Indicator',
            'Display GNOME Speaks in the top panel',
            'show-panel-indicator');

        // ── Keyboard Shortcuts ──
        const shortcutGroup = new Adw.PreferencesGroup({
            title: 'Keyboard Shortcuts',
            description: 'Global shortcuts. Change via GNOME Settings > Keyboard > Custom Shortcuts, or edit dconf directly.',
        });
        page.add(shortcutGroup);

        this._addShortcutRow(shortcutGroup, 'Toggle Listening', 'toggle-listening-shortcut');
        this._addShortcutRow(shortcutGroup, 'Speak Clipboard', 'speak-clipboard-shortcut');
        this._addShortcutRow(shortcutGroup, 'Read Selection', 'read-selection-shortcut');

        // ── Behavior ──
        const behaviorGroup = new Adw.PreferencesGroup({
            title: 'Behavior',
        });
        page.add(behaviorGroup);

        this._addGSettingsSpinRow(behaviorGroup, 'Auto-stop Silence (s)',
            'auto-stop-silence-seconds', 1, 10, 1, 0,
            'Seconds of silence before auto-stop listening');

        window.add(page);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Page 7 — Advanced
    // ═══════════════════════════════════════════════════════════════════
    _addAdvancedPage(window) {
        const page = new Adw.PreferencesPage({
            title: 'Advanced',
            icon_name: 'preferences-other-symbolic',
        });

        // ── Debug ──
        const debugGroup = new Adw.PreferencesGroup({
            title: 'Debug',
        });
        page.add(debugGroup);

        this._addSwitchRow(debugGroup, 'Debug Mode',
            'Write detailed logs to /tmp/speech-debug.log',
            'debug', false);

        // ── Barge-in ──
        const bargeGroup = new Adw.PreferencesGroup({
            title: 'Barge-in (Experimental)',
            description: 'Allow your voice to interrupt TTS playback.',
        });
        page.add(bargeGroup);

        this._addSwitchRow(bargeGroup, 'Enable Barge-in',
            'Pause TTS when you start speaking',
            'enable_barge_in', false);

        this._addSpinRow(bargeGroup, 'Barge-in Frames', 'barge_in_frames',
            1, 20, 1, 0, 3,
            'Speech frames needed to trigger barge-in');

        this._addSpinRow(bargeGroup, 'Barge-in Silence', 'barge_in_silence',
            0.3, 10.0, 0.1, 1, 1.0,
            'Seconds of silence before resuming TTS');

        this._addSwitchRow(bargeGroup, 'Barge-in Chime',
            'Play chime when barge-in is detected',
            'chime_barge_in', true);

        // ── Conversation Mode ──
        const convGroup = new Adw.PreferencesGroup({
            title: 'Conversation Mode',
            description: 'Voice chat: your speech is sent to an LLM, and the response is spoken back.',
        });
        page.add(convGroup);

        this._addSwitchRow(convGroup, 'Enable Conversation Mode',
            'Send transcriptions to LLM and speak the response',
            'conversation_mode', false);

        this._addComboRow(convGroup, 'LLM Provider', 'llm_provider', [
            ['anthropic', 'Anthropic (Claude)'],
            ['openai', 'OpenAI (GPT)'],
        ], 'anthropic');

        this._addPasswordRow(convGroup, 'LLM API Key', 'llm_api_key',
            'API key for the selected LLM provider');

        this._addEntryRow(convGroup, 'LLM Model', 'llm_model', 'claude-sonnet-4-20250514',
            'Model to use for conversation');

        this._addEntryRow(convGroup, 'System Prompt', 'llm_system_prompt',
            'You are a helpful voice assistant. Keep responses concise and conversational.',
            'Instructions for the LLM persona');

        // ── Notification Reader ──
        const notifGroup = new Adw.PreferencesGroup({
            title: 'Notification Reader',
            description: 'Automatically read GNOME notifications aloud.',
        });
        page.add(notifGroup);

        this._addSwitchRow(notifGroup, 'Read Notifications',
            'Speak notification titles and body text as they arrive',
            'read_notifications', false);

        // ── Auto-Corrections ──
        const correctGroup = new Adw.PreferencesGroup({
            title: 'Auto-Corrections',
            description: 'Custom word replacements applied to transcriptions. Format: wrong=right, one per line.',
        });
        page.add(correctGroup);

        this._addCorrectionsRow(correctGroup);

        // ── Other ──
        const otherGroup = new Adw.PreferencesGroup({
            title: 'Other',
        });
        page.add(otherGroup);

        this._addSwitchRow(otherGroup, 'Echo Cancellation',
            'Use PipeWire echo cancellation nodes if available',
            'enable_echo_cancel', true);

        this._addSwitchRow(otherGroup, 'Enable Pause',
            'Allow pausing and resuming playback',
            'enable_pause', true);

        // ── Service Management ──
        const serviceGroup = new Adw.PreferencesGroup({
            title: 'Service',
            description: 'Restart to apply config.json changes to the running speech service.',
        });
        page.add(serviceGroup);

        const restartRow = new Adw.ActionRow({
            title: 'Restart Speech Service',
            subtitle: 'systemctl --user restart gnome-speaks.service',
        });
        const restartButton = new Gtk.Button({
            label: 'Restart',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        restartButton.connect('clicked', () => this._restartService(restartButton));
        restartRow.add_suffix(restartButton);
        restartRow.set_activatable_widget(restartButton);
        serviceGroup.add(restartRow);

        window.add(page);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Widget Helpers — config.json backed
    // ═══════════════════════════════════════════════════════════════════

    _addComboRow(group, title, configKey, options, defaultValue) {
        // options: [[value, label], ...]
        const values = options.map(o => o[0]);
        const labels = options.map(o => o[1]);

        const currentValue = this._config[configKey] ?? defaultValue;
        let selectedIdx = values.findIndex(v => String(v) === String(currentValue));
        if (selectedIdx < 0) selectedIdx = 0;

        const model = Gtk.StringList.new(labels);
        const row = new Adw.ComboRow({
            title: title,
            model: model,
            selected: selectedIdx,
        });

        row.connect('notify::selected', () => {
            const idx = row.get_selected();
            if (idx >= 0 && idx < values.length)
                this._setConfigValue(configKey, values[idx]);
        });

        group.add(row);
        return row;
    }

    _addRegionCombo(group, title, configKey, subtitle, defaultValue) {
        const regions = [...REGIONS];
        const currentValue = this._config[configKey] || defaultValue;

        // Add current value if custom (not in preset list)
        if (currentValue && !regions.find(r => r[0] === currentValue))
            regions.push([currentValue, `${currentValue} (custom)`]);

        // For optional fields, add "none" option
        if (defaultValue === '')
            regions.unshift(['', 'Same as primary region']);

        const values = regions.map(r => r[0]);
        const labels = regions.map(r => r[0] ? `${r[1]} (${r[0]})` : r[1]);

        let selectedIdx = values.indexOf(currentValue);
        if (selectedIdx < 0) selectedIdx = 0;

        const model = Gtk.StringList.new(labels);
        const row = new Adw.ComboRow({
            title: title,
            subtitle: subtitle || '',
            model: model,
            selected: selectedIdx,
        });

        row.connect('notify::selected', () => {
            const idx = row.get_selected();
            if (idx >= 0 && idx < values.length) {
                const val = values[idx];
                if (val === '')
                    this._deleteConfigKey(configKey);
                else
                    this._setConfigValue(configKey, val);
            }
        });

        group.add(row);
        return row;
    }

    _addSwitchRow(group, title, subtitle, configKey, defaultValue) {
        const currentValue = this._config[configKey] ?? defaultValue;
        const row = new Adw.SwitchRow({
            title: title,
            subtitle: subtitle || '',
            active: !!currentValue,
        });

        row.connect('notify::active', () => {
            this._setConfigValue(configKey, row.active);
        });

        group.add(row);
        return row;
    }

    _addSpinRow(group, title, configKey, lower, upper, step, digits, defaultValue, subtitle) {
        const currentValue = this._config[configKey] ?? defaultValue;
        const adjustment = new Gtk.Adjustment({
            lower: lower,
            upper: upper,
            step_increment: step,
            page_increment: step * 10,
            value: currentValue,
        });

        const row = new Adw.SpinRow({
            title: title,
            subtitle: subtitle || '',
            adjustment: adjustment,
            digits: digits,
            value: currentValue,
        });

        row.connect('notify::value', () => {
            const val = digits > 0
                ? Math.round(row.value * Math.pow(10, digits)) / Math.pow(10, digits)
                : Math.round(row.value);
            this._setConfigValue(configKey, val);
        });

        group.add(row);
        return row;
    }

    _addEntryRow(group, title, configKey, defaultValue, description) {
        const currentValue = this._config[configKey] ?? defaultValue;
        const row = new Adw.EntryRow({
            title: title,
            text: currentValue != null ? String(currentValue) : '',
            show_apply_button: true,
        });

        if (description) {
            // Wrap in an ExpanderRow for description, or use group description
            // For simplicity, show as subtitle via ActionRow approach
        }

        row.connect('apply', () => {
            const text = row.get_text().trim();
            if (text === '')
                this._deleteConfigKey(configKey);
            else
                this._setConfigValue(configKey, text);
        });

        group.add(row);
        return row;
    }

    _addPasswordRow(group, title, configKey, subtitle) {
        const currentValue = this._config[configKey] || '';

        let row;
        try {
            row = new Adw.PasswordEntryRow({
                title: title,
                text: currentValue,
                show_apply_button: true,
            });
        } catch (e) {
            // Fallback for older Adw without PasswordEntryRow
            row = new Adw.EntryRow({
                title: title,
                text: currentValue,
                show_apply_button: true,
            });
        }

        row.connect('apply', () => {
            const text = row.get_text().trim();
            if (text === '')
                this._deleteConfigKey(configKey);
            else
                this._setConfigValue(configKey, text);
        });

        if (subtitle) {
            const wrapper = new Adw.PreferencesGroup({description: subtitle});
            wrapper.add(row);
            group.add(wrapper);
            return row;
        }

        group.add(row);
        return row;
    }

    _addCorrectionsRow(group) {
        const corrections = this._config['auto_corrections'] || {};
        const text = Object.entries(corrections)
            .map(([wrong, right]) => `${wrong}=${right}`)
            .join('\n');

        const row = new Adw.ActionRow({
            title: 'Edit Corrections',
            subtitle: `${Object.keys(corrections).length} corrections defined`,
        });

        const editButton = new Gtk.Button({
            label: 'Edit',
            valign: Gtk.Align.CENTER,
        });

        editButton.connect('clicked', () => {
            const dialog = new Gtk.Dialog({
                title: 'Auto-Corrections',
                modal: true,
                default_width: 400,
                default_height: 300,
            });

            const textView = new Gtk.TextView({
                editable: true,
                wrap_mode: Gtk.WrapMode.WORD,
                monospace: true,
                top_margin: 8,
                bottom_margin: 8,
                left_margin: 8,
                right_margin: 8,
            });
            textView.buffer.set_text(text, -1);

            const scrolled = new Gtk.ScrolledWindow({
                child: textView,
                vexpand: true,
                hexpand: true,
            });

            const box = dialog.get_content_area();
            const label = new Gtk.Label({
                label: 'One correction per line: wrong=right',
                halign: Gtk.Align.START,
                margin_start: 8,
                margin_top: 8,
            });
            box.append(label);
            box.append(scrolled);

            dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
            dialog.add_button('Save', Gtk.ResponseType.OK);

            dialog.connect('response', (dlg, response) => {
                if (response === Gtk.ResponseType.OK) {
                    let [start, end] = textView.buffer.get_bounds();
                    let newText = textView.buffer.get_text(start, end, false);
                    let newCorrections = {};
                    for (let line of newText.split('\n')) {
                        line = line.trim();
                        if (!line || !line.includes('=')) continue;
                        let [wrong, ...rightParts] = line.split('=');
                        newCorrections[wrong.trim()] = rightParts.join('=').trim();
                    }
                    this._setConfigValue('auto_corrections', newCorrections);
                    row.subtitle = `${Object.keys(newCorrections).length} corrections defined`;
                }
                dlg.destroy();
            });

            dialog.present();
        });

        row.add_suffix(editButton);
        row.set_activatable_widget(editButton);
        group.add(row);
    }

    _addShortcutRow(group, title, settingsKey) {
        const shortcuts = this._settings.get_strv(settingsKey);
        const currentShortcut = shortcuts.length > 0 ? shortcuts[0] : 'Disabled';

        const row = new Adw.ActionRow({
            title: title,
            subtitle: currentShortcut,
        });

        const editButton = new Gtk.Button({
            label: 'Change',
            valign: Gtk.Align.CENTER,
        });

        editButton.connect('clicked', () => {
            const dialog = new Adw.MessageDialog({
                heading: `Set shortcut for "${title}"`,
                body: 'Enter a keyboard shortcut (e.g. <Super><Alt>space):',
                modal: true,
            });

            const entry = new Gtk.Entry({
                text: currentShortcut,
                margin_start: 16,
                margin_end: 16,
                margin_bottom: 8,
            });
            dialog.set_extra_child(entry);

            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('save', 'Save');
            dialog.add_response('disable', 'Disable');
            dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);

            dialog.connect('response', (dlg, response) => {
                if (response === 'save') {
                    let val = entry.get_text().trim();
                    if (val) {
                        this._settings.set_strv(settingsKey, [val]);
                        row.subtitle = val;
                    }
                } else if (response === 'disable') {
                    this._settings.set_strv(settingsKey, []);
                    row.subtitle = 'Disabled';
                }
            });

            dialog.present();
        });

        row.add_suffix(editButton);
        row.set_activatable_widget(editButton);
        group.add(row);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Widget Helpers — GSettings backed (extension settings)
    // ═══════════════════════════════════════════════════════════════════

    _addGSettingsSwitchRow(group, title, subtitle, settingsKey) {
        const row = new Adw.SwitchRow({
            title: title,
            subtitle: subtitle || '',
            active: this._settings.get_boolean(settingsKey),
        });

        this._settings.bind(settingsKey, row, 'active',
            Gio.SettingsBindFlags.DEFAULT);

        group.add(row);
        return row;
    }

    _addGSettingsSpinRow(group, title, settingsKey, lower, upper, step, digits, subtitle) {
        const adjustment = new Gtk.Adjustment({
            lower: lower,
            upper: upper,
            step_increment: step,
            page_increment: step * 10,
            value: this._settings.get_int(settingsKey),
        });

        const row = new Adw.SpinRow({
            title: title,
            subtitle: subtitle || '',
            adjustment: adjustment,
            digits: digits,
            value: this._settings.get_int(settingsKey),
        });

        row.connect('notify::value', () => {
            this._settings.set_int(settingsKey, Math.round(row.value));
        });

        group.add(row);
        return row;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Config I/O — ~/.config/speech-to-cli/config.json
    // ═══════════════════════════════════════════════════════════════════

    _loadConfig() {
        const path = GLib.build_filenamev([
            GLib.get_home_dir(), '.config', 'speech-to-cli', 'config.json',
        ]);
        try {
            const [ok, contents] = GLib.file_get_contents(path);
            if (ok) {
                const decoder = new TextDecoder('utf-8');
                return JSON.parse(decoder.decode(contents));
            }
        } catch (e) {
            // File doesn't exist or parse error — start fresh
        }
        return {};
    }

    _saveConfig() {
        const dir = GLib.build_filenamev([
            GLib.get_home_dir(), '.config', 'speech-to-cli',
        ]);
        GLib.mkdir_with_parents(dir, 0o755);

        const path = GLib.build_filenamev([dir, 'config.json']);
        const json = JSON.stringify(this._config, null, 2) + '\n';
        const encoder = new TextEncoder();
        GLib.file_set_contents(path, encoder.encode(json));
    }

    _setConfigValue(key, value) {
        this._config[key] = value;
        this._scheduleConfigSave();
    }

    _deleteConfigKey(key) {
        delete this._config[key];
        this._scheduleConfigSave();
    }

    _scheduleConfigSave() {
        if (this._saveTimeoutId) {
            GLib.Source.remove(this._saveTimeoutId);
            this._saveTimeoutId = null;
        }
        this._saveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._saveConfig();
            this._saveTimeoutId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushConfigSave() {
        if (this._saveTimeoutId) {
            GLib.Source.remove(this._saveTimeoutId);
            this._saveTimeoutId = null;
            this._saveConfig();
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Service Management
    // ═══════════════════════════════════════════════════════════════════

    _restartService(button) {
        button.set_sensitive(false);
        button.set_label('Restarting...');

        try {
            const [ok] = GLib.spawn_command_line_async(
                'systemctl --user restart gnome-speaks.service'
            );
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                button.set_label('Restart');
                button.set_sensitive(true);
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            button.set_label('Failed');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                button.set_label('Restart');
                button.set_sensitive(true);
                return GLib.SOURCE_REMOVE;
            });
        }
    }
}
