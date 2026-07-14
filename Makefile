.DEFAULT_GOAL := help
.PHONY: help up up-apps down logs ps psql index vectordb vectordb-chat search search-chat backlog seed-issues reset-db demo-governance backend test-backend

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

up: ## Start the data tier (postgres, redis, nats, vault, trigger.dev)
	docker compose up -d

up-apps: ## Start data + platform services (needs service Dockerfiles)
	docker compose --profile apps up -d --build

down: ## Stop everything
	docker compose down

logs: ## Tail all container logs
	docker compose logs -f

ps: ## Show running containers
	docker compose ps

psql: ## Open a psql shell on the dev database
	docker compose exec postgres psql -U olma -d olma

reset-db: ## Drop the pgdata volume and re-apply migrations on next `up`
	docker compose down -v

nats-provision: ## Create/update JetStream streams from infra/nats/streams.json (needs nats up)
	NATS_URL=$${NATS_URL:-nats://localhost:4222} python3 tools/provision_nats.py

migrate-lint: ## Lint migrations (naming + no destructive DDL); pass DSN=... to also apply-clean
	python3 tools/migrate_lint.py $(if $(DSN),--dsn $(DSN),)

index: ## Rebuild the blueprint code index (docs/blueprint-index.md)
	python3 tools/build_index.py

backlog: ## Rebuild the product backlog (docs/backlog/ + tickets.json)
	python3 tools/backlog.py

seed-issues: ## Create GitHub issues from the backlog (needs gh auth + repo)
	bash tools/seed_github_issues.sh

vectordb: ## Rebuild the blueprint semantic vector DB
	cd vectordb && python3 ingest.py

vectordb-chat: ## Ingest the latest session chat into the vector DB
	cd vectordb && python3 ingest_chat.py

search: ## Semantic search the blueprint: make search Q="how are permissions evaluated?"
	cd vectordb && python3 query.py "$(Q)"

search-chat: ## Semantic search the session chat: make search-chat Q="what did we decide?"
	cd vectordb && python3 query.py --chat "$(Q)"

demo-governance: ## Offline governance-chain demo (turn + approval re-mint loop, no API key)
	bash tools/demo_governance.sh

backend: ## Run backend-core (FastAPI) on :8000
	cd services/backend-core && uvicorn app.main:app --reload --port 8000

test-backend: ## Run backend-core test suite
	cd services/backend-core && python3 -m pytest

errors: ## Regenerate the shared error taxonomy (TS + Python) from errors.json
	python3 packages/errors/gen.py

schemas: ## Regenerate event-contract types (TS + Python) from *.schema.json
	python3 packages/schemas/gen.py

test-contracts: ## Test the shared contract packages (schemas + errors)
	python3 -m pytest packages/schemas packages/errors
	cd packages/shared-ts && node --test test/shared.test.ts

test-shared: ## Test shared-py + cross-language (py<->ts) JWT/traceparent compatibility
	cd packages/shared-py && python3 -m pytest
	bash packages/shared-ts/xcheck.sh

test-all: ## Run every test suite (Python + TypeScript + Go) — the local CI mirror
	bash tools/test_all.sh
