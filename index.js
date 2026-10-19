/* Remove Ellipsis — Instant UI Update & Thai-English Bracket Removal
 * Refactored: schema-driven settings, debounced observer, race-condition lock,
 * unified toggle logic, undo support, per-message clean button.
 */
(() => {
    if (typeof window === 'undefined') { global.window = {}; }
    if (window.__REMOVE_ELLIPSIS_EXT_LOADED__) return;
    window.__REMOVE_ELLIPSIS_EXT_LOADED__ = true;

    // ========================================================================
    // MODULE: Constants & Schema
    // ========================================================================
    const MODULE_NAME = 'removeEllipsisExt';

    /**
     * SETTINGS_SCHEMA — single source of truth for every toggle.
     * Adding a new setting = add one entry here only.
     *
     * Fields:
     *   key        {string}  — storage key
     *   default    {boolean} — default value
     *   label      {string}  — display label
     *   icon       {string}  — FontAwesome class
     *   inPopup    {boolean} — show in quick-button popup?
     *   warning    {string?} — optional toastr warning on enable
     *   title      {string?} — tooltip text
     */
    const SETTINGS_SCHEMA = [
        {
            key: 'autoRemove',
            default: false,
            label: 'Auto Remove (After Generation)',
            icon: 'fa-solid fa-robot',
            inPopup: true,
            title: 'ลบอัตโนมัติหลังจาก AI สร้างข้อความ'
        },
        {
            key: 'cleanDepth',
            type: 'number',
            default: 1,
            min: 0,
            max: 999,
            label: 'Auto Clean Depth',
            icon: 'fa-solid fa-layer-group',
            inPopup: false,
            title: 'จำนวน message ล่าสุดที่ให้ Auto Remove ทำงาน (1 = เฉพาะล่าสุด, 0 = ทั้งหมด)'
        },
        {
            key: 'removeEngParens',
            default: false,
            label: 'Remove English in ( )',
            icon: 'fa-solid fa-language',
            inPopup: true,
            highlight: true,
            title: 'ลบวงเล็บภาษาอังกฤษที่ตามหลังภาษาไทย เช่น แชท(chat) → แชท'
        },
        {
            key: 'removeAllDots',
            default: false,
            label: 'Remove ALL Dots (.)',
            icon: 'fa-solid fa-ellipsis',
            inPopup: false,
            warning: 'Warning: Will remove ALL periods including sentence endings!'
        },
        {
            key: 'treatTwoDots',
            default: false,
            label: 'Remove ".."',
            icon: 'fa-solid fa-minus',
            inPopup: false,
            title: 'ลบจุดสองจุด (..) ด้วย ไม่ใช่แค่สามจุด'
        },
        {
            key: 'protectCode',
            default: true,
            label: 'Protect Code & HTML',
            icon: 'fa-solid fa-shield-halved',
            inPopup: false,
            title: 'ไม่แตะโค้ด, HTML tags, script และ style blocks'
        },
        {
            key: 'preserveSpace',
            default: true,
            label: 'Preserve Space',
            icon: 'fa-solid fa-text-width',
            inPopup: false,
            title: 'แทนที่จุดด้วย space แทนที่จะลบทิ้งเลย'
        },
        {
            key: 'notifications',
            default: true,
            label: 'Show Notifications',
            icon: 'fa-solid fa-bell',
            inPopup: false,
            title: 'แสดงแจ้งเตือนเมื่อทำการลบ'
        },
        // Custom entries are literal text, never user-supplied regular expressions.
        { key: 'customEnabled', default: true, label: 'Clean custom text', icon: 'fa-solid fa-list', inPopup: true },
        { key: 'customText', type: 'text', default: '', label: 'Custom text' },
    ];

    // Build DEFAULTS from schema
    const DEFAULTS = Object.fromEntries(SETTINGS_SCHEMA.map(s => [s.key, s.default]));

    // ========================================================================
    // MODULE: Core
    // ========================================================================
    const Core = {
        getContext() {
            try { return window.SillyTavern?.getContext?.() || null; } catch (_) { return null; }
        },

        getSettings() {
            const ctx = this.getContext();
            if (!ctx) return { ...DEFAULTS };
            const store = ctx.extensionSettings || (ctx.extensionSettings = {});
            if (!store[MODULE_NAME]) store[MODULE_NAME] = {};
            // Fill missing keys from defaults
            for (const key of Object.keys(DEFAULTS)) {
                if (!(key in store[MODULE_NAME])) store[MODULE_NAME][key] = DEFAULTS[key];
            }
            return store[MODULE_NAME];
        },

        saveSettings() {
            const ctx = this.getContext();
            if (ctx?.saveSettingsDebounced) ctx.saveSettingsDebounced();
            else if (ctx?.saveSettings) ctx.saveSettings();
        }
    };

    // ========================================================================
    // MODULE: Undo Stack
    // ========================================================================
    const UndoStack = {
        _stack: [],
        MAX: 1,

        push(snapshot) {
            this._stack.push(snapshot);
            if (this._stack.length > this.MAX) this._stack.shift();
        },

        pop() {
            return this._stack.pop() || null;
        },

        canUndo() {
            return this._stack.length > 0;
        },

        clear() {
            this._stack = [];
        }
    };

    // ========================================================================
    // MODULE: Cleaner
    // ========================================================================
    const Cleaner = {
        _patternKey: null,
        _patterns: null,

        /**
         * Clean a single string.
         * @returns {{ text: string, removed: number }}
         */
        cleanText(text, settings) {
            if (typeof text !== 'string' || !text) return { text, removed: 0 };

            const customText = settings.customEnabled !== false && typeof settings.customText === 'string'
                ? settings.customText : '';
            const patternKey = JSON.stringify([settings.removeAllDots, settings.treatTwoDots, customText]);
            if (patternKey !== this._patternKey) {
                const literals = [...new Set(customText.split(/\r?\n/).map(line => line.trim()).filter(Boolean))]
                    .sort((a, b) => b.length - a.length)
                    .map(value => value.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&'));
                const dots = settings.removeAllDots ? '\\.+' : settings.treatTwoDots ? '\\.{2,}' : '\\.{3,}';
                const pattern = '(?:' + [...literals, dots, '…'].join('|') + ')';
                this._patterns = {
                    before: new RegExp('(?<=[*"\\\'])' + pattern + '[ \\t]*', 'g'),
                    after: new RegExp(pattern + '[ \\t]*(?=[*"\\\'])', 'g'),
                    main: new RegExp(pattern, 'g'),
                    compact: new RegExp(pattern + '[ \\t]*', 'g'),
                };
                this._patternKey = patternKey;
            }
            const patterns = this._patterns;
            let removed = 0;
            const clean = (part, before, after) => {
                if (settings.removeEngParens) {
                    part = part.replace(/([\u0E00-\u0E7F][*_"']*)(\s*(?:[^\w\s\u0E00-\u0E7F]{0,3}\s*))(\([^)]*[A-Za-z][^)]*\))/g,
                        (_, thai, separator) => { removed++; return thai + separator.trimEnd(); });
                }
                part = part
                    .replace(patterns.before, () => { removed++; return ''; })
                    .replace(patterns.after, () => { removed++; return ''; });
                return part.replace(settings.preserveSpace ? patterns.main : patterns.compact, (match, offset, full) => {
                    removed++;
                    if (!settings.preserveSpace) return '';
                    const prev = full[offset - 1] ?? before;
                    const next = full[offset + match.length] ?? after;
                    return prev === undefined || next === undefined || /\s/.test(prev) || /\s/.test(next) ? '' : ' ';
                });
            };

            // Clean unprotected spans so custom text cannot damage placeholders.
            // Unclosed reasoning/code blocks stay protected through the end.
            const protectedRx = settings.protectCode
                ? /<think\b[^>]*>[\s\S]*?(?:<\/think>|$)|```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)|<(script|style|pre|code)\b[^>]*>[\s\S]*?(?:<\/\1>|$)|<[^>]+>/gi
                : /<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi;
            let result = '';
            let cursor = 0;
            for (const match of text.matchAll(protectedRx)) {
                result += clean(text.slice(cursor, match.index), text[cursor - 1], text[match.index]) + match[0];
                cursor = match.index + match[0].length;
            }
            result += clean(text.slice(cursor), text[cursor - 1]);
            return { text: result, removed };
        },

        /**
         * Clean a single chat message object in-place.
         * @returns {number} count of items removed
         */
        cleanMessage(msg, settings) {
            if (!msg) return 0;
            settings = settings || Core.getSettings();
            let total = 0;

            if (typeof msg.mes === 'string') {
                const r = this.cleanText(msg.mes, settings);
                if (r.removed > 0) { msg.mes = r.text; total += r.removed; }
            }

            if (msg.extra && typeof msg.extra.display_text === 'string') {
                const r = this.cleanText(msg.extra.display_text, settings);
                if (r.removed > 0) { msg.extra.display_text = r.text; total += r.removed; }
            }

            return total;
        },

        /**
         * Scan chat without modifying — returns count only.
         */
        countAll(chat, settings) {
            settings = settings || Core.getSettings();
            let count = 0;
            for (const msg of chat) {
                if (typeof msg.mes === 'string') count += this.cleanText(msg.mes, settings).removed;
                if (typeof msg.extra?.display_text === 'string') {
                    count += this.cleanText(msg.extra.display_text, settings).removed;
                }
            }
            return count;
        }
    };

    // ========================================================================
    // MODULE: UI
    // ========================================================================
    const UI = {
        notify(msg, type = 'info') {
            if (!Core.getSettings().notifications) return;
            if (typeof toastr !== 'undefined' && toastr[type]) toastr[type](msg, 'Cleaner Ext');
            else console.log(`[CleanerExt] ${msg}`);
        },

        closeDrawer() {
            if (typeof $ !== 'undefined') $('.drawer-overlay').trigger('click');
        },

        // ----------------------------------------------------------------
        // Sync ALL UI elements from current settings (single source of truth)
        // ----------------------------------------------------------------
        syncAll() {
            const st = Core.getSettings();

            // Drawer checkboxes
            for (const def of SETTINGS_SCHEMA) {
                if (def.type === 'number' || def.type === 'text') {
                    $(`.rm-ell-input-${def.key}`).val(st[def.key]);
                    continue;
                }
                $(`.rm-ell-input-${def.key}`).each((_, el) => {
                    if (el.checked !== st[def.key]) el.checked = st[def.key];
                });
            }

            this.updateQuickButtonState();
            this.updatePopupMenuState();
            this.updateDrawerHeaderStatus();
            this.updateUndoButtons();
        },

        updateQuickButtonState() {
            const btn = $('#rm-ell-quick-btn');
            if (!btn.length) return;
            const st = Core.getSettings();
            // Option D: show/hide dot badge instead of ring
            const dot = document.getElementById('rm-ell-auto-dot');
            if (dot) dot.style.display = st.autoRemove ? 'block' : 'none';
            btn.toggleClass('rm-ell-auto-active', !!st.autoRemove);
        },

        updatePopupMenuState() {
            const st = Core.getSettings();
            for (const def of SETTINGS_SCHEMA) {
                if (!def.inPopup) continue;
                const statusEl = $(`#rm-ell-popup-${def.key} .rm-ell-toggle-status`);
                if (!statusEl.length) continue;
                const val = !!st[def.key];
                $(`#rm-ell-popup-${def.key}`).attr('aria-pressed', String(val));
                statusEl.text(val ? 'ON' : 'OFF').removeClass('on off').addClass(val ? 'on' : 'off');
            }
        },

        updateDrawerHeaderStatus() {
            const st = Core.getSettings();
            const val = !!st.autoRemove;
            const text = val ? 'ON' : 'OFF';
            const cls  = val ? 'on' : 'off';

            let badge = document.getElementById('rm-ell-header-status');
            if (!badge) {
                const header = document.querySelector('#remove-ellipsis-settings .inline-drawer-toggle b');
                if (!header) return;
                badge = document.createElement('span');
                badge.id = 'rm-ell-header-status';
                header.appendChild(badge);
            }
            if (badge.textContent !== text) badge.textContent = text;
            badge.className = `rm-ell-header-status ${cls}`;
        },

        updateUndoButtons() {
            const can = UndoStack.canUndo();
            $('.rm-ell-btn-undo, #rm-ell-popup-undo').toggleClass('rm-ell-btn-disabled', !can).prop('disabled', !can);
        },

        // ----------------------------------------------------------------
        // Popup menu
        // ----------------------------------------------------------------
        togglePopupMenu() {
            const popup = $('#rm-ell-popup-menu');
            popup.hasClass('show') ? this.hidePopupMenu() : (() => {
                this.updatePopupMenuState();
                popup.addClass('show');
                $('#rm-ell-quick-btn').attr('aria-expanded', 'true');
                popup.find('button:enabled').first().trigger('focus');
            })();
        },

        hidePopupMenu() {
            $('#rm-ell-popup-menu').removeClass('show');
            $('#rm-ell-quick-btn').attr('aria-expanded', 'false');
        },

        // ----------------------------------------------------------------
        // Build the quick-button popup HTML from schema
        // ----------------------------------------------------------------
        _buildPopupHTML() {
            const st = Core.getSettings();
            const dotVisible = st.autoRemove ? '' : 'display:none;';
            const popupItems = SETTINGS_SCHEMA.filter(d => d.inPopup).map(def => {
                const val = !!st[def.key];
                return `
                    <button type="button" class="rm-ell-popup-item rm-ell-popup-toggle" id="rm-ell-popup-${def.key}" data-key="${def.key}">
                        <span class="rm-ell-toggle-label">
                            <i class="${def.icon}"></i> ${def.label}
                        </span>
                        <span class="rm-ell-toggle-status ${val ? 'on' : 'off'}">${val ? 'ON' : 'OFF'}</span>
                    </button>`;
            }).join('');

            return `
                <div id="rm-ell-quick-btn-wrapper" class="rm-ell-quick-btn-wrapper">
                    <button id="rm-ell-quick-btn" class="rm-ell-quick-btn" type="button"
                         aria-label="Text Cleaner options" aria-expanded="false" aria-controls="rm-ell-popup-menu">
                        <span class="rm-ell-quick-emoji" aria-hidden="true">🧹</span>
                        <span id="rm-ell-auto-dot" class="rm-ell-auto-dot" style="${dotVisible}"></span>
                    </button>
                    <div id="rm-ell-popup-menu" class="rm-ell-popup-menu">
                        <div class="rm-ell-popup-header">
                            <span class="rm-ell-quick-emoji">🧹</span> Text Cleaner
                        </div>
                        <button type="button" class="rm-ell-popup-item" id="rm-ell-popup-clean">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> Clean Now
                        </button>
                        <button type="button" class="rm-ell-popup-item" id="rm-ell-popup-undo" data-undo>
                            <i class="fa-solid fa-rotate-left"></i> Undo
                        </button>
                        <button type="button" class="rm-ell-popup-item" id="rm-ell-popup-check">
                            <i class="fa-solid fa-magnifying-glass"></i> Check
                        </button>
                        <div class="rm-ell-popup-divider"></div>
                        ${popupItems}
                    </div>
                </div>`;
        },

        // ----------------------------------------------------------------
        // Build drawer settings panel HTML from schema
        // ----------------------------------------------------------------
        buildSettingsPanelHtml() {
            const st = Core.getSettings();

            // Keep rules separate from the options shared by every cleaning action.
            const primary = SETTINGS_SCHEMA.filter(d => d.key === 'autoRemove');
            const rules = SETTINGS_SCHEMA.filter(d => ['removeEngParens', 'removeAllDots', 'treatTwoDots', 'customEnabled'].includes(d.key));
            const advanced = SETTINGS_SCHEMA.filter(d => ['protectCode', 'preserveSpace', 'notifications'].includes(d.key));

            const makeCheckbox = (def) => {
                return `
                    <label class="checkbox_label" ${def.title ? `title="${def.title}"` : ''}>
                        <input type="checkbox"
                               class="rm-ell-input-${def.key}"
                               id="drawer-rm-ell-${def.key}"
                               ${st[def.key] ? 'checked' : ''} />
                        <span>${def.label}</span>
                    </label>`;
            };

            return `
                <p class="rm-ell-intro">Clean repeated punctuation and unwanted text with one shared set of options.</p>
                <div class="rm-ell-section">
                <h4>Automatic cleaning</h4>

                ${primary.map(makeCheckbox).join('')}

                <div class="rm-ell-depth-row" title="จำนวน message ล่าสุดที่ให้ Auto Remove ทำงาน&#10;1 = เฉพาะ message ล่าสุด&#10;0 = ทั้งหมด (เหมือน Clean Now)">
                    <label for="drawer-rm-ell-cleanDepth" class="rm-ell-depth-label">
                        <i class="fa-solid fa-layer-group"></i> Auto Clean Depth
                    </label>
                    <input type="number"
                           id="drawer-rm-ell-cleanDepth"
                           class="rm-ell-input-cleanDepth text_pole"
                           min="0" max="999" step="1"
                           value="${st.cleanDepth ?? 1}" />
                    <span class="rm-ell-depth-hint">messages (0 = all)</span>
                </div>

                </div>
                <div class="rm-ell-section">
                    <h4>What to clean</h4>
                    <p class="rm-ell-hint">Always removes <code>...</code> and <code>…</code>.</p>
                    ${rules.map(makeCheckbox).join('')}
                    <label for="drawer-rm-ell-customText">Additional text · one item per line</label>
                    <textarea id="drawer-rm-ell-customText" class="rm-ell-input-customText text_pole" rows="4"
                        placeholder=". . .&#10;⋯&#10;—" aria-describedby="rm-ell-custom-hint">${String(st.customText ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
                    <p id="rm-ell-custom-hint" class="rm-ell-hint">Exact, case-sensitive matches. Blank lines are ignored. All entries use the shared options below.</p>
                </div>
                <details class="rm-ell-section">
                    <summary>Shared options</summary>

                ${advanced.map(makeCheckbox).join('')}
                </details>

                <div class="rm-ell-actions">
                    <button type="button" class="rm-ell-btn-clean menu_button"
                         title="ลบสิ่งสกปรกในแชทปัจจุบันทันที">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> Clean Now
                    </button>
                    <button type="button" class="rm-ell-btn-undo menu_button rm-ell-btn-disabled" disabled
                         title="เลิกทำการลบครั้งล่าสุด">
                        <i class="fa-solid fa-rotate-left"></i> Undo
                    </button>
                    <button type="button" class="rm-ell-btn-check menu_button"
                         title="ตรวจสอบจำนวนที่ต้องลบ">
                        <i class="fa-solid fa-magnifying-glass"></i> Check
                    </button>
                </div>
                <p class="rm-ell-hint">Clean Now and Check cover the entire chat. By Zealllll.</p>`;
        },

        // ----------------------------------------------------------------
        // Inject quick button into send_form
        // ----------------------------------------------------------------
        injectQuickButton() {
            if (typeof $ === 'undefined') return;

            // Self-heal: if one or more wrappers already exist, keep the first
            // and remove any duplicates, then bail out (button is already present).
            const existingWrappers = $('#rm-ell-quick-btn-wrapper');
            if (existingWrappers.length > 0) {
                if (existingWrappers.length > 1) existingWrappers.slice(1).remove();
                return;
            }

            const sendForm = $('#send_form');
            if (!sendForm.length) return;


            const wrapper = $(this._buildPopupHTML());
            const sendBut = $('#send_but');
            if (sendBut.length) sendBut.before(wrapper);
            else sendForm.append(wrapper);

            // A normal click works on touch, mouse, and keyboard.
            $('#rm-ell-quick-btn').on('click contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.togglePopupMenu();
            });

            // Popup action buttons
            $('#rm-ell-popup-clean').on('click', async (e) => {
                e.stopPropagation();
                this.hidePopupMenu();
                await App.removeAll();
            });

            $('#rm-ell-popup-undo').on('click', async (e) => {
                e.stopPropagation();
                this.hidePopupMenu();
                await App.undo();
            });

            $('#rm-ell-popup-check').on('click', async (e) => {
                e.stopPropagation();
                this.hidePopupMenu();
                await App.checkAll();
            });

            this.updateQuickButtonState();
            this.updateUndoButtons();
        },

        // ----------------------------------------------------------------
        // Inject settings drawer
        // ----------------------------------------------------------------
        injectSettings() {
            if (typeof $ === 'undefined') return;
            if ($('#remove-ellipsis-settings').length > 0) return;
            const container = $('#extensions_settings');
            if (!container.length) return;

            container.append(`
                <div id="remove-ellipsis-settings" class="extension_settings_block">
                    <div class="inline-drawer">
                        <div class="inline-drawer-toggle inline-drawer-header">
                            <b><span class="rm-ell-quick-emoji">🧹</span> Text Cleaner</b>
                            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
                        </div>
                        <div class="inline-drawer-content rm-ell-panel-body" style="display:none;">
                            ${this.buildSettingsPanelHtml()}
                        </div>
                    </div>
                </div>
            `);
        }
    };

    // ========================================================================
    // MODULE: App
    // ========================================================================
    const App = {
        _removeAllRunning: false,  // Lock against concurrent removeAll calls
        _autoRemoveSource: null,

        // ----------------------------------------------------------------
        // Unified toggle — single function handles both drawer + popup
        // ----------------------------------------------------------------
        toggleSetting(key) {
            const def = SETTINGS_SCHEMA.find(d => d.key === key);
            if (!def) return;
            const st = Core.getSettings();
            st[key] = !st[key];
            Core.saveSettings();
            UI.syncAll();
            if (def.warning && st[key]) UI.notify(def.warning, 'warning');
            else UI.notify(`${def.label}: ${st[key] ? 'ON' : 'OFF'}`);
        },

        // ----------------------------------------------------------------
        // Remove all — with undo snapshot + concurrency lock
        // ----------------------------------------------------------------
        async removeAll(silent = false, depth = 0) {
            if (this._removeAllRunning) return;
            this._removeAllRunning = true;

            try {
                const ctx = Core.getContext();
                if (!ctx?.chat) return;

                const settings = Core.getSettings();

                const snapshot = {};

                let count = 0;
                const updatedIndexes = [];

                const start = depth > 0 ? Math.max(0, ctx.chat.length - depth) : 0;
                for (let index = start; index < ctx.chat.length; index++) {
                    const msg = ctx.chat[index];
                    const previous = { mes: msg.mes, extra_display: msg.extra?.display_text };
                    const removed = Cleaner.cleanMessage(msg, settings);
                    if (removed > 0) {
                        snapshot[index] = previous;
                        count += removed;
                        updatedIndexes.push(index);
                    }
                }

                if (updatedIndexes.length > 0) {
                    UndoStack.push({ snapshot, indexes: updatedIndexes });

                    // Update DOM for changed messages
                    updatedIndexes.forEach(index => {
                        this._updateMessageBlock(ctx, index);
                    });

                    await ctx.saveChat?.();
                }

                if (!silent) {
                    if (count > 0) UI.notify(`Cleaned ${count} items.`, 'success');
                    else UI.notify('Nothing to clean.', 'info');
                }

                UI.updateUndoButtons();

            } finally {
                this._removeAllRunning = false;
            }
        },

        // ----------------------------------------------------------------
        // Undo last removeAll
        // ----------------------------------------------------------------
        async undo() {
            const ctx = Core.getContext();
            if (!ctx?.chat) return;

            const entry = UndoStack.pop();
            if (!entry) { UI.notify('Nothing to undo.', 'info'); return; }

            entry.indexes.forEach(index => {
                const msg = ctx.chat[index];
                if (!msg) return;
                msg.mes = entry.snapshot[index].mes;
                if (msg.extra && entry.snapshot[index].extra_display !== undefined) {
                    msg.extra.display_text = entry.snapshot[index].extra_display;
                }
                this._updateMessageBlock(ctx, index);
            });

            await ctx.saveChat?.();
            UI.notify('Undo complete.', 'success');
            UI.updateUndoButtons();
        },

        // ----------------------------------------------------------------
        // Check (dry-run) — no changes
        // ----------------------------------------------------------------
        async checkAll() {
            const ctx = Core.getContext();
            if (!ctx?.chat) return;
            const count = Cleaner.countAll(ctx.chat);
            UI.notify(count > 0 ? `Found ${count} items to clean.` : 'All clean.', 'info');
        },

        // ----------------------------------------------------------------
        // Clean a single message by index (for per-message button)
        // ----------------------------------------------------------------
        async cleanSingleMessage(index) {
            const ctx = Core.getContext();
            if (!ctx?.chat) return;
            const msg = ctx.chat[index];
            if (!msg) return;

            const snapshot = { mes: msg.mes, extra_display: msg.extra?.display_text };
            const removed = Cleaner.cleanMessage(msg);

            if (removed > 0) {
                // Save undo snapshot for this single message
                UndoStack.push({ snapshot: { [index]: snapshot }, indexes: [index] });
                this._updateMessageBlock(ctx, index);
                await ctx.saveChat?.();
                UI.notify(`Cleaned ${removed} items from message.`, 'success');
                UI.updateUndoButtons();
            } else {
                UI.notify('Nothing to clean in this message.', 'info');
            }
        },

        // ----------------------------------------------------------------
        // Helper: update single message block in DOM
        // ----------------------------------------------------------------
        _updateMessageBlock(ctx, index) {
            if (typeof window.updateMessageBlock === 'function') {
                window.updateMessageBlock(index, ctx.chat[index]);
            } else if (typeof ctx.updateMessageBlock === 'function') {
                ctx.updateMessageBlock(index, ctx.chat[index]);
            } else if (ctx.eventSource) {
                ctx.eventSource.emit(ctx.event_types.MESSAGE_UPDATED, index);
            }
        },

        // ----------------------------------------------------------------
        // Bind all events
        // ----------------------------------------------------------------
        bindEvents() {
            if (this._eventsBound) return;
            this._eventsBound = true;

            // Settings drawer checkboxes — generated from schema
            for (const def of SETTINGS_SCHEMA) {
                if (def.type) continue; // non-boolean settings are handled below
                $(document).on('change', `.rm-ell-input-${def.key}`, (e) => {
                    const st = Core.getSettings();
                    st[def.key] = e.target.checked;
                    Core.saveSettings();
                    UI.syncAll();
                    if (def.warning && e.target.checked) UI.notify(def.warning, 'warning');
                });
            }

            $(document).on('change', '.rm-ell-input-customText', (e) => {
                Core.getSettings().customText = e.target.value;
                Core.saveSettings();
            });

            $(document).on('keydown.rmellpopup', (e) => {
                if (e.key === 'Escape' && $('#rm-ell-popup-menu').hasClass('show')) {
                    UI.hidePopupMenu();
                    $('#rm-ell-quick-btn').trigger('focus');
                }
            });

            // cleanDepth number input
            $(document).on('change', '.rm-ell-input-cleanDepth', (e) => {
                const raw = parseInt(e.target.value, 10);
                const schema = SETTINGS_SCHEMA.find(d => d.key === 'cleanDepth');
                const val = isNaN(raw)
                    ? schema.default
                    : Math.min(schema.max, Math.max(0, raw));
                e.target.value = val;
                Core.getSettings().cleanDepth = val;
                Core.saveSettings();
            });

            // Action buttons
            $(document).on('click', '.rm-ell-btn-clean', async (e) => {
                e.preventDefault(); e.stopPropagation();
                UI.closeDrawer();
                await App.removeAll();
            });

            $(document).on('click', '.rm-ell-btn-undo:not(.rm-ell-btn-disabled)', async (e) => {
                e.preventDefault(); e.stopPropagation();
                UI.closeDrawer();
                await App.undo();
            });

            $(document).on('click', '.rm-ell-btn-check', async (e) => {
                e.preventDefault(); e.stopPropagation();
                UI.closeDrawer();
                await App.checkAll();
            });

            // Per-message clean button (injected via MutationObserver)
            $(document).on('click', '.rm-ell-msg-clean-btn', async (e) => {
                e.preventDefault(); e.stopPropagation();
                const index = parseInt($(e.currentTarget).closest('.mes').attr('mesid'), 10);
                if (!isNaN(index)) await App.cleanSingleMessage(index);
            });

            $(document).on('click', '.rm-ell-popup-toggle[data-key]', function(e) {
                e.stopPropagation();
                App.toggleSetting($(this).data('key'));
            });

            $(document).on('click.rmellpopup', (e) => {
                if (!$(e.target).closest('#rm-ell-quick-btn-wrapper').length) UI.hidePopupMenu();
            });
        },

        bindAutoRemove() {
            const ctx = Core.getContext();
            if (!ctx?.eventSource || ctx.eventSource === this._autoRemoveSource) return;
            this._autoRemoveSource = ctx.eventSource;
            if (ctx.event_types.CHAT_CHANGED) {
                ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
                    UndoStack.clear();
                    UI.updateUndoButtons();
                });
            }
            ctx.eventSource.on(ctx.event_types.MESSAGE_RECEIVED, async () => {
                const st = Core.getSettings();
                if (st.autoRemove) await App.removeRecent(st.cleanDepth);
            });
        },

        // ----------------------------------------------------------------
        // Inject per-message clean button into existing messages
        // ----------------------------------------------------------------
        injectMessageButtons() {
            if (typeof $ === 'undefined') return;
            $('.mes').each((_, el) => {
                const mes = $(el);
                if (mes.find('.rm-ell-msg-clean-btn').length > 0) return;
                // ".extraMesButtons" is nested inside ".mes_buttons", so selecting
                // both would prepend to two containers at once (duplicate button).
                // Pick a single target: prefer ".extraMesButtons", fall back to ".mes_buttons".
                let target = mes.find('.extraMesButtons').first();
                if (!target.length) target = mes.find('.mes_buttons').first();
                if (!target.length) return;
                target.prepend(
                    `<div class="rm-ell-msg-clean-btn mes_button" title="Clean this message">
                        <i class="fa-solid fa-eraser"></i>
                    </div>`
                );
            });

        },

        // ----------------------------------------------------------------
        // Remove only the N most recent messages (used by auto-remove)
        // depth = 0 หมายถึงทั้งหมด (fallback to removeAll)
        // ----------------------------------------------------------------
        async removeRecent(depth) {
            await this.removeAll(true, depth);
        },

        // ----------------------------------------------------------------
        // Init
        // ----------------------------------------------------------------
        init() {
            this.bindEvents();
            this.bindAutoRemove();

            UI.injectSettings();
            UI.injectQuickButton();
            this.injectMessageButtons();
        }
    };

    // ========================================================================
    // Boot
    // ========================================================================
    (() => {
        if (typeof document === 'undefined') return;

        const onReady = () => {
            App.init();
            setTimeout(() => UI.updateDrawerHeaderStatus(), 100);

            let debounceTimer = null;
            let isRunning = false;

            const runChecks = () => {
                if (isRunning) return;
                isRunning = true;
                try {
                    if (!document.getElementById('remove-ellipsis-settings'))  UI.injectSettings();
                    // Always call: injectQuickButton self-heals (removes duplicate
                    // wrappers) and bails out cheaply when exactly one exists.
                    UI.injectQuickButton();
                    App.injectMessageButtons();
                    App.bindAutoRemove();

                    UI.updateDrawerHeaderStatus();
                } catch (err) {
                    console.error('[CleanerExt] observer error:', err);
                } finally {
                    isRunning = false;
                }
            };

            const scheduleCheck = (records) => {
                // Text streaming and our own controls do not require another chat scan.
                if (!records.some(record => [...record.addedNodes].some(node =>
                    node.nodeType === 1 && (
                        node.matches('.mes, .mes_buttons, .extraMesButtons, #send_form, #send_but, #extensions_settings') ||
                        node.querySelector('.mes, .mes_buttons, .extraMesButtons, #send_form, #send_but, #extensions_settings')
                    )
                ))) return;
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(runChecks, 150);
            };

            const obs = new MutationObserver(scheduleCheck);
            const target = document.querySelector('#content') || document.body;
            obs.observe(target, { childList: true, subtree: true });
        };

        if (window.SillyTavern?.getContext) onReady();
        else setTimeout(onReady, 2000);
    })();

    // Public API
    window.RemoveEllipsis = { Core, Cleaner, UI, App, UndoStack };
})();
