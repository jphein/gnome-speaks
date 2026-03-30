# Voice Feedback Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make voice-to-text dictation feel alive — the badge breathes with your voice, subtitles follow the badge as a cohesive widget, and each word appears as you speak it.

**Architecture:** Three layered changes to extension.js and stylesheet.css. (1) A glow ring actor behind the badge modulates opacity/scale with audio level for dramatic breathing feedback. (2) The subtitle overlay repositions itself relative to badge coordinates (above or below depending on screen position), updating on drag. (3) Partial transcription uses word-level diffing with Pango markup to highlight new words as they appear and flash corrected words.

**Tech Stack:** GJS, GNOME Shell (St, Clutter, GLib, Pango markup via ClutterText), GNOME Shell CSS

---

## File Map

| File | Changes |
|------|---------|
| `extension.js` | Glow ring actor lifecycle, audio level visual driver, subtitle anchoring to badge, word-diff partial transcription |
| `stylesheet.css` | Glow ring styles, subtitle anchor positioning tweaks, word highlight styles |

No new files. All changes in the existing two UI files.

---

## Task 1: Audio Level Glow Ring

Create a glow ring actor behind the badge that breathes with voice input. This is the most visible change — the badge goes from subtle scale modulation to a dramatic living glow.

**Files:**
- Modify: `extension.js` — `_createBadge()` (line ~416), `_onAudioLevel()` (line ~1673), `_destroyBadge()` (line ~862), `_positionBadge()` (line ~1060)
- Modify: `stylesheet.css` — add glow ring styles

### Concept

A `St.Bin` actor positioned behind the badge with a large border-radius and colored background. When audio level is 0, it's invisible (opacity 0, scale 1.0). As level increases, opacity rises (0→200) and scale increases (1.0→1.6), creating an expanding, brightening halo effect. The glow color matches the current state (blue for listening, purple for speaking).

- [ ] **Step 1: Add glow ring CSS classes**

In `stylesheet.css`, add after the base `.gnome-speaks-badge` block (after line ~35):

```css
/* ============================================================
   Glow ring — audio-reactive halo behind badge
   ============================================================ */

.gnome-speaks-glow {
    border-radius: 999px;
    background-color: rgba(60, 140, 255, 0.0);
    transition-duration: 0ms;
}

.gnome-speaks-glow-listening {
    background-color: rgba(60, 140, 255, 0.35);
}

.gnome-speaks-glow-speaking {
    background-color: rgba(150, 70, 230, 0.35);
}

.gnome-speaks-glow-processing {
    background-color: rgba(220, 160, 40, 0.35);
}
```

- [ ] **Step 2: Create glow ring actor in `_createBadge()`**

In `extension.js`, inside `_createBadge()`, after badge creation (after line ~424) but BEFORE `Main.layoutManager.addTopChrome()`:

```javascript
// Glow ring — audio-reactive halo behind badge
this._glowRing = new St.Bin({
    style_class: 'gnome-speaks-glow',
    reactive: false,
    can_focus: false,
    opacity: 0,
});
this._glowRing.set_pivot_point(0.5, 0.5);
Main.uiGroup.add_child(this._glowRing);
```

The glow ring goes on `Main.uiGroup` (not as a badge child) so it renders behind the badge without clipping.

- [ ] **Step 3: Position glow ring in `_positionBadge()`**

Add a helper method and call it at the end of `_positionBadge()` and from the drag motion handler:

```javascript
_positionGlowRing() {
    if (!this._glowRing || !this._badge) return;
    let badge = this._badge;
    // Size the glow to 2.5x badge size for visible halo
    let size = Math.max(badge.width, badge.height) * 2.5;
    this._glowRing.set_size(size, size);
    // Center on badge
    this._glowRing.set_position(
        badge.x + badge.width / 2 - size / 2,
        badge.y + badge.height / 2 - size / 2
    );
}
```

