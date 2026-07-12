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
            min: 1,
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
            if (!ctx) return structuredClone(DEFAULTS);
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
        /**
         * Clean a single string.
         * @returns {{ text: string, removed: number }}
         */
        cleanText(text, settings) {
            if (typeof text !== 'string' || !text) return { text, removed: 0 };

            const protectedItems = [];
            let processed = text;
            let removedCount = 0;

            // --- Always protect <think> blocks regardless of protectCode setting ---
            // mask ทั้งก้อนก่อนเสมอ เพราะเนื้อหาใน think ไม่ควรถูกแตะ
            processed = processed.replace(
                /<think\b[^>]*>[\s\S]*?<\/think>/gi,
                m => `@@PT${protectedItems.push(m) - 1}@@`
            );

            // --- Protect code/HTML blocks ---
            if (settings.protectCode) {
                const mask = (regex) => {
                    processed = processed.replace(
                        regex,
                        m => `@@PT${protectedItems.push(m) - 1}@@`
                    );
                };
                mask(/```[\s\S]*?```/g);
                mask(/`[^`]*`/g);
                mask(/<script\b[^>]*>[\s\S]*?<\/script>/gi);
                mask(/<style\b[^>]*>[\s\S]*?<\/style>/gi);
                mask(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi);
                mask(/<code\b[^>]*>[\s\S]*?<\/code>/gi);
                // <think> ถูก mask ไปแล้วข้างบน ไม่ต้อง mask ซ้ำ
                mask(/<[^>]+>/g);
            }

            // --- Remove English in parentheses after Thai ---
            if (settings.removeEngParens) {
                // Improved: allow optional space/punctuation between Thai and paren
                // e.g. แชท(chat), แชท (chat), แชท — (chat), แชท: (chat)
                const engParenRegex = /([\u0E00-\u0E7F][*_"']*)\s*(?:[^\w\s\u0E00-\u0E7F]{0,3}\s*)(\([^)]*[A-Za-z][^)]*\))/g;
                processed = processed.replace(engParenRegex, (match, thaiPart, parenPart) => {
                    removedCount++;  // count brackets removed, not characters
                    return thaiPart;
                });
            }

            // --- Build ellipsis pattern ---
            let patternSource;
            if (settings.removeAllDots) {
                patternSource = '\\.+|…';
            } else if (settings.treatTwoDots) {
                patternSource = '(?<!\\d)\\.{2,}(?!\\d)|…';
            } else {
                patternSource = '(?<!\\d)\\.{3,}(?!\\d)|…';
            }

            const baseRegex = new RegExp(patternSource, 'g');

            // Handle ellipsis adjacent to markdown markers (* " ')
            const specialAfterRx  = new RegExp(`(?:${patternSource})[ \\t]*(?=[*"'])`, 'g');
            const specialBeforeRx = new RegExp(`(?<=[*"'])(?:${patternSource})[ \\t]*`, 'g');

            processed = processed
                .replace(specialBeforeRx, m => { removedCount++; return ''; })
                .replace(specialAfterRx,  m => { removedCount++; return ''; });

            // Main replacement
            const mainRegex = settings.preserveSpace
                ? baseRegex
                : new RegExp(`(?:${patternSource})[ \\t]*`, 'g');

            processed = processed.replace(mainRegex, (match, offset, fullStr) => {
                removedCount++;
                if (!settings.preserveSpace) return '';
                const prev = fullStr[offset - 1];
                const next = fullStr[offset + match.length];
                const hasSpaceBefore = prev === undefined || /\s/.test(prev);
                const hasSpaceAfter  = next === undefined || /\s/.test(next);
                return (hasSpaceBefore || hasSpaceAfter) ? '' : ' ';
            });

            // Restore protected items
            if (settings.protectCode) {
                processed = processed.replace(/@@PT(\d+)@@/g, (_, i) => protectedItems[+i]);
            }

            return { text: processed, removed: removedCount };
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
                if (r.removed > 0) { msg.extra.display_text = r.text; }
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
                if (typeof msg.mes === 'string') {
                    count += this.cleanText(msg.mes, settings).removed;
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
            badge.textContent = text;
            badge.className = `rm-ell-header-status ${cls}`;
        },

        updateUndoButtons() {
            const can = UndoStack.canUndo();
            $('.rm-ell-btn-undo').toggleClass('rm-ell-btn-disabled', !can);
        },

        // ----------------------------------------------------------------
        // Popup menu
        // ----------------------------------------------------------------
        togglePopupMenu() {
            const popup = $('#rm-ell-popup-menu');
            popup.hasClass('show') ? this.hidePopupMenu() : (() => {
                this.updatePopupMenuState();
                popup.addClass('show');
            })();
        },

        hidePopupMenu() {
            $('#rm-ell-popup-menu').removeClass('show');
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
                    <div class="rm-ell-popup-item rm-ell-popup-toggle" id="rm-ell-popup-${def.key}" data-key="${def.key}">
                        <span class="rm-ell-toggle-label">
                            <i class="${def.icon}"></i> ${def.label}
                        </span>
                        <span class="rm-ell-toggle-status ${val ? 'on' : 'off'}">${val ? 'ON' : 'OFF'}</span>
                    </div>`;
            }).join('');

            return `
                <div id="rm-ell-quick-btn-wrapper" class="rm-ell-quick-btn-wrapper">
                    <div id="rm-ell-quick-btn" class="rm-ell-quick-btn" role="button"
                         aria-label="Text Cleaner: tap to clean, hold for options">
                        <span class="rm-ell-quick-emoji" aria-hidden="true">🧹</span>
                        <span id="rm-ell-auto-dot" class="rm-ell-auto-dot" style="${dotVisible}"></span>
                    </div>
                    <div id="rm-ell-popup-menu" class="rm-ell-popup-menu">
                        <div class="rm-ell-popup-header">
                            <span class="rm-ell-quick-emoji">🧹</span> Text Cleaner
                        </div>
                        <div class="rm-ell-popup-item" id="rm-ell-popup-clean">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> Clean Now
                        </div>
                        <div class="rm-ell-popup-item" id="rm-ell-popup-undo" data-undo>
                            <i class="fa-solid fa-rotate-left"></i> Undo
                        </div>
                        <div class="rm-ell-popup-item" id="rm-ell-popup-check">
                            <i class="fa-solid fa-magnifying-glass"></i> Check
                        </div>
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

            // Group: first two (auto + engparens) are "primary", rest are "advanced"
            const primary  = SETTINGS_SCHEMA.filter(d =>  d.inPopup);
            const advanced = SETTINGS_SCHEMA.filter(d => !d.inPopup);

            const makeCheckbox = (def) => {
                const labelStyle = def.highlight ? 'color:var(--smart-blue);' : '';
                const labelWeight = def.highlight ? 'font-weight:bold;' : '';
                return `
                    <label class="checkbox_label" ${def.title ? `title="${def.title}"` : ''}>
                        <input type="checkbox"
                               class="rm-ell-input-${def.key}"
                               id="drawer-rm-ell-${def.key}"
                               ${st[def.key] ? 'checked' : ''} />
                        <span style="${labelStyle}${labelWeight}">${def.label}</span>
                    </label>`;
            };

            return `
                <div class="styled_description_block">Extension by Zealllll</div>

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

                <hr style="margin: 10px 0; border-color: var(--grey-60); opacity: 0.5;">

                ${advanced.map(makeCheckbox).join('')}

                <div style="display: flex; gap: 8px; margin-top: 15px; flex-wrap: wrap;">
                    <div class="rm-ell-btn-clean menu_button" style="flex: 1; min-width: 90px;"
                         title="ลบสิ่งสกปรกในแชทปัจจุบันทันที">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> Clean Now
                    </div>
                    <div class="rm-ell-btn-undo menu_button rm-ell-btn-disabled" style="flex: 1; min-width: 80px;"
                         title="เลิกทำการลบครั้งล่าสุด">
                        <i class="fa-solid fa-rotate-left"></i> Undo
                    </div>
                    <div class="rm-ell-btn-check menu_button" style="flex: 1; min-width: 80px;"
                         title="ตรวจสอบจำนวนที่ต้องลบ">
                        <i class="fa-solid fa-magnifying-glass"></i> Check
                    </div>
                </div>`;
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

            // --- Long press logic ---
            // NOTE: Do NOT pass `{ passive: true }` as jQuery `.on()` 3rd arg.
            // jQuery treats that arg as event data / handler and breaks touchstart
            // on mobile (desktop mousedown still worked, so only phones failed).
            const LONG_PRESS_MS = 450;
            const MOVE_CANCEL_PX = 12;
            const btnEl = document.getElementById('rm-ell-quick-btn');
            let pressTimer = null;
            let longPressFired = false;
            let pressActive = false;
            let pressPointerType = null; // 'touch' | 'mouse'
            let startX = 0;
            let startY = 0;
            let suppressOutsideCloseUntil = 0;
            let ignoreMouseUntil = 0; // swallow ghost mouse events after touch

            const clearTimer = () => {
                if (pressTimer) {
                    clearTimeout(pressTimer);
                    pressTimer = null;
                }
            };

            const openPopupFromLongPress = () => {
                longPressFired = true;
                btnEl?.classList.remove('rm-ell-pressing');
                // Keep outside-close from eating the synthetic click that follows
                // a long-press on mobile browsers.
                suppressOutsideCloseUntil = Date.now() + 450;
                UI.updatePopupMenuState();
                $('#rm-ell-popup-menu').addClass('show');
                if (navigator.vibrate) {
                    try { navigator.vibrate(15); } catch (_) {}
                }
            };

            const startPress = (e, pointerType) => {
                // After a real touch, browsers also emit ghost mouse events —
                // ignore those so we don't restart/cancel the long-press.
                if (pointerType === 'mouse' && Date.now() < ignoreMouseUntil) return;
                if (pointerType === 'mouse' && e.button != null && e.button !== 0) return;
                // Don't stack a second press while one is active
                if (pressActive) return;

                pressActive = true;
                pressPointerType = pointerType;
                longPressFired = false;
                btnEl?.classList.add('rm-ell-pressing');

                if (pointerType === 'touch' && e.touches && e.touches[0]) {
                    startX = e.touches[0].clientX;
                    startY = e.touches[0].clientY;
                } else {
                    startX = e.clientX ?? 0;
                    startY = e.clientY ?? 0;
                }

                clearTimer();
                pressTimer = setTimeout(openPopupFromLongPress, LONG_PRESS_MS);
            };

            const endPress = (e, cancelled = false) => {
                if (!pressActive) return;
                const wasTouch = pressPointerType === 'touch';
                pressActive = false;
                pressPointerType = null;
                clearTimer();
                btnEl?.classList.remove('rm-ell-pressing');

                if (wasTouch) {
                    // Block the synthetic mousedown/mouseup/click sequence
                    ignoreMouseUntil = Date.now() + 700;
                }

                if (cancelled || longPressFired) {
                    // Stop the follow-up click from also firing clean / closing menu
                    if (e) {
                        try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
                    }
                    return;
                }

                if (e) {
                    try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
                }
                App.removeAll();
            };

            const onTouchMove = (e) => {
                if (!pressActive || pressPointerType !== 'touch' || !e.touches?.[0]) return;
                const dx = e.touches[0].clientX - startX;
                const dy = e.touches[0].clientY - startY;
                if ((dx * dx + dy * dy) > (MOVE_CANCEL_PX * MOVE_CANCEL_PX)) {
                    endPress(null, true);
                }
            };

            // Prefer native listeners for touch — reliable passive/options + no jQuery arg pitfalls
            if (btnEl) {
                btnEl.addEventListener('touchstart', (e) => {
                    // Single-finger only
                    if (e.touches && e.touches.length > 1) {
                        endPress(null, true);
                        return;
                    }
                    startPress(e, 'touch');
                }, { passive: true });

                btnEl.addEventListener('touchmove', onTouchMove, { passive: true });

                btnEl.addEventListener('touchend', (e) => {
                    endPress(e, false);
                }, { passive: false });

                btnEl.addEventListener('touchcancel', () => {
                    endPress(null, true);
                }, { passive: true });

                btnEl.addEventListener('mousedown', (e) => startPress(e, 'mouse'));
                btnEl.addEventListener('mouseup', (e) => endPress(e, false));
                btnEl.addEventListener('mouseleave', () => endPress(null, true));
                btnEl.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                });
                // Swallow click always — short tap is handled in touchend/mouseup
                btnEl.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                });
            }

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

            // Popup toggle buttons (generated from schema)
            $(document).on('click', '.rm-ell-popup-toggle[data-key]', function(e) {
                e.stopPropagation();
                const key = $(this).data('key');
                App.toggleSetting(key);
            });

            // Close popup on outside click / tap
            // (skip briefly after long-press open — mobile synthetic click would re-close it)
            $(document)
                .off('click.rmellpopup pointerdown.rmellpopup')
                .on('click.rmellpopup pointerdown.rmellpopup', (e) => {
                    if (Date.now() < suppressOutsideCloseUntil) return;
                    if (!$(e.target).closest('#rm-ell-quick-btn-wrapper').length) {
                        UI.hidePopupMenu();
                    }
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
                            <b><span class="rm-ell-quick-emoji">🧹</span> Text Cleaner Ext</b>
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
        async removeAll(silent = false) {
            if (this._removeAllRunning) return;
            this._removeAllRunning = true;

            try {
                const ctx = Core.getContext();
                if (!ctx?.chat) return;

                const settings = Core.getSettings();

                // Save snapshot for undo (deep clone only modified messages)
                const snapshot = ctx.chat.map(msg => ({
                    mes: msg.mes,
                    extra_display: msg.extra?.display_text
                }));

                let count = 0;
                const updatedIndexes = [];

                ctx.chat.forEach((msg, index) => {
                    const removed = Cleaner.cleanMessage(msg, settings);
                    if (removed > 0) {
                        count += removed;
                        updatedIndexes.push(index);
                    }
                });

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
            const entry = UndoStack.pop();
            if (!entry) { UI.notify('Nothing to undo.', 'info'); return; }

            const ctx = Core.getContext();
            if (!ctx?.chat) return;

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
                if (def.type === 'number') continue; // handle separately below
                $(document).on('change', `.rm-ell-input-${def.key}`, (e) => {
                    const st = Core.getSettings();
                    st[def.key] = e.target.checked;
                    Core.saveSettings();
                    UI.syncAll();
                    if (def.warning && e.target.checked) UI.notify(def.warning, 'warning');
                });
            }

            // cleanDepth number input
            $(document).on('change input', '.rm-ell-input-cleanDepth', (e) => {
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
            if (this._removeAllRunning) return;
            if (!depth || depth <= 0) { await this.removeAll(true); return; }

            this._removeAllRunning = true;
            try {
                const ctx = Core.getContext();
                if (!ctx?.chat) return;

                const settings = Core.getSettings();
                const chat = ctx.chat;
                const startIndex = Math.max(0, chat.length - depth);

                const snapshot = {};
                let count = 0;
                const updatedIndexes = [];

                for (let i = startIndex; i < chat.length; i++) {
                    const msg = chat[i];
                    snapshot[i] = { mes: msg.mes, extra_display: msg.extra?.display_text };
                    const removed = Cleaner.cleanMessage(msg, settings);
                    if (removed > 0) {
                        count += removed;
                        updatedIndexes.push(i);
                    }
                }

                if (updatedIndexes.length > 0) {
                    UndoStack.push({ snapshot, indexes: updatedIndexes });
                    updatedIndexes.forEach(i => this._updateMessageBlock(ctx, i));
                    await ctx.saveChat?.();
                }

                UI.updateUndoButtons();
            } finally {
                this._removeAllRunning = false;
            }
        },

        // ----------------------------------------------------------------
        // Init
        // ----------------------------------------------------------------
        init() {
            const ctx = Core.getContext();
            this.bindEvents();

            // Auto-remove on new message — ใช้ depth แทน removeAll ทั้งหมด
            if (ctx?.eventSource) {
                ctx.eventSource.on(ctx.event_types.MESSAGE_RECEIVED, async () => {
                    const st = Core.getSettings();
                    if (st.autoRemove) await App.removeRecent(st.cleanDepth);
                });
            }

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

                    UI.updateDrawerHeaderStatus();
                } catch (err) {
                    console.error('[CleanerExt] observer error:', err);
                } finally {
                    isRunning = false;
                }
            };

            const scheduleCheck = () => {
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
