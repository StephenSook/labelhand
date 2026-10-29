# Labelhand code-audited facts

This file is the source for README claims, the Devpost writeup, and demo narration. Every factual row carries its value, source, and provenance tag. JSON-backed MEASURED rows use `json:path#key` so `tests/test_facts.py` can compare them with the committed artifact.

## What Labelhand does

Labelhand compiles EPA pesticide labels into typed rules that retain the quoted label clause and page, combines the rules for the products in a tank, and checks them against the National Weather Service hourly forecast. It marks forecast-permitted hours, blocked hours, and hours that require a field check while keeping the applicator responsible for the decision.

## Label compilation accuracy

### Gold set

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Gold set scoring the shipped tank | `"v1"` | `json:eval/gold_v1.json#version` | MEASURED |
| Gold-set v1 creation date | `"2026-10-20"` | `json:eval/gold_v1.json#created` | MEASURED |
| Gold-set v1 clause count | `64` | `json:eval/results/ship.json#overall.gold`; cross-check command: `uv run python -c "import json;print(sum(map(len,json.load(open('eval/gold_v1.json'))['labels'].values())))"`; output: `64` | MEASURED |
| Gold-set v1 clauses per label | `{"5481-504":24,"228-653":27,"228-659":13}` | command: count `labels` entries in `eval/gold_v1.json`; output: `5481-504=24, 228-653=27, 228-659=13`; the 24 Folex clauses equal v0's (`tests/test_gold_record.py`) | MEASURED |
| Gold-set v1 written before any compile of its new labels | `"The 228-653 and 228-659 clauses were written before any compiled output for those labels existed."` | `json:eval/gold_v1.json#annotator` (stated by the annotator; the order of work is not machine-checkable) | SOURCED |
| Gold-set version, development tank | `"v0"` | `json:eval/gold_v0.json#version` | MEASURED |
| Gold-set v0 creation date | `"2026-10-05"` | `json:eval/gold_v0.json#created` | MEASURED |
| Gold-set v0 clause count | `46` | `json:eval/results/ship_gold_v0.json#overall.gold`; cross-check command: `uv run python -c "import json;print(sum(map(len,json.load(open('eval/gold_v0.json'))['labels'].values())))"`; output: `46` | MEASURED |
| Gold-set review status | `"not yet reviewed by an outside expert; labelled as our own annotation until it is"` | `json:eval/gold_v0.json#review_status` | MEASURED |
| Gold-set scope | `"clauses the spray-window planner uses: wind, temperature inversion, rain, air and night temperature, open-boll stage, buffers, release or nozzle height, droplet size, re-entry interval. Rate tables, first aid, storage, mixing order and aerial boom geometry are out of scope for v0."` | `json:eval/gold_v0.json#scope` | MEASURED |

The metric object in each row uses these exact keys: `coverage_recall`, `typed_recall`, `value_exact`, `modality_acc`, `acting_precision`, and `acting_recall`. Acting rules are rules whose modality is `MUST` or `MUST_NOT`. The shipped score uses strict acting precision, so an acting prediction only matches an acting gold clause.

### Every committed score configuration

These rows score the development tank (Folex 6 EC, Dropp SC, Prep) on gold v0, the labels the pipeline was built on. The shipped tank's rows follow.

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
| Development tank majority `.ship` merge | `{"coverage_recall":1.0,"typed_recall":1.0,"value_exact":0.944,"modality_acc":0.87,"acting_precision":1.0,"acting_recall":1.0}` | `json:eval/results/ship_gold_v0.json#overall` | MEASURED |

### Shipped tank on gold v1

Folex 6 EC, FreeFall SC (228-653) and Super Boll (228-659), compiled by the same pipeline three times. Dropp SC was replaced because EPA lists it as cancelled, and Prep because it has no Georgia registration record.

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Gold v1 p2 run one | `{"coverage_recall":0.953,"typed_recall":0.875,"value_exact":0.907,"modality_acc":0.911,"acting_precision":0.917,"acting_recall":1.0}` | `json:eval/results/v1/p2_union_typed_v3_ocr_mf.json#overall` | MEASURED |
| Gold v1 p2 run two | `{"coverage_recall":0.953,"typed_recall":0.891,"value_exact":1.0,"modality_acc":0.877,"acting_precision":0.857,"acting_recall":1.0}` | `json:eval/results/v1/p2r2_union_typed_v3_ocr_mf.json#overall` | MEASURED |
| Gold v1 p2 run three | `{"coverage_recall":0.984,"typed_recall":0.891,"value_exact":0.955,"modality_acc":0.895,"acting_precision":0.917,"acting_recall":1.0}` | `json:eval/results/v1/p2r3_union_typed_v3_ocr_mf.json#overall` | MEASURED |
| Shipped majority `.ship` merge | `{"coverage_recall":0.984,"typed_recall":0.906,"value_exact":0.889,"modality_acc":0.879,"acting_precision":0.846,"acting_recall":1.0}` | `json:eval/results/ship.json#overall` | MEASURED |
| Shipped result suffix | `".ship"` | `json:eval/results/ship.json#suffix` | MEASURED |
| Shipped acting rules and matches | `{"acting_rules":13,"acting_good":11,"gold_acting":10,"gold_acting_hit":10}` | `json:eval/results/ship.json#overall` | MEASURED |
| Shipped acting rules the gold set marks advisory | `["228-653-p5-2","228-653-p8-15"]` | command: list `labels.*.acting_false_positives[].id` in `eval/results/ship.json`; output: `228-653-p5-2` (calm-wind sentence, MUST_NOT), `228-653-p8-15` (tribufos tank mix below 60 F, MUST) | MEASURED |
| Rule skipped as tobacco-only | `{"id":"228-659-p8-12","why":"applies to tobacco, not cotton"}` | command: `windows.load_rules("228-659")[2]`; rule in `data/compiled/228-659.ship.json` with `applies_to` `tobacco (flue-cured only)`; filter at `engine/windows.py` (`other_crop`) and `core/src/lib.rs` (`OTHER_CROPS`) | MEASURED |
| Tank-mix rules that drop out of a tank without their partner | `{"5481-504-p10-10":"thidiazuron","228-653-p8-15":"tribufos","228-653-p8-13":"ethephon","228-653-p8-17":"tribufos","228-653-p8-21":"tribufos"}` | command: `windows.tank_mix_partners(r)` over `windows.load_rules(reg)[1]` for the three shipped labels; filter at `engine/windows.py` (`partner_missing`) and `core/src/lib.rs` (`partner_missing`); both copies of `5481-504-p10-10` name thidiazuron | MEASURED |
| Cold Tift forecast, forecast-permitted hours by tank | `{"full_tank":0,"folex_super_boll":46,"freefall_super_boll":46}` | command: count hours with `state` `PERMITTED` in `expected` of `tests/fixtures/engine/tift-cold-full-tank.json`, `tift-cold-folex-superboll.json` and `tift-cold-freefall-superboll.json` (last Tift issuance recorded 2026-10-19, 156 hours); before the scoping both two-product tanks had 0 | MEASURED |
| Shipped-tank compile cost per run, USD (FreeFall SC and Super Boll) | `{"p2":0.3385,"p2r2":0.3713,"p2r3":0.3642}` | command: sum `cost_usd` and `retype_cost_usd` in `data/compiled/228-65*.union.<run>.typed.v3.ocr.mf.json`; no OCR file, so no rescue typing | MEASURED |