Call `this._positionGlowRing()` at the end of `_positionBadge()` (inside the idle callback), and also from the drag motion handler (after badge position update, line ~488).

- [ ] **Step 4: Drive glow from `_onAudioLevel()`**

Replace the current scale-only logic in `_onAudioLevel()` with scale + glow:

```javascript
_onAudioLevel(level) {
    if (this._destroyed) return;
    if (this._state !== States.LISTENING && this._state !== States.SPEAKING)
        return;

    let now = GLib.get_monotonic_time();
    if (this._lastAudioLevelTime && (now - this._lastAudioLevelTime) < 80000)
        return;
    this._lastAudioLevelTime = now;

    // Suspend pulse while audio drives the badge
    if (this._pulseActive) {
        this._pulseActive = false;
        if (this._pulseNextId) {
            this._cancelTimeout('pulse-next');
            this._pulseNextId = null;
        }
        this._badge.remove_all_transitions();
    }

    let clampedLevel = Math.min(level, 1.0);

    // Badge scale: 1.0 to 1.15
    let scale = 1.0 + clampedLevel * 0.15;
    this._badge.set_scale(scale, scale);

    // Glow ring: opacity 0→220, scale 1.0→1.4
    if (this._glowRing) {
        this._glowRing.opacity = Math.floor(clampedLevel * 220);
        let glowScale = 1.0 + clampedLevel * 0.4;
        this._glowRing.set_scale(glowScale, glowScale);
    }

    // Schedule pulse resume after 300ms silence
    this._cancelTimeout('audio-pulse-resume');
    let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        this._removeTimeout('audio-pulse-resume');
        if (this._destroyed || !this._badge) return GLib.SOURCE_REMOVE;
        // Fade glow out
        if (this._glowRing) {
            this._glowRing.ease({
                opacity: 0,
                scale_x: 1.0,
                scale_y: 1.0,
                duration: 400,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        if (this._state === States.LISTENING || this._state === States.SPEAKING)
            this._startPulse();
        return GLib.SOURCE_REMOVE;
    });
    this._trackTimeout(timeoutId, 'audio-pulse-resume');
}
```

- [ ] **Step 5: Update glow color on state change**

In `_setState()`, after adding the new state style class (around line ~1321), update the glow ring class:

```javascript
// Update glow ring color for state
if (this._glowRing) {
    this._glowRing.remove_style_class_name('gnome-speaks-glow-listening');
    this._glowRing.remove_style_class_name('gnome-speaks-glow-speaking');
    this._glowRing.remove_style_class_name('gnome-speaks-glow-processing');
    let glowClass = {
        [States.LISTENING]: 'gnome-speaks-glow-listening',
        [States.SPEAKING]: 'gnome-speaks-glow-speaking',
        [States.PROCESSING]: 'gnome-speaks-glow-processing',
    }[newState];
    if (glowClass) this._glowRing.add_style_class_name(glowClass);
}
```

- [ ] **Step 6: Clean up glow in `_destroyBadge()`**

In `_destroyBadge()`, before badge destruction (around line ~862):

```javascript
if (this._glowRing) {
    this._glowRing.remove_all_transitions();
    Main.uiGroup.remove_child(this._glowRing);
    this._glowRing.destroy();
    this._glowRing = null;
}
```

- [ ] **Step 7: Test audio level glow**

```bash
# Restart service and log in/out to reload extension
systemctl --user restart gnome-speaks.service
# Then log out and log back in (Wayland requires full restart)
# Test: click badge to start listening, speak, observe glow ring
# Verify: glow appears behind badge, scales up with voice volume, fades when silent
```

- [ ] **Step 8: Commit**

```bash
git add extension.js stylesheet.css
git commit -m "feat: add audio-reactive glow ring behind badge for voice feedback"
```

---

## Task 2: Subtitle Anchored to Badge

