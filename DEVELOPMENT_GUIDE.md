# Руководство по продолжению разработки

## 🎯 Для кого этот документ

Это руководство для AI-ассистента (Claude, Cursor, и т.д.), который будет продолжать разработку проекта VoteCoop.

## 📁 Структура проекта

```
voting-app/
├── index.html          # ВСЕ экраны приложения (спрятаны через CSS .screen)
├── css/style.css       # Глобальные стили, переменные, компоненты
├── js/app.js           # Главный файл с логикой (App class)
└── *.md                # Документация
```

## 🔧 Ключевые концепции

### 1. Единый HTML файл
Все экраны приложения находятся в `index.html`, но скрыты через CSS:
```html
<div class="screen" id="auth-screen">...</div>
<div class="screen" id="main-screen">...</div>
<div class="screen hidden" id="profile-screen">...</div>
```

Переключение экранов через JavaScript:
```javascript
this.showScreen('profile-screen');
```

### 2. State Management
Все данные хранятся в `this.state` объекта App:
```javascript
this.state = {
    user: { /* текущий пользователь */ },
    groups: [ /* группы пользователя */ ],
    votings: [ /* все голосования */ ],
    notifications: [ /* уведомления */ ],
    currentLanguage: 'uk', // 'uk' | 'en' | 'ru'
    // ...другие поля
};
```

### 3. Система переводов
Все тексты вынесены в объект `translations`:
```javascript
this.translations = {
    uk: { greeting: 'Привіт', ... },
    en: { greeting: 'Hello', ... },
    ru: { greeting: 'Привет', ... }
};
```

Использование в HTML:
```html
<span data-lang="greeting">Привіт</span>
<input data-lang-placeholder="search_placeholder">
```

Переводы применяются автоматически при смене языка.

### 4. Mock-данные
Данные загружаются в `loadMockData()`:
- Пользователь
- 2-3 группы с участниками
- 5-6 голосований разных типов
- Уведомления

## 📝 Работа с кодом

### Добавление нового экрана

1. **HTML**: Добавить блок в `index.html`:
```html
<div class="screen hidden" id="new-screen">
    <!-- контент -->
</div>
```

2. **CSS**: Добавить стили в `css/style.css`

3. **JS**: Добавить метод в `app.js`:
```javascript
showNewScreen() {
    this.showScreen('new-screen');
}
```

### Добавление нового типа голосования

1. Добавить в селект в `index.html`:
```html
<option value="new-type" data-lang="type_new">Новый тип</option>
```

2. Добавить переводы в `translations` (uk, en, ru)

3. В `onVotingTypeChange()` добавить логику:
```javascript
if (type === 'new-type') {
    // показать/скрыть нужные поля
}
```

4. В `createVoting()` добавить обработку

5. В `showVotingDetail()` добавить отображение

### Добавление перевода

1. Найти объект `translations` в `app.js`
2. Добавить ключ в три языка:
```javascript
uk: { new_key: 'Новий текст' },
en: { new_key: 'New text' },
ru: { new_key: 'Новый текст' }
```

## 🎨 Дизайн-принципы

### Цвета (ИСПОЛЬЗОВАТЬ ТОЛЬКО ЭТИ)
```css
--color-bg: #FAFAFA;           /* фон */
--color-surface: #FFFFFF;       /* карточки */
--color-text: #1A1A1A;          /* текст */
--color-text-secondary: #666666; /* вторичный текст */
--color-primary: #1A1A1A;       /* акцент (чёрный!) */
--color-success: #22C55E;       /* успех */
--color-danger: #EF4444;        /* ошибка */
--color-warning: #EAB308;       /* предупреждение */
--color-info: #3B82F6;          /* информация */
```

**ВАЖНО**: В текущей версии primary color синий (`#007AFF`), но по дизайну должен быть чёрный (`#1A1A1A`).

### Иконки
Используем **Phosphor Icons**:
```html
<i class="ph ph-icon-name"></i>        <!-- outline -->
<i class="ph-fill ph-icon-name"></i>   <!-- filled -->
```

Сайт: https://phosphoricons.com

### Компоненты
- **Карточки**: `border-radius: 12px`, тень `0 1px 3px rgba(0,0,0,0.1)`
- **Кнопки**: `border-radius: 8px`, padding `12px 24px`
- **Инпуты**: `border-radius: 8px`, border `1px solid #E5E5E5`

## 🐛 Отладка

### Просмотр state
В консоли браузера:
```javascript
app.state
```

### Смена языка
```javascript
app.changeLanguage('en')  // 'uk', 'en', 'ru'
```

### Переход на экран
```javascript
app.showScreen('screen-id')
```

### Просмотр mock-данных
```javascript
app.loadMockData()
```

## 📋 Чеклист перед коммитом

- [ ] Проверить на трёх языках
- [ ] Проверить мобильную версию (Chrome DevTools)
- [ ] Проверить все user flows
- [ ] Убедиться что нет ошибок в консоли
- [ ] Проверить контрастность цветов

## 🚀 Деплой

### Локальный сервер
```bash
python3 -m http.server 8080
```

### Проверка
Открыть http://localhost:8080

### Git (если используется)
```bash
git add .
git commit -m "Описание изменений"
git push
```

## 💡 Типичные задачи

### Добавить поле в профиль
1. Найти `showProfile()` — добавить input
2. Добавить в `saveProfile()` сохранение
3. Добавить в `loadMockData()` mock-значение

### Изменить цвет кнопок
1. Найти CSS класс `.btn-primary`
2. Изменить `background-color`

### Добавить новое уведомление
```javascript
this.state.notifications.unshift({
    id: Date.now(),
    type: 'system', // 'voting', 'member', 'result', 'system'
    text: 'Текст уведомления',
    time: 'Щойно',
    read: false
});
this.renderNotifications();
```

## 📞 Вопросы?

Если что-то непонятно — смотри `design-system.md` и `ux-structure.md`.
Там детально описаны все компоненты и flows.

---

**Удачи в разработке! 🚀**
