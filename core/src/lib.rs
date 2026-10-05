use std::collections::HashSet;
use std::fmt;
use std::sync::OnceLock;

use chrono::{DateTime, Datelike, FixedOffset, Timelike, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const TOPIC: [(&str, &[&str]); 6] = [
    ("wind_speed_mph", &["wind"]),
    ("temperature_inversion", &["inversion"]),
    ("rain_free_hours", &["rain"]),
    ("rainfall_expected", &["rain"]),
    ("night_temperature_f", &["night"]),
    ("air_temperature_f", &["temperature"]),
];
pub const RAIN_EXPECTED_POP: f64 = 50.0;
pub const RAIN_UNSURE_POP: f64 = 20.0;
pub const ADVISORY_HOURS: usize = 24;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub page: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reg: Option<String>,
    pub param: String,
    pub op: String,
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub value2: Option<Value>,
    pub unit: Option<String>,
    pub modality: String,
    pub quote: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompiledLabel {
    pub product: String,
    pub accepted: Vec<Rule>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SkippedRule {
    pub id: String,
    pub param: String,
    pub why: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadRulesResult {
    pub product: String,
    pub used: Vec<Rule>,
    pub skipped: Vec<SkippedRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbabilityOfPrecipitation {
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Period {
    #[serde(rename = "startTime")]
    pub start_time: String,
    #[serde(rename = "isDaytime", default)]
    pub is_daytime: Option<bool>,
    #[serde(default)]
    pub temperature: Option<Value>,
    #[serde(rename = "windSpeed", default)]
    pub wind_speed: Option<String>,
    #[serde(rename = "probabilityOfPrecipitation", default)]
    pub probability_of_precipitation: Option<ProbabilityOfPrecipitation>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Citation {
    pub product: String,
    pub rule: String,
    pub page: Value,
    pub quote: String,
    pub why: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Evaluation {
    pub start: String,
    pub state: String,
    pub temp_f: Option<Value>,
    pub wind: Option<String>,
    pub pop: Option<Value>,
    pub sun_alt: f64,
    pub blocked: Vec<Citation>,
    pub checks: Vec<Citation>,
    pub advisories: Vec<Citation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreError(String);

impl CoreError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CoreError {}

fn topic_words(param: &str) -> Option<&'static [&'static str]> {
    TOPIC
        .iter()
        .find_map(|(candidate, words)| (*candidate == param).then_some(*words))
}

fn tuple_repr(words: &[&str]) -> String {
    let joined = words
        .iter()
        .map(|word| format!("'{word}'"))
        .collect::<Vec<_>>()
        .join(", ");
    if words.len() == 1 {
        format!("({joined},)")
    } else {
        format!("({joined})")
    }
}

pub fn load_rules(compiled: &CompiledLabel, reg: &str) -> LoadRulesResult {
    static NON_WORDS: OnceLock<Regex> = OnceLock::new();
    let non_words = NON_WORDS.get_or_init(|| Regex::new(r"\W+").expect("valid dedupe regex"));
    let mut used = Vec::new();
    let mut skipped = Vec::new();
    let mut seen = HashSet::new();

    for source_rule in &compiled.accepted {
        let Some(words) = topic_words(&source_rule.param) else {
            continue;
        };
        let quote = source_rule.quote.to_lowercase();
        let key = (
            source_rule.param.clone(),
            non_words.replace_all(&quote, "").into_owned(),
        );
        if !seen.insert(key) {
            continue;
        }
        if words.iter().all(|word| quote.contains(word)) {
            let mut rule = source_rule.clone();
            rule.product = Some(compiled.product.clone());
            rule.reg = Some(reg.to_owned());
            used.push(rule);
        } else {
            skipped.push(SkippedRule {
                id: source_rule.id.clone(),
                param: source_rule.param.clone(),
                why: format!("quote lacks {}", tuple_repr(words)),
            });
        }
    }

    LoadRulesResult {
        product: compiled.product.clone(),
        used,
        skipped,
    }
}

pub fn mph(input: &str) -> f64 {
    static NUMBERS: OnceLock<Regex> = OnceLock::new();
    let numbers = NUMBERS.get_or_init(|| Regex::new(r"\d+(?:\.\d+)?").expect("valid mph regex"));
    numbers
        .find_iter(input)
        .filter_map(|number| number.as_str().parse::<f64>().ok())
        .reduce(f64::max)
        .unwrap_or(f64::NAN)
}

pub fn sun_altitude(lat: f64, lon: f64, t: DateTime<FixedOffset>) -> f64 {
    let t = t.with_timezone(&Utc);
    let doy = f64::from(t.ordinal());
    let hour = f64::from(t.hour()) + f64::from(t.minute()) / 60.0;
    let g = 2.0 * std::f64::consts::PI / 365.0 * (doy - 1.0 + (hour - 12.0) / 24.0);
    let decl = 0.006918 - 0.399912 * g.cos() + 0.070257 * g.sin() - 0.006758 * (2.0 * g).cos()
        + 0.000907 * (2.0 * g).sin()
        - 0.002697 * (3.0 * g).cos()
        + 0.00148 * (3.0 * g).sin();
    let eqt = 229.18
        * (0.000075 + 0.001868 * g.cos()
            - 0.032077 * g.sin()
            - 0.014615 * (2.0 * g).cos()
            - 0.040849 * (2.0 * g).sin());
    let tst = hour * 60.0 + eqt + 4.0 * lon;
    let ha = (tst / 4.0 - 180.0).to_radians();
    let la = lat.to_radians();
    let cz = la.sin() * decl.sin() + la.cos() * decl.cos() * ha.cos();
    cz.clamp(-1.0, 1.0).asin().to_degrees()
}

fn value_as_f64(value: &Option<Value>) -> Option<f64> {
    match value.as_ref()? {
        Value::Number(number) => number.as_f64(),
        Value::String(number) => number.parse().ok(),
        _ => None,
    }
}

fn pop_as_f64(period: &Period) -> f64 {
    period
        .probability_of_precipitation
        .as_ref()
        .and_then(|probability| value_as_f64(&probability.value))
        .unwrap_or(0.0)
}

pub fn max_pop(periods: &[Period]) -> f64 {
    periods
        .iter()
        .map(pop_as_f64)
        .reduce(f64::max)
        .unwrap_or(0.0)
}

pub fn holds(x: f64, op: &str, value: f64) -> bool {
    match op {
        "lt" => x < value,
        "lte" => x <= value,
        "gt" => x > value,
        "gte" => x >= value,
        _ => panic!("unsupported comparison operator: {op}"),
    }
}

fn symbol(op: &str) -> Option<&'static str> {
    match op {
        "lt" => Some("<"),
        "lte" => Some("<="),
        "gt" => Some(">"),
        "gte" => Some(">="),
        _ => None,
    }
}

fn trim_fraction(mut value: String) -> String {
    if let Some(dot) = value.find('.') {
        while value.ends_with('0') {
            value.pop();
        }
        if value.len() == dot + 1 {
            value.pop();
        }
    }
    value
}

fn py_general(value: f64) -> String {
    if value.is_nan() {
        return "nan".to_owned();
    }
    if value.is_infinite() {
        return if value.is_sign_negative() {
            "-inf".to_owned()
        } else {
            "inf".to_owned()
        };
    }
    if value == 0.0 {
        return if value.is_sign_negative() {
            "-0".to_owned()
        } else {
            "0".to_owned()
        };
    }

    let scientific = format!("{value:.5e}");
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("Rust scientific notation contains an exponent");
    let exponent: i32 = exponent.parse().expect("Rust exponent is an integer");
    if !(-4..6).contains(&exponent) {
        return format!("{}e{exponent:+03}", trim_fraction(mantissa.to_owned()));
    }

    let precision = usize::try_from(5 - exponent).expect("nonnegative fixed precision");
    trim_fraction(format!("{value:.precision$}"))
}

fn py_fixed_zero(value: f64) -> String {
    format!("{value:.0}")
}

fn pop_display(value: f64) -> String {
    if value.fract() == 0.0 && value >= i64::MIN as f64 && value <= i64::MAX as f64 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

fn temperature_values(periods: &[Period]) -> impl Iterator<Item = f64> + '_ {
    periods
        .iter()
        .filter_map(|period| value_as_f64(&period.temperature))
}

pub fn temperature_condition(rule: &Rule, i: usize, periods: &[Period]) -> Option<String> {
    let value = value_as_f64(&rule.value)?;
    let comparison = symbol(&rule.op)?;
    let ahead = periods.get(i..i.saturating_add(ADVISORY_HOURS).min(periods.len()))?;

    let (temperature, what) = if rule.param == "night_temperature_f" {
        let temperature = ahead
            .iter()
            .filter(|period| period.is_daytime == Some(false))
            .filter_map(|period| value_as_f64(&period.temperature))
            .reduce(f64::min)?;
        (temperature, "night low")
    } else {
        let temperatures = temperature_values(ahead).collect::<Vec<_>>();
        if rule.quote.to_lowercase().contains("mean") {
            let temperature = temperatures.iter().sum::<f64>() / temperatures.len() as f64;
            (temperature, "mean")
        } else {
            (*temperatures.first()?, "temperature now")
        }
    };

    if !holds(temperature, &rule.op, value) {
        return None;
    }
    let span = if what == "temperature now" {
        "this hour".to_owned()
    } else {
        format!("over the next {} h", ahead.len())
    };
    Some(format!(
        "forecast {what} {} F {comparison} {} F {span}",
        py_fixed_zero(temperature),
        py_general(value)
    ))
}

fn tank_composition_clause(rule: &Rule) -> bool {
    static ALONE_TANK: OnceLock<Regex> = OnceLock::new();
    let alone_tank = ALONE_TANK.get_or_init(|| {
        Regex::new(r"\buse\b[^.]*\balone\b").expect("valid tank-composition regex")
    });
    matches!(rule.modality.as_str(), "MUST" | "MUST_NOT")
        && matches!(
            rule.param.as_str(),
            "night_temperature_f" | "air_temperature_f"
        )
        && alone_tank.is_match(&rule.quote.to_lowercase())
}

pub type WindLimits = (Option<f64>, bool, Option<f64>, bool);

pub fn wind_limits(rule: &Rule) -> WindLimits {
    let value = value_as_f64(&rule.value);
    let value2 = value_as_f64(&rule.value2);
    if rule.op == "between"
        && let (Some(lower), Some(upper)) = (value, value2)
    {
        return (Some(upper), false, Some(lower), false);
    }
    let Some(value) = value else {
        return (None, false, None, false);
    };
    if !matches!(rule.op.as_str(), "gt" | "gte" | "lt" | "lte") {
        return (None, false, None, false);
    }
    if value >= 5.0 {
        return (
            Some(value),
            matches!(rule.op.as_str(), "lt" | "gte"),
            None,
            false,
        );
    }
    if value <= 3.0 {
        return (
            None,
            false,
            Some(value),
            matches!(rule.op.as_str(), "gt" | "lte"),
        );
    }
    (None, false, None, false)
}

fn period_window(periods: &[Period], i: usize, hours: i64) -> &[Period] {
    if i >= periods.len() || hours < 0 {
        return &periods[0..0];
    }
    let length = usize::try_from(hours)
        .unwrap_or(usize::MAX)
        .saturating_add(1);
    &periods[i..i.saturating_add(length).min(periods.len())]
}

pub fn advisory(rule: &Rule, i: usize, periods: &[Period], wind: f64) -> Option<String> {
    if rule.param == "wind_speed_mph" {
        let (upper, upper_out, lower, lower_out) = wind_limits(rule);
        if wind.is_nan() {
            return None;
        }
        if let Some(upper) = upper
            && (wind > upper || (upper_out && wind == upper))
        {
            return Some(format!(
                "forecast wind up to {} mph {} {} mph",
                py_general(wind),
                if wind > upper { ">" } else { "=" },
                py_general(upper)
            ));
        }
        if let Some(lower) = lower
            && (wind < lower || (lower_out && wind == lower))
        {
            return Some(format!(
                "forecast wind {} mph {} {} mph",
                py_general(wind),
                if wind < lower { "<" } else { "=" },
                py_general(lower)
            ));
        }
        return None;
    }

    let value = value_as_f64(&rule.value)?;
    if matches!(
        rule.param.as_str(),
        "night_temperature_f" | "air_temperature_f"
    ) {
        return temperature_condition(rule, i, periods);
    }
    if matches!(rule.param.as_str(), "rain_free_hours" | "rainfall_expected") {
        let hours = value.trunc() as i64;
        let pop = max_pop(period_window(periods, i, hours));
        if pop >= RAIN_UNSURE_POP {
            return Some(format!(
                "rain chance up to {}% within {hours} h",
                pop_display(pop)
            ));
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateState {
    Blocked,
    FieldCheck,
}

impl GateState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Blocked => "BLOCKED",
            Self::FieldCheck => "FIELD_CHECK",
        }
    }
}

pub fn gate(
    rule: &Rule,
    i: usize,
    periods: &[Period],
    wind: f64,
    altitude: f64,
    tank_products: &HashSet<String>,
) -> Option<(GateState, String)> {
    if tank_composition_clause(rule) {
        let why = temperature_condition(rule, i, periods)?;
        let product = rule
            .product
            .as_deref()
            .expect("tank-composition rules have a product");
        let mut other_products = tank_products
            .iter()
            .filter(|other| other.as_str() != product)
            .cloned()
            .collect::<Vec<_>>();
        other_products.sort();
        if !other_products.is_empty() {
            return Some((
                GateState::Blocked,
                format!(
                    "{why}: the label says use {product} alone, and this tank also has {}",
                    other_products.join(", ")
                ),
            ));
        }
        return None;
    }

    match rule.param.as_str() {
        "wind_speed_mph" => {
            let (upper, upper_out, lower, lower_out) = wind_limits(rule);
            if upper.is_none() && lower.is_none() {
                return Some((
                    GateState::FieldCheck,
                    "wind clause the planner cannot read as a limit; check the label on site"
                        .to_owned(),
                ));
            }
            if wind.is_nan() {
                return Some((
                    GateState::FieldCheck,
                    "no wind in the forecast for this hour".to_owned(),
                ));
            }
            if let Some(upper) = upper
                && (wind > upper || (upper_out && wind == upper))
            {
                return Some((
                    GateState::Blocked,
                    format!(
                        "forecast wind up to {} mph {} {} mph",
                        py_general(wind),
                        if wind > upper { ">" } else { "=" },
                        py_general(upper)
                    ),
                ));
            }
            if let Some(lower) = lower
                && (wind < lower || (lower_out && wind == lower))
            {
                return Some((
                    GateState::FieldCheck,
                    format!(
                        "forecast wind {} mph {} {} mph: variable direction, inversion potential",
                        py_general(wind),
                        if wind < lower { "<" } else { "=" },
                        py_general(lower)
                    ),
                ));
            }
            None
        }
        "temperature_inversion" => {
            if altitude < 3.0 || (altitude < 20.0 && (wind.is_nan() || wind < 3.0)) {
                let wind = if wind.is_nan() {
                    "unknown".to_owned()
                } else {
                    format!("{} mph", py_general(wind))
                };
                return Some((
                    GateState::FieldCheck,
                    format!(
                        "sun {} deg, wind {wind}: inversion possible, confirm on site",
                        py_fixed_zero(altitude)
                    ),
                ));
            }
            None
        }
        "rain_free_hours" | "rainfall_expected" => {
            let Some(value) = value_as_f64(&rule.value) else {
                return Some((
                    GateState::FieldCheck,
                    "rain clause without a number of hours; check the label".to_owned(),
                ));
            };
            if value == 0.0 {
                return Some((
                    GateState::FieldCheck,
                    "rain clause without a number of hours; check the label".to_owned(),
                ));
            }
            let hours = value.trunc() as i64;
            let pop = max_pop(period_window(periods, i, hours));
            if pop >= RAIN_EXPECTED_POP {
                return Some((
                    GateState::Blocked,
                    format!(
                        "rain chance up to {}% within {hours} h (rain expected = {}%+)",
                        pop_display(pop),
                        pop_display(RAIN_EXPECTED_POP)
                    ),
                ));
            }
            if pop >= RAIN_UNSURE_POP {
                return Some((
                    GateState::FieldCheck,
                    format!("rain chance up to {}% within {hours} h", pop_display(pop)),
                ));
            }
            None
        }
        "night_temperature_f" | "air_temperature_f" => {
            if let Some(why) = temperature_condition(rule, i, periods) {
                return Some((
                    GateState::FieldCheck,
                    format!("{why}: the label sets a requirement at this temperature"),
                ));
            }
            if value_as_f64(&rule.value).is_none() || symbol(&rule.op).is_none() {
                return Some((
                    GateState::FieldCheck,
                    "temperature clause the planner cannot read as a limit; check the label on site"
                        .to_owned(),
                ));
            }
            None
        }
        param => Some((
            GateState::FieldCheck,
            format!(
                "{param} limit on the label; the planner does not evaluate it yet, check it on site"
            ),
        )),
    }
}

fn citation(rule: &Rule, why: String) -> Result<Citation, CoreError> {
    let product = rule
        .product
        .clone()
        .ok_or_else(|| CoreError::new(format!("rule {} has no product", rule.id)))?;
    Ok(Citation {
        product,
        rule: rule.id.clone(),
        page: rule.page.clone(),
        quote: rule.quote.clone(),
        why,
    })
}

pub fn evaluate(
    rules: &[Rule],
    periods: &[Period],
    lat: f64,
    lon: f64,
    hours: usize,
) -> Result<Vec<Evaluation>, CoreError> {
    // The tank is every distinct product represented by the supplied rules. Rules from all
    // three labels contribute regardless of modality.
    let tank_products = rules
        .iter()
        .map(|rule| {
            rule.product
                .clone()
                .ok_or_else(|| CoreError::new(format!("rule {} has no product", rule.id)))
        })
        .collect::<Result<HashSet<_>, _>>()?;
    let mut output = Vec::new();
    for (i, period) in periods.iter().take(hours).enumerate() {
        let time = DateTime::parse_from_rfc3339(&period.start_time).map_err(|error| {
            CoreError::new(format!("invalid startTime {}: {error}", period.start_time))
        })?;
        let wind = mph(period.wind_speed.as_deref().unwrap_or(""));
        let altitude = sun_altitude(lat, lon, time);
        let mut blocked = Vec::new();
        let mut checks = Vec::new();
        let mut advisories = Vec::new();

        for rule in rules {
            if rule.modality == "ADVISORY" {
                if let Some(why) = advisory(rule, i, periods, wind) {
                    advisories.push(citation(rule, why)?);
                }
                continue;
            }
            if let Some((state, why)) = gate(rule, i, periods, wind, altitude, &tank_products) {
                let cite = citation(rule, why)?;
                match state {
                    GateState::Blocked => blocked.push(cite),
                    GateState::FieldCheck => checks.push(cite),
                }
            }
        }

        let state = if blocked.is_empty() {
            if checks.is_empty() {
                "PERMITTED"
            } else {
                GateState::FieldCheck.as_str()
            }
        } else {
            GateState::Blocked.as_str()
        };
        let pop = period
            .probability_of_precipitation
            .as_ref()
            .and_then(|probability| probability.value.clone());
        output.push(Evaluation {
            start: period.start_time.clone(),
            state: state.to_owned(),
            temp_f: period.temperature.clone(),
            wind: period.wind_speed.clone(),
            pop,
            sun_alt: (altitude * 10.0).round_ties_even() / 10.0,
            blocked,
            checks,
            advisories,
        });
    }
    Ok(output)
}

#[cfg(feature = "wasm")]
fn js_error(error: impl fmt::Display) -> wasm_bindgen::JsValue {
    wasm_bindgen::JsValue::from_str(&error.to_string())
}

#[cfg(feature = "wasm")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn evaluate_json(
    rules_json: &str,
    periods_json: &str,
    lat: f64,
    lon: f64,
    hours: usize,
) -> Result<String, wasm_bindgen::JsValue> {
    let rules: Vec<Rule> = serde_json::from_str(rules_json).map_err(js_error)?;
    let periods: Vec<Period> = serde_json::from_str(periods_json).map_err(js_error)?;
    let output = evaluate(&rules, &periods, lat, lon, hours).map_err(js_error)?;
    serde_json::to_string(&output).map_err(js_error)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn filter_rules_json(
    compiled_label_json: &str,
    reg: &str,
) -> Result<String, wasm_bindgen::JsValue> {
    let compiled: CompiledLabel = serde_json::from_str(compiled_label_json).map_err(js_error)?;
    serde_json::to_string(&load_rules(&compiled, reg)).map_err(js_error)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use serde_json::json;

    use super::{GateState, Period, Rule, gate, mph, py_fixed_zero, py_general};

    #[test]
    fn python_number_formats_cover_kernel_values() {
        assert_eq!(py_general(10.0), "10");
        assert_eq!(py_general(7.5), "7.5");
        assert_eq!(py_general(1_234_567.0), "1.23457e+06");
        assert_eq!(py_fixed_zero(2.5), "2");
        assert_eq!(py_fixed_zero(3.5), "4");
    }

    #[test]
    fn mph_uses_the_largest_number_and_nan_for_no_number() {
        assert_eq!(mph("5 to 10 mph"), 10.0);
        assert!(mph("calm").is_nan());
    }

    #[test]
    fn tank_composition_clause_blocks_only_when_cold_and_mixed() {
        let rule: Rule = serde_json::from_value(json!({
            "id": "t-12",
            "page": 1,
            "product": "FOLEX 6 EC",
            "reg": "0-0",
            "param": "night_temperature_f",
            "op": "lt",
            "value": 60,
            "value2": null,
            "unit": "F",
            "modality": "MUST",
            "quote": "When minimum night temperature is below 60F use FOLEX 6 EC alone."
        }))
        .expect("test rule parses");
        let cold: Vec<Period> = serde_json::from_value(json!([
            {"startTime": "2026-10-07T13:00:00-04:00", "isDaytime": true, "temperature": 72, "windSpeed": "5 mph"},
            {"startTime": "2026-10-08T02:00:00-04:00", "isDaytime": false, "temperature": 56, "windSpeed": "5 mph"}
        ]))
        .expect("cold periods parse");
        let warm: Vec<Period> = serde_json::from_value(json!([
            {"startTime": "2026-10-07T13:00:00-04:00", "isDaytime": true, "temperature": 72, "windSpeed": "5 mph"},
            {"startTime": "2026-10-08T02:00:00-04:00", "isDaytime": false, "temperature": 64, "windSpeed": "5 mph"}
        ]))
        .expect("warm periods parse");
        let mixed = HashSet::from([
            "FOLEX 6 EC".to_owned(),
            "Dropp SC".to_owned(),
            "Prep".to_owned(),
        ]);
        let alone = HashSet::from(["FOLEX 6 EC".to_owned()]);

        assert_eq!(
            gate(&rule, 0, &cold, 5.0, 50.0, &mixed),
            Some((
                GateState::Blocked,
                "forecast night low 56 F < 60 F over the next 2 h: the label says use FOLEX 6 EC alone, and this tank also has Dropp SC, Prep".to_owned()
            ))
        );
        assert_eq!(gate(&rule, 0, &cold, 5.0, 50.0, &alone), None);
        assert_eq!(gate(&rule, 0, &warm, 5.0, 50.0, &mixed), None);
    }
}
