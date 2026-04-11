// src/i18n.ts

export type Locale = 'ja' | 'en';

let currentLocale: Locale = 'ja';
let translations: Record<string, any> = {};

export async function initI18n(locale: Locale) {
    currentLocale = locale;
    try {
        const [common, editor, ideaProcessor, settings, prompts, main, shortcut, markdown] = await Promise.all([
            import(`../locales/${locale}/common.json`),
            import(`../locales/${locale}/editor.json`),
            import(`../locales/${locale}/ideaProcessor.json`),
            import(`../locales/${locale}/settings.json`),
            import(`../locales/${locale}/prompts.json`),
            import(`../locales/${locale}/main.json`),
            import(`../locales/${locale}/shortcut.json`),
            import(`../locales/${locale}/markdown.json`),
        ]);

        translations = {
            common: common.default,
            editor: editor.default,
            ideaProcessor: ideaProcessor.default,
            settings: settings.default,
            prompts: prompts.default,
            main: main.default,
            shortcut: shortcut.default,
            markdown: markdown.default
        };
    } catch (e) {
        console.error(`[i18n] Failed to load translations for ${locale}`, e);
    }
}

export function t(key: string, params?: Record<string, string | number>): string {
    const keys = key.split('.');
    let value: any = translations;

    for (const k of keys) {
        if (value && typeof value === 'object' && k in value) {
            value = value[k];
        } else {
            console.warn(`[i18n] Missing key: ${key}`);
            return key;
        }
    }

    if (typeof value === 'string') {
        if (params) {
            return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_: string, k: string) => String(params[k] ?? ''));
        }
        return value;
    }

    return key;
}

export function getCurrentLocale(): Locale {
    return currentLocale;
}

function setText(el: Element, key: string) {
    const translated = t(key);
    if (translated !== key) {
        el.textContent = translated;
    }
}

export function applyTranslationsToDOM() {
    // textContent: only on elements that have NO element children (text-only leaves)
    const textEls = document.querySelectorAll('[data-i18n]');
    textEls.forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (!key) return;
        const hasElementChild = Array.from(el.children).some(c => c.nodeType === 1);
        if (!hasElementChild) {
            setText(el, key);
        }
    });

    // placeholder
    const placeholderEls = document.querySelectorAll('[data-i18n-placeholder]');
    placeholderEls.forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (key && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
            (el as HTMLInputElement | HTMLTextAreaElement).placeholder = t(key);
        }
    });

    // title attribute via data-i18n-title
    const titleEls = document.querySelectorAll('[data-i18n-title]');
    titleEls.forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (key) {
            el.setAttribute('title', t(key));
        }
    });

    // arbitrary attribute via data-i18n-{attrName}
    const attrEls = document.querySelectorAll('[data-i18n-attr]');
    attrEls.forEach(el => {
        const attrName = el.getAttribute('data-i18n-attr');
        const key = el.getAttribute('data-i18n');
        if (attrName && key) {
            el.setAttribute(attrName, t(key));
        }
    });
}
