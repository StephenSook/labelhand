# Labelhand code-audited facts

This file is the source for README claims, the Devpost writeup, and demo narration. Every factual row carries its value, source, and provenance tag. JSON-backed MEASURED rows use `json:path#key` so `tests/test_facts.py` can compare them with the committed artifact.

## What Labelhand does

Labelhand compiles EPA pesticide labels into typed rules that retain the quoted label clause and page, combines the rules for the products in a tank, and checks them against the National Weather Service hourly forecast. It marks forecast-permitted hours, blocked hours, and hours that require a field check while keeping the applicator responsible for the decision.

## Label compilation accuracy

### Gold set

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Gold-set version | `"v0"` | `json:eval/gold_v0.json#version` | MEASURED |
| Gold-set creation date | `"2026-10-05"` | `json:eval/gold_v0.json#created` | MEASURED |
| Gold-set clause count | `46` | `json:eval/results/ship.json#overall.gold`; cross-check command: `uv run python -c "import json;print(sum(map(len,json.load(open('eval/gold_v0.json'))['labels'].values())))"`; output: `46` | MEASURED |
| Gold-set review status | `"not yet reviewed by an outside expert; labelled as our own annotation until it is"` | `json:eval/gold_v0.json#review_status` | MEASURED |
| Gold-set scope | `"clauses the spray-window planner uses: wind, temperature inversion, rain, air and night temperature, open-boll stage, buffers, release or nozzle height, droplet size, re-entry interval. Rate tables, first aid, storage, mixing order and aerial boom geometry are out of scope for v0."` | `json:eval/gold_v0.json#scope` | MEASURED |

The metric object in each row uses these exact keys: `coverage_recall`, `typed_recall`, `value_exact`, `modality_acc`, `acting_precision`, and `acting_recall`. Acting rules are rules whose modality is `MUST` or `MUST_NOT`. The shipped score uses strict acting precision, so an acting prediction only matches an acting gold clause.

