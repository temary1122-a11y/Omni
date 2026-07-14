import { Settings, KeyRound, Trash2, Download, Shield, Plug, Check } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useOmniStore } from '@/store/omniStore';
import { useTranslation } from '@/i18n';

const ACCENT = 'var(--vscode-textLink-foreground, #7c6af7)';
const BORDER = 'var(--vscode-panel-border, #30363d)';
const FG = 'var(--vscode-foreground, #e6e6e6)';
const DESC = 'var(--vscode-descriptionForeground, #8b949e)';

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 14px',
  borderBottom: `1px solid ${BORDER}`,
  flexShrink: 0,
};

function btnStyle(accent: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    padding: '8px 10px',
    fontSize: 12.5,
    fontWeight: 500,
    borderRadius: 8,
    cursor: 'pointer',
    color: accent ? ACCENT : FG,
    background: accent ? `${ACCENT}14` : 'var(--vscode-input-background, #0b0d12)',
    border: `1px solid ${accent ? `${ACCENT}55` : BORDER}`,
  };
}

function fieldLabel(text: string) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6, color: DESC, marginBottom: 6 }}>
      {text}
    </div>
  );
}

export function SettingsPanel() {
  const { t } = useTranslation();
  const modelCatalog = useOmniStore((s) => s.modelCatalog);
  const selectModel = useOmniStore((s) => s.selectModel);
  const configureApi = useOmniStore((s) => s.configureApi);
  const clearMessages = useOmniStore((s) => s.clearMessages);
  const exportSession = useOmniStore((s) => s.exportSession);
  const useSupervisor = useOmniStore((s) => s.useSupervisor);
  const setUseSupervisor = useOmniStore((s) => s.setUseSupervisor);
  const budget = useOmniStore((s) => s.budget);
  const setBudget = useOmniStore((s) => s.setBudget);
  const preferredProvider = useOmniStore((s) => s.preferredProvider);
  const setPreferredProvider = useOmniStore((s) => s.setPreferredProvider);
  const providerInfo = useOmniStore((s) => s.providerInfo);

  const selectStyle: CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    fontSize: 12.5,
    borderRadius: 8,
    color: FG,
    background: 'var(--vscode-input-background, #0b0d12)',
    border: `1px solid ${BORDER}`,
    outline: 'none',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', color: FG }}>
      <div style={headerStyle}>
        <Settings size={16} style={{ color: ACCENT }} />
        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: 0.3 }}>{t('panel.settings')}</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <section>
          {fieldLabel(t('panel.model'))}
          {Object.keys(modelCatalog).length > 0 ? (
            <select defaultValue="" onChange={(e) => selectModel(e.target.value || undefined)} aria-label={t('panel.model')} style={selectStyle}>
              <option value="">{t('panel.selectModel')}</option>
              {Object.entries(modelCatalog).map(([provider, models]) => (
                <optgroup key={provider} label={provider}>
                  {models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          ) : (
            <p style={{ margin: 0, fontSize: 11, color: DESC }}>{t('panel.modelCatalogLoading')}</p>
          )}
          <p style={{ margin: '6px 0 0', fontSize: 11, color: DESC }}>
            Smart-free routes across providers when free keys exist; manual selection uses the live catalog.
          </p>
        </section>

        <section>
          {fieldLabel('Режим бюджета')}
          <select
            value={budget}
            onChange={(e) => setBudget(e.target.value as typeof budget)}
            aria-label="Режим бюджета"
            style={selectStyle}
          >
            <option value="free">Smart-free / только free</option>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </section>

        <section>
          {fieldLabel('Предпочтительный провайдер')}
          <select
            value={preferredProvider}
            onChange={(e) => setPreferredProvider(e.target.value)}
            aria-label="Предпочтительный провайдер"
            style={selectStyle}
          >
            <option value="openrouter">OpenRouter</option>
            <option value="kilo-gateway">Kilo Gateway</option>
            <option value="codik">Codik</option>
            <option value="ollama">Ollama</option>
          </select>
        </section>

        <section>
          {fieldLabel('OpenRouter')}
          <button
            type="button"
            onClick={() => configureApi()}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              width: '100%',
              padding: '8px 10px',
              fontSize: 12.5,
              fontWeight: 500,
              borderRadius: 8,
              cursor: 'pointer',
              color: providerInfo['openrouter']?.hasKey ? '#3fb950' : ACCENT,
              background: providerInfo['openrouter']?.hasKey ? '#3fb95014' : `${ACCENT}14`,
              border: `1px solid ${providerInfo['openrouter']?.hasKey ? '#3fb95055' : `${ACCENT}55`}`,
            }}
            aria-label="Подключить OpenRouter"
          >
            <Plug size={14} />
            {providerInfo['openrouter']?.hasKey ? (
              <>
                <Check size={14} />
                Подключено
              </>
            ) : (
              'Подключить OpenRouter'
            )}
          </button>
        </section>

        <section style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Shield size={14} style={{ color: ACCENT }} />
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t('panel.agentSupervisor')}</div>
              <div style={{ fontSize: 11, color: DESC }}>{t('panel.supervisorDesc')}</div>
            </div>
          </div>
          <input
            type="checkbox"
            checked={useSupervisor}
            onChange={(e) => setUseSupervisor(e.target.checked)}
            aria-label={t('panel.enableSupervisor')}
          />
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button type="button" onClick={() => configureApi()} style={btnStyle(true)} aria-label={t('panel.configureApiKeys')}>
            <KeyRound size={14} />
            {t('panel.configureApiKeys')}
          </button>
          <button type="button" onClick={() => exportSession()} style={btnStyle(false)} aria-label={t('panel.exportSession')}>
            <Download size={14} />
            {t('panel.exportSessionJson')}
          </button>
          <button type="button" onClick={() => clearMessages()} style={btnStyle(false)} aria-label={t('panel.clearChat')}>
            <Trash2 size={14} />
            {t('panel.clearChat')}
          </button>
        </section>

      </div>
    </div>
  );
}
