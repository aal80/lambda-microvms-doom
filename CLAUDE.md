# lambda-microvm-doom

Run Doom (the game) on AWS Lambda MicroVMs, played from a web browser.

- **Browser ↔ webui:** POST + SSE.
- **webui ↔ MicroVM:** one WebSocket per webui execution environment. It carries binary frames, audio events and input.
- **Provisioning:** MicroVMs aren't created on demand. The webui provisions one explicitly ("Provision DOOM" → `RunMicrovm`), mints an endpoint auth token (`CreateMicrovmAuthToken`, header `X-aws-proxy-auth`, port via `X-aws-proxy-port: 8081`), and keeps both in memory.
- **Lifecycle:** 5 min max lifetime, suspend after 2 min idle, terminate after 2 min suspended.

## Layout

- `doom/`: the MicroVM image. Terraform zips it, and Lambda builds it from the Dockerfile (ARM64).
  - `engine/`: the headless doomgeneric engine.
  - `server/server.js`: lifecycle hooks on :8080, and the game on :8081 (`/ws`, `/sounds`, `/music/:lump`). Frames are WebP (`sharp`), the WebSocket uses `ws`.
  - `music/render.mjs`: a build-time step that renders the MIDI tracks to MP3.
- `webui/`: the server (`server.js`: provisioning, token, WebSocket bridge) plus the browser client (`public/`). `LOCAL_GAME_URL` targets a local container (no provisioning, no auth); `MICROVM_IMAGE_ARN` and `MICROVM_RUN_ROLE_ARN` target AWS.
- `terraform/`:
  - `microvm.tf`: S3 artifact (keyed by zip md5, so a `doom/` change rebuilds the image), build and run roles, and the image as an `aws_cloudformation_stack` (`AWS::Lambda::MicrovmImage`) with hooks. `awscc_lambda_microvm_image` doesn't work: it drops the empty lists the schema requires. It writes the ARNs to `./tmp/`.
  - `webui.tf`: Lambda Web Functions. Its role scopes Run/Get/Resume/CreateMicrovmAuthToken to the image ARN; `ListMicrovms` and `PassNetworkConnector` must be on `*`.
- `Makefile`:
  - `make local` runs the container on :8080/:8081 and the UI on :3000.
  - `make deploy` and `make destroy` manage AWS.
  - `make webui-run-aws` runs the local UI against AWS.

## Debugging on AWS

- Logs: webui `/aws/lambda/web/lambda-microvm-doom-webui`; MicroVM build and runtime `/aws/lambda-microvms/lambda-microvm-doom`. Provisioning runs in the background, so its failures only show in the webui log (`provisioning failed: ...`).
- The game is shared: provisioning or terminating a MicroVM affects the user's game. Ask first.

## Working rules

- Never run `terraform apply`, `make deploy` or `make destroy`; the user applies. Use `terraform fmt`, `validate` and `plan` only.
- Test the web UI only through a single server on port 3001, which the user watches live. There is one shared game, so test input drives the user's game.

## Project memory

Read `memory.md` first (local, git-ignored). It holds verified facts, assumptions, decisions and open risks.

- Update it after learning anything non-obvious.
- Keep it **under 20 KB**.
- Label entries [FACT] or [ASSUMPTION].