### Run-to-run variance and Token Factory cost

The variance and cost rows are the development tank. The variance rows use the three final p2 receipts with OCR and the modality floor. The cost is the sum of the two extraction passes, the Ultra typing pass, and OCR-rescue typing for all three labels. It does not include the Nebius AI Cloud GPU job cost.

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Final p2 run one | `{"coverage_recall":1.0,"typed_recall":1.0,"value_exact":0.944,"modality_acc":0.848,"acting_precision":0.909,"acting_recall":1.0}` | `json:eval/results/p2_union_typed_v3_ocr_mf.json#overall` | MEASURED |
| Final p2 run two | `{"coverage_recall":1.0,"typed_recall":1.0,"value_exact":0.972,"modality_acc":0.891,"acting_precision":1.0,"acting_recall":1.0}` | `json:eval/results/p2r2_union_typed_v3_ocr_mf.json#overall` | MEASURED |
| Final p2 run three | `{"coverage_recall":1.0,"typed_recall":1.0,"value_exact":0.944,"modality_acc":0.891,"acting_precision":1.0,"acting_recall":1.0}` | `json:eval/results/p2r3_union_typed_v3_ocr_mf.json#overall` | MEASURED |
| Observed metric ranges | `{"coverage_recall":"1.000..1.000","typed_recall":"1.000..1.000","value_exact":"0.944..0.972","modality_acc":"0.848..0.891","acting_precision":"0.909..1.000","acting_recall":"1.000..1.000"}` | command: PowerShell read of the three final result files; output: `coverage_recall=1.000..1.000`, `typed_recall=1.000..1.000`, `value_exact=0.944..0.972`, `modality_acc=0.848..0.891`, `acting_precision=0.909..1.000`, `acting_recall=1.000..1.000` | MEASURED |
| p2 run one Token Factory cost, USD | `{"extraction":0.2178,"typing":0.3095,"ocr_rescue_typing":0.0046,"total":0.5319}` | command: sum `cost_usd`, `retype_cost_usd`, and optional `ocr_rescue_cost_usd` in `data/compiled/{5481-504,264-700,264-418}.union.p2.typed.v3.ocr.mf.json`; output: `p2=0.5319` | MEASURED |
| p2 run two Token Factory cost, USD | `{"extraction":0.2238,"typing":0.3295,"ocr_rescue_typing":0.0064,"total":0.5597}` | command: same sum for `data/compiled/{5481-504,264-700,264-418}.union.p2r2.typed.v3.ocr.mf.json`; output: `p2r2=0.5597` | MEASURED |
| p2 run three Token Factory cost, USD | `{"extraction":0.2196,"typing":0.3218,"ocr_rescue_typing":0.0045,"total":0.5459}` | command: same sum for `data/compiled/{5481-504,264-700,264-418}.union.p2r3.typed.v3.ocr.mf.json`; output: `p2r3=0.5459` | MEASURED |

### Live compiler three-reading cost caps

The live compiler keeps the prior worst-case spend envelope while taking three readings. One reading is capped at 120,000 tokens. At the maximum configured token price of $3 per million tokens, that is $0.36 per reading and $1.08 reserved per three-reading request against the unchanged $2 daily budget. The shared ledger permits 13 requests per day and 133 over its lifetime, which allow at most 39 and 399 readings compared with the prior caps of 40 and 400 single readings.

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Three-reading request reservation, USD | `{"per_reading_tokens":120000,"maximum_usd_per_million_tokens":3,"per_reading_usd":0.36,"readings":3,"request_reservation_usd":1.08,"daily_budget_usd":2}` | `web/src/lib/live-limits.ts`; arithmetic: `120000 * 3 / 1000000 = 0.36`, then `3 * 0.36 = 1.08` | MEASURED |
| Shared daily reading ceiling | `{"requests":13,"readings_per_request":3,"maximum_readings":39,"prior_single_reading_cap":40}` | `web/src/lib/live-ledger.ts`; arithmetic: `13 * 3 = 39 <= 40` | MEASURED |
| Shared lifetime reading ceiling | `{"requests":133,"readings_per_request":3,"maximum_readings":399,"prior_single_reading_cap":400}` | `web/src/lib/live-ledger.ts`; arithmetic: `133 * 3 = 399 <= 400` | MEASURED |

### Live three-reading measurement

