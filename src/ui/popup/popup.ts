// popup.ts
import './popup.css';
import '../common-vars.css';
import { getSettings, saveSettings } from '../../utils/settings';
import { addWhitelistRule, setDefaultWhitelist } from '../../utils/whitelist';

document.addEventListener('DOMContentLoaded', async () => {
  // 设置文档语言
  document.documentElement.setAttribute('lang', chrome.i18n.getMessage('@@ui_locale') || 'en');
  
  // 设置版本信息
  const versionInfo = document.getElementById('version-info');
  if (versionInfo) {
    const manifest = chrome.runtime.getManifest();
    versionInfo.textContent += manifest.version;
  }
  
  // 应用国际化
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(element => {
    const key = element.getAttribute('data-i18n');
    if (key) {
      const message = chrome.i18n.getMessage(key);
      if (message) {
        element.textContent = message;
      } else {
        console.warn(`No i18n message for key: ${key}`);
      }
    }
  });
  
  // 获取DOM元素
  const modeSelect = document.getElementById('mode-select') as HTMLSelectElement;
  const resolutionSelect = document.getElementById('resolution-select') as HTMLSelectElement;
  const saveButton = document.getElementById('save-settings') as HTMLButtonElement;
  const whitelistToggle = document.getElementById('whitelist-toggle') as HTMLInputElement;
  const addCurrentPageBtn = document.getElementById('add-current-page') as HTMLButtonElement;
  const addCurrentDomainBtn = document.getElementById('add-current-domain') as HTMLButtonElement;
  const addParentPathBtn = document.getElementById('add-parent-path') as HTMLButtonElement;
  const openSettingsBtn = document.getElementById('open-settings') as HTMLButtonElement;

  if (!modeSelect || !resolutionSelect || !saveButton || !whitelistToggle ||
      !addCurrentPageBtn || !addCurrentDomainBtn || !addParentPathBtn || !openSettingsBtn) {
    console.error('Required elements not found');
    return;
  }

  // 设置无障碍标签
  modeSelect.setAttribute('aria-label', chrome.i18n.getMessage('enhancementModeLabel') || 'Enhancement Mode');
  resolutionSelect.setAttribute('aria-label', chrome.i18n.getMessage('resolutionLabel') || 'Resolution');
  whitelistToggle.setAttribute('aria-label', chrome.i18n.getMessage('whitelistEnable') || 'Enable Whitelist');

  // 加载保存的设置
  let currentSettings;
  try {
    currentSettings = await getSettings();
    
    // 动态填充模式下拉框
    modeSelect.innerHTML = ''; // 清空现有选项
    currentSettings.enhancementModes.forEach(mode => {
      const option = document.createElement('option');
      option.value = mode.id;
      option.textContent = mode.name;
      modeSelect.appendChild(option);
    });

    modeSelect.value = currentSettings.selectedModeId;
    resolutionSelect.value = currentSettings.targetResolutionSetting;
    whitelistToggle.checked = currentSettings.whitelistEnabled;
    
    // 设置默认白名单（如果不存在）
    if (currentSettings.whitelist.length === 0) {
      await setDefaultWhitelist();
      currentSettings = await getSettings(); // 重新加载设置
    }
  } catch (error) {
    console.error('Error loading settings:', error);
    // 设置默认值
    modeSelect.value = 'builtin-mode-a';
    resolutionSelect.value = 'x2';
    whitelistToggle.checked = false;
    currentSettings = await getSettings(); // 获取包含默认模式的设置
  }

  // 保存设置
  saveButton.addEventListener('click', async () => {
    const selectedModeId = modeSelect.value;
    const selectedResolution = resolutionSelect.value;
    
    try {
      const updatedSettings = {
        selectedModeId: selectedModeId,
        targetResolutionSetting: selectedResolution,
      };
      await saveSettings(updatedSettings);
      
      console.log('Settings saved:', updatedSettings);
      
      // 显示成功消息
      const status = document.createElement('div');
      status.textContent = chrome.i18n.getMessage('settingsSaved') || 'Settings saved!';
      status.style.color = 'green';
      status.style.marginTop = '10px';
      document.body.appendChild(status);
      
      // 通知内容脚本设置已更新
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'SETTINGS_UPDATED',
            settings: { // 这个 payload 实际上没有被 video-manager 使用，但我们保留它以防万一
              selectedModeId: selectedModeId,
              targetResolution: selectedResolution,
            }
          }, (response) => {
            if (chrome.runtime.lastError) {
              console.warn('Message send error:', chrome.runtime.lastError.message);
            } else {
              console.log('Content script response:', response);
            }
          });
        }
      });

      // 3秒后关闭弹窗
      setTimeout(() => {
        status.remove();
        window.close();
      }, 3000);
      
    } catch (error) {
      console.error('Error saving settings:', error);
      alert('Failed to save settings');
    }
  });

  // 白名单开关改变事件
  whitelistToggle.addEventListener('change', async () => {
    try {
      const whitelistEnabled = whitelistToggle.checked;
      const updatedSettings = { whitelistEnabled: whitelistEnabled };

      await saveSettings(updatedSettings);
      
      console.log('Settings saved on toggle:', updatedSettings);
    } catch (error) {
      console.error('Error saving settings on toggle:', error);
    }
  });
  
  // 白名单按钮事件处理
  addCurrentPageBtn.addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].url) {
        const url = new URL(tabs[0].url);
        // 只保留域名和路径，去除查询参数
        const cleanUrl = url.hostname + url.pathname;
        await addWhitelistRule(cleanUrl);
        alert(chrome.i18n.getMessage('pageAdded') || 'URL added to whitelist');
      }
    } catch (error) {
      console.error('Error adding current URL:', error);
      alert('Failed to add URL to whitelist');
    }
  });

  addCurrentDomainBtn.addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].url) {
        const url = new URL(tabs[0].url);
        await addWhitelistRule(`${url.hostname}/*`);
        alert(chrome.i18n.getMessage('domainAdded') || 'Domain added to whitelist');
      }
    } catch (error) {
      console.error('Error adding current domain:', error);
      alert('Failed to add domain to whitelist');
    }
  });

  addParentPathBtn.addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].url) {
        const url = new URL(tabs[0].url);
        const pathParts = url.pathname.split('/').filter(p => p);
        const parentPath = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : '';
        // 只使用域名和父路径，不使用协议头
        await addWhitelistRule(`${url.hostname}/${parentPath}/*`);
        alert(chrome.i18n.getMessage('parentPathAdded') || 'Parent path added to whitelist');
      }
    } catch (error) {
      console.error('Error adding parent path:', error);
      alert('Failed to add parent path to whitelist');
    }
  });

  openSettingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});