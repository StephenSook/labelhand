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

### Live compiler three-reading cost caps

The live compiler keeps the prior worst-case spend envelope while taking three readings. One reading is capped at 120,000 tokens. At the maximum configured token price of $3 per million tokens, that is $0.36 per reading and $1.08 reserved per three-reading request against the unchanged $2 daily budget. The shared ledger permits 13 requests per day and 133 over its lifetime, which allow at most 39 and 399 readings compared with the prior caps of 40 and 400 single readings.

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Three-reading request reservation, USD | `{"per_reading_tokens":120000,"maximum_usd_per_million_tokens":3,"per_reading_usd":0.36,"readings":3,"request_reservation_usd":1.08,"daily_budget_usd":2}` | `web/src/lib/live-limits.ts`; arithmetic: `120000 * 3 / 1000000 = 0.36`, then `3 * 0.36 = 1.08` | MEASURED |
| Shared daily reading ceiling | `{"requests":13,"readings_per_request":3,"maximum_readings":39,"prior_single_reading_cap":40}` | `web/src/lib/live-ledger.ts`; arithmetic: `13 * 3 = 39 <= 40` | MEASURED |
| Shared lifetime reading ceiling | `{"requests":133,"readings_per_request":3,"maximum_readings":399,"prior_single_reading_cap":400}` | `web/src/lib/live-ledger.ts`; arithmetic: `133 * 3 = 399 <= 400` | MEASURED |

## EPA label photo reading

The inputs below are rendered pages from real EPA PPLS labels. They are not photos. Each image row, including the source PDF hash, selected page, read, verdict, latency, token counts, and cost, remains in the receipt.

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Vision model availability check | `{"http_status":200,"model":"nvidia/Nemotron-3.5-Super-VL","model_present":true,"model_count":28}` | `json:eval/results/photo-read-2026-10-19.json#model_availability` | MEASURED |
| Photo evaluation input settings | `{"rendered_label_pages":{"images":20,"long_side_px":1600,"jpeg_quality":90},"simulated_phone_degradation":{"images":20,"rotation_degrees":4,"crop_percent":6,"long_side_px":1600,"jpeg_quality":55}}` | `json:eval/results/photo-read-2026-10-19.json#input_sets` | MEASURED |
| Photo evaluation sample and completion | `{"labels_evaluated":20,"expected_images":40,"completed_images":40,"failed_images":0}` | `json:eval/results/photo-read-2026-10-19.json#pooled` | MEASURED |
| Rendered label-page reads | `{"images":20,"exact_reg_reads":20,"exact_reg_read_rate":1,"product_name_agreements":20,"product_name_agreement_rate":1,"verdict_counts":{"MATCHED":20},"latency_ms":{"total":30503,"mean":1525.15},"tokens":{"input":41540,"output":1508,"total":43048},"cost_usd":0.0138192}` | `json:eval/results/photo-read-2026-10-19.json#pooled.sets.rendered_label_pages` | MEASURED |
| Simulated phone-degradation reads | `{"images":20,"exact_reg_reads":20,"exact_reg_read_rate":1,"product_name_agreements":20,"product_name_agreement_rate":1,"verdict_counts":{"MATCHED":20},"latency_ms":{"total":27439,"mean":1371.95},"tokens":{"input":40840,"output":1485,"total":42325},"cost_usd":0.0135885}` | `json:eval/results/photo-read-2026-10-19.json#pooled.sets.simulated_phone_degradation` | MEASURED |
| All photo-evaluation reads | `{"images":40,"exact_reg_reads":40,"exact_reg_read_rate":1,"product_name_agreements":40,"product_name_agreement_rate":1,"verdict_counts":{"MATCHED":40},"latency_ms":{"total":57942,"mean":1448.55},"tokens":{"input":82380,"output":2993,"total":85373},"cost_usd":0.0274077}` | `json:eval/results/photo-read-2026-10-19.json#pooled.overall` | MEASURED |
| Wrong-but-valid registration reads | `{"wrong_but_valid_reg_reads":0,"wrong_but_valid_cases":[]}` | `json:eval/results/photo-read-2026-10-19.json#pooled` | MEASURED |
| Official run cost, cumulative paid spend, and budget | `{"budget_usd":2,"current_run_cost_usd":0.0274077,"total_session_cost_usd":0.1101414}` | `json:eval/results/photo-read-2026-10-19.json#run` | MEASURED |
| Nemotron 3.5 Super VL price used | `{"input_usd_per_million_tokens":0.3,"output_usd_per_million_tokens":0.9}` | `json:eval/results/photo-read-2026-10-19.json#pricing` | MEASURED |

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

## Nemotron alone against the compiled rules