This is the single paid live compile authorized for this change. It used the newest EPA PPLS label for Axial XL and made no retry at the reading level.

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Measured label | `{"registration":"100-1256","product":"AXIAL XL","accepted":"2022-05-03","file_name":"000100-01256-20220503.pdf","label_sha256":"79bf4aedc997858f1267832e11fed6d4bc1437382b6bb1eb643513e5b975d68c"}` | `json:eval/results/live-3run-2026-10-19.json#source` | MEASURED |
| Per-reading rules, latency, tokens, and cost | `{"1":{"attempts":1,"accepted_rules":58,"rejected_rules":0,"latency_ms":15247,"total_tokens":37040,"cost_usd":0.0237838},"2":{"attempts":1,"accepted_rules":70,"rejected_rules":1,"latency_ms":15920,"total_tokens":39204,"cost_usd":0.025904},"3":{"attempts":1,"accepted_rules":54,"rejected_rules":2,"latency_ms":15250,"total_tokens":35900,"cost_usd":0.0226146}}` | `json:eval/results/live-3run-2026-10-19.json#summary.reading_metrics` | MEASURED |
| Merged rules by reading support | `{"merged_rule_count":99,"found_in_readings":{"1":53,"2":13,"3":33}}` | `json:eval/results/live-3run-2026-10-19.json#summary.merge` | MEASURED |
| Rules with modality splits | `{"rules_with_split":3}` | `json:eval/results/live-3run-2026-10-19.json#summary.modality_splits` | MEASURED |
| Total wall time, tokens, and cost | `{"wall_time_ms":17116,"pipeline_latency_ms":17091,"tokens_in":88536,"tokens_out":23608,"total_tokens":112144,"cost_usd":0.0723024}` | `json:eval/results/live-3run-2026-10-19.json#summary.totals` | MEASURED |

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
| FreeFall SC and Super Boll | `{"PERMITTED":17,"FIELD_CHECK":63,"BLOCKED":76}` | command: filter fixture rules to registrations `228-653,228-659`, run `windows.evaluate`, count `state`; output: `PERMITTED=17,FIELD_CHECK=63,BLOCKED=76` | MEASURED |
| Folex 6 EC, FreeFall SC, and Super Boll | `{"PERMITTED":17,"FIELD_CHECK":63,"BLOCKED":76}` | command: run `windows.evaluate` with all fixture rules, count `state`; output: `PERMITTED=17,FIELD_CHECK=63,BLOCKED=76` | MEASURED |
| Folex 6 EC and FreeFall SC (the what-if without Super Boll) | `{"PERMITTED":31,"windows_at_least_3_hours":5,"run_lengths":[6,6,11,5,3]}` | command: run `windows.evaluate` with fixture rules for `5481-504,228-653`, count `PERMITTED` and its runs; output: `31`, runs `6,6,11,5,3` | MEASURED |
| Development tank on the same replay | `{"PERMITTED":17,"FIELD_CHECK":63,"BLOCKED":76}` | the fixture's `expected` before the tank change (git history of `tests/fixtures/engine/tift.json`) | MEASURED |

## Nemotron alone against the compiled rules

These receipts used the development tank (Folex 6 EC, Dropp SC, Prep); each receipt records its own tank. `tools/model_alone.py` gives `nvidia/nemotron-3-super-120b-a12b` the full text of the three labels and a recorded 48-hour NWS forecast, with no compiled rules, and compares its hour states with the planner's on the same forecast. Response schema revision 2; revision 1 is kept in `eval/results/model-alone-2026-10-19.schema-v1.json`.

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
| Shipped tank: cases and hours compared | `{"planned_cases":30,"successful_cases":30,"failed_cases":0,"hours_compared":1440}` | `json:web/public/data/model-alone-shipped.json#pooled` | MEASURED |
| Shipped tank: agreement matrix, model state by planner state | `{"PERMITTED":{"PERMITTED":5,"BLOCKED":0,"FIELD_CHECK":0},"BLOCKED":{"PERMITTED":6,"BLOCKED":44,"FIELD_CHECK":18},"FIELD_CHECK":{"PERMITTED":194,"BLOCKED":219,"FIELD_CHECK":954}}` | `json:web/public/data/model-alone-shipped.json#pooled.agreement_matrix_model_x_planner` | MEASURED |
| Shipped tank: model go hours the planner blocks | `0` | `json:web/public/data/model-alone-shipped.json#pooled.unsafe_go_count` | MEASURED |
| Shipped tank: cited sentences verbatim on the cited page | `{"matched":1344,"total":1440}` | `json:web/public/data/model-alone-shipped.json#pooled.quote_check` | MEASURED |
| Shipped tank: go hours against the station | `{"model_permitted":{"held":4,"broke":0},"planner_permitted":{"held":66,"broke":89}}` | `json:web/public/data/model-alone-shipped.json#pooled.against_observations` | MEASURED |
| Shipped tank: model calls, tokens, latency and cost | `{"attempts":30,"prompt_tokens":991994,"completion_tokens":163182,"latency_ms":1208276,"cost_usd":0.444462}` | `json:web/public/data/model-alone-shipped.json#pooled.model_calls` | MEASURED |
| Ultra cases and hours compared | `{"planned_cases":30,"successful_cases":24,"failed_cases":5,"not_attempted_cases":1,"hours_compared":1152}` | `json:eval/results/model-alone-ultra-2026-10-19.json#summary` | MEASURED |
| Ultra agreement matrix, model state by planner state | `{"PERMITTED":{"PERMITTED":0,"BLOCKED":0,"FIELD_CHECK":0},"BLOCKED":{"PERMITTED":180,"BLOCKED":190,"FIELD_CHECK":446},"FIELD_CHECK":{"PERMITTED":107,"BLOCKED":26,"FIELD_CHECK":203}}` | `json:eval/results/model-alone-ultra-2026-10-19.json#summary.agreement_matrix_model_x_planner` | MEASURED |
| Ultra cited sentences verbatim on the cited page | `{"matched":609,"total":1152}` | `json:eval/results/model-alone-ultra-2026-10-19.json#summary.quote_check` | MEASURED |
| Ultra model calls, tokens, latency and cost | `{"attempts":36,"prompt_tokens":1483002,"completion_tokens":290917,"latency_ms":639806,"cost_usd":2.355753}` | `json:eval/results/model-alone-ultra-2026-10-19.json#summary.model_calls` | MEASURED |
| Lightning cases and hours compared | `{"planned_cases":30,"successful_cases":27,"failed_cases":1,"not_attempted_cases":2,"hours_compared":1296}` | `json:eval/results/model-alone-lightning-2026-10-19.json#summary` | MEASURED |
| Lightning agreement matrix, model state by planner state | `{"PERMITTED":{"PERMITTED":20,"BLOCKED":1,"FIELD_CHECK":54},"BLOCKED":{"PERMITTED":146,"BLOCKED":216,"FIELD_CHECK":332},"FIELD_CHECK":{"PERMITTED":166,"BLOCKED":7,"FIELD_CHECK":354}}` | `json:eval/results/model-alone-lightning-2026-10-19.json#summary.agreement_matrix_model_x_planner` | MEASURED |
| Lightning cited sentences verbatim on the cited page | `{"matched":814,"total":1296}` | `json:eval/results/model-alone-lightning-2026-10-19.json#summary.quote_check` | MEASURED |
| Lightning model calls, tokens, latency and cost | `{"attempts":28,"prompt_tokens":1153453,"completion_tokens":267080,"latency_ms":887955,"cost_usd":0.13330638}` | `json:eval/results/model-alone-lightning-2026-10-19.json#summary.model_calls` | MEASURED |
| Revision 1 schema outcome | `"10 of 10 calls returned one hour"` | `eval/results/model-alone-2026-10-19.schema-v1.json`, every `model_calls[].error`: `response has 1 hours, expected 48` | MEASURED |