Move the subtitle overlay from a fixed screen position to being anchored relative to the badge. The subtitle becomes part of the badge "widget" — it follows the badge when dragged and positions above or below based on screen location.

**Files:**
- Modify: `extension.js` — `_createSubtitleOverlay()` (line ~648), `_positionSubtitleOverlay()` (line ~706), `_showSubtitle()` (line ~723), drag motion handler (line ~470)
- Modify: `stylesheet.css` — subtitle overlay positioning adjustments

- [ ] **Step 1: Rewrite `_positionSubtitleOverlay()` to anchor to badge**

Replace the current fixed-position method:

```javascript
_positionSubtitleOverlay() {
    if (!this._subtitleOverlay || !this._badge) return;

    let badge = this._badge;
    let monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;

    let overlayWidth = Math.min(600, monitor.width - 80);
    this._subtitleOverlay.set_style(`max-width: ${overlayWidth}px; min-width: 200px;`);

    // Determine if badge is in top or bottom half of screen
    let badgeCenterY = badge.y + badge.height / 2;
    let screenMidY = monitor.y + monitor.height / 2;
    let showAbove = badgeCenterY > screenMidY;

    // Horizontal: center on badge, clamp to screen
    let overlayX = badge.x + badge.width / 2 - overlayWidth / 2;
    overlayX = Math.max(monitor.x + 20, Math.min(overlayX, monitor.x + monitor.width - overlayWidth - 20));

    // Vertical: 12px gap above or below badge
    let overlayY;
    if (showAbove) {
        // Need to estimate height since allocation may not be ready
        let estHeight = this._subtitleOverlay.height || 60;
        overlayY = badge.y - estHeight - 12;
    } else {
        overlayY = badge.y + badge.height + 12;
    }

    this._subtitleOverlay.set_position(overlayX, overlayY);
}
```

- [ ] **Step 2: Call reposition from drag handler**

In the drag motion handler (around line ~488), after updating badge position, add:

```javascript
this._positionSubtitleOverlay();
this._positionGlowRing();
```

- [ ] **Step 3: Call reposition when showing subtitle**

In `_showSubtitle()`, call `this._positionSubtitleOverlay()` after setting text and before the fade-in ease (around line ~762). This ensures the overlay is correctly sized and positioned before becoming visible:

```javascript
// Reposition after text change (size may have changed)
this._positionSubtitleOverlay();
```

- [ ] **Step 4: Update subtitle CSS for anchored layout**

In `stylesheet.css`, update `.gnome-speaks-subtitle-overlay` to remove fixed bottom positioning and add a subtle connection to the badge:

```css
.gnome-speaks-subtitle-overlay {
    background-color: rgba(20, 12, 36, 0.88);
    border: 1px solid rgba(160, 120, 255, 0.15);
    border-radius: 14px;
    padding: 10px 20px;
    text-align: center;
}
```

Remove any `margin-bottom` or fixed positioning properties that exist.

- [ ] **Step 5: Test anchored subtitles**

```bash
systemctl --user restart gnome-speaks.service
# Log out/in to reload extension
# Test: start listening, speak, verify subtitle appears near badge
# Test: drag badge to top of screen, verify subtitle appears below
# Test: drag badge to bottom, verify subtitle appears above
# Test: drag badge to left/right edges, verify subtitle stays on screen
```

- [ ] **Step 6: Commit**

```bash
git add extension.js stylesheet.css
git commit -m "feat: anchor subtitle overlay to badge position"
```

---

## Task 3: Word-by-Word Reveal

Replace the full-text-replacement partial transcription with word-level diffing. New words appear highlighted, corrected words flash, giving real-time confidence that "it's hearing my exact words."

**Files:**
- Modify: `extension.js` — `_showPartialTranscription()` (line ~1551), `_showSubtitle()` (line ~723), `_setState()` for reset, add new `_buildWordMarkup()` helper
- Modify: `stylesheet.css` — word highlight styles

### Concept

