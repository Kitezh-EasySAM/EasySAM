.PHONY: coverage check lint clippy format format-check demo fresh-demo user enroll-key web web-build dev test typecheck noise-report reset-db seed fresh docker agent-test agent-check agent-windows watch agent-dist
dev:           ## API на :8000
	npm run dev
test:          ## тесты сервера
	npm test
typecheck:
	npm run typecheck
noise-report:  ## доля шума в реальной выгрузке
	npm run noise-report -w server
reset-db:      ## снести локальную БД (схема создаётся при старте)
	rm -f server/sam.db server/sam.db-*
seed:          ## наполнить пустую БД: каталог + данные из материалы/, если файлы есть
	npm run seed -w server
demo:          ## добавить демо-данные (закупки, сотрудники, лицензии ПК, КриптоПро…) в БД с реальными данными
	npm run demo -w server
fresh: reset-db seed  ## чистая БД + реальные данные (без демо)
fresh-demo: reset-db  ## чистая БД + реальные данные + демо (как раньше make fresh)
	npm run seed -w server -- --demo
docker:        ## поднять всё в Docker (реальные данные при первом старте; DEMO=1 — и демо)
	docker compose up -d --build
agent-test:    ## тесты агента
	cd agent && cargo test
agent-check:   ## проверить код агента под Windows (без линковки)
	cd agent && cargo check --target x86_64-pc-windows-gnu
agent-windows: ## собрать sam-agent.exe (нужен mingw-w64-gcc: sudo pacman -S mingw-w64-gcc)
	cd agent && cargo build --release --target x86_64-pc-windows-gnu && ls -lh target/x86_64-pc-windows-gnu/release/sam-agent.exe
watch:         ## живая лента событий в терминале (SAM_URL=http://host:8000)
	@npm run -s watch -w server
agent-dist: agent-windows  ## папка для ПК: sam-agent.exe + установщики (agent/dist/sam-agent)
	mkdir -p agent/dist/sam-agent && cp agent/target/x86_64-pc-windows-gnu/release/sam-agent.exe agent/install/*.ps1 agent/dist/sam-agent/
	@ls -lh agent/dist/sam-agent

web:           ## фронтенд Vite на :5173 (прокси /api на :8000; другой бэк: API_URL=http://localhost:81xx make web)
	cd web && npm install --no-audit --no-fund && npm run dev

web-build:     ## проверка типов и сборка фронтенда
	cd web && npm run build
user:          ## пользователь интерфейса / сброс пароля: make user LOGIN=ivanov ROLE=viewer [PASSWORD=…]
	@npm run -s user -w server
enroll-key:    ## ключ регистрации агентов для install-sam-agent.ps1: make enroll-key TITLE="Бухгалтерия" USES=50 DAYS=30
	@npm run -s enroll-key -w server
format:        ## отформатировать весь код (Prettier, rustfmt)
	npm run -s format && cd agent && cargo fmt
format-check:  ## проверить форматирование, ничего не меняя
	npm run -s format:check && cd agent && cargo fmt --check
lint:          ## ESLint для сервера и фронта, без предупреждений
	npm run -s lint
clippy:        ## clippy агента без предупреждений: Linux (логика) и Windows (весь код)
	cd agent && cargo clippy --all-targets -- -D warnings && cargo clippy --target x86_64-pc-windows-gnu -- -D warnings
check: format-check lint typecheck test web-test web-build agent-test clippy  ## всё сразу: то же, что CI
	@echo "✓ make check: всё зелёное"

coverage:      ## покрытие тестами: сервер → coverage/lcov.info, фронт (Vitest) → coverage/web/lcov.info
	mkdir -p coverage
	cd server && AUTH=off INGEST_TOKEN=dev-token AGENT_DIST= node --test --experimental-test-isolation=none --experimental-test-coverage \
		--test-reporter=spec --test-reporter-destination=stdout \
		--test-reporter=lcov --test-reporter-destination=../coverage/lcov.info test/
	sed -i 's|^SF:src/|SF:server/src/|' coverage/lcov.info
	cd web && npx vitest run --coverage --coverage.reporter=lcov --coverage.reportsDirectory=../coverage/web --coverage.all=false
	sed -i 's|^SF:src/|SF:web/src/|' coverage/web/lcov.info
web-test:      ## юнит-тесты фронта (Vitest)
	cd web && npm test
e2e: web-build ## обход фронта в браузере (Playwright, свой сервер на :8190 с временной демо-базой)
	cd web && npm run e2e