## Recorded season and forecast check-back

The season files are exported by `tools/season_export.py`. The check-back runs the planner on the forecast issued closest to 24 hours before each recorded hour and checks every forecast-permitted hour against the station observation recorded for that hour. Only label limits a station can measure are checked; clauses it cannot decide are listed, never counted as held.

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Season recorded span | `{"first":"2026-10-05T01:19:36+00:00","last":"2026-10-19T18:07:01+00:00"}` | `json:web/public/data/season/index.json#recorded_span` | MEASURED |
| Season issuances per point | `{"ben_hill":{"issuances":339},"berrien":{"issuances":339},"coffee":{"issuances":339},"colquitt":{"issuances":339},"cook":{"issuances":338},"dooly":{"issuances":339},"irwin":{"issuances":339},"mitchell":{"issuances":339},"tift":{"issuances":339},"worth":{"issuances":339}}` | `json:web/public/data/season/index.json#points` | MEASURED |
| Check-back recorded span | `{"first":"2026-10-05T01:19:36+00:00","last":"2026-10-20T22:07:02+00:00"}` | `json:web/public/data/checkback.json#recorded_span` | MEASURED |
| Check-back input files | `{"hourly_files":3649,"valid_hourly_files":3649,"observation_files":3649,"valid_observation_files":3649,"observations_outside_hour_tolerance":0}` | `json:web/public/data/checkback.json#input_counts` | MEASURED |
| Check-back tank mix, Folex 6 EC, FreeFall SC, and Super Boll | `{"hours_considered":3820,"evaluated_hours":2581,"permitted_a_day_ahead":401,"held":236,"broke":134,"skipped":{"no_obs":936,"no_issuance":303,"missing_measurement":31}}` | `json:web/public/data/checkback.json#tank_mix.pooled` | MEASURED |
| Check-back Folex 6 EC alone | `{"permitted_a_day_ahead":834,"held":527,"broke":232,"skipped":{"missing_measurement":75}}` | `json:web/public/data/checkback.json#products.5481-504.pooled` | MEASURED |
| Check-back FreeFall SC alone | `{"permitted_a_day_ahead":498,"held":283,"broke":174,"skipped":{"missing_measurement":41}}` | `json:web/public/data/checkback.json#products.228-653.pooled` | MEASURED |
| Check-back Super Boll alone | `{"permitted_a_day_ahead":737,"held":480,"broke":192,"skipped":{"missing_measurement":65}}` | `json:web/public/data/checkback.json#products.228-659.pooled` | MEASURED |
| Every check-back break was wind | `{"tank_and_each_product_break_params":["wind_speed_mph"],"tank_over_10_mph_hours":119,"tank_over_10_mph_observed":"10.29..16.11","tank_calm_hours":15,"tank_calm_rule":"228-653-p5-2"}` | command: collect `param`, `count`, `observed_min`, `observed_max` over `pooled.breaks` for `tank_mix` and each product in `web/public/data/checkback.json`; output: `{'wind_speed_mph'}` for all four; tank mix: 119 hours at `10.289907..16.105941` on five 10 mph clauses, 15 hours at `0.0` on `228-653-p5-2` | MEASURED |
| Tank-mix clauses a station cannot check | `6` | command: count unique `rule` in `tank_mix.not_checkable_clauses`; output: `6` (params `night_temperature_f`, `rain_free_hours`, `temperature_inversion`) | MEASURED |
| Development tank check-back, recordings to 2026-10-19 18:07 UTC | `{"permitted_a_day_ahead":566,"held":405,"broke":119}` | `json:eval/results/checkback-2026-10-19.json#tank_mix.pooled` | MEASURED |
| Check-back recompute command | `"python tools/checkback.py --recorded data/nws_recorded"` | `tools/checkback.py`; `data/nws_recorded/` is gitignored at `.gitignore:16`, so the recorded inputs are not in the repo | SOURCED |
| Recorder ran every hour of the span | `"NOT VERIFIED"` | The recorder ran on a desktop PC through Oct 19 and missed hours while it was off (Tift has no files from 08:07 UTC Oct 16 to 01:07 UTC Oct 17). The app shows recorded against expected issuances per point. | NOT VERIFIED |

## Label time machine