Azure sends partial hypotheses that grow word by word: `"hello"` → `"hello how"` → `"hello how are"`. We split into word arrays, diff against previous, and build Pango markup where:
- **Settled words** (unchanged from previous): default color
- **New words** (appended): bright highlight color + bold
- **Corrected words** (changed position): brief flash via different highlight

ClutterText supports `set_markup()` for Pango markup, which St.Label wraps.

- [ ] **Step 1: Add word highlight CSS and markup colors**

No CSS needed — Pango markup handles colors inline. But define the color constants in extension.js near the top (after STATE_CONFIG, around line ~155):

```javascript
// Word-reveal markup colors (Pango span attributes)
const WORD_COLOR_SETTLED = '#e8e0f0';      // soft cream — matches subtitle text
const WORD_COLOR_NEW = '#88ccff';          // bright blue — new words
const WORD_COLOR_CORRECTED = '#ffcc66';    // warm amber — corrected words
```

- [ ] **Step 2: Add word tracking state**

In `enable()` (around line ~190, near other state variables):

```javascript
this._previousWords = [];
this._wordHighlights = [];  // [{index, type, time}] for active highlights
```

- [ ] **Step 3: Write `_buildWordMarkup()` helper**

Add a new method that diffs word arrays and builds Pango markup:

```javascript
_buildWordMarkup(newText) {
    let newWords = newText.trim().split(/\s+/).filter(w => w.length > 0);
    let prevWords = this._previousWords || [];
    let now = GLib.get_monotonic_time();

    // Find the common prefix length
    let commonLen = 0;
    while (commonLen < prevWords.length && commonLen < newWords.length
           && prevWords[commonLen] === newWords[commonLen]) {
        commonLen++;
    }

    // Words after commonLen are new or corrected
    let markupParts = [];
    for (let i = 0; i < newWords.length; i++) {
        let word = GLib.markup_escape_text(newWords[i], -1);
        if (i < commonLen) {
            // Settled word — check if it has a fading highlight
            let highlight = this._wordHighlights.find(h => h.index === i);
            if (highlight && (now - highlight.time) < 600000) {
                // Still within highlight window (600ms)
                let color = highlight.type === 'new' ? WORD_COLOR_NEW : WORD_COLOR_CORRECTED;
                markupParts.push(`<span foreground="${color}" font_weight="bold">${word}</span>`);
            } else {
                markupParts.push(`<span foreground="${WORD_COLOR_SETTLED}">${word}</span>`);
            }
        } else if (i >= prevWords.length) {
            // Brand new word (appended)
            markupParts.push(`<span foreground="${WORD_COLOR_NEW}" font_weight="bold">${word}</span>`);
            this._wordHighlights.push({index: i, type: 'new', time: now});
        } else {
            // Corrected word (different from previous at this position)
            markupParts.push(`<span foreground="${WORD_COLOR_CORRECTED}" font_weight="bold">${word}</span>`);
            this._wordHighlights.push({index: i, type: 'corrected', time: now});
        }
    }

    // Clean up old highlights (older than 600ms)
    this._wordHighlights = this._wordHighlights.filter(h => (now - h.time) < 600000);

    this._previousWords = newWords;
    return markupParts.join(' ');
}
```

- [ ] **Step 4: Update `_showSubtitle()` to support markup mode**

Add a `useMarkup` parameter to `_showSubtitle()`. When true, use `set_markup()` instead of setting `text` property:

```javascript
_showSubtitle(text, isPartial, useMarkup = false) {
    // ... existing guard/state checks ...

    if (useMarkup) {
        // Pango markup mode — text is pre-formatted markup
        this._subtitleLabel.clutter_text.set_markup(text);
    } else {
        // Plain text mode (existing behavior)
        // ... existing text truncation and setting logic ...
        this._subtitleLabel.text = displayText;
    }

    // ... rest of existing show/fade-in logic ...
}
```