### Every committed score configuration

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| `baseline_super_run2.json` | `{"coverage_recall":0.652,"typed_recall":0.565,"value_exact":0.941,"modality_acc":0.654,"acting_precision":0.588,"acting_recall":0.9}` | `json:eval/results/baseline_super_run2.json#overall` | MEASURED |
| `typed_ultra.json` | `{"coverage_recall":0.652,"typed_recall":0.609,"value_exact":0.947,"modality_acc":0.964,"acting_precision":0.909,"acting_recall":0.9}` | `json:eval/results/typed_ultra.json#overall` | MEASURED |
| `ultra_pass_alone.json` | `{"coverage_recall":0.848,"typed_recall":0.674,"value_exact":0.909,"modality_acc":0.677,"acting_precision":0.565,"acting_recall":0.9}` | `json:eval/results/ultra_pass_alone.json#overall` | MEASURED |
| `union_raw.json` | `{"coverage_recall":0.891,"typed_recall":0.739,"value_exact":0.917,"modality_acc":0.647,"acting_precision":0.458,"acting_recall":1.0}` | `json:eval/results/union_raw.json#overall` | MEASURED |
| `union_typed_ultra.json` | `{"coverage_recall":0.891,"typed_recall":0.848,"value_exact":0.931,"modality_acc":0.897,"acting_precision":0.8,"acting_recall":1.0}` | `json:eval/results/union_typed_ultra.json#overall` | MEASURED |
| `union_typed_ultra_v2.json` | `{"coverage_recall":0.891,"typed_recall":0.848,"value_exact":0.897,"modality_acc":0.872,"acting_precision":1.0,"acting_recall":0.8}` | `json:eval/results/union_typed_ultra_v2.json#overall` | MEASURED |
| `union_typed_ultra_v3.json` | `{"coverage_recall":0.891,"typed_recall":0.891,"value_exact":0.935,"modality_acc":0.902,"acting_precision":1.0,"acting_recall":1.0}` | `json:eval/results/union_typed_ultra_v3.json#overall` | MEASURED |
| p2 run one, typing v3 | `{"coverage_recall":0.957,"typed_recall":0.957,"value_exact":0.941,"modality_acc":0.841,"acting_precision":0.909,"acting_recall":1.0}` | `json:eval/results/p2_union_typed_v3.json#overall` | MEASURED |
| p2 run one, modality floor | `{"coverage_recall":0.957,"typed_recall":0.957,"value_exact":0.941,"modality_acc":0.841,"acting_precision":0.909,"acting_recall":1.0}` | `json:eval/results/p2_union_typed_v3mf.json#overall` | MEASURED |
| p2 run one, three typing votes | `{"coverage_recall":0.957,"typed_recall":0.957,"value_exact":0.912,"modality_acc":0.864,"acting_precision":0.909,"acting_recall":1.0}` | `json:eval/results/p2_union_typed_v3k3.json#overall` | MEASURED |
| p2 run one, OCR and modality floor | `{"coverage_recall":1.0,"typed_recall":1.0,"value_exact":0.944,"modality_acc":0.848,"acting_precision":0.909,"acting_recall":1.0}` | `json:eval/results/p2_union_typed_v3_ocr_mf.json#overall` | MEASURED |
| p2 run two, typing v3 | `{"coverage_recall":0.957,"typed_recall":0.957,"value_exact":0.971,"modality_acc":0.886,"acting_precision":1.0,"acting_recall":1.0}` | `json:eval/results/p2r2_union_typed_v3.json#overall` | MEASURED |
| p2 run two, modality floor | `{"coverage_recall":0.957,"typed_recall":0.957,"value_exact":0.971,"modality_acc":0.886,"acting_precision":1.0,"acting_recall":1.0}` | `json:eval/results/p2r2_union_typed_v3mf.json#overall` | MEASURED |
| p2 run two, three typing votes | `{"coverage_recall":0.957,"typed_recall":0.957,"value_exact":0.941,"modality_acc":0.864,"acting_precision":1.0,"acting_recall":1.0}` | `json:eval/results/p2r2_union_typed_v3k3.json#overall` | MEASURED |
| p2 run two, OCR and modality floor | `{"coverage_recall":1.0,"typed_recall":1.0,"value_exact":0.972,"modality_acc":0.891,"acting_precision":1.0,"acting_recall":1.0}` | `json:eval/results/p2r2_union_typed_v3_ocr_mf.json#overall` | MEASURED |
| p2 run three, typing v3 | `{"coverage_recall":0.957,"typed_recall":0.957,"value_exact":0.941,"modality_acc":0.864,"acting_precision":1.0,"acting_recall":0.9}` | `json:eval/results/p2r3_union_typed_v3.json#overall` | MEASURED |
| p2 run three, modality floor | `{"coverage_recall":0.957,"typed_recall":0.957,"value_exact":0.941,"modality_acc":0.886,"acting_precision":1.0,"acting_recall":1.0}` | `json:eval/results/p2r3_union_typed_v3mf.json#overall` | MEASURED |
| p2 run three, three typing votes | `{"coverage_recall":0.957,"typed_recall":0.957,"value_exact":0.941,"modality_acc":0.864,"acting_precision":0.909,"acting_recall":0.9}` | `json:eval/results/p2r3_union_typed_v3k3.json#overall` | MEASURED |
| p2 run three, OCR and modality floor | `{"coverage_recall":1.0,"typed_recall":1.0,"value_exact":0.944,"modality_acc":0.891,"acting_precision":1.0,"acting_recall":1.0}` | `json:eval/results/p2r3_union_typed_v3_ocr_mf.json#overall` | MEASURED |
| Shipped majority `.ship` merge | `{"coverage_recall":1.0,"typed_recall":1.0,"value_exact":0.944,"modality_acc":0.87,"acting_precision":1.0,"acting_recall":1.0}` | `json:eval/results/ship.json#overall` | MEASURED |
| Shipped result suffix | `".ship"` | `json:eval/results/ship.json#suffix` | MEASURED |

### Run-to-run variance and Token Factory cost

