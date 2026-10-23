IMAGE ?= lambda-microvm-doom
CONTAINER ?= lambda-microvm-doom
WEBUI_PORT ?= 3000
TF := cd terraform && terraform

# ---- AWS ----

# Build the webui package, then deploy everything (MicroVM image build, roles, webui web function).
deploy:
	cd webui && npm ci --omit=dev
	$(TF) init
	$(TF) apply --auto-approve

destroy:
	$(TF) destroy --auto-approve

# Local web UI provisioning a MicroVM on AWS with your local AWS credentials. Terraform writes the ARNs to tmp/.
webui-run-aws:
	$(eval MICROVM_IMAGE_ARN := $(shell cat $(CURDIR)/tmp/microvm_image_arn.txt))
	$(eval MICROVM_RUN_ROLE_ARN := $(shell cat $(CURDIR)/tmp/microvm_run_role_arn.txt))
	cd webui && MICROVM_IMAGE_ARN=$(MICROVM_IMAGE_ARN) MICROVM_RUN_ROLE_ARN=$(MICROVM_RUN_ROLE_ARN) PORT=$(WEBUI_PORT) npm start

# ---- Local ----

doom-build:
	docker build --platform linux/arm64 -t $(IMAGE) doom/

# Runs the MicroVM image as a container: hooks on :8080, the game on :8081.
doom-run: doom-stop
	docker run -d --rm --init --name $(CONTAINER) -p 8080:8080 -p 8081:8081 $(IMAGE)

doom-stop:
	-docker rm -f $(CONTAINER) 2>/dev/null

doom-logs:
	docker logs -f $(CONTAINER)

webui-install:
	cd webui && npm install

# Web UI talking straight to the local container (no provisioning, no auth).
webui-run:
	cd webui && LOCAL_GAME_URL=http://localhost:8081 PORT=$(WEBUI_PORT) npm start

# Everything locally: build + start the container, then serve the UI on http://localhost:3000
local: doom-build doom-run webui-install webui-run

.PHONY: deploy destroy webui-run-aws doom-build doom-run doom-stop doom-logs webui-install webui-run local