Keep the existing plain-text path for TTS subtitle updates (SubtitleUpdate signal), which don't need word highlighting.

- [ ] **Step 5: Update `_showPartialTranscription()` to use word markup**

Modify the partial transcription handler to build word markup instead of passing plain text:

```javascript
_showPartialTranscription(text) {
    if (this._destroyed) return;
    if (this._state !== States.LISTENING && this._state !== States.SPEAKING)
        return;

    if (text === this._lastPartialText)
        return;
    this._lastPartialText = text;

    // Build word-level markup
    let markup = this._buildWordMarkup(text);
    this._pendingPartialMarkup = markup;

    if (this._partialDebounceId)
        return;

    // First update — render immediately
    this._showSubtitle(markup, true, true);
    this._lastPartialTime = GLib.get_monotonic_time();

    // Schedule gate for coalescing
    let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
        this._partialDebounceId = null;
        this._removeTimeout('partial-debounce');
        if (this._destroyed) return GLib.SOURCE_REMOVE;
        if (this._pendingPartialMarkup) {
            // Rebuild markup to fade highlights
            let freshMarkup = this._buildWordMarkup(this._lastPartialText);
            this._showSubtitle(freshMarkup, true, true);
        }
        return GLib.SOURCE_REMOVE;
    });
    this._partialDebounceId = timeoutId;
    this._trackTimeout(timeoutId, 'partial-debounce');
}
```

Note: debounce reduced from 300ms to 200ms for snappier word-by-word feel.

- [ ] **Step 6: Reset word state on state transitions**

In `_setState()`, when transitioning to IDLE or LISTENING (new utterance start), reset word tracking:

```javascript
// Reset word tracking for new utterance
if (newState === States.IDLE || newState === States.LISTENING) {
    this._previousWords = [];
    this._wordHighlights = [];
}
```

Also reset in `_showTranscription()` (final transcription handler) since the partial is done:

```javascript
this._previousWords = [];
this._wordHighlights = [];
```

- [ ] **Step 7: Schedule highlight fade refresh**

The word highlights fade after 600ms, but the display only updates on new partial transcription signals. Add a refresh timer in `_showPartialTranscription()` to re-render after 600ms to clear stale highlights:

```javascript
// Schedule highlight fade refresh
this._cancelTimeout('word-highlight-fade');
let fadeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 650, () => {
    this._removeTimeout('word-highlight-fade');
    if (this._destroyed) return GLib.SOURCE_REMOVE;
    if (this._lastPartialText && this._state === States.LISTENING) {
        let freshMarkup = this._buildWordMarkup(this._lastPartialText);
        this._showSubtitle(freshMarkup, true, true);
    }
    return GLib.SOURCE_REMOVE;
});
this._trackTimeout(fadeId, 'word-highlight-fade');
```

- [ ] **Step 8: Cancel word-highlight-fade in cleanup**

In `_disable()` and `_setState()` when going to IDLE, cancel the timer:

```javascript
this._cancelTimeout('word-highlight-fade');
```

- [ ] **Step 9: Test word-by-word reveal**

```bash
systemctl --user restart gnome-speaks.service
# Log out/in to reload extension
# Test: start listening, speak slowly word by word
# Verify: each new word appears in blue highlight
# Verify: highlights fade to cream after ~600ms
# Verify: if Azure corrects a word, it flashes amber
# Test: speak a long sentence, verify smooth scrolling
# Test: stop listening, verify clean reset
```

- [ ] **Step 10: Commit**

```bash
git add extension.js stylesheet.css
git commit -m "feat: word-by-word reveal with highlight for partial transcription"
```

---

## Task 4: Polish and Integration

Final polish pass — ensure all three features work together seamlessly, handle edge cases, and look beautiful.

**Files:**
- Modify: `extension.js` — edge case handling, timing coordination
- Modify: `stylesheet.css` — visual refinements

