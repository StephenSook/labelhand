use std::fs;
use std::path::{Path, PathBuf};

use labelhand_core::{CompiledLabel, Period, Rule, evaluate, load_rules};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Fixture {
    lat: f64,
    lon: f64,
    hours: usize,
    rules_suffix: String,
    rules: Vec<Rule>,
    periods: Vec<Period>,
    expected: Vec<Value>,
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("core crate has a repository parent")
        .to_path_buf()
}

fn fixture_paths() -> Vec<PathBuf> {
    let directory = repo_root().join("tests/fixtures/engine");
    let mut paths = fs::read_dir(&directory)
        .unwrap_or_else(|error| panic!("could not read {}: {error}", directory.display()))
        .map(|entry| entry.expect("fixture directory entry is readable").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    paths.sort();
    assert!(
        paths.len() >= 3,
        "expected at least 3 engine fixtures in {}, found {}",
        directory.display(),
        paths.len()
    );
    paths
}

fn read_fixture(path: &Path) -> Fixture {
    let text = fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("could not read {}: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("could not parse {}: {error}", path.display()))
}

#[test]
fn evaluate_matches_every_frozen_fixture_per_hour() {
    for path in fixture_paths() {
        let fixture = read_fixture(&path);
        let name = path
            .file_name()
            .expect("fixture has a file name")
            .to_string_lossy();
        let got = evaluate(
            &fixture.rules,
            &fixture.periods,
            fixture.lat,
            fixture.lon,
            fixture.hours,
        )
        .unwrap_or_else(|error| panic!("fixture {name} could not be evaluated: {error}"));
        assert_eq!(
            got.len(),
            fixture.hours,
            "fixture {name}: Rust returned the wrong hour count"
        );
        assert_eq!(
            fixture.expected.len(),
            fixture.hours,
            "fixture {name}: frozen expected data has the wrong hour count"
        );
        for (hour_index, (actual, expected)) in got.iter().zip(fixture.expected.iter()).enumerate()
        {
            let actual = serde_json::to_value(actual).expect("evaluation serializes to JSON");
            assert_eq!(
                actual,
                *expected,
                "fixture {name}, hour {hour_index}\nactual: {}\nexpected: {}",
                serde_json::to_string_pretty(&actual).expect("actual JSON prints"),
                serde_json::to_string_pretty(expected).expect("expected JSON prints")
            );
        }
    }
}

#[test]
fn load_rules_matches_the_fixture_rule_order_and_fields() {
    let root = repo_root();
    let regs = ["5481-504", "264-700", "264-418"];
    let fields = [
        "id", "page", "product", "reg", "param", "op", "value", "value2", "unit", "modality",
        "quote",
    ];
    for fixture_path in fixture_paths() {
        let fixture = read_fixture(&fixture_path);
        let name = fixture_path
            .file_name()
            .expect("fixture has a file name")
            .to_string_lossy();
        let mut actual_rules = Vec::new();
        for reg in regs {
            let path = root.join(format!("data/compiled/{reg}{}.json", fixture.rules_suffix));
            let text = fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("could not read {}: {error}", path.display()));
            let compiled: CompiledLabel = serde_json::from_str(&text)
                .unwrap_or_else(|error| panic!("could not parse {}: {error}", path.display()));
            actual_rules.extend(load_rules(&compiled, reg).used);
        }
        assert_eq!(
            actual_rules.len(),
            fixture.rules.len(),
            "fixture {name}: load_rules returned the wrong number of rules"
        );
        for (index, (actual, expected)) in actual_rules.iter().zip(fixture.rules.iter()).enumerate()
        {
            let actual = serde_json::to_value(actual).expect("actual rule serializes");
            let expected = serde_json::to_value(expected).expect("fixture rule serializes");
            for field in fields {
                assert_eq!(
                    actual.get(field),
                    expected.get(field),
                    "fixture {name}, rule index {index}, field {field}\nactual: {}\nexpected: {}",
                    actual.get(field).unwrap_or(&Value::Null),
                    expected.get(field).unwrap_or(&Value::Null)
                );
            }
        }
    }
}