`tools/model_alone.py` gives `nvidia/nemotron-3-super-120b-a12b` the full text of the three labels and a recorded 48-hour NWS forecast, with no compiled rules, and compares its hour states with the planner's on the same forecast. Response schema revision 2; revision 1 is kept in `eval/results/model-alone-2026-10-19.schema-v1.json`.

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Cases and hours compared | `{"planned_cases":30,"successful_cases":30,"failed_cases":0,"hours_compared":1440}` | `json:web/public/data/model-alone.json#pooled` | MEASURED |
| Agreement matrix, model state by planner state | `{"PERMITTED":{"PERMITTED":35,"BLOCKED":3,"FIELD_CHECK":73},"BLOCKED":{"PERMITTED":11,"BLOCKED":43,"FIELD_CHECK":20},"FIELD_CHECK":{"PERMITTED":314,"BLOCKED":217,"FIELD_CHECK":724}}` | `json:web/public/data/model-alone.json#pooled.agreement_matrix_model_x_planner` | MEASURED |
| Model go hours the planner blocks | `3` | `json:web/public/data/model-alone.json#pooled.unsafe_go_count` | MEASURED |
| Cited sentences verbatim on the cited page | `{"matched":1440,"total":1440}` | `json:web/public/data/model-alone.json#pooled.quote_check` | MEASURED |
| Go hours against the station | `{"model_permitted":{"held":51,"broke":17},"planner_permitted":{"held":197,"broke":89}}` | `json:web/public/data/model-alone.json#pooled.against_observations` | MEASURED |
| Model calls, tokens, latency and cost | `{"attempts":30,"prompt_tokens":1235834,"completion_tokens":190862,"latency_ms":1371365,"cost_usd":0.542526}` | `json:web/public/data/model-alone.json#pooled.model_calls` | MEASURED |
| The 73 model-go, planner-field-check hours are all possible-inversion hours | `73` | command: count planner `checks` whose `why` contains "inversion" over hours with model `PERMITTED` and planner `FIELD_CHECK` in `eval/results/model-alone-2026-10-19.json`; output: `73 [('inversion', 73)]` | MEASURED |
| The 3 unsafe hours | `"Worth, 2026-10-11 13:00 to 15:00 EDT; forecast 15 mph; model reason: wind ≤10 mph"` | `eval/results/model-alone-2026-10-19.json`, case `worth-2026-10-10`, hour indexes 30 to 32 | MEASURED |
| Revision 1 schema outcome | `"10 of 10 calls returned one hour"` | `eval/results/model-alone-2026-10-19.schema-v1.json`, every `model_calls[].error`: `response has 1 hours, expected 48` | MEASURED |

## Recorded season and forecast check-back