- [ ] **Step 1: Handle badge resize affecting glow and subtitle**

The badge changes size when transitioning between states (pills show/hide, label changes). Add a call to reposition both glow and subtitle when the badge allocation changes. In `_setState()`, after all style/pill changes, schedule a reposition:

```javascript
// Reposition glow and subtitle after badge size changes
GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    if (this._destroyed) return GLib.SOURCE_REMOVE;
    this._positionGlowRing();
    this._positionSubtitleOverlay();
    return GLib.SOURCE_REMOVE;
});
```

- [ ] **Step 2: Smooth subtitle repositioning on text growth**

When the subtitle text grows (more words), its height changes, which shifts the overlay position (especially when shown above the badge). In `_showSubtitle()`, after setting text/markup, schedule a reposition in an idle callback so the allocation is updated:

```javascript
GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    if (this._destroyed) return GLib.SOURCE_REMOVE;
    this._positionSubtitleOverlay();
    return GLib.SOURCE_REMOVE;
});
```

- [ ] **Step 3: Glow ring smooth transitions for speech gaps**

During natural speech, there are brief silences between words. The current 300ms timeout for pulse resume is fine, but the glow should ease smoothly rather than snapping. The ease in the pulse-resume timeout (step 4 of Task 1) handles this. Verify the 400ms ease-out feels natural.

If the glow feels too abrupt, increase the ease to 600ms:

```javascript
this._glowRing.ease({
    opacity: 0,
    scale_x: 1.0,
    scale_y: 1.0,
    duration: 600,
    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
});
```

- [ ] **Step 4: Test full integration**

```bash
systemctl --user restart gnome-speaks.service
# Full log out/in cycle
# Test sequence:
# 1. Badge idle — no glow, no subtitle
# 2. Start listening — badge pulses, glow ring visible on voice
# 3. Speak slowly — words appear one by one, highlighted in blue
# 4. Speak continuously — smooth word flow, highlights fade naturally
# 5. Pause briefly — glow fades smoothly, subtitle stays visible
# 6. Resume speaking — glow returns, new words highlight
# 7. Stop listening — subtitle shows final text, fades out
# 8. Drag badge — subtitle and glow follow
# 9. Drag to top of screen — subtitle appears below badge
# 10. Drag to bottom — subtitle appears above badge
# 11. AI mode conversation — subtitle shows TTS text (plain, not word-highlighted)
```

- [ ] **Step 5: Final commit**

```bash
git add extension.js stylesheet.css
git commit -m "feat: polish voice feedback overhaul - glow, anchored subtitles, word reveal"
```

---

## Architecture Notes for Implementer

### GC Safety
All Clutter `ease()` calls must NOT use `onComplete` callbacks — use `GLib.timeout_add()` follow-ups instead. Existing code already follows this pattern (see commit `14c8fbb`). The glow ring eases are safe as-is since they don't need completion callbacks.

### Timeout Tracking
Every `GLib.timeout_add()` must be tracked via `this._trackTimeout(id, name)`. The `_trackTimeout` method auto-deduplicates by name (cancels existing same-name timeout). Always use descriptive names: `'audio-pulse-resume'`, `'word-highlight-fade'`, `'partial-debounce'`.

### Actor Lifecycle
The glow ring must be destroyed in `_destroyBadge()` with `remove_all_transitions()` before `destroy()`. It lives on `Main.uiGroup`, not as a badge child, so it needs explicit removal.

### Pango Markup
Use `GLib.markup_escape_text()` on all user-provided text before embedding in Pango spans to prevent markup injection from transcription content (e.g., if user says "less than sign").

### Performance
- Audio level updates are throttled to 80ms (~12fps) — sufficient for smooth visual
- Partial transcription debounce reduced to 200ms for word-reveal responsiveness
- Word highlight fade at 600ms provides visible-but-not-distracting feedback
- Glow ring opacity/scale are set directly (not eased) during active speech for instant response
