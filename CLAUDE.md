# uni-git — инструкции для агента

Простой Git-клиент с интеграциями для Unity, Windows и macOS, мгновенный запуск. Стек зафиксирован: Neutralino (оболочка) + Node/TypeScript (бэкенд) + TypeScript/Vite (фронтенд), git через CLI. Репозиторий: github.com/roflseech/uni-git (публичный); каждый push в `main` выпускает релиз, установленные копии обновляются сами.

## Прочитать перед работой
1. `plan_work.md` — решения, архитектура, спецификация интерфейса, список функций, этапы. Раздел 9 описывает, что уже сделано и что делать следующим.
2. `docs/wireframes/index.html` — макеты каждого окна и состояния; это спецификация UI. Цифры в кружках ссылаются на пометки под макетом.
3. `app/README.md` — особенности оболочки Neutralino, которые уже стоили времени (в том числе запуск бэкенда как extension).
4. `shared/src/index.ts` — контракт API между фронтом и бэкендом (`Api`, `ServerEvent`); новые маршруты добавлять сначала сюда.

## Правила
- Не пересматривать стек (Rust, Electron, Python исключены), не менять принятые решения из раздела 1 плана.
- Всё должно работать на Windows и macOS одновременно: любая нативная деталь (пути, команды, askpass) делается для обеих ОС в одном изменении.
- Установка одним файлом: новая внешняя зависимость означает правку `install.ps1` и `install.sh` (их же вызывают `setup.ps1`/`setup.sh` с `-DepsOnly`/`--deps-only`).
- Все git-операции асинхронные (очередь задач `backend/src/jobs.ts`), блокировка только на уровне репозитория, никаких модальных окон на операции.
- Настройки только в `data/` рядом с приложением; в пользовательский репозиторий пишутся только штатные git-настройки.
- Фронтенд подключает `neutralino.js` классическим скриптом. Не переводить на ESM-пакет `@neutralinojs/lib` (он остаётся только для типов).
- Не создавать новых документов рядом с `plan_work.md`; состояние проекта и решения дописывать в него.
- Каждый push в `main` — релиз для всех установленных копий (`.github/workflows/release.yml`; правки только `*.md`, `docs/`, `tools/win/` релиз не выпускают). Пушить только проверенное: workflow сам гоняет typecheck, тесты и smoke, но не окно.
- Ключ подписи релизов: приватный — `.keys/update-signing-key.pem` (в git не попадает) и секрет `UNI_GIT_SIGNING_KEY` на GitHub, публичный — `backend/src/update-key.ts`. Не перегенерировать (`release:keygen --force`): установленные копии перестанут принимать обновления до переустановки.
- Файлы, которые меняет апдейтер, перечислены в `FILES` в `tools/release/build.mjs`; пути внутри `data/` и `.update/` манифест запрещает. Новый файл приложения рядом с бинарником — добавить туда.

## Команды
```
npm run setup      # зависимости + бинарники Neutralino (или setup.cmd / setup.sh на чистой машине)
npm run dev        # Vite watch + бэкенд tsx watch + neu run (расширения выключены, бэкенд отдельным процессом)
npm run build      # shared, backend (tsc + esbuild → app/extensions/backend/main.js), frontend
npm run typecheck
npm test           # vitest: парсеры и апдейтер бэкенда, форматтеры фронта, shared
npm run smoke -w backend   # сценарий по HTTP/WS на временном репозитории против собранного бандла
npm run dist       # сборка + neu build → app/dist/uni-git/
npm run release:test       # самообновление целиком: настоящий бандл, локальный сервер релизов, подписанный манифест
npm run release:build -- --version 0.1.99 [--base-url http://127.0.0.1:port/v0.1.99/]   # папка release/ без публикации
```

## Проверка в реальном окне (Windows, без человека)
Запустить из `app/`: `./bin/neutralino-win_x64.exe --load-dir-res --path=.` (бэкенд стартует как extension, лог в `app/data/logs/backend.log`). Затем `powershell -ExecutionPolicy Bypass -File tools/win/shot.ps1 -Out shot.png [-ClickX x -ClickY y] [-Keys "..."]` — DPI-корректный скриншот окна с кликом по физическим пикселям; смотреть картинку, а не верить коду. `tools/win/procs.ps1` — список процессов оболочки/бэкенда, `tools/win/kill-app.ps1` — остановить всё (не `taskkill /PID` из Git Bash: MSYS ломает `/PID`). Тестовый репозиторий можно подложить в `app/data/config.json`. После правок фронта: `npm run build -w frontend` и перезапуск окна.

Если `shot.ps1` падает с «The handle is invalid» и даёт белую картинку, рабочий стол недоступен (пользователь отошёл, экран погас): окно не проверить. Тогда фронтенд можно отрисовать в headless Edge против работающего бэкенда (`app/resources` через любой статический сервер, `?port=…&token=…` из `data/session.json`, отдельный `--user-data-dir`) и снять скриншоты через CDP.

Установка и обновление без GitHub: собрать два релиза `release:build -- --version X --out <dir>/vX --base-url http://127.0.0.1:<port>/vX/`, раздать их локальным сервером (`/latest.json` → текущий релиз), поставить `irm http://127.0.0.1:<port>/install.ps1 | iex` с переменными `UNI_GIT_RELEASES`, `UNI_GIT_INSTALL_DIR`, `UNI_GIT_NO_SHORTCUT=1`, `UNI_GIT_UPDATE_URL`. Убивать только свои тестовые процессы (по пути установки), не `kill-app.ps1`.

## Структура
```
app/       оболочка Neutralino: конфиг, bin/ и client/ (скачиваются), resources/ (сборка фронтенда), extensions/backend/ (бандл бэкенда + run.sh)
frontend/  Vite + TS без фреймворка: dom.ts, store.ts, app.ts, views/*, собирается в app/resources
backend/   Node + TS сервис: server.ts (HTTP/WS), repo.ts (git-операции), jobs.ts (очередь), updater.ts (самообновление), watcher.ts, parse/*, scripts/smoke.mjs
shared/    типы API между фронтом и бэкендом
tools/release  build.mjs (сборка и подпись релиза), keygen.mjs, e2e-update.mjs
tools/win  PowerShell-скрипты для проверки окна
install.ps1, install.sh   установщики для пользователей (и зависимости для setup.*)
.github/workflows/release.yml   релиз на каждый push в main
docs/      wireframes
```
