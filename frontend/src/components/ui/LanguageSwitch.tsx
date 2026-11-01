import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import LanguageIcon from '@/components/icons/LanguageIcon';

const LanguageSwitch: React.FC = () => {
  const { i18n } = useTranslation();
  const [languageDropdownOpen, setLanguageDropdownOpen] = useState(false);
  const [currentLanguage, setCurrentLanguage] = useState(i18n.language);

  // Available languages
  const availableLanguages = [
    { code: 'en', label: 'English' },
    { code: 'vi', label: 'Tiếng Việt' },
    { code: 'zh', label: '中文' },
    { code: 'fr', label: 'Français' },
    { code: 'tr', label: 'Türkçe' },
    { code: 'es', label: 'Español' }
  ];

  // Update current language when it changes
  useEffect(() => {
    setCurrentLanguage(i18n.language);
  }, [i18n.language]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.language-dropdown')) {
        setLanguageDropdownOpen(false);
      }
    };

    if (languageDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [languageDropdownOpen]);

  const handleLanguageChange = (lang: string) => {
    localStorage.setItem('i18nextLng', lang);
    setLanguageDropdownOpen(false);
    window.location.reload();
  };

  // Always show dropdown for language selection
  const handleLanguageToggle = () => {
    setLanguageDropdownOpen(!languageDropdownOpen);
  };

  return (
    <div className="relative language-dropdown">
      <button
        onClick={handleLanguageToggle}
        className="hub-icon-btn"
        aria-expanded={languageDropdownOpen}
        aria-label="Language Switcher"
      >
        <LanguageIcon className="h-4 w-4" />
      </button>

      {/* Show dropdown when opened */}
      {languageDropdownOpen && (
        <div className="hub-menu absolute right-0 top-full z-50 mt-1 min-w-32">
          <div>
            {availableLanguages.map((lang) => (
              <button
                key={lang.code}
                onClick={() => handleLanguageChange(lang.code)}
                aria-current={currentLanguage.startsWith(lang.code) ? 'true' : undefined}
                className="hub-menu-item"
              >
                {lang.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default LanguageSwitch;
