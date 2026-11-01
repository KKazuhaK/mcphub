import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { User, Settings, LogOut, Info } from 'lucide-react';
import AboutDialog from './AboutDialog';
import SponsorDialog from './SponsorDialog';
import WeChatDialog from './WeChatDialog';
import WeChatIcon from '@/components/icons/WeChatIcon';
import DiscordIcon from '@/components/icons/DiscordIcon';
import SponsorIcon from '@/components/icons/SponsorIcon';
import { ChangelogUpdateInfo } from '@/types';
import {
  fetchChangelogUpdateInfo,
  shouldShowUpdateBadge,
} from '@/services/changelogService';

interface UserProfileMenuProps {
  collapsed: boolean;
  version: string;
}

const UserProfileMenu: React.FC<UserProfileMenuProps> = ({ collapsed, version }) => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { auth, logout } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [showNewVersionInfo, setShowNewVersionInfo] = useState(false);
  const [showAboutDialog, setShowAboutDialog] = useState(false);
  const [sponsorDialogOpen, setSponsorDialogOpen] = useState(false);
  const [wechatDialogOpen, setWechatDialogOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<ChangelogUpdateInfo | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Check for new version on login and component mount.
  useEffect(() => {
    const checkForNewVersion = async () => {
      try {
        const info = await fetchChangelogUpdateInfo({
          currentVersion: version,
          locale: i18n.language,
        });
        setUpdateInfo(info);
        setShowNewVersionInfo(shouldShowUpdateBadge(info));
      } catch (error) {
        console.error('Error checking for new version:', error);
      }
    };

    checkForNewVersion();
  }, [version, i18n.language]);

  // Close the menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleSettingsClick = () => {
    navigate('/settings');
    setIsOpen(false);
  };

  const handleLogoutClick = () => {
    logout();
    navigate('/login');
  };

  const handleAboutClick = () => {
    setShowAboutDialog(true);
    setIsOpen(false);
  };

  const handleSponsorClick = () => {
    setSponsorDialogOpen(true);
    setIsOpen(false);
  };

  const handleWeChatClick = () => {
    setWechatDialogOpen(true);
    setIsOpen(false);
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        className={`flex h-9 w-full items-center rounded-md px-2 text-[var(--hub-ink-2)] transition-colors duration-100 hover:bg-[var(--hub-surface-hover)] hover:text-[var(--hub-ink)] ${collapsed ? 'justify-center' : ''} ${isOpen ? 'bg-[var(--hub-surface-hover)] text-[var(--hub-ink)]' : ''}`}
      >
        <div className="flex-shrink-0 relative">
          <div className="w-6 h-6 flex items-center justify-center rounded-full border border-[var(--hub-line)] bg-[var(--hub-surface)]">
            <User className="h-3.5 w-3.5" />
          </div>
          {showNewVersionInfo && (
            <span className="absolute -top-1 -right-1 block w-2 h-2 bg-red-500 rounded-full"></span>
          )}
        </div>
        {!collapsed && (
          <div className="hub-sidebar-label ml-2.5 flex min-w-0 flex-col items-start">
            <span className="truncate text-[14px] font-medium">
              {auth.user?.username || t('auth.user')}
            </span>
          </div>
        )}
      </button>

      {isOpen && (
        <div className="hub-menu absolute bottom-full left-0 z-50 mb-1 w-full min-w-max">
          <button
            onClick={handleSponsorClick}
            className="hub-menu-item"
          >
            <SponsorIcon className="h-4 w-4 mr-2" />
            {t('sponsor.label')}
          </button>

          {i18n.resolvedLanguage === 'zh' ? (
            <button
              onClick={handleWeChatClick}
              className="hub-menu-item"
            >
              <WeChatIcon className="h-4 w-4 mr-2" />
              {t('wechat.label')}
            </button>
          ) : (
            <a
              href="https://discord.gg/2BJehJZVH5"
              target="_blank"
              rel="noopener noreferrer"
              className="hub-menu-item"
            >
              <DiscordIcon className="h-4 w-4 mr-2" />
              {t('discord.label')}
            </a>
          )}

          <button
            onClick={handleSettingsClick}
            className="hub-menu-item"
          >
            <Settings className="h-4 w-4 mr-2" />
            {t('nav.settings')}
          </button>
          <button
            onClick={handleAboutClick}
            className="hub-menu-item relative"
          >
            <Info className="h-4 w-4 mr-2" />
            {t('about.title')}
            {showNewVersionInfo && (
              <span className="absolute top-3 right-3 block w-2 h-2 bg-red-500 rounded-full"></span>
            )}
          </button>

          <div className="my-1 border-t border-[var(--hub-line)]"></div>

          <button
            onClick={handleLogoutClick}
            className="hub-menu-item"
          >
            <LogOut className="h-4 w-4 mr-2" />
            {t('app.logout')}
          </button>
        </div>
      )}

      {/* About dialog */}
      <AboutDialog
        isOpen={showAboutDialog}
        onClose={() => setShowAboutDialog(false)}
        version={version}
        initialUpdateInfo={updateInfo}
        onUpdateInfoChange={(info) => {
          setUpdateInfo(info);
          setShowNewVersionInfo(shouldShowUpdateBadge(info));
        }}
        onDismissUpdate={() => {
          setShowNewVersionInfo(false);
        }}
      />

      {/* Sponsor dialog */}
      <SponsorDialog open={sponsorDialogOpen} onOpenChange={setSponsorDialogOpen} />

      {/* WeChat dialog */}
      <WeChatDialog open={wechatDialogOpen} onOpenChange={setWechatDialogOpen} />
    </div>
  );
};

export default UserProfileMenu;
