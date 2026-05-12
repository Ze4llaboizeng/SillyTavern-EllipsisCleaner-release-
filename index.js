/* Remove Ellipsis — Instant UI Update & Thai-English Bracket Removal */
(() => {
    if (typeof window === 'undefined') { global.window = {}; }
    if (window.__REMOVE_ELLIPSIS_EXT_LOADED__) return;
    window.__REMOVE_ELLIPSIS_EXT_LOADED__ = true;

    // ========================================================================
    // MODULE: Constants & Defaults
    // ========================================================================
    const MODULE_NAME = 'removeEllipsisExt';
    const DEFAULTS = { 
        autoRemove: false, 
        removeAllDots: false, 
        treatTwoDots: false,
        preserveSpace: true,
        protectCode: true,
        notifications: true,
        removeEngParens: false 
    };

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
    // MODULE: Cleaner
    // ========================================================================
    const Cleaner = {
        cleanText(text, settings) {
            if (typeof text !== 'string' || !text) return { text, removed: 0 };

            const protectedItems = [];
            let processed = text;
            let removedCount = 0;

            // --- PROTECT CODE BLOCKS ---
            if (settings.protectCode) {
                const mask = (regex) => {
                    processed = processed.replace(regex, m => `@@PT${protectedItems.push(m) - 1}@@`);
                };

                mask(/```[\s\S]*?```/g);
                mask(/`[^`]*`/g);
                mask(/<script\b[^>]*>[\s\S]*?<\/script>/gi);
                mask(/<style\b[^>]*>[\s\S]*?<\/style>/gi);
                mask(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi);
                mask(/<code\b[^>]*>[\s\S]*?<\/code>/gi);
                mask(/<[^>]+>/g);
            }

            // --- 1. REMOVE ENGLISH PARENTHESES AFTER THAI ---
            if (settings.removeEngParens) {
                // อธิบาย Regex ใหม่:
                // Group 1: จับตัวอักษรไทย รวมถึงสัญลักษณ์ตกแต่ง (เช่น *, _, ") ที่อาจคั่นอยู่
                // Group 2: จับช่องว่าง(ถ้ามี) + วงเล็บที่มีภาษาอังกฤษข้างใน
                const engParenRegex = /([\u0E00-\u0E7F][*_"']*)(\s*\([^)]*[A-Za-z][^)]*\))/g;
                processed = processed.replace(engParenRegex, (match, g1, g2) => {
                    removedCount += g2.length;
                    return g1; // คืนค่าภาษาไทยกลับไป ลบเฉพาะ Group 2 (วงเล็บ) ทิ้ง
                });
            }

            // --- 2. REMOVE ELLIPSIS ---
            let patternSource;
            if (settings.removeAllDots) {
                patternSource = "\\.+|…";
            } else {
                patternSource = settings.treatTwoDots ? "(?<!\\d)\\.{2,}(?!\\d)|…" : "(?<!\\d)\\.{3,}(?!\\d)|…";
            }
            const baseRegex = new RegExp(patternSource, 'g');

            const specialAfter = new RegExp(`(?:${patternSource})[ \t]*(?=[*"'])`, 'g');
            const specialBefore = new RegExp(`(?<=[*"'])(?:${patternSource})[ \t]*`, 'g');
            
            processed = processed
                .replace(specialBefore, m => { removedCount += m.length; return ''; })
                .replace(specialAfter, m => { removedCount += m.length; return ''; });

            const mainPattern = settings.preserveSpace ? baseRegex : new RegExp(`(?:${patternSource})[ \t]*`, 'g');

            processed = processed.replace(mainPattern, (match, offset, fullStr) => {
                removedCount += match.length;
                if (!settings.preserveSpace) return '';
                const prev = fullStr[offset - 1];
                const next = fullStr[offset + match.length];
                const hasSpaceBefore = prev === undefined ? true : /\s/.test(prev);
                const hasSpaceAfter = next === undefined ? true : /\s/.test(next);
                if (hasSpaceBefore || hasSpaceAfter) return '';
                return ' '; 
            });

            // --- UNPROTECT CODE BLOCKS ---
            if (settings.protectCode) {
                processed = processed.replace(/@@PT(\d+)@@/g, (_, i) => protectedItems[i]);
            }

            return { text: processed, removed: removedCount };
        },

        cleanMessage(msg) {
            if (!msg) return 0;
            const settings = Core.getSettings();
            let total = 0;
            
            if (typeof msg.mes === 'string') {
                const r = this.cleanText(msg.mes, settings);
                if (r.removed > 0) {
                    msg.mes = r.text;
                    total += r.removed;
                }
            }

            if (msg.extra && typeof msg.extra.display_text === 'string') {
                const r = this.cleanText(msg.extra.display_text, settings);
                if (r.removed > 0) {
                    msg.extra.display_text = r.text;
                }
            }
            
            return total;
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
        }
    };

    // ========================================================================
    // MODULE: App
    // ========================================================================
    const App = {
        async removeAll(silent = false) {
            const ctx = Core.getContext();
            if (!ctx?.chat) return;
            
            let count = 0;
            let updatedIndexes = [];
            
            // 1. วนเช็กและลบจุด/วงเล็บ ในข้อมูล Chat
            ctx.chat.forEach((msg, index) => {
                const removed = Cleaner.cleanMessage(msg);
                if (removed > 0) {
                    count += removed;
                    updatedIndexes.push(index); // บันทึกตำแหน่งที่ถูกแก้ไข
                }
            });
            
            // 2. ถ้ามีการแก้ไข ให้ทำการบังคับรีเรนเดอร์ UI ทันที
            if (updatedIndexes.length > 0) {
                updatedIndexes.forEach(index => {
                    // ใช้ฟังก์ชันหลักของ ST เพื่อเรนเดอร์กล่องข้อความที่มีการแก้ไขใหม่
                    if (typeof window.updateMessageBlock === 'function') {
                        window.updateMessageBlock(index, ctx.chat[index]);
                    } else if (typeof ctx.updateMessageBlock === 'function') {
                        ctx.updateMessageBlock(index, ctx.chat[index]);
                    } else if (ctx.eventSource) {
                        ctx.eventSource.emit(ctx.event_types.MESSAGE_UPDATED, index);
                    }
                });
                if (typeof ctx.saveChat === 'function') await ctx.saveChat();
            }
            
            if (!silent) {
                if (count > 0) UI.notify(`Cleaned ${count} elements instantly.`, 'success');
                else UI.notify('No elements found (or protected).', 'info');
            }
        },

        async checkAll() {
            const ctx = Core.getContext();
            if (!ctx?.chat) return;
            let count = 0;
            const st = Core.getSettings();
            ctx.chat.forEach(msg => {
                if (typeof msg.mes === 'string') count += Cleaner.cleanText(msg.mes, st).removed;
            });
            if (st.notifications) UI.notify(count > 0 ? `Found ${count} elements to clean.` : 'All clean.', 'info');
            else if (typeof toastr !== 'undefined') toastr.info(count > 0 ? `Found ${count} elements.` : 'All clean.', 'Check Result');
        },

        injectSettings() {
            if (typeof $ === 'undefined') return;
            
            if ($('#remove-ellipsis-settings').length > 0) return;
            const container = $('#extensions_settings');
            if (!container.length) return;

            const st = Core.getSettings();

            container.append(`
                <div id="remove-ellipsis-settings" class="extension_settings_block">
                    <div class="inline-drawer">
                        <div class="inline-drawer-toggle inline-drawer-header">
                            <b><i class="fa-solid fa-broom"></i> Text Cleaner Ext</b>
                            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
                        </div>
                        <div class="inline-drawer-content" style="display:none;">
                            
                            <div class="styled_description_block">Extension by Zealllll</div>
                            
                            <label class="checkbox_label">
                                <input type="checkbox" id="rm-ell-auto" ${st.autoRemove ? 'checked' : ''} />
                                <span>Auto Remove (After Generation)</span>
                            </label>

                            <hr style="margin: 10px 0; border-color: var(--grey-60); opacity: 0.5;">

                            <label class="checkbox_label" title="ลบวงเล็บภาษาอังกฤษที่ตามหลังภาษาไทย เช่น แชท(chat) ให้เหลือแค่ แชท">
                                <input type="checkbox" id="rm-ell-engparens" ${st.removeEngParens ? 'checked' : ''} />
                                <span style="color:var(--smart-blue);"><b>Remove English in ( )</b></span>
                            </label>

                            <hr style="margin: 10px 0; border-color: var(--grey-60); opacity: 0.5;">

                            <label class="checkbox_label" title="อันตราย: ตัวเลือกนี้จะลบจุด (.) ทุกตัวในข้อความ!">
                                <input type="checkbox" id="rm-ell-all" ${st.removeAllDots ? 'checked' : ''} />
                                <span>Remove ALL Dots (.)</span>
                            </label>
                            
                            <label class="checkbox_label">
                                <input type="checkbox" id="rm-ell-twodots" ${st.treatTwoDots ? 'checked' : ''} />
                                <span>Remove ".."</span>
                            </label>

                            <hr style="margin: 10px 0; border-color: var(--grey-60); opacity: 0.5;">
                            
                            <label class="checkbox_label">
                                <input type="checkbox" id="rm-ell-protect" ${st.protectCode !== false ? 'checked' : ''} />
                                <span>Protect Code & HTML</span>
                            </label>

                            <label class="checkbox_label">
                                <input type="checkbox" id="rm-ell-space" ${st.preserveSpace ? 'checked' : ''} />
                                <span>Preserve Space</span>
                            </label>

                            <label class="checkbox_label" title="แสดงแจ้งเตือนเมื่อทำการลบจุดหรือวงเล็บ">
                                <input type="checkbox" id="rm-ell-notify" ${st.notifications !== false ? 'checked' : ''} />
                                <span>Show Notifications</span>
                            </label>

                            <div style="display: flex; gap: 10px; margin-top: 15px;">
                                <div id="rm-ell-btn-clean" class="menu_button" style="flex: 1;" title="ลบสิ่งสกปรกในแชทปัจจุบันทันที">
                                    <i class="fa-solid fa-wand-magic-sparkles"></i> Clean Now
                                </div>
                                <div id="rm-ell-btn-check" class="menu_button" style="flex: 1;" title="ตรวจสอบจำนวนที่ต้องลบ">
                                    <i class="fa-solid fa-magnifying-glass"></i> Check
                                </div>
                            </div>

                        </div>
                    </div>
                </div>
            `);
        },

        bindEvents() {
            if (this._eventsBound) return;
            this._eventsBound = true;

            const updateSetting = (key, val) => {
                Core.getSettings()[key] = val;
                Core.saveSettings();
            };

            $(document).on('change', '#rm-ell-auto', (e) => {
                updateSetting('autoRemove', e.target.checked);
                UI.notify(`Auto Remove: ${e.target.checked ? 'ON' : 'OFF'}`);
            });
            $(document).on('change', '#rm-ell-engparens', (e) => {
                updateSetting('removeEngParens', e.target.checked);
                UI.notify(`Remove English in ( ): ${e.target.checked ? 'ON' : 'OFF'}`);
            });
            $(document).on('change', '#rm-ell-all', (e) => {
                updateSetting('removeAllDots', e.target.checked);
                if(e.target.checked) UI.notify("Warning: Will remove ALL periods!", 'warning');
            });
            $(document).on('change', '#rm-ell-twodots', (e) => updateSetting('treatTwoDots', e.target.checked));
            $(document).on('change', '#rm-ell-space', (e) => updateSetting('preserveSpace', e.target.checked));
            $(document).on('change', '#rm-ell-protect', (e) => {
                updateSetting('protectCode', e.target.checked);
                UI.notify(`Code Protection: ${e.target.checked ? 'ON' : 'OFF'}`);
            });
            
            $(document).on('change', '#rm-ell-notify', (e) => {
                updateSetting('notifications', e.target.checked);
                if(e.target.checked) UI.notify('Notifications Enabled', 'success');
            });

            $(document).on('click', '#rm-ell-btn-clean', async (e) => {
                e.preventDefault();
                UI.closeDrawer();
                await App.removeAll(); // ทำงานและอัปเดต UI ทันที
            });
            $(document).on('click', '#rm-ell-btn-check', async (e) => {
                e.preventDefault();
                UI.closeDrawer();
                await App.checkAll();
            });
        },

        init() {
            const ctx = Core.getContext();
            this.bindEvents(); 
            if (ctx?.eventSource) {
                // อัปเดตเมื่อ AI สร้างข้อความเสร็จสมบูรณ์
                ctx.eventSource.on(ctx.event_types.MESSAGE_RECEIVED, async () => {
                    if (Core.getSettings().autoRemove) await App.removeAll(true);
                });
            }
            this.injectSettings();
        }
    };

    (function boot() {
        if (typeof document === 'undefined') return;
        const onReady = () => {
            App.init();
            const obs = new MutationObserver(() => App.injectSettings());
            const target = document.querySelector('#content') || document.body;
            obs.observe(target, { childList: true, subtree: true });
        };
        if (window.SillyTavern?.getContext) onReady();
        else setTimeout(onReady, 2000); 
    })();

    window.RemoveEllipsis = { Core, Cleaner, UI, App };
})();
