export type TranslationKey =
  | 'nav.chat'
  | 'nav.agents'
  | 'nav.files'
  | 'nav.sessions'
  | 'nav.settings'
  | 'sidebar.navigator'
  | 'sidebar.agents'
  | 'sidebar.providers'
  | 'sidebar.noProviders'
  | 'sidebar.connected'
  | 'sidebar.noKey'
  | 'sidebar.selectModel'
  | 'sidebar.configureApi'
  | 'sidebar.expand'
  | 'sidebar.collapse'
  | 'panel.files'
  | 'panel.refresh'
  | 'panel.refreshWorkspace'
  | 'panel.refreshDisabled'
  | 'panel.root'
  | 'panel.generatedArtifacts'
  | 'panel.noArtifacts'
  | 'panel.workspace'
  | 'panel.workspaceNotLoaded'
  | 'panel.workspaceStartSession'
  | 'panel.sessions'
  | 'panel.sessionId'
  | 'panel.goal'
  | 'panel.messages'
  | 'panel.currentPhase'
  | 'panel.newSession'
  | 'panel.exportSession'
  | 'panel.clearChat'
  | 'panel.settings'
  | 'panel.chatDensity'
  | 'panel.densityMinimal'
  | 'panel.densityNormal'
  | 'panel.densityDebug'
  | 'panel.budget'
  | 'panel.budgetFree'
  | 'panel.budgetLow'
  | 'panel.budgetNormal'
  | 'panel.budgetHigh'
  | 'panel.agentSupervisor'
  | 'panel.supervisorDesc'
  | 'panel.enableSupervisor'
  | 'panel.model'
  | 'panel.modelCatalogLoading'
  | 'panel.configureApiKeys'
  | 'panel.exportSessionJson'
  | 'panel.activityLog'
  | 'panel.vibeMode'
  | 'panel.vibeModeDesc'
  | 'panel.open'
  | 'panel.selectModel'
  | 'toolbar.code'
  | 'toolbar.chat'
  | 'toolbar.plan'
  | 'toolbar.activeAgents'
  | 'toolbar.phasesComplete'
  | 'toolbar.dismissError'
  | 'toolbar.pause'
  | 'toolbar.continue'
  | 'toolbar.stop'
  | 'toolbar.moreOptions'
  | 'toolbar.clearChat'
  | 'toolbar.exportSession'
  | 'toolbar.configureApi'
  | 'welcome.title'
  | 'welcome.subtitle'
  | 'welcome.run'
  | 'chat.you'
  | 'chat.system'
  | 'chat.copyMessage'
  | 'chat.noSessionPlaceholder'
  | 'chat.refineTask'
  | 'chat.describeBuild'
  | 'chat.running'
  | 'chat.idle'
  | 'chat.generationInProgress'
  | 'chat.clear'
  | 'commentary.title'
  | 'reasoning.title'
  | 'reasoning.noThoughts'
  | 'reasoning.closeDetail'
  | 'timeline.inProgress'
  | 'timeline.jumpToPhase'
  | 'tool.running'
  | 'tool.success'
  | 'tool.error'
  | 'tool.sources'
  | 'common.close'
  | 'approval.approve'
  | 'approval.reject'
  | 'questions.back'
  | 'questions.finish'
  | 'questions.next'
  | 'delivery.done'
  | 'delivery.artifacts'
  | 'delivery.open'
  | 'markdown.copyCode';

