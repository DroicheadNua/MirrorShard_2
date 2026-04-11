// src/i18n.ts

export type Locale = 'ja' | 'en';

let currentLocale: Locale = 'ja';
let translations: Record<string, any> = {};

/**
 * 複数のJSONファイルを読み込んでマージする
 */
export async function initI18n(locale: Locale) {
    currentLocale = locale;
    try {
        // Viteの機能を使って、該当ロケールのJSONを動的にインポート
        const [common, editor, ideaProcessor, settings, prompts] = await Promise.all([
            import(`../locales/${locale}/common.json`),
            import(`../locales/${locale}/editor.json`),
            import(`../locales/${locale}/ideaProcessor.json`),
            import(`../locales/${locale}/settings.json`),
            import(`../locales/${locale}/prompts.json`),
        ]);

        translations = {
            common: common.default,
            editor: editor.default,
            ideaProcessor: ideaProcessor.default,
            settings: settings.default,
            prompts: prompts.default
        };
    } catch (e) {
        console.error(`[i18n] Failed to load translations for ${locale}`, e);
    }
}

/**
 * キー（例: 'editor.alerts.hugeFile'）から翻訳を取得
 */
export function t(key: string, params?: Record<string, string | number>): string {
    const keys = key.split('.');
    let value: any = translations; // ★修正: any型を明示

    for (const k of keys) {
        if (value && typeof value === 'object' && k in value) {
            value = value[k];
        } else {
            console.warn(`[i18n] Missing key: ${key}`);
            return key; // 見つからない場合はキーをそのまま返す
        }
    }

    if (typeof value === 'string') {
        if (params) {
            // ★修正: 引数 _ と k に型 (string) を明示
            return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_: string, k: string) => String(params[k] ?? ''));
        }
        return value;
    }

    return key;
}

export function getCurrentLocale(): Locale {
    return currentLocale;
}