/**
 * i18n Service - Quản lý đa ngôn ngữ cho hệ thống ERP
 * Hỗ trợ: Tiếng Việt (vi), Tiếng Anh (en), Tiếng Hàn (ko)
 */

const I18n = {
    currentLang: 'vi',
    translations: {},
    
    /**
     * Khởi tạo i18n với ngôn ngữ từ localStorage hoặc mặc định
     */
    init() {
        const savedLang = localStorage.getItem('app_language') || 'vi';
        this.setLanguage(savedLang);
    },
    
    /**
     * Load translations cho một ngôn ngữ
     */
    async loadTranslations(lang) {
        try {
            const response = await fetch(`/modules/assets/i18n/${lang}.json`);
            if (!response.ok) throw new Error(`Failed to load ${lang}.json`);
            this.translations[lang] = await response.json();
            return this.translations[lang];
        } catch (err) {
            console.error(`[i18n] Failed to load translations for ${lang}:`, err);
            // Fallback to Vietnamese if other languages fail
            if (lang !== 'vi') {
                return this.loadTranslations('vi');
            }
            return {};
        }
    },
    
    /**
     * Đặt ngôn ngữ hiện tại và load translations
     */
    async setLanguage(lang) {
        if (!['vi', 'en', 'ko'].includes(lang)) {
            console.warn(`[i18n] Invalid language: ${lang}, defaulting to 'vi'`);
            lang = 'vi';
        }
        
        this.currentLang = lang;
        localStorage.setItem('app_language', lang);
        
        // Load translations if not already loaded
        if (!this.translations[lang]) {
            await this.loadTranslations(lang);
        }
        
        // Update HTML lang attribute
        document.documentElement.lang = lang;
        
        // Trigger custom event for other scripts to listen
        document.dispatchEvent(new CustomEvent('languageChanged', { detail: { lang } }));
        
        // If running in iframe, notify parent window
        if (window.parent && window.parent !== window) {
            try {
                window.parent.postMessage({
                    type: 'languageChanged',
                    lang: lang
                }, '*');
            } catch (e) {
                console.warn('[i18n] Failed to notify parent window:', e);
            }
        }
        
        // Update all translated elements
        this.updatePage();
    },
    
    /**
     * Lấy translation cho một key
     * @param {string} key - Key của translation (có thể dùng dot notation như "mps.title")
     * @param {object} params - Object chứa các tham số để thay thế trong translation
     * @returns {string} Translated text
     */
    t(key, params = {}) {
        const translations = this.translations[this.currentLang] || {};
        let value = key.split('.').reduce((obj, k) => obj?.[k], translations);
        
        if (value === undefined) {
            console.warn(`[i18n] Translation missing for key: ${key} (lang: ${this.currentLang})`);
            return key; // Return key if translation not found
        }
        
        // Replace parameters in translation
        if (typeof value === 'string' && Object.keys(params).length > 0) {
            Object.keys(params).forEach(param => {
                value = value.replace(new RegExp(`{{${param}}}`, 'g'), params[param]);
            });
        }
        
        return value;
    },
    
    /**
     * Cập nhật tất cả elements có data-i18n attribute
     */
    updatePage() {
        // Update elements with data-i18n attribute
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            let params = {};
            
            // Check for data-i18n-params attribute (JSON format)
            const paramsAttr = el.getAttribute('data-i18n-params');
            if (paramsAttr) {
                try {
                    params = JSON.parse(paramsAttr);
                } catch (e) {
                    console.warn(`[i18n] Failed to parse params for ${key}:`, paramsAttr);
                }
            }
            
            const text = this.t(key, params);
            
            // Handle different element types
            if (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number')) {
                el.placeholder = text;
            } else if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button')) {
                el.value = text;
            } else if (el.tagName === 'TITLE') {
                el.textContent = text;
            } else {
                el.textContent = text;
            }
        });
        
        // Update elements with data-i18n-html (for HTML content)
        document.querySelectorAll('[data-i18n-html]').forEach(el => {
            const key = el.getAttribute('data-i18n-html');
            let params = {};
            const paramsAttr = el.getAttribute('data-i18n-params');
            if (paramsAttr) {
                try {
                    params = JSON.parse(paramsAttr);
                } catch (e) {
                    console.warn(`[i18n] Failed to parse params for ${key}:`, paramsAttr);
                }
            }
            el.innerHTML = this.t(key, params);
        });
        
        // Update elements with data-i18n-attr (for attributes like title, aria-label)
        document.querySelectorAll('[data-i18n-attr]').forEach(el => {
            const attrs = el.getAttribute('data-i18n-attr').split(',');
            attrs.forEach(attr => {
                const [attrName, key] = attr.split(':');
                if (attrName && key) {
                    el.setAttribute(attrName.trim(), this.t(key.trim()));
                }
            });
        });
    },
    
    /**
     * Lấy danh sách ngôn ngữ hỗ trợ
     */
    getSupportedLanguages() {
        return [
            { code: 'vi', name: 'Tiếng Việt', nativeName: 'Tiếng Việt' },
            { code: 'en', name: 'English', nativeName: 'English' },
            { code: 'ko', name: 'Korean', nativeName: '한국어' }
        ];
    },
    
    /**
     * Lấy ngôn ngữ hiện tại
     */
    getCurrentLanguage() {
        return this.currentLang;
    }
};

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => I18n.init());
} else {
    I18n.init();
}

// Export for use in other scripts
window.I18n = I18n;