The season files are exported by `tools/season_export.py`. The check-back runs the planner on the forecast issued closest to 24 hours before each recorded hour and checks every forecast-permitted hour against the station observation recorded for that hour. Only label limits a station can measure are checked; clauses it cannot decide are listed, never counted as held.

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Season recorded span | `{"first":"2026-10-05T01:19:36+00:00","last":"2026-10-19T18:07:01+00:00"}` | `json:web/public/data/season/index.json#recorded_span` | MEASURED |
| Season issuances per point | `{"ben_hill":{"issuances":339},"berrien":{"issuances":339},"coffee":{"issuances":339},"colquitt":{"issuances":339},"cook":{"issuances":338},"dooly":{"issuances":339},"irwin":{"issuances":339},"mitchell":{"issuances":339},"tift":{"issuances":339},"worth":{"issuances":339}}` | `json:web/public/data/season/index.json#points` | MEASURED |
| Check-back input files | `{"hourly_files":3389,"valid_hourly_files":3389,"observation_files":3389,"valid_observation_files":3389,"observations_outside_hour_tolerance":0}` | `json:web/public/data/checkback.json#input_counts` | MEASURED |
| Check-back tank mix, Folex 6 EC, Dropp SC, and Prep | `{"hours_considered":3540,"evaluated_hours":2446,"permitted_a_day_ahead":566,"held":405,"broke":119,"skipped":{"no_obs":791,"no_issuance":303,"missing_measurement":42}}` | `json:web/public/data/checkback.json#tank_mix.pooled` | MEASURED |
| Check-back Folex 6 EC alone | `{"permitted_a_day_ahead":731,"held":474,"broke":199,"skipped":{"missing_measurement":58}}` | `json:web/public/data/checkback.json#products.5481-504.pooled` | MEASURED |
| Check-back Dropp SC alone | `{"permitted_a_day_ahead":731,"held":474,"broke":199,"skipped":{"missing_measurement":58}}` | `json:web/public/data/checkback.json#products.264-700.pooled` | MEASURED |
| Check-back Prep alone | `{"permitted_a_day_ahead":634,"held":427,"broke":159,"skipped":{"missing_measurement":48}}` | `json:web/public/data/checkback.json#products.264-418.pooled` | MEASURED |
| Every check-back break was wind | `{"tank_and_each_product_break_params":["wind_speed_mph"],"tank_observed_mph":"10.29..16.11","tank_wind_clauses":5}` | command: collect `param`, `observed_min`, `observed_max` over `pooled.breaks` for `tank_mix` and each product in `web/public/data/checkback.json`; output: `{'wind_speed_mph'}` for all four, min `10.289907`, max `16.105941`, 5 rule ids | MEASURED |
| Tank-mix clauses a station cannot check | `5` | command: count unique `rule` in `tank_mix.not_checkable_clauses`; output: `5` (params `night_temperature_f`, `rain_free_hours`, `temperature_inversion`) | MEASURED |
| Check-back recompute command | `"python tools/checkback.py --recorded data/nws_recorded"` | `tools/checkback.py`; `data/nws_recorded/` is gitignored at `.gitignore:16`, so the recorded inputs are not in the repo | SOURCED |
| Recorder ran every hour of the span | `"NOT VERIFIED"` | The recorder ran on a desktop PC through Oct 19 and missed hours while it was off (Tift has no files from 08:07 UTC Oct 16 to 01:07 UTC Oct 17). The app shows recorded against expected issuances per point. | NOT VERIFIED |

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
| Historical OCR job ran on an L40S | `"NVIDIA L40S"` | retained job output `data/text/264-700.ocr.json` (gitignored because it is label text), key `device`, written inside the job by `torch.cuda.get_device_name(0)` at `tools/ocr_parse.py:86`; same file: `ocr_utc` `2026-10-05T04:15:25+00:00`, model `nvidia/NVIDIA-Nemotron-Parse-2.0`, 9 pages. The Nebius job record itself is no longer listed (`nebius ai job list` in all three projects on 2026-10-19: no jobs). | MEASURED |

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
| Python format | `"33 files already formatted"` | command: `uv run --no-sync ruff format --check .`, 2026-10-19; output: `33 files already formatted` | MEASURED |
| Python tests | `"87 passed"` | command: `uv run --no-sync pytest -q`, 2026-10-19; output: `87 passed in 0.82s` | MEASURED |
| Tracked-text em-dash gate | `"35 files scanned, 0 hits"` | the `.github/workflows/ci.yml:30-34` command in Git Bash, 2026-10-19; output: `files=35 hits=0` | MEASURED |
| Rust format | `"passed"` | command: `cargo fmt --check`; exit: `0` | MEASURED |
| Rust lint | `"passed"` | command: `cargo clippy --all-targets --all-features -- -D warnings`; exit: `0` | MEASURED |
| Rust tests | `"5 passed: 3 unit and 2 parity"` | command: `cargo test`; output: `3 passed`, `2 passed`, and `0` doc tests | MEASURED |
| Rust WASM build | `"release build passed"` | command: `wasm-pack build core --target web --release -- --features wasm`; output: `Your wasm pkg is ready to publish at core\\pkg` | MEASURED |
| Web typecheck | `"passed"` | command from `web/`: `pnpm typecheck`; output: `Types generated successfully`; `tsc --noEmit` exit: `0` | MEASURED |
| Web lint | `"passed"` | command from `web/`: `pnpm lint`; exit: `0` | MEASURED |
| Web unit tests | `"91 passed in 9 files"` | command from `web/`: `pnpm test`, 2026-10-19; output: `Test Files 9 passed`, `Tests 91 passed` | MEASURED |
| Web production build | `"passed; 6 of 6 static pages generated"` | command from `web/`: `pnpm build`; output: `Compiled successfully`, `Generating static pages (6/6)` | MEASURED |
| Web end-to-end tests | `"18 passed"` | command from `web/`: `pnpm e2e`, 2026-10-19; output: `18 passed (39.2s)` | MEASURED |
| Browser data freshness | `"passed with no diff"` | commands: rebuild WASM, `pnpm sync-engine`, then `git diff --exit-code -- web/public/data`; all exits: `0` | MEASURED |

## Drift found

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Not drift: README `.ship` precision | `"README.md:71 gives 0.923 (12/13) for the acting-wins .ship merge, a different merge from the shipped majority .ship row, which scores 1.0 (12/12)."` | `README.md:71` and `README.md:67`; command: read `eval/results/ship.json` keys `overall.acting_precision`, `overall.acting_good`, and `overall.acting_rules`; output: `1.0`, `12`, `12` | MEASURED |
| Fixed: README every-run statement | `"README.md:125 said acting precision and recall are 1.0 on every run, but final p2 run one acting precision is 0.909. The sentence now says acting recall is 1.0 on every run and single runs reach 0.909 to 1.0 on acting precision."` | `README.md:125`; command: read `eval/results/p2_union_typed_v3_ocr_mf.json` key `overall.acting_precision`; output: `0.909` | MEASURED |
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