The `/changes/<reg>` page compares accepted label versions. The earlier version of each shipped label was compiled once by `tools/previous_compile.py` with the shipped pipeline unchanged; `tools/label_changes.py` compares the rules and runs the planner on the four committed forecasts in `tests/fixtures/engine/` (tift, worth, colquitt, tift-cold-full-tank).

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Folex 6 EC version before the shipped one | `{"accepted":"2025-02-27","compiled":false,"pages":11,"why":"11 of 11 pages have no readable text layer; the PDF is a scan."}` | `json:eval/results/previous-compile-2026-10-21.json#labels.5481-504` | MEASURED |
| FreeFall SC version before the shipped one | `{"accepted":"2021-01-27","compiled":true,"cost_usd":0.6154,"merged_rules":166}` | `json:eval/results/previous-compile-2026-10-21.json#labels.228-653` | MEASURED |
| Super Boll version before the shipped one | `{"accepted":"2020-01-31","compiled":true,"cost_usd":0.523,"merged_rules":147}` | `json:eval/results/previous-compile-2026-10-21.json#labels.228-659` | MEASURED |
| Token Factory spend on the earlier versions | `1.1384` | `json:eval/results/previous-compile-2026-10-21.json#total_cost_usd` | MEASURED |
| FreeFall SC rules, shipped against earlier | `{"shipped_count":148,"previous_count":166,"unchanged":88}` | `json:web/public/data/changes.json#labels.228-653.rules` | MEASURED |
| Super Boll rules, shipped against earlier | `{"shipped_count":131,"previous_count":147,"unchanged":79}` | `json:web/public/data/changes.json#labels.228-659.rules` | MEASURED |
| Rule differences, sentence in one text layer only against in both | `{"228-653":{"one_text_layer":5,"both_text_layers":100},"228-659":{"one_text_layer":0,"both_text_layers":85}}` | command: count `added`, `removed` and `changed` entries of `labels.<reg>.rules` in `web/public/data/changes.json` by `label_changed`; output: `228-653 5 100`, `228-659 0 85` | MEASURED |
| The 5 FreeFall SC one-text-layer differences, checked by eye | `{"real_wording_change":2,"words_printed_but_missing_from_the_2021-01-27_text_layer":3}` | manual check, 2026-10-21, in the app's PDF dialog on the preview: page 10 of the 2021-01-27 PDF prints "reminder" where the 2021-05-14 label has "remainder" (one rule added, one removed); page 8 prints "(COC's) or" and page 9 prints "It is the pesticide user's responsibility to ensure that all products", both absent from that PDF's text layer (pypdf and pdf.js) | MEASURED |
| FreeFall SC planner hours that change state, cold Tift forecast | `{"hours":156,"changed":0}` | `json:web/public/data/changes.json#labels.228-653.hours.tift-cold.tank` | MEASURED |
| Planner hours that change state, four forecasts | `{"228-653":{"tank":"0 of 624","alone":"0 of 624"},"228-659":{"tank":"0 of 624","alone":"0 of 624"}}` | command: sum `changed` and `hours` over `labels.<reg>.hours.*.tank` and over `.alone` in `web/public/data/changes.json`; output: `0 624` for each | MEASURED |
| Text changes between each shipped label and the version before it | `{"228-653":{"changes":42,"spray_conditions":1,"formatting_blocks":9,"blank_pages_earlier":[1,2]},"228-659":{"changes":14,"spray_conditions":0},"5481-504":{"unreadable":"from"}}` | command from `web/`: `pnpm exec tsx scripts/record-changes-fixtures.ts`, 2026-10-21, against live EPA; output files `web/tests/fixtures/changes/diff-*.json` | MEASURED |

