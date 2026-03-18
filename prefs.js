// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME Speaks — TTS/STT floating badge for GNOME Shell
// Copyright (C) 2025 JP Hein
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

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

        this._addComboRow(hdGroup, 'HD Voice Name', 'voice', [
            ['en-US-Ava:DragonHDLatestNeural', 'Ava (DragonHD)'],
            ['en-US-Andrew:DragonHDLatestNeural', 'Andrew (DragonHD)'],
            ['en-US-Brian:DragonHDLatestNeural', 'Brian (DragonHD)'],
            ['en-US-Emma:DragonHDLatestNeural', 'Emma (DragonHD)'],
            ['en-US-Aria:DragonHDLatestNeural', 'Aria (DragonHD)'],
            ['en-US-Davis:DragonHDLatestNeural', 'Davis (DragonHD)'],
            ['en-US-Jenny:DragonHDLatestNeural', 'Jenny (DragonHD)'],
            ['en-US-Guy:DragonHDLatestNeural', 'Guy (DragonHD)'],
            ['en-US-Steffan:DragonHDLatestNeural', 'Steffan (DragonHD)'],
            ['en-US-Christopher:DragonHDLatestNeural', 'Christopher (DragonHD)'],
            ['en-US-Eric:DragonHDLatestNeural', 'Eric (DragonHD)'],
            ['en-US-Roger:DragonHDLatestNeural', 'Roger (DragonHD)'],
            ['en-US-Alloy:DragonHDLatestNeural', 'Alloy (DragonHD)'],
            ['en-US-Echo:DragonHDLatestNeural', 'Echo (DragonHD)'],
            ['en-US-Fable:DragonHDLatestNeural', 'Fable (DragonHD)'],
            ['en-US-Onyx:DragonHDLatestNeural', 'Onyx (DragonHD)'],
            ['en-US-Nova:DragonHDLatestNeural', 'Nova (DragonHD)'],
            ['en-US-Shimmer:DragonHDLatestNeural', 'Shimmer (DragonHD)'],
        ], 'en-US-Ava:DragonHDLatestNeural');

        // ── Fast Voice ──
        const fastGroup = new Adw.PreferencesGroup({
            title: 'Fast Voice',
            description: 'Low-latency neural voice for quick responses (~120ms).',
        });
        page.add(fastGroup);

        this._addComboRow(fastGroup, 'Fast Voice Name', 'fast_voice', [
            ['en-US-AvaNeural', 'Ava'],
            ['en-US-AndrewNeural', 'Andrew'],
            ['en-US-AriaNeural', 'Aria'],
            ['en-US-DavisNeural', 'Davis'],
            ['en-US-JennyNeural', 'Jenny'],
            ['en-US-GuyNeural', 'Guy'],
            ['en-US-BrianNeural', 'Brian'],
            ['en-US-EmmaNeural', 'Emma'],
            ['en-US-SteffanNeural', 'Steffan'],
            ['en-US-ChristopherNeural', 'Christopher'],
            ['en-US-EricNeural', 'Eric'],
            ['en-US-RogerNeural', 'Roger'],
            ['en-US-MichelleNeural', 'Michelle'],
            ['en-US-MonicaNeural', 'Monica'],
            ['en-US-CoraNeural', 'Cora'],
            ['en-US-JaneNeural', 'Jane'],
            ['en-US-NancyNeural', 'Nancy'],
            ['en-US-SaraNeural', 'Sara'],
            ['en-US-TonyNeural', 'Tony'],
            ['en-US-JasonNeural', 'Jason'],
            ['en-US-BrandonNeural', 'Brandon'],
            ['en-US-JacobNeural', 'Jacob'],
            ['en-US-AmberNeural', 'Amber'],
            ['en-US-AshleyNeural', 'Ashley'],
            ['en-US-ElizabethNeural', 'Elizabeth'],
        ], 'en-US-AvaNeural');

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

        // Enumerate PipeWire sinks and sources for device menus
        const sinks = this._enumeratePipeWireDevices('sinks');
        const sources = this._enumeratePipeWireDevices('sources');

        // ── Playback ──
        const playGroup = new Adw.PreferencesGroup({
            title: 'Playback',
        });
        page.add(playGroup);

        const playerOptions = [['auto', 'Auto-detect']];
        for (const [cmd, label] of [
            ['aplay', 'aplay (ALSA)'],
            ['pw-play', 'pw-play (PipeWire)'],
            ['pw-cat', 'pw-cat (PipeWire)'],
            ['ffplay', 'ffplay (FFmpeg)'],
        ]) {
            if (this._commandExists(cmd))
                playerOptions.push([cmd, label]);
            else
                playerOptions.push([cmd, `${label} — not found`]);
        }
        this._addComboRow(playGroup, 'Player', 'player', playerOptions, 'auto');

        this._addComboRow(playGroup, 'Speaker', 'speaker_sink',
            [['', 'System Default'], ...sinks], '');

        // ── Recording ──
        const recGroup = new Adw.PreferencesGroup({
            title: 'Recording',
        });
        page.add(recGroup);

        const recorderOptions = [['auto', 'Auto-detect']];
        for (const [cmd, label] of [
            ['pw-record', 'pw-record (PipeWire)'],
            ['arecord', 'arecord (ALSA)'],
        ]) {
            if (this._commandExists(cmd))
                recorderOptions.push([cmd, label]);
            else
                recorderOptions.push([cmd, `${label} — not found`]);
        }
        this._addComboRow(recGroup, 'Recorder', 'recorder', recorderOptions, 'auto');

        this._addComboRow(recGroup, 'Microphone', 'mic_source',
            [['', 'System Default'], ...sources], '');

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

    /**
     * Enumerate PipeWire sinks or sources by parsing `wpctl status`.
     * Returns [[nodeId, label], ...] suitable for _addComboRow.
     */
    _enumeratePipeWireDevices(type) {
        const devices = [];
        try {
            const [ok, stdout, stderr, exitCode] = GLib.spawn_command_line_sync('wpctl status');
            if (!ok || exitCode !== 0) return devices;

            const output = new TextDecoder('utf-8').decode(stdout);
            const lines = output.split('\n');

            // Find the section header: "Sinks:" or "Sources:" within the Audio block
            const header = type === 'sinks' ? 'Sinks:' : 'Sources:';
            let inAudio = false;
            let inSection = false;

            for (const line of lines) {
                const trimmed = line.trim();

                // Track whether we are inside the "Audio" top-level block so
                // we don't accidentally match Video sinks/sources.
                if (trimmed === 'Audio') {
                    inAudio = true;
                    continue;
                }
                if (inAudio && /^(Video|Settings)$/.test(trimmed)) {
                    break;           // left the Audio block
                }
                if (!inAudio) continue;

                if (trimmed.endsWith(header)) {
                    inSection = true;
                    continue;
                }

                // Stop at next sub-section (empty pipe line, blank line, or a
                // new header such as "Sink endpoints:" / "Streams:")
                if (inSection && (trimmed === '│' || trimmed === '' ||
                    (trimmed.endsWith(':') && !trimmed.match(/^\d/)))) {
                    break;
                }

                if (!inSection) continue;

                // Strip leading box-drawing characters (│ ├ └ ─ etc.) so the
                // regex only sees the device text, e.g.:
                //   "│      35. USB Audio Device Analog Stereo      [vol: 0.19]"
                //   "│  *   55. Built-in Audio Analog Stereo        [vol: 0.65]"
                const stripped = trimmed.replace(/^[│├└─┬┤┼╌╎\s]+/, '');

                // Match: optional "*", node ID, name, and optional "[...]" tail
                const match = stripped.match(/^(\*?)\s*(\d+)\.\s+(.+?)(?:\s+\[.*\])?\s*$/);
                if (match) {
                    const isDefault = match[1] === '*';
                    const nodeId = match[2];
                    const name = match[3].trim();
                    const label = isDefault ? `${name} (default)` : name;
                    devices.push([nodeId, label]);
                }
            }
        } catch (e) {
            // wpctl not available — return empty list
        }
        return devices;
    }

    /**
     * Check if a command exists on the system (uses `which`).
     */
    _commandExists(cmd) {
        try {
            const [ok, stdout, stderr, exitCode] = GLib.spawn_command_line_sync(`which ${cmd}`);
            return ok && exitCode === 0;
        } catch (e) {
            return false;
        }
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
            ['anthropic', 'Anthropic (Claude API)'],
            ['openai', 'OpenAI (GPT API)'],
            ['azure', 'Azure AI Foundry'],
            ['bedrock', 'AWS Bedrock'],
            ['google', 'Google Vertex AI'],
            ['cloud-chat-assistant', 'Cloud Chat Assistant (all providers)'],
        ], 'anthropic');

        this._addPasswordRow(convGroup, 'LLM API Key', 'llm_api_key',
            'API key for the selected LLM provider');

        this._addComboRow(convGroup, 'LLM Model', 'llm_model', [
            // Anthropic (Direct API)
            ['claude-opus-4-6', 'Claude Opus 4.6'],
            ['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
            ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
            // OpenAI (Direct API)
            ['gpt-4o', 'GPT-4o'],
            ['gpt-4o-mini', 'GPT-4o Mini'],
            ['o1', 'o1'],
            ['o4-mini', 'o4-mini'],
            ['o3-mini', 'o3-mini'],
            ['gpt-5.3-chat', 'GPT-5.3 Chat'],
            // Azure AI Foundry (Serverless)
            ['grok-3', 'Grok-3 (xAI)'],
            ['grok-3-mini', 'Grok-3 Mini (xAI)'],
            ['DeepSeek-R1', 'DeepSeek R1'],
            ['Meta-Llama-3.1-405B-Instruct', 'Llama 3.1 405B'],
            ['Llama-3.3-70B-Instruct', 'Llama 3.3 70B'],
            ['Llama-4-Scout-17B-16E-Instruct', 'Llama 4 Scout 17B'],
            ['Phi-4', 'Phi-4 (Microsoft)'],
            ['Codestral-2501', 'Codestral 2501 (Mistral)'],
            // AWS Bedrock
            ['claude-opus-4.6', 'Claude Opus 4.6 (Bedrock)'],
            ['claude-sonnet-4.6', 'Claude Sonnet 4.6 (Bedrock)'],
            ['nova-pro', 'Amazon Nova Pro'],
            ['nova-lite', 'Amazon Nova Lite'],
            ['llama4-maverick-17b', 'Llama 4 Maverick 17B (Bedrock)'],
            ['palmyra-x5', 'Palmyra X5 (Writer)'],
            // Google Vertex AI
            ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
            ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
            ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview'],
        ], 'claude-opus-4-6');

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
            if (idx >= 0 && idx < values.length) {
                const val = values[idx];
                if (val === '' || val === null)
                    this._deleteConfigKey(configKey);
                else
                    this._setConfigValue(configKey, val);
            }
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