The variance rows use the three final p2 receipts with OCR and the modality floor. The cost is the sum of the two extraction passes, the Ultra typing pass, and OCR-rescue typing for all three labels. It does not include the Nebius AI Cloud GPU job cost.

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Final p2 run one | `{"coverage_recall":1.0,"typed_recall":1.0,"value_exact":0.944,"modality_acc":0.848,"acting_precision":0.909,"acting_recall":1.0}` | `json:eval/results/p2_union_typed_v3_ocr_mf.json#overall` | MEASURED |
| Final p2 run two | `{"coverage_recall":1.0,"typed_recall":1.0,"value_exact":0.972,"modality_acc":0.891,"acting_precision":1.0,"acting_recall":1.0}` | `json:eval/results/p2r2_union_typed_v3_ocr_mf.json#overall` | MEASURED |
| Final p2 run three | `{"coverage_recall":1.0,"typed_recall":1.0,"value_exact":0.944,"modality_acc":0.891,"acting_precision":1.0,"acting_recall":1.0}` | `json:eval/results/p2r3_union_typed_v3_ocr_mf.json#overall` | MEASURED |
| Observed metric ranges | `{"coverage_recall":"1.000..1.000","typed_recall":"1.000..1.000","value_exact":"0.944..0.972","modality_acc":"0.848..0.891","acting_precision":"0.909..1.000","acting_recall":"1.000..1.000"}` | command: PowerShell read of the three final result files; output: `coverage_recall=1.000..1.000`, `typed_recall=1.000..1.000`, `value_exact=0.944..0.972`, `modality_acc=0.848..0.891`, `acting_precision=0.909..1.000`, `acting_recall=1.000..1.000` | MEASURED |
| p2 run one Token Factory cost, USD | `{"extraction":0.2178,"typing":0.3095,"ocr_rescue_typing":0.0046,"total":0.5319}` | command: sum `cost_usd`, `retype_cost_usd`, and optional `ocr_rescue_cost_usd` in `data/compiled/*.union.p2.typed.v3.ocr.mf.json`; output: `p2=0.5319` | MEASURED |
| p2 run two Token Factory cost, USD | `{"extraction":0.2238,"typing":0.3295,"ocr_rescue_typing":0.0064,"total":0.5597}` | command: same sum for `data/compiled/*.union.p2r2.typed.v3.ocr.mf.json`; output: `p2r2=0.5597` | MEASURED |
| p2 run three Token Factory cost, USD | `{"extraction":0.2196,"typing":0.3218,"ocr_rescue_typing":0.0045,"total":0.5459}` | command: same sum for `data/compiled/*.union.p2r3.typed.v3.ocr.mf.json`; output: `p2r3=0.5459` | MEASURED |

## Planner results on the committed Tift replay

These counts were recomputed from the committed replay periods and `.ship` rules through `engine/windows.py`. `PERMITTED` is displayed in the web app as `FORECAST-PERMITTED`.

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Replay point | `"tift"` | `json:tests/fixtures/engine/tift.json#point` | MEASURED |
| Replay forecast fetch time | `"2026-10-05T17:07:01+00:00"` | `json:tests/fixtures/engine/tift.json#forecast_fetched_utc` | MEASURED |
| Replay hours | `156` | `json:tests/fixtures/engine/tift.json#hours` | MEASURED |
| Folex 6 EC | `{"PERMITTED":31,"FIELD_CHECK":54,"BLOCKED":71}` | command: filter fixture rules to registration `5481-504`, run `windows.evaluate`, count `state`; output: `PERMITTED=31,FIELD_CHECK=54,BLOCKED=71` | MEASURED |
| Dropp SC and Prep | `{"PERMITTED":17,"FIELD_CHECK":63,"BLOCKED":76}` | command: filter fixture rules to registrations `264-700,264-418`, run `windows.evaluate`, count `state`; output: `PERMITTED=17,FIELD_CHECK=63,BLOCKED=76` | MEASURED |
| Folex 6 EC, Dropp SC, and Prep | `{"PERMITTED":17,"FIELD_CHECK":63,"BLOCKED":76}` | command: run `windows.evaluate` with all fixture rules, count `state`; output: `PERMITTED=17,FIELD_CHECK=63,BLOCKED=76` | MEASURED |