## Data sources and fetch scripts

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Folex 6 EC accepted label | `{"accepted":"2026-03-04","url":"https://www3.epa.gov/pesticides/chem_search/ppls/005481-00504-20260304.pdf"}` | `data/labels/index.json`, keys `5481-504.accepted` and `5481-504.url`; [EPA PDF](https://www3.epa.gov/pesticides/chem_search/ppls/005481-00504-20260304.pdf) | SOURCED |
| FreeFall SC accepted label | `{"accepted":"2021-05-14","url":"https://www3.epa.gov/pesticides/chem_search/ppls/000228-00653-20210514.pdf"}` | `data/labels/index.json`, keys `228-653.accepted` and `228-653.url`; [EPA PDF](https://www3.epa.gov/pesticides/chem_search/ppls/000228-00653-20210514.pdf) | SOURCED |
| Super Boll accepted label | `{"accepted":"2022-08-08","url":"https://www3.epa.gov/pesticides/chem_search/ppls/000228-00659-20220808.pdf"}` | `data/labels/index.json`, keys `228-659.accepted` and `228-659.url`; PPLS name `ETHEPHON E-AG 6 PLANT GROWTH REGULATOR`, alternate brand name Super Boll on the label; [EPA PDF](https://www3.epa.gov/pesticides/chem_search/ppls/000228-00659-20220808.pdf) | SOURCED |
| Dropp SC registration status | `{"product_status":"Inactive","cancel_flag":"Yes","cancellationreason":"Company Request","product_status_date":"January 15, 2014"}` | [EPA PPLS record for 264-700](https://ordspub.epa.gov/ords/pesticides/cswu/ppls/264-700), read 2026-10-20; the label stays in `data/labels/index.json` as the development tank | SOURCED |
| EPA label index and download script | `"tools/ppls_fetch.py"` | PPLS page template at `tools/ppls_fetch.py:30`, JSON API fallback at `tools/ppls_fetch.py:31`, PDF URL construction at `tools/ppls_fetch.py:56`, and PDF content check at `tools/ppls_fetch.py:100`; [EPA PPLS](https://ordspub.epa.gov/ords/pesticides/f?p=PPLS:1) | SOURCED |
| Tift hourly forecast endpoint | `"https://api.weather.gov/gridpoints/TAE/106,131/forecast/hourly"` | `data/nws_points_cache.json`, key `tift.forecastHourly`; [NWS API documentation](https://www.weather.gov/documentation/services-web-api) | SOURCED |
| Forecast and observation recorder | `"tools/nws_recorder.py"` | point resolution at `tools/nws_recorder.py:80-98`, hourly forecast fetch at `tools/nws_recorder.py:122`, and latest station observation fetch at `tools/nws_recorder.py:141`; [NWS API documentation](https://www.weather.gov/documentation/services-web-api) | SOURCED |

## Models and services

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Label extraction model | `"nvidia/nemotron-3-super-120b-a12b"` | `json:data/compiled/5481-504.p2.json#model`; caller at `compiler/compile_label.py:35,226-242` | MEASURED |
| Rule typing model | `"nvidia/Nemotron-3-Ultra-550b-a55b"` | `json:data/compiled/5481-504.union.p2.typed.v3.ocr.mf.json#retype_model`; caller at `compiler/retype.py:34,95-113` | MEASURED |
| OCR model (used on the development tank's scanned Dropp SC label) | `"nvidia/NVIDIA-Nemotron-Parse-2.0"` | `json:data/compiled/264-700.union.p2.typed.v3.ocr.mf.json#ocr_model`; caller at `tools/ocr_parse.py:34,48,55,72` | MEASURED |
| Browser agent model | `"nvidia/Nemotron-3_5-Lightning"` | `web/src/app/api/agent/route.ts:8,159-176`; static audit command output: `const MODEL = "nvidia/Nemotron-3_5-Lightning"` | MEASURED |
| Token Factory base URL | `"https://api.tokenfactory.nebius.com/v1"` | `compiler/compile_label.py:34,235`; the web agent uses `https://api.tokenfactory.nebius.com/v1/chat/completions` at `web/src/app/api/agent/route.ts:9,159` | MEASURED |
| OCR Serverless Job target | `"gpu-l40s-a"` | `tools/ocr_job/submit.sh:9-21`, specifically line 13; job command runs Parse at `tools/ocr_job/run.sh:31-32` | MEASURED |
| Historical OCR job ran on an L40S | `"NVIDIA L40S"` | retained job output `data/text/264-700.ocr.json` (gitignored because it is label text), key `device`, written inside the job by `torch.cuda.get_device_name(0)` at `tools/ocr_parse.py:86`; same file: `ocr_utc` `2026-10-05T04:15:25+00:00`, model `nvidia/NVIDIA-Nemotron-Parse-2.0`, 9 pages. The Nebius job record itself is no longer listed (`nebius ai job list` in all three projects on 2026-10-19: no jobs). | MEASURED |

## Web app and agent

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| App routes | `["/","/app","/changes/[reg]","/judge","/map","/proof"]` | command: enumerate `page.tsx` below `web/src/app` on branch label-time-machine, 2026-10-21 | MEASURED |
| API routes | `["/api/agent","/api/alerts/confirm","/api/alerts/run","/api/alerts/start","/api/alerts/voice/stop","/api/alerts/voice/why","/api/label-pdf/[reg]","/api/labels/compile","/api/labels/diff","/api/labels/photo","/api/labels/search","/api/labels/versions/[reg]","/api/season/[...path]"]` | command: enumerate `route.ts` below `web/src/app` on branch label-time-machine, 2026-10-21 | MEASURED |
| Agent per-IP limit | `{"requests":20,"window_minutes":10,"scope":"best effort per Node instance"}` | `web/src/app/api/agent/route.ts:14-15,33-36,88-102`; local static audit output: `RATE_LIMIT_COUNT=20`, `RATE_LIMIT_WINDOW_MS=600000` | MEASURED |
| Agent daily token budget | `{"tokens":2000000,"reset":"UTC date","scope":"best effort per Node instance"}` | `web/src/app/api/agent/route.ts:16,33-36,105-110,141,199-205`; local static audit output: `DAILY_TOKEN_BUDGET=2000000` | MEASURED |
| Agent tool order | `"check_tank first; then final_answer at once for a when or window question; otherwise one get_clause round, then final_answer"` | `web/src/lib/agent/tool-choice.ts:17-23` | MEASURED |
| Answer guard | `"every cited rule id, window index and number must appear in a tool result; Latin script only; ends as a sentence; no unscoped no-window claim and no window called blocked when check_tank returned a window"` | `web/src/lib/agent/guard.ts:307` (`guardFinalAnswer`); `web/tests/agent-guard.test.ts` | MEASURED |
| Number reading in the guard | `"a comma joins digits only as a thousands separator (pages 7,8 is 7 and 8); a minus counts only with no letter, digit or dot before it (3-7 PM is 3 and 7)"` | `web/src/lib/agent/guard.ts:17-30`; test `reading numbers out of a summary` in `web/tests/agent-guard.test.ts` | MEASURED |
| Repair of a false window sentence | `"if the only failure is a no-window or window-blocked sentence and check_tank returned windows, that sentence is removed, every returned window is listed, and the page says what was removed"` | `web/src/lib/agent/guard.ts:367` (`dropWindowClaims`); `web/src/lib/agent/loop.ts:297`; `web/src/ui/planner/AskTank.tsx` (`data-answer-edit`) | MEASURED |
| Agent cost per question on production | `["0.000254","0.000258","0.000575","0.000582","0.000584"]` | five Ask the tank runs on labelhand-web.vercel.app, main e77fadc, 2026-10-20 05:58 to 06:08 UTC; each value is the page trace's `total cost`; all five passed the guard | MEASURED |

## Live label reading, map, alerts and offline use

A label not in the shipped tank is read live: the browser streams `/api/labels/compile`, which reads the EPA label three times with the same models as the compiler and merges the readings like `compiler/merge_runs.py`. Live rules are unscored; the gold set covers only the three shipped labels.

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Readings per live compile | `3` | `web/src/lib/live-limits.ts:9` (`LIVE_COMPILE_READINGS`) | MEASURED |
| Second recorded live compile of AXIAL XL (EPA 100-1256), kept as the streaming test fixture | `{"rules_per_reading":[62,72,80],"merged_rules":128,"found_in_all_three":28,"found_in_two":26,"found_in_one":74,"pages":20,"latency_ms":19743,"cost_usd":0.0768177}` | `web/tests/fixtures/live/axial-xl-100-1256.ndjson`, final `done` event: `reading_records[].accepted_rules`, `accepted` length, `found_in_runs` length per accepted rule, `pages`, `latency_ms`, `cost_usd` | MEASURED |
| Map counties drawn | `43` | command: count `counties` in `web/public/data/map/south-georgia.json`, 2026-10-20 | MEASURED |
| Map boundary source | `"us-atlas counties-10m (US Census cartographic boundaries 1:10,000,000)"` | `json:web/public/data/map/south-georgia.json#source` | MEASURED |
| Map points with a recorded forecast | `["ben_hill","berrien","coffee","colquitt","cook","dooly","irwin","mitchell","tift","worth"]` | command: sorted keys of `points` in `web/public/data/season/index.json`, 2026-10-20 | MEASURED |
| Alert phone check and call services | `{"phone_check":"Twilio Verify v2","call":"Twilio Programmable Voice calls.create"}` | `web/src/lib/alerts/twilio.ts:36,50,59` | MEASURED |
| Alert caps | `{"verify_code_ttl_minutes":10,"calls_per_subscription_per_day":3,"calls_per_phone_per_day":9,"calls_total_per_day":30,"verify_starts_per_phone_per_day":5,"verify_starts_per_client_per_day":20,"verify_starts_total_per_day":100}` | `web/src/lib/alerts/service.ts:33`; `web/src/lib/alerts/storage.ts:15-20` | MEASURED |
| Alert planning horizon | `"36 hours"` | `web/src/lib/alerts/planner.ts:12` | MEASURED |
| Alert runner trigger | `"hourly recorder job posts /api/alerts/run when repository variable RECORDER_ALERTS is true"` | `.github/workflows/recorder.yml:5,56,208-212` | MEASURED |
| Production alert calls to the builder's own phone | `{"2026-10-20T16:16:11Z":{"field":"tift","called":1,"answered":false},"2026-10-20T18:21:52Z":{"field":"tift","called":0,"duplicate":1},"2026-10-20T18:26:41Z":{"fields_scanned":2,"called":1,"duplicate":1,"answered":true}}` | command: `POST https://labelhand-web.vercel.app/api/alerts/run` with the run secret, at each time shown; outputs: `called 1`, then `scanned 1, called 0, duplicate 1` (the Tift window already called was not called again), then `scanned 2, called 1, duplicate 1` after a Worth subscription was confirmed. The 16:16 call completed unanswered (Twilio call status `completed`, 8 s). The 18:26 call was answered (phone screen recording, in-call timer past 0:39). | MEASURED |
| Endangered species bulletins | `"asked live: the next-window card calls /api/bulletins, which asks EPA Bulletins Live! Two data services (informational, not a Bulletin) for every tank registration at the field point in the next window's month; an unavailable answer falls back to the link and prints the field as latitude, longitude for its Location Search"` | `web/src/lib/blt.ts`; `web/src/app/api/bulletins/route.ts`; `web/src/ui/planner/BulletinCheck.tsx` (`data-bulletin`, `data-bulletin-status`); `web/tests/blt.test.ts`; `web/tests/e2e/app.spec.ts`. The map's Location Search placed its result pin at `31.400000 -83.600000` for the input `31.4, -83.6` (Chrome, 2026-10-20). | MEASURED |
| Bulletins Live! Two calls per check | `{"point":"blt.epa.gov PesticideUsageLimitationAreas MapServer layer 0 query","products":"blt.epa.gov/blt/api/pulas_public","limitations":"blt.epa.gov/blt/api/limitations_public, only when a PULA at the point lists a tank product","timeout_ms_per_call":8000,"cache_seconds":10800}` | `web/src/lib/blt.ts` (`pointQueryUrl`, `candidatePulasUrl`, `limitationsUrl`, `BLT_UPSTREAM_TIMEOUT_MS`, `BLT_CACHE_SECONDS`) | MEASURED |
| Controls behind a "no limits" answer | `{"point":"31.31097, -82.43219 in Ware County, inside PULAs 91, 96, 97 and 110","product":"STRYAX HERBICIDE, EPA Reg. No. 264-1241, in PULAs 111, 121, 122 and 123"}` | `web/src/lib/blt.ts` (`CONTROL_POINT`, `CONTROL_REG`); responses `web/tests/fixtures/blt/point-ware-control.json` and `candidates-stryax-2026-11.json`, URLs and fetch times in `web/tests/fixtures/blt/sources.json` (2026-10-20). Both are asked again for every empty answer, never cached, and both must return every PULA listed here; otherwise the answer is unavailable. | MEASURED |
| Live answer for Folex 6 EC, Dropp SC and Prep at the ten field points | `{"checks":20,"checked":20,"months":["2026-10","2026-11"],"pulas_at_points":0,"limitations":0,"ms_per_check":{"min":64,"max":538}}` | command from `web/`: `pnpm exec tsx scripts/blt-live-check.ts 2026-10 2026-11`, 2026-10-20T21:13:41Z; output: `checks 20`, `checked 20`, every `pulas` and `limitations` list empty | MEASURED |
| Live answers that do list a limitation | `{"264-1241 at 32.21361, -83.73173":"DC125 in PULA 121","61842-55 at 31.31097, -82.43219":"MY225 in PULA 110"}` | same command and run as the row above; output `positives`: `264-1241 DC125 PULA 121` and `61842-55 MY225 PULA 110` | MEASURED |
| EPA answers that look like success | `{"map_query_error":"HTTP 200 with an error object","map_unreadable_geometry":"HTTP 200, every PULA, exceededTransferLimit true","api_unknown_where_field":"HTTP 200, every limitation row"}` | `web/tests/fixtures/blt/point-error-unknown-field.json`, `point-truncated-bad-geometry.json` and `limitations-ignored-filter.json`, URLs in `sources.json` (2026-10-20); each makes the check answer unavailable in `web/tests/blt.test.ts` | MEASURED |
| Installable app manifest | `{"name":"Labelhand","start_url":"/app","display":"standalone","icons":3}` | `web/src/app/manifest.ts` | MEASURED |
| Offline forecast copy | `{"header":"x-labelhand-offline-copy","badge":"OFFLINE COPY","forecast_cache":"labelhand-forecasts"}` | `web/public/sw.js:8,11`; `web/src/lib/planner-data.ts` (`OFFLINE_COPY_HEADER`); `web/src/ui/planner/Planner.tsx` | MEASURED |
| Offline end-to-end test | `"one first visit, no reload, every loaded file cached, then offline: 156 hour cells and OFFLINE COPY"` | `web/tests/e2e/pwa.spec.ts`; CI web job on d64b10b passed; with the page-to-worker forecast handoff removed, this test fails (local mutation check, 2026-10-20) | MEASURED |

## Tests and CI

The required CI workflow jobs are `python`, `rust`, and `web` at `.github/workflows/ci.yml:16-100`. The scheduled production workflow job is `probe` at `.github/workflows/live.yml:11-41`. The local pre-commit run mirrors the code gates in `ci.yml`; dependency and browser setup steps are environment preparation, not verdicts.

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Python lint | `"passed"` | command: `uv run --active --no-sync ruff check .`; output: `All checks passed!` | MEASURED |
| Python format | `"50 files already formatted"` | command: `uv run ruff format --check .`, 2026-10-21; output: `50 files already formatted` | MEASURED |
| Python tests | `"149 passed"` | command: `pytest -q` in the project venv, 2026-10-21; output: `149 passed in 4.76s` | MEASURED |
| Tracked-text em-dash gate | `"53 files scanned, 0 hits"` | the `.github/workflows/ci.yml:30-34` command in Git Bash, 2026-10-21; output: `files=53`, grep matched no file | MEASURED |
| Rust format | `"passed"` | command: `cargo fmt --check`; exit: `0` | MEASURED |
| Rust lint | `"passed"` | command: `cargo clippy --all-targets --all-features -- -D warnings`; exit: `0` | MEASURED |
| Rust tests | `"8 passed: 6 unit and 2 parity"` | command: `cargo test`, 2026-10-21; output: `6 passed`, `2 passed`, and `0` doc tests | MEASURED |
| Rust WASM build | `"release build passed"` | command: `wasm-pack build core --target web --release -- --features wasm`; output: `Your wasm pkg is ready to publish at core\\pkg` | MEASURED |
| Web typecheck | `"passed"` | command from `web/`: `pnpm typecheck`; output: `Types generated successfully`; `tsc --noEmit` exit: `0` | MEASURED |
| Web lint | `"passed"` | command from `web/`: `pnpm lint`; exit: `0` | MEASURED |
| Web unit tests | `"481 passed in 49 files"` | command from `web/`: `pnpm test`, 2026-10-21; output: `Test Files 49 passed`, `Tests 481 passed` | MEASURED |
| Web production build | `"passed; 19 of 19 static pages generated"` | command from `web/`: `pnpm build`, 2026-10-21; output: `Generating static pages using 7 workers (19/19)` | MEASURED |
| Web end-to-end tests | `"48 passed"` | command from `web/`: `pnpm e2e` against `pnpm start`, 2026-10-21; output: `48 passed (1.8m)` | MEASURED |
| Browser data freshness | `"passed with no diff"` | commands: rebuild WASM, `pnpm sync-engine`, then `git diff --exit-code -- web/public/data`; all exits: `0` | MEASURED |

## Drift found

| Claim | Exact value | Source | Tag |
|---|---|---|---|
| Not drift: README `.ship` precision | `"README.md:71 gives 0.923 (12/13) for the acting-wins .ship merge, a different merge from the shipped majority .ship row, which scores 1.0 (12/12)."` | `README.md:71` and `README.md:67`; command: read `eval/results/ship.json` keys `overall.acting_precision`, `overall.acting_good`, and `overall.acting_rules`; output: `1.0`, `12`, `12` | MEASURED |
| Fixed: README every-run statement | `"README.md:125 said acting precision and recall are 1.0 on every run, but final p2 run one acting precision is 0.909. The sentence now says acting recall is 1.0 on every run and single runs reach 0.909 to 1.0 on acting precision."` | `README.md:125`; command: read `eval/results/p2_union_typed_v3_ocr_mf.json` key `overall.acting_precision`; output: `0.909` | MEASURED |
| README rounded cost hides run variance | `"README.md:73 says $0.53 per run. Exact committed Token Factory totals are $0.5319, $0.5597, and $0.5459."` | `README.md:73`; cost commands and outputs in the run-cost table above | MEASURED |
| Rule ids repeat after merging readings | `{"228-653":{"rules":148,"ids_repeated":32},"228-659":{"rules":131,"ids_repeated":36},"5481-504":{"rules":140,"ids_repeated":37}}` | command: count `id` values that occur more than once in `accepted` of each `web/public/data/compiled/*.ship.json`, 2026-10-20. Ids are numbered per reading, so the merge keeps two clauses under one id. Four repeats are between planner-used rules (for example `5481-504-p9-2` is both a wind and an inversion advisory). Every hour citation carries its own quote, so the planner and the clause cards show the right sentence; `get_clause` now returns every clause under a shared id and the hour card shows one sentence once. The ids themselves were not renumbered, to keep the Python, Rust and browser parity fixtures unchanged. | MEASURED |

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
| An alert call has reached an applicator | `"NOT VERIFIED"` | Both production calls so far went to the builder's own phone (row above). Check needed: a subscription confirmed by an applicator and the call that followed it. | NOT VERIFIED |
| A native mobile app is shipped | `"NOT VERIFIED"` | The web app installs from the browser as a web app with an offline forecast copy; there is no App Store or Play Store build. | NOT VERIFIED |
| A live compile returns the same rules every run | `"DO NOT CLAIM"` | Two committed live compiles of the same AXIAL XL label merged 99 and 128 rules (rows above), at temperature 0 with three readings each. | NOT VERIFIED |
