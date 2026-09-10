# epic-git — инструкции для агента

Git-клиент с мгновенным запуском для Windows и macOS. Стек зафиксирован: Neutralino (оболочка) + Node/TypeScript (бэкенд) + TypeScript/Vite (фронтенд), git через CLI.

## Прочитать перед работой
1. `plan_work.md` — решения, архитектура, спецификация интерфейса, список функций, этапы. Раздел 9 описывает, что уже сделано и что делать следующим.
2. `docs/wireframes/index.html` — макеты каждого окна и состояния; это спецификация UI. Цифры в кружках ссылаются на пометки под макетом.
3. `app/README.md` — особенности оболочки Neutralino, которые уже стоили времени (в том числе запуск бэкенда как extension).
4. `shared/src/index.ts` — контракт API между фронтом и бэкендом (`Api`, `ServerEvent`); новые маршруты добавлять сначала сюда.

## Правила
- Не пересматривать стек (Rust, Electron, Python исключены), не менять принятые решения из раздела 1 плана.
- Всё должно работать на Windows и macOS одновременно: любая нативная деталь (пути, команды, askpass) делается для обеих ОС в одном изменении.
- Установка одним файлом: новая внешняя зависимость означает правку `setup.ps1` и `setup.sh`.
- Все git-операции асинхронные (очередь задач `backend/src/jobs.ts`), блокировка только на уровне репозитория, никаких модальных окон на операции.
- Настройки только в `data/` рядом с приложением; в пользовательский репозиторий пишутся только штатные git-настройки.
- Фронтенд подключает `neutralino.js` классическим скриптом. Не переводить на ESM-пакет `@neutralinojs/lib` (он остаётся только для типов).
- Не создавать новых документов рядом с `plan_work.md`; состояние проекта и решения дописывать в него.

## Команды
```
npm run setup      # зависимости + бинарники Neutralino (или setup.cmd / setup.sh на чистой машине)
npm run dev        # Vite watch + бэкенд tsx watch + neu run (расширения выключены, бэкенд отдельным процессом)
npm run build      # shared, backend (tsc + esbuild → app/extensions/backend/main.js), frontend
npm run typecheck
npm test           # vitest: парсеры бэкенда, форматтеры фронта
npm run smoke -w backend   # сценарий по HTTP/WS на временном репозитории против собранного бандла
npm run dist       # сборка + neu build → app/dist/epic-git/
```

## Проверка в реальном окне (Windows, без человека)
Запустить из `app/`: `./bin/neutralino-win_x64.exe --load-dir-res --path=.` (бэкенд стартует как extension, лог в `app/data/logs/backend.log`). Затем `powershell -ExecutionPolicy Bypass -File tools/win/shot.ps1 -Out shot.png [-ClickX x -ClickY y] [-Keys "..."]` — DPI-корректный скриншот окна с кликом по физическим пикселям; смотреть картинку, а не верить коду. `tools/win/procs.ps1` — список процессов оболочки/бэкенда, `tools/win/kill-app.ps1` — остановить всё (не `taskkill /PID` из Git Bash: MSYS ломает `/PID`). Тестовый репозиторий можно подложить в `app/data/config.json`. После правок фронта: `npm run build -w frontend` и перезапуск окна.

## Структура
```
app/       оболочка Neutralino: конфиг, bin/ и client/ (скачиваются), resources/ (сборка фронтенда), extensions/backend/ (бандл бэкенда + run.sh)
frontend/  Vite + TS без фреймворка: dom.ts, store.ts, app.ts, views/*, собирается в app/resources
backend/   Node + TS сервис: server.ts (HTTP/WS), repo.ts (git-операции), jobs.ts (очередь), watcher.ts, parse/*, scripts/smoke.mjs
shared/    типы API между фронтом и бэкендом
tools/win  PowerShell-скрипты для проверки окна
docs/      wireframes
```
