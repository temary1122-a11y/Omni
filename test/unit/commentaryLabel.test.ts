import { test, expect } from '../harness';
import { t } from '../../webview-ui/src/i18n/ru';

test('UI commentary label is localized', () => {
  expect(t('commentary.title') === 'Комментарий', 'commentary label should be explicit in the chat UI');
});