## Data sources and fetch scripts

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Folex 6 EC accepted label | `{"accepted":"2026-03-04","url":"https://www3.epa.gov/pesticides/chem_search/ppls/005481-00504-20260304.pdf"}` | `data/labels/index.json`, keys `5481-504.accepted` and `5481-504.url`; [EPA PDF](https://www3.epa.gov/pesticides/chem_search/ppls/005481-00504-20260304.pdf) | SOURCED |
| Dropp SC accepted label | `{"accepted":"2009-12-14","url":"https://www3.epa.gov/pesticides/chem_search/ppls/000264-00700-20091214.pdf"}` | `data/labels/index.json`, keys `264-700.accepted` and `264-700.url`; [EPA PDF](https://www3.epa.gov/pesticides/chem_search/ppls/000264-00700-20091214.pdf) | SOURCED |
| Prep accepted label | `{"accepted":"2021-02-24","url":"https://www3.epa.gov/pesticides/chem_search/ppls/000264-00418-20210224.pdf"}` | `data/labels/index.json`, keys `264-418.accepted` and `264-418.url`; [EPA PDF](https://www3.epa.gov/pesticides/chem_search/ppls/000264-00418-20210224.pdf) | SOURCED |
| EPA label index and download script | `"tools/ppls_fetch.py"` | PPLS page template at `tools/ppls_fetch.py:30`, PDF URL construction at `tools/ppls_fetch.py:56`, and PDF content check at `tools/ppls_fetch.py:69`; [EPA PPLS](https://ordspub.epa.gov/ords/pesticides/f?p=PPLS:1) | SOURCED |
| Tift hourly forecast endpoint | `"https://api.weather.gov/gridpoints/TAE/106,131/forecast/hourly"` | `data/nws_points_cache.json`, key `tift.forecastHourly`; [NWS API documentation](https://www.weather.gov/documentation/services-web-api) | SOURCED |
| Forecast and observation recorder | `"tools/nws_recorder.py"` | point resolution at `tools/nws_recorder.py:80-98`, hourly forecast fetch at `tools/nws_recorder.py:122`, and latest station observation fetch at `tools/nws_recorder.py:141`; [NWS API documentation](https://www.weather.gov/documentation/services-web-api) | SOURCED |

## Models and services

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Label extraction model | `"nvidia/nemotron-3-super-120b-a12b"` | `json:data/compiled/5481-504.p2.json#model`; caller at `compiler/compile_label.py:35,226-242` | MEASURED |
| Rule typing model | `"nvidia/Nemotron-3-Ultra-550b-a55b"` | `json:data/compiled/5481-504.union.p2.typed.v3.ocr.mf.json#retype_model`; caller at `compiler/retype.py:34,95-113` | MEASURED |
| OCR model | `"nvidia/NVIDIA-Nemotron-Parse-2.0"` | `json:data/compiled/264-700.union.p2.typed.v3.ocr.mf.json#ocr_model`; caller at `tools/ocr_parse.py:34,48,55,72` | MEASURED |
| Browser agent model | `"nvidia/Nemotron-3_5-Lightning"` | `web/src/app/api/agent/route.ts:8,159-176`; static audit command output: `const MODEL = "nvidia/Nemotron-3_5-Lightning"` | MEASURED |
| Token Factory base URL | `"https://api.tokenfactory.nebius.com/v1"` | `compiler/compile_label.py:34,235`; the web agent uses `https://api.tokenfactory.nebius.com/v1/chat/completions` at `web/src/app/api/agent/route.ts:9,159` | MEASURED |
| OCR Serverless Job target | `"gpu-l40s-a"` | `tools/ocr_job/submit.sh:9-21`, specifically line 13; job command runs Parse at `tools/ocr_job/run.sh:31-32` | MEASURED |
| Historical OCR job actually ran on an L40S | `"NOT VERIFIED"` | Check needed: read the Nebius job record or retained job log and match its job ID to the committed OCR result. The repo records the requested platform but not the job ID or returned hardware name. | NOT VERIFIED |

## Web app and agent

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| App routes | `["/","/app","/judge"]` | command: enumerate `page.tsx` below `web/src/app`; output: `/page.tsx`, `/app/page.tsx`, `/judge/page.tsx` | MEASURED |
| API routes | `["/api/agent","/api/label-pdf/[reg]"]` | command: enumerate `route.ts` below `web/src/app`; output: `/api/agent/route.ts`, `/api/label-pdf/[reg]/route.ts` | MEASURED |
| Agent per-IP limit | `{"requests":20,"window_minutes":10,"scope":"best effort per Node instance"}` | `web/src/app/api/agent/route.ts:14-15,33-36,88-102`; local static audit output: `RATE_LIMIT_COUNT=20`, `RATE_LIMIT_WINDOW_MS=600000` | MEASURED |
| Agent daily token budget | `{"tokens":2000000,"reset":"UTC date","scope":"best effort per Node instance"}` | `web/src/app/api/agent/route.ts:16,33-36,105-110,141,199-205`; local static audit output: `DAILY_TOKEN_BUDGET=2000000` | MEASURED |

## Tests and CI

The required CI workflow jobs are `python`, `rust`, and `web` at `.github/workflows/ci.yml:16-100`. The scheduled production workflow job is `probe` at `.github/workflows/live.yml:11-41`. The local pre-commit run mirrors the code gates in `ci.yml`; dependency and browser setup steps are environment preparation, not verdicts.

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Python lint | `"passed"` | command: `uv run --active --no-sync ruff check .`; output: `All checks passed!` | MEASURED |
| Python format | `"29 files already formatted"` | command: `uv run --active --no-sync ruff format --check .`; output: `29 files already formatted` | MEASURED |
| Python tests | `"79 passed"` | command: `uv run --active --no-sync pytest -q`; output: `79 passed in 0.59s` | MEASURED |
| Tracked-text em-dash gate | `"31 files scanned, 0 hits"` | PowerShell equivalent of `.github/workflows/ci.yml:30-34`, expanded to tracked and pending files; output: `PASS em-dash files=31` | MEASURED |
| Rust format | `"passed"` | command: `cargo fmt --check`; exit: `0` | MEASURED |
| Rust lint | `"passed"` | command: `cargo clippy --all-targets --all-features -- -D warnings`; exit: `0` | MEASURED |
| Rust tests | `"5 passed: 3 unit and 2 parity"` | command: `cargo test`; output: `3 passed`, `2 passed`, and `0` doc tests | MEASURED |
| Rust WASM build | `"release build passed"` | command: `wasm-pack build core --target web --release -- --features wasm`; output: `Your wasm pkg is ready to publish at core\\pkg` | MEASURED |
| Web typecheck | `"passed"` | command from `web/`: `pnpm typecheck`; output: `Types generated successfully`; `tsc --noEmit` exit: `0` | MEASURED |
| Web lint | `"passed"` | command from `web/`: `pnpm lint`; exit: `0` | MEASURED |
| Web unit tests | `"24 passed in 6 files"` | command from `web/`: `pnpm test`; output: `Test Files 6 passed`, `Tests 24 passed` | MEASURED |
| Web production build | `"passed; 6 of 6 static pages generated"` | command from `web/`: `pnpm build`; output: `Compiled successfully`, `Generating static pages (6/6)` | MEASURED |
| Web end-to-end tests | `"15 passed"` | command from `web/`: `pnpm e2e`; output: `15 passed (30.5s)` | MEASURED |
| Browser data freshness | `"passed with no diff"` | commands: rebuild WASM, `pnpm sync-engine`, then `git diff --exit-code -- web/public/data`; all exits: `0` | MEASURED |

## Drift found

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| README stale `.ship` precision | `"README.md:71 says 0.923 (12/13), but the current majority .ship receipt says 1.0 (12/12)."` | `README.md:71`; command: read `eval/results/ship.json` keys `overall.acting_precision`, `overall.acting_good`, and `overall.acting_rules`; output: `1.0`, `12`, `12` | MEASURED |
| README false every-run statement | `"README.md:125 says acting precision and recall are 1.0 on every run, but final p2 run one acting precision is 0.909."` | `README.md:125`; command: read `eval/results/p2_union_typed_v3_ocr_mf.json` key `overall.acting_precision`; output: `0.909` | MEASURED |
| README rounded cost hides run variance | `"README.md:73 says $0.53 per run. Exact committed Token Factory totals are $0.5319, $0.5597, and $0.5459."` | `README.md:73`; cost commands and outputs in the run-cost table above | MEASURED |

## Do not claim

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| A real applicator has used Labelhand | `"NOT VERIFIED"` | Check needed: obtain permissioned evidence from an applicator who used the product on a real planning task. | NOT VERIFIED |
| Labelhand says a spray is legal | `"DO NOT CLAIM"` | The product returns forecast states and cited clauses. Legal and application decisions remain with the applicator. | NOT VERIFIED |
| Accuracy beyond the committed gold set | `"NOT VERIFIED"` | Check needed: define and score a broader held-out set. Current accuracy evidence covers only the committed gold set. | NOT VERIFIED |
| The gold set was reviewed by an outside expert | `"NOT VERIFIED"` | `eval/gold_v0.json`, key `review_status`, says it has not yet been reviewed by an outside expert. | NOT VERIFIED |
| The deployed web app is live now | `"NOT VERIFIED"` | Check needed: make a timestamped read-only request to `https://labelhand-web.vercel.app` and record the status and response. No live request was needed for this fact sheet. | NOT VERIFIED |
| Four Token Factory models passed the capability probe with subsecond first-token times | `"NOT VERIFIED"` | Check needed: commit or retain the probe receipt with model IDs, request IDs, capability outcomes, and timings. The claim appears in README.md but no underlying receipt was found. | NOT VERIFIED |
| Nebius AI Cloud GPU cost for OCR | `"NOT VERIFIED"` | Check needed: read the billed job cost for the retained OCR job. The cost rows above cover Token Factory only. | NOT VERIFIED |
| A phone call or mobile app is shipped | `"NOT VERIFIED"` | Check needed: point to a shipped implementation and an end-to-end result. Neither is part of the current web and planner evidence. | NOT VERIFIED |