export const ru: Record<TranslationKey, string> = {
  'nav.chat': 'Чат',
  'nav.agents': 'Агенты',
  'nav.files': 'Файлы',
  'nav.sessions': 'Сессии',
  'nav.settings': 'Настройки',
  'sidebar.navigator': 'Навигатор',
  'sidebar.agents': 'Агенты',
  'sidebar.providers': 'Провайдеры',
  'sidebar.noProviders': 'Провайдеры не обнаружены.',
  'sidebar.connected': 'подключён',
  'sidebar.noKey': 'нет ключа',
  'sidebar.selectModel': 'Выбрать модель…',
  'sidebar.configureApi': 'Настроить API',
  'sidebar.expand': 'Развернуть панель',
  'sidebar.collapse': 'Свернуть панель',
  'panel.selectModel': 'Выбрать модель…',
  'panel.files': 'Файлы',
  'panel.refresh': 'Обновить',
  'panel.refreshWorkspace': 'Обновить рабочую область',
  'panel.refreshDisabled': 'Запустите сессию для загрузки рабочей области',
  'panel.root': 'Корень:',
  'panel.generatedArtifacts': 'Сгенерированные артефакты',
  'panel.noArtifacts': 'Артефакты ещё не созданы.',
  'panel.workspace': 'Рабочая область',
  'panel.workspaceNotLoaded': 'Дерево рабочей области не загружено. Нажмите Обновить.',
  'panel.workspaceStartSession': 'Запустите сессию, затем нажмите Обновить для загрузки дерева.',
  'panel.sessions': 'Сессии',
  'panel.sessionId': 'ID сессии',
  'panel.goal': 'Цель',
  'panel.messages': 'Сообщения',
  'panel.currentPhase': 'Текущая фаза',
  'panel.newSession': 'Новая сессия',
  'panel.exportSession': 'Экспортировать сессию',
  'panel.clearChat': 'Очистить чат',
  'panel.settings': 'Настройки',
  'panel.chatDensity': 'Плотность чата',
  'panel.densityMinimal': 'Минимальная — только результаты и комментарии',
  'panel.densityNormal': 'Нормальная — инструменты и рассуждения',
  'panel.densityDebug': 'Отладка — всё, включая вызовы LLM',
  'panel.budget': 'Бюджет (сначала бесплатные)',
  'panel.budgetFree': 'Бесплатно — максимум бесплатных моделей',
  'panel.budgetLow': 'Низкий',
  'panel.budgetNormal': 'Нормальный',
  'panel.budgetHigh': 'Высокий',
  'panel.agentSupervisor': 'Супервизор агентов',
  'panel.supervisorDesc': 'Умная параллельная оркестрация с повтором',
  'panel.enableSupervisor': 'Включить супервизора',
  'panel.model': 'Модель',
  'panel.modelCatalogLoading': 'Каталог моделей загружается при подключении.',
  'panel.configureApiKeys': 'Настроить API-ключи',
  'panel.exportSessionJson': 'Экспортировать сессию в JSON',
  'panel.activityLog': 'Журнал активности',
  'panel.vibeMode': 'Режим виб-кодера',
  'panel.vibeModeDesc': 'Используйте минимальную плотность чата + бесплатный бюджет. Агенты делегируют — наблюдайте за появлением узлов.',
  'panel.open': 'Открыть',
  'toolbar.code': 'Код',
  'toolbar.chat': 'Чат',
  'toolbar.plan': 'План',
  'toolbar.activeAgents': 'активных',
  'toolbar.phasesComplete': 'фаз завершено',
  'toolbar.dismissError': 'Закрыть ошибку',
  'toolbar.pause': 'Пауза',
  'toolbar.continue': 'Продолжить',
  'toolbar.stop': 'Остановить',
  'toolbar.moreOptions': 'Ещё',
  'toolbar.clearChat': 'Очистить чат',
  'toolbar.exportSession': 'Экспортировать сессию',
  'toolbar.configureApi': 'Настроить API',
  'welcome.title': 'Omni — AI Оркестратор',
  'welcome.subtitle': 'Мульти-агентная система для планирования, сборки и верификации кода. Выберите агента и сформулируйте задачу.',
  'welcome.run': 'Запустить',
  'chat.you': 'Вы',
  'chat.system': 'Система',
  'chat.copyMessage': 'Копировать',
  'chat.noSessionPlaceholder': 'Опишите задачу…',
  'chat.refineTask': 'Уточните задачу…',
  'chat.describeBuild': 'Опишите что хотите создать…',
  'chat.running': 'Выполняется…',
  'chat.idle': 'Простой',
  'chat.generationInProgress': 'Генерация в процессе…',
  'chat.clear': 'Очистить',
  'commentary.title': 'Комментарий',
  'reasoning.title': 'Рассуждение',
  'reasoning.noThoughts': 'Мыслей пока нет.',
  'reasoning.closeDetail': 'Закрыть',
  'timeline.inProgress': 'В процессе…',
  'timeline.jumpToPhase': 'Перейти к фазе «{meta}»',
  'tool.running': 'выполняется',
  'tool.success': 'успех',
  'tool.error': 'ошибка',
  'tool.sources': '🔗 источники',
  'common.close': 'Закрыть',
  'approval.approve': '✅ Одобрить',
  'approval.reject': '⛔ Отклонить',
  'questions.back': 'Назад',
  'questions.finish': 'Завершить',
  'questions.next': 'Далее',
  'delivery.done': '✅ Готово',
  'delivery.artifacts': 'Артефакты',
  'delivery.open': 'Открыть',
  'markdown.copyCode': 'Копировать код',
};

export type TranslationParams = Record<string, string | number>;

export function t(key: TranslationKey, params?: TranslationParams): string {
  let value = ru[key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(`{${k}}`, String(v));
    }
  }
  return value;
}
