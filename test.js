'use strict';

const assert = require('node:assert/strict');

require('./index.js');

const { Cleaner, Core, UI } = global.window.RemoveEllipsis;
const settings = overrides => ({ ...Core.getSettings(), ...overrides });
const clean = (text, overrides = {}) => Cleaner.cleanText(text, settings(overrides));

assert.deepEqual(clean('Hello...world'), { text: 'Hello world', removed: 1 });
assert.deepEqual(clean('Version 1.2.3... done'), { text: 'Version 1.2.3 done', removed: 1 });
assert.deepEqual(clean('Wait.. now'), { text: 'Wait.. now', removed: 0 });
assert.deepEqual(clean('Wait.. now', { treatTwoDots: true }), { text: 'Wait now', removed: 1 });

assert.deepEqual(
    clean('<think>Keep...</think> Remove...', { protectCode: false }),
    { text: '<think>Keep...</think> Remove', removed: 1 },
);
assert.deepEqual(
    clean('`keep...` remove...'),
    { text: '`keep...` remove', removed: 1 },
);
assert.deepEqual(
    clean('\uE000RMELL0\uE001 ```keep...``` remove...'),
    { text: '\uE000RMELL0\uE001 ```keep...``` remove', removed: 1 },
);
assert.deepEqual(
    clean('คำ: (word) ต่อ...', { removeEngParens: true }),
    { text: 'คำ: ต่อ', removed: 2 },
);

const message = { mes: 'plain', extra: { display_text: 'Shown...' } };
assert.equal(Cleaner.cleanMessage(message, settings()), 1);
assert.equal(message.extra.display_text, 'Shown');
assert.equal(Cleaner.countAll([{ mes: 'plain', extra: { display_text: 'Shown...' } }], settings()), 1);

const panel = UI.buildSettingsPanelHtml();
assert.equal(panel.match(/id="drawer-rm-ell-cleanDepth"/g)?.length, 1);
assert.match(panel, /type="number"[\s\S]*id="drawer-rm-ell-cleanDepth"/);

// Literal custom entries share spacing, protection, counting, and message cleaning.
assert.deepEqual(clean('Hello—world⋯again. . .done', { customText: '—\n⋯\n. . .' }),
    { text: 'Hello world again done', removed: 3 });
assert.deepEqual(clean('a[x]b.*c', { customText: '[x]\n.*' }),
    { text: 'a b c', removed: 2 });
assert.deepEqual(clean('a—b...', { customText: '—', customEnabled: false }),
    { text: 'a—b', removed: 1 });
assert.deepEqual(clean('a— b', { customText: '—', preserveSpace: false }),
    { text: 'ab', removed: 1 });
assert.deepEqual(clean('a——b', { customText: '—\n——\n—\n\n' }),
    { text: 'a b', removed: 1 });
assert.deepEqual(clean('Word word', { customText: 'word' }),
    { text: 'Word ', removed: 1 });
assert.deepEqual(clean('a...b', { customText: '\n  \n' }),
    { text: 'a b', removed: 1 });
assert.deepEqual(clean('`keep—` <code>keep—</code> remove—', { customText: '—' }),
    { text: '`keep—` <code>keep—</code> remove', removed: 1 });
assert.deepEqual(clean('<think>keep—</think> `remove—`', { customText: '—', protectCode: false }),
    { text: '<think>keep—</think> `remove `', removed: 1 });
assert.deepEqual(clean('a...`code`...b'), { text: 'a `code` b', removed: 2 });
assert.deepEqual(clean('<pre><think>keep...</think> keep...</pre> remove...'),
    { text: '<pre><think>keep...</think> keep...</pre> remove', removed: 1 });
assert.deepEqual(clean('text... <think>unfinished...'),
    { text: 'text <think>unfinished...', removed: 1 });
assert.deepEqual(clean('text... ```unfinished...'),
    { text: 'text ```unfinished...', removed: 1 });
assert.deepEqual(clean('`RMELL...` RMELL', { customText: 'RMELL' }),
    { text: '`RMELL...` ', removed: 1 });
for (const literal of ['$', '^', '(', ')', '[', ']', '{', '}', '|', '+', '?', '\\', '*']) {
    assert.equal(clean(`a${literal}b`, { customText: literal }).text, 'a b');
}
const customSettings = settings({ customText: '—' });
const customMessage = { mes: 'a—b', extra: { display_text: 'c—d' } };
assert.equal(Cleaner.countAll([customMessage], customSettings), 2);
assert.equal(customMessage.mes, 'a—b'); // Check never mutates the chat.
assert.equal(Cleaner.cleanMessage(customMessage, customSettings), 2);
assert.deepEqual(customMessage, { mes: 'a b', extra: { display_text: 'c d' } });
assert.match(panel, /<textarea[^>]*id="drawer-rm-ell-customText"/);
assert.match(panel, /<summary>Shared options<\/summary>/);
assert.match(UI._buildPopupHTML(), /aria-controls="rm-ell-popup-menu"/);
assert.match(UI._buildPopupHTML(), /<button[^>]*id="rm-ell-popup-customEnabled"/);

console.log('Ellipsis Cleaner checks passed.');
