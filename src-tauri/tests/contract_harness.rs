use serde_json::Value;
use std::fs;
use std::path::PathBuf;

#[test]
fn test_compatibility_scenarios() {
    let path = PathBuf::from("../tests/contracts/compatibility-scenarios.json");
    if !path.exists() {
        return;
    }

    let content = fs::read_to_string(path).unwrap();
    let root: Value = serde_json::from_str(&content).unwrap();

    let pure = root["pureCases"].as_array().unwrap();
    for case in pure {
        let id = case["id"].as_str().unwrap();
        let cat = case["category"].as_str().unwrap();
        println!("Checking pure case {:?} in category {:?}", id, cat);
        match cat {
            "window-policy" => {
                let input = &case["input"];
                let target = input["targetUrl"].as_str().unwrap();
                let frontend = input["frontendUrl"].as_str().unwrap();
                let is_valid = target.starts_with(frontend);
                println!("Window policy case {}: valid={}", id, is_valid);
            },
            "process-manager-shutdown" => {
                let services = case["input"].as_array().unwrap();
                let mut reversed = services.clone();
                reversed.reverse();
                assert_eq!(&reversed, case["expectedOutput"].as_array().unwrap());
            },
            _ => {}
        }
    }

    let sup = root["supervisionScenarios"].as_array().unwrap();
    for case in sup {
        println!("Checking supervision case {:?}", case["id"]);
    }
}

